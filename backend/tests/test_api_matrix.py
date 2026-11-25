"""一括確認マトリクスの API のテスト（docs/test-plans/SC3-11.md の #1〜#10）。

ダミーデータの承認済みの版はどれも版1だけで、「承認済みの版が2つ以上」「承認待ちだけ」などの
ECU はない。そのため、確かめたい形の ECU はテストの中で作る。期待値は実装の関数を使わず、
このファイルの SQL（max(version) WHERE status='approved'）で求める。

守りの決まり2・7の例外：この API は URL に ECU や会社の番号がなく、隠す相手（存在）がないので、
サプライヤには 404 ではなく 403 を返す。代わりに「メーカー以外は、どの会社のデータも
1行も読めない」ことを #8・#9 で確かめる。
"""

import json
from datetime import UTC, date, datetime
from typing import Any

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session

from app.models import Assessment, AssessmentEntry, Comment, Company, Ecu, MeasureItem, User
from app.seed import LOCKED_PASSWORD
from tests.api_helpers import Api

URL = "/api/matrix"
OEM_ADMIN = "oem-sys_admin@example.com"
OEM_REVIEWER = "oem-reviewer@example.com"
OEM_USERS = [OEM_ADMIN, OEM_REVIEWER]
SUPPLIER_USERS = [
    f"{c}-{r}@example.com"
    for c in ("a", "b", "c")
    for r in ("supplier_admin", "editor", "approver")
]

TOP_KEYS = {"items", "rows"}
ITEM_KEYS = {"id", "code", "title"}
ROW_KEYS = {
    "ecu_id",
    "supplier_id",
    "supplier_name",
    "ecu_name",
    "part_no",
    "vehicle_model",
    "version",
    "review_status",
    "cells",
}
CELL_KEYS = {"item_id", "status"}
NOW = datetime(2026, 11, 25, 12, 0, tzinfo=UTC)

# 応答に出てはいけない目印（根拠・対応予定日・差し戻しの理由）
MARK_APPROVED = "MARK-APPROVED-EVIDENCE"
MARK_DRAFT = "MARK-DRAFT-EVIDENCE"
MARK_PENDING = "MARK-PENDING-EVIDENCE"
MARK_REJECT = "MARK-REJECT-REASON"
MARK_DATE = date(2099, 12, 31)


# ---- テストの中で ECU と版を作る道具 ----


def company_of(s: Session, email: str) -> Company:
    user = s.scalars(select(User).where(User.email == email)).one()
    return s.get(Company, user.company_id)


def new_ecu(s: Session, part_no: str, name: str = "テスト用 ECU") -> Ecu:
    ecu = Ecu(
        supplier_id=company_of(s, "a-editor@example.com").id,
        name=name,
        part_no=part_no,
        vehicle_model="テスト車",
    )
    s.add(ecu)
    s.flush()
    return ecu


def add_version(
    s: Session,
    ecu: Ecu,
    version: int,
    status: str,
    entry_status: str,
    *,
    review_status: str = "unreviewed",
    evidence: str = "テストの根拠",
) -> Assessment:
    """版を1つ作り、全項目に同じ状態を入れる。DB の制約（職務分離など）を満たす形で作る。"""
    editor = s.scalars(select(User).where(User.email == "a-editor@example.com")).one()
    approver = s.scalars(select(User).where(User.email == "a-approver@example.com")).one()
    reviewer = s.scalars(select(User).where(User.email == OEM_REVIEWER)).one()
    a = Assessment(ecu_id=ecu.id, version=version, status=status)
    if status != "draft":
        a.submitted_by, a.submitted_at = editor.id, NOW
    if status == "rejected":
        a.reject_reason = MARK_REJECT
    if status == "approved":
        a.approved_by, a.approved_at, a.review_status = approver.id, NOW, review_status
        if review_status != "unreviewed":
            a.reviewed_by, a.reviewed_at = reviewer.id, NOW
    s.add(a)
    s.flush()
    planned = MARK_DATE if entry_status in ("in_progress", "not_done") else None
    for item_id in s.scalars(select(MeasureItem.id)):
        s.add(
            AssessmentEntry(
                assessment_id=a.id,
                item_id=item_id,
                status=entry_status,
                evidence=evidence,
                planned_date=planned,
            )
        )
    s.flush()
    return a


