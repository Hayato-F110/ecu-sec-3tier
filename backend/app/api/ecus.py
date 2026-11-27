"""ECU の一覧、対策状況の取得、下書きの保存、承認フロー（申請・承認・差し戻し）（サプライヤ用）。

守りの決まり（CLAUDE.md）：
- 会社ごとの絞り込みは app/deps.py の own_ecu（他社も存在しない番号も 404）
- 承認済みの版は書き換えない。更新は新しい版（番号＋1）の下書きを作る
- 状態の変更は API で検証する（申請者本人は承認・差し戻しできない、差し戻しには理由が必須）
- 保存と状態の変更は監査ログに残す
"""

import ipaddress
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.deps import Db, OwnEcu, SupplierUser, approver_of_own_ecu, editor_of_own_ecu
from app.models import (
    OPEN_STATUSES,
    Assessment,
    AssessmentEntry,
    AuditLog,
    Ecu,
    MeasureItem,
    User,
)
from app.schemas import (
    AssessmentOut,
    AssessmentView,
    DraftIn,
    EcuSummary,
    EntryOut,
    NoFieldsIn,
    RejectIn,
    has_visible,
)

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


def can_review(assessment: Assessment | None, user: User | None) -> bool:
    """承認者で、申請者本人でなく、承認待ちのときだけ承認・差し戻しできる（画面のボタンの出し分け）"""
    return (
        assessment is not None
        and user is not None
        and user.role == "approver"
        and assessment.status == "pending"
        and assessment.submitted_by != user.id
    )


def view_of(db: Session, assessment: Assessment | None, user: User | None = None) -> AssessmentView:
    # 対策項目を起点にする：まだ入力のない項目も、空のまま並べて返す（画面が全項目を出せるように）。
    # 版がまだない ECU でも同じ。空の一覧を返すと、画面に入力欄が出ず、最初の下書きを作れない
    rows: Sequence[tuple[MeasureItem, AssessmentEntry | None]]
    if assessment is None:
        items = db.scalars(select(MeasureItem).order_by(MeasureItem.sort_order)).all()
        rows = [(m, None) for m in items]
    else:
        rows = (
            db.execute(
                select(MeasureItem, AssessmentEntry)
                .outerjoin(
                    AssessmentEntry,
                    and_(
                        AssessmentEntry.item_id == MeasureItem.id,
                        AssessmentEntry.assessment_id == assessment.id,
                    ),
                )
                .order_by(MeasureItem.sort_order)
            )
            .tuples()
            .all()
        )
    return AssessmentView(
        assessment=None
        if assessment is None
        else AssessmentOut(
            id=assessment.id,
            version=assessment.version,
            status=assessment.status,
            reject_reason=assessment.reject_reason if assessment.status == "rejected" else None,
        ),
        can_review=can_review(assessment, user),
        entries=[
            EntryOut(
                item_id=m.id,
                code=m.code,
                title=m.title,
                status=e.status if e else None,
                evidence=e.evidence if e else None,
                planned_date=e.planned_date if e else None,
            )
            for m, e in rows
        ],
    )


def client_ip(request: Request) -> str | None:
    """接続元の IP アドレス。IP アドレスでないとき（テストの "testclient" など）は空にする。

    IPv6 のゾーン ID（fe80::1%eth0 の %eth0）は除く。PostgreSQL の INET が受け付けないため。
    """
    host = request.client.host if request.client else None
    if host is None:
        return None
    try:
        return str(ipaddress.ip_address(host.split("%", 1)[0]))
    except ValueError:
        return None


# ---- API ----


@router.get("", response_model=list[EcuSummary])
def list_ecus(user: SupplierUser, db: Db) -> list[EcuSummary]:
    """自社の ECU と、それぞれの最新の版の番号・状態。"""
    ecus = db.scalars(
        select(Ecu).where(Ecu.supplier_id == user.company_id).order_by(Ecu.part_no)
    ).all()
    # ECU ごとに、番号のいちばん大きい版だけを読む（版が増えても読む行は ECU の数だけ）
    newest = (
        select(Assessment.ecu_id, func.max(Assessment.version).label("version"))
        .where(Assessment.ecu_id.in_([e.id for e in ecus]))
        .group_by(Assessment.ecu_id)
        .subquery()
    )
    latest = {
        a.ecu_id: a
        for a in db.scalars(
            select(Assessment).join(
                newest,
                and_(Assessment.ecu_id == newest.c.ecu_id, Assessment.version == newest.c.version),
            )
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
def get_assessment(ecu: OwnEcu, user: SupplierUser, db: Db) -> AssessmentView:
    """作業中の版があればそれ、なければ最新の承認済みの版。"""
    return view_of(db, open_version(db, ecu.id) or latest_approved(db, ecu.id), user)


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

    # 調べる順番：入力の誤り（422）→ 状態（409）。docs/test-plans/SC3-9.md
    known = set(db.scalars(select(MeasureItem.id)))
    unknown = sorted({e.item_id for e in body.entries} - known)
    if unknown:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"存在しない対策項目：{unknown}"
        )

    current = open_version(db, ecu.id, lock=True)
    if current is not None and current.status == "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="承認待ちの版は編集できません")

    # 版を作る・書き込む・確定するまでの全体で、DB の制約の違反（同時の保存など）を 409 にする
    try:
        draft = write_draft(db, ecu.id, current, body, user, client_ip(request))
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="ほかの保存と重なりました。やり直してください"
        ) from exc
    return view_of(db, draft, user)


