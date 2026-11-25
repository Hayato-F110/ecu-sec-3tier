"""一括確認マトリクス（メーカー用）。行＝ECU、列＝対策項目、セル＝状態。

守りの決まり（CLAUDE.md・docs/test-plans/SC3-11.md）：
- 呼べるのはメーカーの会社のシステム管理者・確認者だけ（app/deps.py の oem_user）
- 承認済みの版だけを見せる。新しい版が承認されるまで、前の承認済みの版を見せる（決まり4）
- 下書き・承認待ち・差し戻しの版の中身は、どの形でも返さない
- 読むだけなので監査ログは書かない
"""

from fastapi import APIRouter
from sqlalchemy import and_, func, select

from app.deps import Db, OemUser
from app.models import Assessment, AssessmentEntry, Company, Ecu, MeasureItem
from app.schemas import MatrixCell, MatrixItem, MatrixRow, MatrixView

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