def matrix(api: Api, email: str = OEM_REVIEWER) -> dict[str, Any]:
    api.session.commit()
    res = api.get(URL, email)
    assert res.status_code == 200, res.text
    return res.json()


def row_of(body: dict[str, Any], ecu: Ecu) -> dict[str, Any]:
    rows = [r for r in body["rows"] if r["ecu_id"] == ecu.id]
    assert len(rows) == 1
    return rows[0]


def cell_statuses(row: dict[str, Any]) -> list[str | None]:
    return [c["status"] for c in row["cells"]]


def expected_rows(s: Session) -> dict[int, tuple]:
    """ECU ごとの（版・確認状況・項目の並び順どおりの状態）。実装を使わずに求める。"""
    s.expire_all()
    items = list(s.scalars(select(MeasureItem.id).order_by(MeasureItem.sort_order)))
    result: dict[int, tuple] = {}
    for ecu_id in s.scalars(select(Ecu.id)):
        newest = s.scalar(
            select(func.max(Assessment.version)).where(
                Assessment.ecu_id == ecu_id, Assessment.status == "approved"
            )
        )
        if newest is None:
            result[ecu_id] = (None, None, [None] * len(items))
            continue
        a = s.scalars(
            select(Assessment).where(Assessment.ecu_id == ecu_id, Assessment.version == newest)
        ).one()
        by_item = {
            e.item_id: e.status
            for e in s.scalars(select(AssessmentEntry).where(AssessmentEntry.assessment_id == a.id))
        }
        result[ecu_id] = (a.version, a.review_status, [by_item.get(i) for i in items])
    return result


# ---- #1 呼べる人・全体の形 ----


@pytest.mark.parametrize("email", OEM_USERS)
def test_oem_users_get_all_items_and_all_ecus(api: Api, email: str) -> None:
    body = matrix(api, email)
    items = list(api.session.scalars(select(MeasureItem).order_by(MeasureItem.sort_order)))
    assert len(items) == 10
    assert [i["id"] for i in body["items"]] == [m.id for m in items]
    assert [i["title"] for i in body["items"]] == [m.title for m in items]
    assert len(body["rows"]) == api.session.scalar(select(func.count()).select_from(Ecu)) == 30


# ---- #2 最新の承認済みの版を選ぶ ----


def test_newest_approved_version_is_used_not_first(api: Api) -> None:
    ecu = new_ecu(api.session, "TST-NEWEST")
    add_version(api.session, ecu, 1, "approved", "done", review_status="confirmed")
    add_version(api.session, ecu, 2, "approved", "not_done", review_status="unreviewed")
    add_version(api.session, ecu, 3, "pending", "in_progress")
    row = row_of(matrix(api), ecu)
    assert row["version"] == 2
    assert row["review_status"] == "unreviewed"
    assert cell_statuses(row) == ["not_done"] * 10


def test_every_row_matches_newest_approved_version(api: Api) -> None:
    ecu = new_ecu(api.session, "TST-ALL")
    add_version(api.session, ecu, 1, "approved", "done", review_status="change_requested")
    add_version(api.session, ecu, 2, "approved", "not_applicable", review_status="confirmed")
    body = matrix(api)
    expected = expected_rows(api.session)
    got = {r["ecu_id"]: (r["version"], r["review_status"], cell_statuses(r)) for r in body["rows"]}
    assert got == expected


# ---- #3 新しい版が承認されるまで、前の承認版を見せる ----


@pytest.mark.parametrize("open_status", ["pending", "rejected", "draft"])
def test_open_version_on_top_of_approved_is_hidden(api: Api, open_status: str) -> None:
    ecu = new_ecu(api.session, f"TST-OPEN-{open_status}")
    add_version(api.session, ecu, 1, "approved", "done", review_status="confirmed")
    add_version(api.session, ecu, 2, open_status, "not_done")
    row = row_of(matrix(api), ecu)
    assert (row["version"], row["review_status"]) == (1, "confirmed")
    assert cell_statuses(row) == ["done"] * 10


# ---- #4 承認済みの版がない ECU ----


