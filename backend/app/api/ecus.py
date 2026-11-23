"""ECU の一覧、対策状況の取得、下書きの保存（サプライヤ用）。

守りの決まり（CLAUDE.md）：
- 会社ごとの絞り込みは app/deps.py の own_ecu（他社も存在しない番号も 404）
- 承認済みの版は書き換えない。更新は新しい版（番号＋1）の下書きを作る
- 保存は監査ログに残す
"""

import ipaddress
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.deps import Db, OwnEcu, SupplierUser, editor_of_own_ecu
from app.models import (
    OPEN_STATUSES,
    Assessment,
    AssessmentEntry,
    AuditLog,
    Ecu,
    MeasureItem,
    User,
)
from app.schemas import AssessmentOut, AssessmentView, DraftIn, EcuSummary, EntryOut

router = APIRouter(prefix="/api/ecus", tags=["ecus"])


# ---- DB から読む道具 ----


def open_version(db: Session, ecu_id: int, *, lock: bool = False) -> Assessment | None:
    """作業中の版（下書き・承認待ち・差し戻し）。DB の索引で ECU ごとに1つまで。"""
    query = select(Assessment).where(
        Assessment.ecu_id == ecu_id, Assessment.status.in_(OPEN_STATUSES)
    )
    if lock:
        query = query.with_for_update()
    return db.scalars(query).one_or_none()


def latest_approved(db: Session, ecu_id: int) -> Assessment | None:
    return db.scalars(
        select(Assessment)
        .where(Assessment.ecu_id == ecu_id, Assessment.status == "approved")
        .order_by(Assessment.version.desc())
        .limit(1)
    ).one_or_none()


def view_of(db: Session, assessment: Assessment | None) -> AssessmentView:
    if assessment is None:
        return AssessmentView(assessment=None, entries=[])
    rows = db.execute(
        select(AssessmentEntry, MeasureItem)
        .join(MeasureItem, MeasureItem.id == AssessmentEntry.item_id)
        .where(AssessmentEntry.assessment_id == assessment.id)
        .order_by(MeasureItem.sort_order)
    ).all()
    return AssessmentView(
        assessment=AssessmentOut(
            id=assessment.id, version=assessment.version, status=assessment.status
        ),
        entries=[
            EntryOut(
                item_id=e.item_id,
                code=m.code,
                title=m.title,
                status=e.status,
                evidence=e.evidence,
                planned_date=e.planned_date,
            )
            for e, m in rows
        ],
    )


def client_ip(request: Request) -> str | None:
    """接続元の IP アドレス。IP アドレスでないとき（テストの "testclient" など）は空にする。"""
    host = request.client.host if request.client else None
    if host is None:
        return None
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return None


# ---- API ----


@router.get("", response_model=list[EcuSummary])
def list_ecus(user: SupplierUser, db: Db) -> list[EcuSummary]:
    """自社の ECU と、それぞれの最新の版の番号・状態。"""
    ecus = db.scalars(
        select(Ecu).where(Ecu.supplier_id == user.company_id).order_by(Ecu.part_no)
    ).all()
    latest = {
        a.ecu_id: a
        for a in db.scalars(
            select(Assessment)
            .where(Assessment.ecu_id.in_([e.id for e in ecus]))
            .order_by(Assessment.ecu_id, Assessment.version)
        )
    }
    return [
        EcuSummary(
            id=e.id,
            name=e.name,
            part_no=e.part_no,
            vehicle_model=e.vehicle_model,
            latest_version=latest[e.id].version if e.id in latest else None,
            latest_status=latest[e.id].status if e.id in latest else None,
        )
        for e in ecus
    ]


@router.get("/{ecu_id}/assessment", response_model=AssessmentView)
def get_assessment(ecu: OwnEcu, db: Db) -> AssessmentView:
    """作業中の版があればそれ、なければ最新の承認済みの版。"""
    return view_of(db, open_version(db, ecu.id) or latest_approved(db, ecu.id))


@router.put("/{ecu_id}/draft", response_model=AssessmentView)
def save_draft(
    body: DraftIn,
    target: Annotated[tuple[Ecu, User], Depends(editor_of_own_ecu)],
    db: Db,
    request: Request,
) -> AssessmentView:
    """下書きを保存する。送らなかった項目は前の値のまま。"""
    ecu, user = target
    # 同じ ECU への同時の保存を1つずつにする（版の番号の重複を防ぐ）
    db.execute(select(Ecu.id).where(Ecu.id == ecu.id).with_for_update())

    current = open_version(db, ecu.id, lock=True)
    if current is not None and current.status == "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="承認待ちの版は編集できません")

    known = set(db.scalars(select(MeasureItem.id)))
    unknown = sorted({e.item_id for e in body.entries} - known)
    if unknown:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"存在しない対策項目：{unknown}"
        )

    if current is not None and current.status == "draft":
        draft, action = current, "save_draft"
    elif current is not None:  # 差し戻し → 下書きに戻す（理由と申請者の記録は残す）
        current.status = "draft"
        draft, action = current, "reopen_rejected"
    else:
        draft = new_version(db, ecu.id)
        action = "create_draft_version"

    existing = {
        e.item_id: e
        for e in db.scalars(
            select(AssessmentEntry).where(AssessmentEntry.assessment_id == draft.id)
        )
    }
    for entry in body.entries:
        row = existing.get(entry.item_id)
        if row is None:
            row = AssessmentEntry(assessment_id=draft.id, item_id=entry.item_id)
            db.add(row)
        row.status = entry.status
        row.evidence = entry.evidence
        row.planned_date = entry.planned_date

    db.add(
        AuditLog(
            user_id=user.id,
            action=action,
            target=f"assessment:{draft.id}",
            ip=client_ip(request),
        )
    )
    try:
        db.commit()
    except IntegrityError as exc:
        # ほかの保存と同時になり、作業中の版が2つになりかけたときなど
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="ほかの保存と重なりました。やり直してください"
        ) from exc
    return view_of(db, draft)


def new_version(db: Session, ecu_id: int) -> Assessment:
    """新しい版（番号＋1）の下書き。最新の承認済みの版の入力を写す（承認済みの版は変えない）。"""
    last = db.scalar(select(func.max(Assessment.version)).where(Assessment.ecu_id == ecu_id))
    draft = Assessment(ecu_id=ecu_id, version=(last or 0) + 1, status="draft")
    db.add(draft)
    db.flush()
    source = latest_approved(db, ecu_id)
    if source is not None:
        for e in db.scalars(
            select(AssessmentEntry).where(AssessmentEntry.assessment_id == source.id)
        ):
            db.add(
                AssessmentEntry(
                    assessment_id=draft.id,
                    item_id=e.item_id,
                    status=e.status,
                    evidence=e.evidence,
                    planned_date=e.planned_date,
                )
            )
        db.flush()
    return draft