def write_draft(
    db: Session,
    ecu_id: int,
    current: Assessment | None,
    body: DraftIn,
    user: User,
    ip: str | None,
) -> Assessment:
    """下書きの版を決めて入力を書き、監査ログを足す（確定はしない）。"""
    if current is not None and current.status == "draft":
        draft, action = current, "save_draft"
    elif current is not None:  # 差し戻し → 下書きに戻す（理由と申請者の記録は残す）
        current.status = "draft"
        draft, action = current, "reopen_rejected"
    else:
        draft = new_version(db, ecu_id)
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

    db.add(AuditLog(user_id=user.id, action=action, target=f"assessment:{draft.id}", ip=ip))
    return draft


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


# ---- 承認フロー（docs/test-plans/SC3-14.md） ----
# 調べる順番：401 → 会社の種類と役割（403）→ 自社の ECU か（404）→ 操作の役割（403）
# → 本文の形（422）→ 状態（409）→ 申請なら全項目が入力済みか（409）
# → 承認・差し戻しなら職務分離（403）

Editor = Annotated[tuple[Ecu, User], Depends(editor_of_own_ecu)]
Approver = Annotated[tuple[Ecu, User], Depends(approver_of_own_ecu)]


def locked_open_version(db: Session, ecu: Ecu, expected: str, detail: str) -> Assessment:
    """ECU の行と作業中の版をロックしてから状態を確かめる（同時の操作を1つずつにする）"""
    db.execute(select(Ecu.id).where(Ecu.id == ecu.id).with_for_update())
    current = open_version(db, ecu.id, lock=True)
    if current is None or current.status != expected:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=detail)
    return current


def is_complete(db: Session, assessment: Assessment) -> bool:
    """全部の対策項目に、状態・空白だけでない根拠、対応中・未対応なら対応予定日がある（決めたこと6）"""
    entries = {
        e.item_id: e
        for e in db.scalars(
            select(AssessmentEntry).where(AssessmentEntry.assessment_id == assessment.id)
        )
    }
    for item_id in db.scalars(select(MeasureItem.id)):
        e = entries.get(item_id)
        if e is None or e.status is None or not has_visible(e.evidence):
            return False
        if e.status in ("in_progress", "not_done") and e.planned_date is None:
            return False
    return True


def not_own_submission(assessment: Assessment, user: User) -> None:
    """職務分離：申請者本人は承認も差し戻しもできない（決めたこと1）"""
    if assessment.submitted_by == user.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="申請者本人は承認・差し戻しできません"
        )


def commit_with_log(
    db: Session, user: User, action: str, assessment: Assessment, request: Request
) -> None:
    """監査ログを足して確定する。DB の制約の違反（同時の操作など）は 409 にし、何も残さない"""
    db.add(
        AuditLog(
            user_id=user.id,
            action=action,
            target=f"assessment:{assessment.id}",
            ip=client_ip(request),
        )
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="ほかの操作と重なりました。やり直してください"
        ) from exc


@router.post("/{ecu_id}/submit", response_model=AssessmentView)
def submit(
    target: Editor, db: Db, request: Request, body: NoFieldsIn | None = None
) -> AssessmentView:
    """承認申請。申請者・申請日時は、いつも今の人・今の時刻に書き直す（SC3-25）"""
    ecu, user = target
    current = locked_open_version(db, ecu, "draft", "申請できるのは下書きの版だけです")
    if not is_complete(db, current):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="未入力の項目があります")
    current.status = "pending"
    current.submitted_by = user.id
    current.submitted_at = datetime.now(UTC)
    commit_with_log(db, user, "submit", current, request)
    return view_of(db, current, user)


@router.post("/{ecu_id}/approve", response_model=AssessmentView)
def approve(
    target: Approver, db: Db, request: Request, body: NoFieldsIn | None = None
) -> AssessmentView:
    """承認。メーカーの確認状況は「未確認」から始める"""
    ecu, user = target
    current = locked_open_version(db, ecu, "pending", "承認待ちの版がありません")
    not_own_submission(current, user)
    current.status = "approved"
    current.approved_by = user.id
    current.approved_at = datetime.now(UTC)
    current.review_status = "unreviewed"
    commit_with_log(db, user, "approve", current, request)
    return view_of(db, current, user)


@router.post("/{ecu_id}/reject", response_model=AssessmentView)
def reject(body: RejectIn, target: Approver, db: Db, request: Request) -> AssessmentView:
    """差し戻し。理由は最後のものだけを残す（決めたこと4）。理由は監査ログに入れない"""
    ecu, user = target
    current = locked_open_version(db, ecu, "pending", "承認待ちの版がありません")
    not_own_submission(current, user)
    current.status = "rejected"
    current.reject_reason = body.reason
    commit_with_log(db, user, "reject", current, request)
    return view_of(db, current, user)