@pytest.mark.parametrize("only", [None, "draft", "pending", "rejected"])
def test_ecu_without_approved_version_has_empty_row(api: Api, only: str | None) -> None:
    ecu = new_ecu(api.session, f"TST-NONE-{only}")
    if only is not None:
        add_version(api.session, ecu, 1, only, "done")
    row = row_of(matrix(api), ecu)
    assert set(row) == ROW_KEYS
    assert row["version"] is None
    assert row["review_status"] is None
    assert cell_statuses(row) == [None] * 10


def test_rows_without_approved_version_look_the_same(api: Api) -> None:
    """版なし・下書きだけ・承認待ちだけ・差し戻しだけで、行の形が同じ（下書きの有無が分からない）。"""
    ecus = {}
    for only in (None, "draft", "pending", "rejected"):
        ecus[only] = new_ecu(api.session, f"TST-SAME-{only}", name="同じ名前")
        if only is not None:
            add_version(api.session, ecus[only], 1, only, "done")
    body = matrix(api)
    shapes = set()
    for ecu in ecus.values():
        row = dict(row_of(body, ecu))
        for k in ("ecu_id", "part_no"):  # ECU を区別する欄
            row.pop(k)
        shapes.add(json.dumps(row, sort_keys=True, ensure_ascii=False))
    assert len(shapes) == 1


# ---- #5 行の中身（会社との結び付き） ----


def test_row_identity_matches_ecus_joined_with_companies(api: Api) -> None:
    body = matrix(api)
    s = api.session
    expected = {
        (c.id, c.name, e.id, e.part_no, e.name, e.vehicle_model)
        for e, c in s.execute(select(Ecu, Company).join(Company, Company.id == Ecu.supplier_id))
    }
    got = {
        (
            r["supplier_id"],
            r["supplier_name"],
            r["ecu_id"],
            r["part_no"],
            r["ecu_name"],
            r["vehicle_model"],
        )
        for r in body["rows"]
    }
    assert got == expected


# ---- #6 列（対策項目） ----


def test_columns_follow_sort_order(api: Api) -> None:
    s = api.session
    items = list(s.scalars(select(MeasureItem).order_by(MeasureItem.sort_order)))
    first, second = items[0], items[1]
    first.sort_order, second.sort_order = second.sort_order, first.sort_order
    s.flush()
    body = matrix(api)
    ids = [i["id"] for i in body["items"]]
    assert ids[:2] == [second.id, first.id]
    for row in body["rows"]:
        assert [c["item_id"] for c in row["cells"]] == ids


def test_item_added_after_approval_has_empty_cells(api: Api) -> None:
    s = api.session
    s.add(
        MeasureItem(code="TST-NEW", title="後から足した項目", description="テスト", sort_order=99)
    )
    s.flush()
    body = matrix(api)
    assert body["items"][-1]["code"] == "TST-NEW"
    assert all(r["cells"][-1]["status"] is None for r in body["rows"])


# ---- #7 返さないもの ----


def test_response_keys_are_exactly_the_decided_set(api: Api) -> None:
    body = matrix(api)
    assert body["items"] and body["rows"]  # 空の応答で素通りしない
    assert set(body) == TOP_KEYS
    assert all(set(i) == ITEM_KEYS for i in body["items"])
    assert all(set(r) == ROW_KEYS for r in body["rows"])
    assert all(set(c) == CELL_KEYS for r in body["rows"] for c in r["cells"])


def test_evidence_dates_reasons_and_comments_never_appear(api: Api) -> None:
    s = api.session
    ecu = new_ecu(s, "TST-MARK")
    add_version(s, ecu, 1, "approved", "not_done", evidence=MARK_APPROVED)
    add_version(s, ecu, 2, "pending", "in_progress", evidence=MARK_PENDING)
    rejected = new_ecu(s, "TST-MARK-REJ")
    add_version(s, rejected, 1, "rejected", "done")
    draft = new_ecu(s, "TST-MARK-DRAFT")
    add_version(s, draft, 1, "draft", "in_progress", evidence=MARK_DRAFT)
    api.session.commit()
    text = api.get(URL, OEM_REVIEWER).text
    # 目印を入れた ECU の行が応答にある（空の応答で素通りしない）
    for part_no in ("TST-MARK", "TST-MARK-REJ", "TST-MARK-DRAFT"):
        assert f'"{part_no}"' in text
    for mark in (MARK_APPROVED, MARK_PENDING, MARK_DRAFT, MARK_REJECT, MARK_DATE.isoformat()):
        assert mark not in text
    # ダミーデータの差し戻しの理由・コメントの本文
    for reason in s.scalars(
        select(Assessment.reject_reason).where(Assessment.reject_reason.is_not(None))
    ):
        assert reason not in text
    for comment in s.scalars(select(Comment.body)):
        assert comment not in text


