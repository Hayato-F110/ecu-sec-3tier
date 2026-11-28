"""一括確認マトリクス（メーカー用）。行＝ECU、列＝対策項目、セル＝状態。

守りの決まり（CLAUDE.md・docs/test-plans/SC3-11.md）：
- 呼べるのはメーカーの会社のシステム管理者・確認者だけ（app/deps.py の oem_user）
- 承認済みの版だけを見せる。新しい版が承認されるまで、前の承認済みの版を見せる（決まり4）
- 下書き・承認待ち・差し戻しの版の中身は、どの形でも返さない
- 一覧は読むだけなので監査ログは書かない。確認完了・修正依頼は監査ログに残す
"""

from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status
from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError

from app.api.ecus import client_ip, commit_with_log
from app.deps import Db, OemUser, reviewer_of_ecu
from app.models import (
    Assessment,
    AssessmentEntry,
    AuditLog,
    Comment,
    Company,
    Ecu,
    MeasureItem,
    User,
)
from app.schemas import (
    ChangeRequestIn,
    ConfirmIn,
    MatrixCell,
    MatrixItem,
    MatrixRow,
    MatrixView,
    ReviewOut,
)

router = APIRouter(prefix="/api/matrix", tags=["matrix"])


@router.get("", response_model=MatrixView)
def get_matrix(_user: OemUser, db: Db) -> MatrixView:
    items = db.scalars(select(MeasureItem).order_by(MeasureItem.sort_order, MeasureItem.id)).all()

    # ECU ごとの、承認済みの版の中でいちばん大きい番号（作業中の版は見ない）
    newest = (
        select(Assessment.ecu_id, func.max(Assessment.version).label("version"))
        .where(Assessment.status == "approved")
        .group_by(Assessment.ecu_id)
        .subquery()
    )
    approved = {
        a.ecu_id: a
        for a in db.scalars(
            select(Assessment).join(
                newest,
                and_(Assessment.ecu_id == newest.c.ecu_id, Assessment.version == newest.c.version),
            )
        )
    }
    # 承認済みの版の、項目ごとの状態だけを読む（根拠・対応予定日は読まない）
    statuses: dict[tuple[int, int], str] = {
        (assessment_id, item_id): status
        for assessment_id, item_id, status in db.execute(
            select(
                AssessmentEntry.assessment_id, AssessmentEntry.item_id, AssessmentEntry.status
            ).where(AssessmentEntry.assessment_id.in_([a.id for a in approved.values()]))
        ).tuples()
    }

    rows = []
    for ecu, company in db.execute(
        select(Ecu, Company)
        .join(Company, Company.id == Ecu.supplier_id)
        .order_by(Company.name, Ecu.part_no, Ecu.id)
    ).tuples():
        a = approved.get(ecu.id)
        rows.append(
            MatrixRow(
                ecu_id=ecu.id,
                supplier_id=company.id,
                supplier_name=company.name,
                ecu_name=ecu.name,
                part_no=ecu.part_no,
                vehicle_model=ecu.vehicle_model,
                version=a.version if a else None,
                review_status=a.review_status if a else None,
                cells=[
                    MatrixCell(item_id=m.id, status=statuses.get((a.id, m.id)) if a else None)
                    for m in items
                ],
            )
        )
    return MatrixView(
        items=[MatrixItem(id=m.id, code=m.code, title=m.title) for m in items], rows=rows
    )


# ---- 確認完了・修正依頼（docs/test-plans/SC3-15.md の #1〜#3） ----
# 調べる順番：401 → メーカーの会社か（403）→ ECU があるか（404）→ 確認者か（403）
# → 本文の形（422）→ 状態（409）

Reviewer = Annotated[tuple[Ecu, User], Depends(reviewer_of_ecu)]
# 「result」の値で形を選ぶ（修正依頼のときだけ理由が必須。確認完了に理由を送ると 422）
ReviewIn = Annotated[ConfirmIn | ChangeRequestIn, Body(discriminator="result")]


@router.post("/ecus/{ecu_id}/review", response_model=ReviewOut)
def review(body: ReviewIn, target: Reviewer, db: Db, request: Request) -> ReviewOut:
    """最新の承認済みの版に、確認完了か修正依頼を記録する（1つの版に1回だけ）。
    修正依頼の理由は、種類「修正依頼」のコメントとして残す（監査ログには入れない）。
    修正依頼のあと、サプライヤが保存すると新しい版の下書きができる（app/api/ecus.py の new_version）
    """
    ecu, user = target
    # ECU の行と版をロックしてから状態を確かめる（同時の確認を1つずつにする）
    db.execute(select(Ecu.id).where(Ecu.id == ecu.id).with_for_update())
    current = db.scalars(
        select(Assessment)
        .where(Assessment.ecu_id == ecu.id, Assessment.status == "approved")
        .order_by(Assessment.version.desc())
        .limit(1)
        .with_for_update()
    ).one_or_none()
    if current is None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="承認済みの版がありません")
    if body.version > current.version:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="その版はまだ承認されていません")
    if body.version < current.version:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="新しい版が承認されました。見直してください"
        )
    if current.review_status != "unreviewed":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="この版はすでに確認済みです")

    current.review_status = body.result
    current.reviewed_by = user.id
    # DB の時計（トランザクションの開始の時刻）。ほかのコメント・監査ログの日時（server_default
    # の now()）と同じ時計にし、アプリと DB の時計のずれで並びが前後しないようにする
    current.reviewed_at = db.scalar(select(func.now()))
    if isinstance(body, ChangeRequestIn):
        # コメントの日時は確認の日時にそろえる（同じ1回の操作なので、並べたとき前後しない）
        comment = Comment(
            assessment_id=current.id,
            author_id=user.id,
            kind="change_request",
            body=body.reason,
            created_at=current.reviewed_at,
        )
        db.add(comment)
        # コメントの番号を得るために DB へ送る。ここで制約に当たっても 500 にせず、
        # 確定のときと同じく 409 にし、何も残さない
        try:
            db.flush()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT, detail="ほかの操作と重なりました。やり直してください"
            ) from exc
        # コメントも監査ログでたどれるように、コメントの番号の行を足す（本文は入れない。決まり5）
        db.add(
            AuditLog(
                user_id=user.id,
                action="add_comment",
                target=f"comment:{comment.id}",
                ip=client_ip(request),
            )
        )
        action = "request_change"
    else:
        action = "confirm"
    commit_with_log(db, user, action, current, request)
    return ReviewOut(ecu_id=ecu.id, version=current.version, review_status=current.review_status)