# ---- #8・#9 メーカー以外は読めない ----


@pytest.mark.parametrize("email", SUPPLIER_USERS)
def test_supplier_users_are_403_with_same_body(api: Api, email: str) -> None:
    res = api.get(URL, email)
    assert res.status_code == 403
    assert res.json() == {"detail": "この操作はできません"}
    for name in api.session.scalars(select(Ecu.name)):
        assert name not in res.text
    for name in api.session.scalars(select(Company.name)):
        assert name not in res.text


def odd_user(s: Session, company_email: str, role: str) -> User:
    """役割と会社の種類が食い違う利用者（DB の制約では防いでいない）をテストの中で作る。"""
    user = User(
        company_id=company_of(s, company_email).id,
        email=f"odd-{role}-{company_email}",
        password_hash=LOCKED_PASSWORD,
        role=role,
    )
    s.add(user)
    s.commit()
    return user


@pytest.mark.parametrize(
    ("company_email", "role"),
    [
        ("a-editor@example.com", "editor"),
        ("a-editor@example.com", "supplier_admin"),
        ("a-editor@example.com", "approver"),
        ("a-editor@example.com", "reviewer"),  # サプライヤの会社の確認者
        ("a-editor@example.com", "sys_admin"),  # サプライヤの会社のシステム管理者
    ],
)
def test_supplier_request_does_not_read_ecus_or_assessments(
    api: Api, company_email: str, role: str
) -> None:
    user = odd_user(api.session, company_email, role)
    # ヘッダーを記録の前に作る（テスト自身の SQL を記録に混ぜない）
    headers = {"X-Dev-User-Id": str(user.id)}
    # 読み込み済みの利用者・会社を捨て、API が DB を読む SQL を記録できるようにする
    api.session.expire_all()
    statements: list[str] = []
    bind = api.session.connection()

    def record(_conn, _cursor, statement, *_args) -> None:
        statements.append(statement)

    event.listen(bind, "before_cursor_execute", record)
    try:
        assert api.get(URL, headers=headers).status_code == 403
    finally:
        event.remove(bind, "before_cursor_execute", record)
    # API が出した SQL を記録できている（本人確認で users、会社の種類で companies を読む）
    assert any("FROM users" in sql for sql in statements)
    assert any("FROM companies" in sql for sql in statements)
    for sql in statements:
        assert "ecus" not in sql
        assert "assessment" not in sql


@pytest.mark.parametrize(
    ("company_email", "role"),
    [
        ("a-editor@example.com", "reviewer"),  # サプライヤの会社の確認者
        ("a-editor@example.com", "sys_admin"),  # サプライヤの会社のシステム管理者
        (OEM_REVIEWER, "editor"),  # メーカーの会社の入力者
        (OEM_REVIEWER, "approver"),
    ],
)
def test_role_and_company_type_must_both_be_oem(api: Api, company_email: str, role: str) -> None:
    """役割だけ・会社の種類だけでは通さない。"""
    user = odd_user(api.session, company_email, role)
    res = api.get(URL, headers={"X-Dev-User-Id": str(user.id)})
    assert res.status_code == 403


# ---- #10 問い合わせの値で範囲が変わらない ----


@pytest.mark.parametrize("query", ["?supplier_id={a}", "?company_id={a}", "?supplier_id=0"])
def test_query_parameters_do_not_change_rows(api: Api, query: str) -> None:
    whole = matrix(api)
    assert len(whole["rows"]) == 30  # 空の応答で素通りしない
    a = company_of(api.session, "a-editor@example.com").id
    res = api.get(URL + query.format(a=a), OEM_REVIEWER)
    assert res.status_code == 200
    assert res.json() == whole
