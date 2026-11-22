"""DB の制約のテスト（docs/test-plans/SC3-8.md の #5〜#14）。

API の検証（Day 7・8）に穴があっても、DB が最後の守りになることを確かめる。
- テーブルは Alembic の変更履歴で作ったもの（conftest.py）。モデルからは作らない
- モデルを通さず SQL で直接入れる
- 失敗は「期待した名前の制約」で起きたかまで確かめる（NOT NULL など別の理由の失敗で合格にしない）
- 失敗のテストには、正しい値なら入るテストを並べる
"""

from dataclasses import dataclass
from typing import Any

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.exc import IntegrityError

FULL_WIDTH_SPACE = "　"
# 見えない空白：ノーブレークスペース、ゼロ幅スペース・非接合子・接合子、単語結合子、BOM
INVISIBLE = [" ", "​", "‌", "‍", "⁠", "﻿"]


@dataclass
class Base:
    oem: int
    supplier: int
    reviewer: int
    editor: int
    approver: int
    ecu: int
    item: int
    item2: int


def insert(conn: Connection, sql: str, **params: Any) -> int:
    return conn.execute(text(sql + " RETURNING id"), params).scalar_one()


def violates(conn: Connection, constraint: str, sql: str, **params: Any) -> None:
    """名前が constraint の制約に違反して失敗することを確かめる。
    外側のトランザクションを続けられるよう、途中の保存点（SAVEPOINT）で包む。"""
    with pytest.raises(IntegrityError) as err, conn.begin_nested():
        conn.execute(text(sql), params)
    assert err.value.orig is not None
    assert err.value.orig.diag.constraint_name == constraint  # type: ignore[attr-defined]


USER = "INSERT INTO users (company_id, email, password_hash, role) VALUES (:c, :e, '!', :r)"


def add_user(conn: Connection, company: int, email: str, role: str) -> int:
    return insert(conn, USER, c=company, e=email, r=role)


@pytest.fixture
def base(conn: Connection) -> Base:
    oem = insert(conn, "INSERT INTO companies (name, type) VALUES ('架空自動車', 'oem')")
    sup = insert(conn, "INSERT INTO companies (name, type) VALUES ('架空電装', 'supplier')")
    reviewer = add_user(conn, oem, "reviewer@example.com", "reviewer")
    editor = add_user(conn, sup, "editor@example.com", "editor")
    approver = add_user(conn, sup, "approver@example.com", "approver")
    ecu = insert(
        conn,
        "INSERT INTO ecus (supplier_id, name, part_no, vehicle_model)"
        " VALUES (:s, 'ゲートウェイ', 'DMY-0001', '架空車A')",
        s=sup,
    )
    item_sql = (
        "INSERT INTO measure_items (code, title, description, sort_order)"
        " VALUES (:code, :title, '説明', :n)"
    )
    item = insert(conn, item_sql, code="SB", title="セキュアブート", n=1)
    item2 = insert(conn, item_sql, code="SECOC", title="メッセージ認証", n=2)
    return Base(oem, sup, reviewer, editor, approver, ecu, item, item2)


# ---- 版（assessments） ----

ASSESSMENT = (
    "INSERT INTO assessments (ecu_id, version, status, submitted_by, submitted_at,"
    " approved_by, approved_at, reject_reason, review_status, reviewed_by, reviewed_at)"
    " VALUES (:ecu, :version, :status, :submitted_by, :submitted_at,"
    " :approved_by, :approved_at, :reject_reason, :review_status, :reviewed_by, :reviewed_at)"
)
NOW = "2026-11-22T10:00:00+09:00"


def version_row(b: Base, version: int = 1, status: str = "draft", **override: Any) -> dict:
    """状態ごとに、制約を満たす正しい行を作る。override で1か所だけ壊す。"""
    row: dict[str, Any] = {
        "ecu": b.ecu,
        "version": version,
        "status": status,
        "submitted_by": None,
        "submitted_at": None,
        "approved_by": None,
        "approved_at": None,
        "reject_reason": None,
        "review_status": None,
        "reviewed_by": None,
        "reviewed_at": None,
    }
    if status in ("pending", "rejected", "approved"):
        row |= {"submitted_by": b.editor, "submitted_at": NOW}
    if status == "rejected":
        row |= {"reject_reason": "根拠が不足"}
    if status == "approved":
        row |= {"approved_by": b.approver, "approved_at": NOW, "review_status": "unreviewed"}
    return row | override


def add_version(conn: Connection, b: Base, version: int = 1, status: str = "draft", **o: Any):
    return insert(conn, ASSESSMENT, **version_row(b, version, status, **o))


@pytest.mark.parametrize("status", ["draft", "pending", "rejected", "approved"])
def test_valid_version_rows_are_accepted(conn: Connection, base: Base, status: str) -> None:
    add_version(conn, base, 1, status)


def test_same_version_twice_fails(conn: Connection, base: Base) -> None:
    add_version(conn, base, 1, "approved")
    violates(conn, "uq_assessments_ecu_version", ASSESSMENT, **version_row(base, 1, "approved"))


def test_version_must_be_positive(conn: Connection, base: Base) -> None:
    violates(conn, "ck_assessments_version_positive", ASSESSMENT, **version_row(base, 0))


@pytest.mark.parametrize("second", ["draft", "pending", "rejected"])
@pytest.mark.parametrize("first", ["draft", "pending", "rejected"])
def test_only_one_open_version_per_ecu(
    conn: Connection, base: Base, first: str, second: str
) -> None:
    add_version(conn, base, 1, first)
    violates(conn, "uq_assessments_one_open_per_ecu", ASSESSMENT, **version_row(base, 2, second))


def test_many_approved_versions_and_one_open_is_ok(conn: Connection, base: Base) -> None:
    add_version(conn, base, 1, "approved")
    add_version(conn, base, 2, "approved")
    add_version(conn, base, 3, "draft")


# 職務分離（#7）


def test_submitter_cannot_approve_own_version(conn: Connection, base: Base) -> None:
    row = version_row(base, 1, "approved", approved_by=base.editor)
    violates(conn, "ck_assessments_separation_of_duties", ASSESSMENT, **row)


def test_submitter_cannot_approve_own_version_by_update(conn: Connection, base: Base) -> None:
    a = add_version(conn, base, 1, "pending")
    violates(
        conn,
        "ck_assessments_separation_of_duties",
        "UPDATE assessments SET status = 'approved', approved_by = submitted_by,"
        " approved_at = now(), review_status = 'unreviewed' WHERE id = :id",
        id=a,
    )


@pytest.mark.parametrize("column", ["approved_by", "approved_at", "review_status"])
def test_approved_requires_approval_fields(conn: Connection, base: Base, column: str) -> None:
    """承認者を空にして職務分離の制約をすり抜けられないこと。"""
    row = version_row(base, 1, "approved", **{column: None})
    violates(conn, "ck_assessments_approved_fields", ASSESSMENT, **row)


@pytest.mark.parametrize("status", ["pending", "rejected", "approved"])
@pytest.mark.parametrize("column", ["submitted_by", "submitted_at"])
def test_submitted_states_require_submitter(
    conn: Connection, base: Base, status: str, column: str
) -> None:
    row = version_row(base, 1, status, **{column: None})
    violates(conn, "ck_assessments_submitted_fields", ASSESSMENT, **row)


@pytest.mark.parametrize("status", ["draft", "pending", "rejected"])
@pytest.mark.parametrize(
    "fields",
    [
        {"approved_by": "approver"},
        {"approved_at": NOW},
        {"review_status": "unreviewed"},
    ],
)
def test_approval_fields_only_on_approved(
    conn: Connection, base: Base, status: str, fields: dict
) -> None:
    if fields.get("approved_by") == "approver":
        fields = {"approved_by": base.approver}
    row = version_row(base, 1, status, **fields)
    violates(conn, "ck_assessments_approved_fields", ASSESSMENT, **row)


# 差し戻しの理由（#8）


@pytest.mark.parametrize(
    "reason", [None, "", "   ", FULL_WIDTH_SPACE * 2, " \t\n", *INVISIBLE, "​ 　﻿"]
)
def test_reject_requires_reason(conn: Connection, base: Base, reason: str | None) -> None:
    row = version_row(base, 1, "rejected", reject_reason=reason)
    violates(conn, "ck_assessments_reject_reason", ASSESSMENT, **row)


def test_reject_with_reason_is_ok(conn: Connection, base: Base) -> None:
    add_version(conn, base, 1, "rejected", reject_reason=f"{FULL_WIDTH_SPACE}根拠が不足")


# 確認状況（#9）


@pytest.mark.parametrize("review", ["confirmed", "change_requested"])
def test_reviewed_states_require_reviewer(conn: Connection, base: Base, review: str) -> None:
    add_version(
        conn, base, 1, "approved", review_status=review, reviewed_by=base.reviewer, reviewed_at=NOW
    )
    for column in ("reviewed_by", "reviewed_at"):
        fields = {"review_status": review, "reviewed_by": base.reviewer, "reviewed_at": NOW}
        row = version_row(base, 2, "approved", **(fields | {column: None}))
        violates(conn, "ck_assessments_reviewed_fields", ASSESSMENT, **row)


@pytest.mark.parametrize("status", ["draft", "pending", "rejected"])
@pytest.mark.parametrize(
    "fields",
    [{"reviewed_by": True, "reviewed_at": NOW}, {"reviewed_by": True}, {"reviewed_at": NOW}],
)
def test_unapproved_has_no_reviewer(
    conn: Connection, base: Base, status: str, fields: dict
) -> None:
    """確認状況が空（承認済みでない）の版に、確認者・確認日時を入れられないこと。
    （1回目のレビューの指摘：NULL のため CHECK が働かなかった）"""
    if "reviewed_by" in fields:
        fields = fields | {"reviewed_by": base.reviewer}
    row = version_row(base, 1, status, **fields)
    violates(conn, "ck_assessments_reviewed_fields", ASSESSMENT, **row)


def test_unreviewed_has_no_reviewer(conn: Connection, base: Base) -> None:
    row = version_row(base, 1, "approved", reviewed_by=base.reviewer, reviewed_at=NOW)
    violates(conn, "ck_assessments_reviewed_fields", ASSESSMENT, **row)


# ---- 決められた値（#10） ----

VALID_VALUES = {
    "assessments.status": ["draft", "pending", "rejected", "approved"],
    "assessments.review_status": ["unreviewed", "confirmed", "change_requested"],
    "assessment_entries.status": ["done", "in_progress", "not_done", "not_applicable"],
    "comments.kind": ["question", "answer", "change_request"],
    "companies.type": ["oem", "supplier"],
    "users.role": ["sys_admin", "reviewer", "supplier_admin", "editor", "approver"],
}
UNKNOWN = "unknown_value"


def put_value(conn: Connection, b: Base, target: str, value: str) -> None:
    """target の列に value を入れる行を1つ作る（ほかの列は正しい値）。"""
    match target:
        case "assessments.status":
            if value in VALID_VALUES[target]:
                add_version(conn, b, 1, value)
            else:
                insert(conn, ASSESSMENT, **(version_row(b, 1, "draft") | {"status": value}))
        case "assessments.review_status":
            reviewed = value in ("confirmed", "change_requested")
            add_version(
                conn,
                b,
                1,
                "approved",
                review_status=value,
                reviewed_by=b.reviewer if reviewed else None,
                reviewed_at=NOW if reviewed else None,
            )
        case "assessment_entries.status":
            a = add_version(conn, b, 1, "draft")
            insert(
                conn,
                "INSERT INTO assessment_entries (assessment_id, item_id, status, evidence)"
                " VALUES (:a, :i, :s, '根拠')",
                a=a,
                i=b.item,
                s=value,
            )
        case "comments.kind":
            a = add_version(conn, b, 1, "approved")
            parent = None
            if value == "answer":
                parent = insert(
                    conn,
                    "INSERT INTO comments (assessment_id, author_id, kind, body)"
                    " VALUES (:a, :u, 'question', '質問')",
                    a=a,
                    u=b.reviewer,
                )
            insert(
                conn,
                "INSERT INTO comments (assessment_id, parent_id, author_id, kind, body)"
                " VALUES (:a, :p, :u, :k, '本文')",
                a=a,
                p=parent,
                u=b.approver,
                k=value,
            )
        case "companies.type":
            insert(conn, "INSERT INTO companies (name, type) VALUES ('架空', :t)", t=value)
        case "users.role":
            add_user(conn, b.supplier, "x@example.com", value)


@pytest.mark.parametrize(
    ("target", "value"), [(t, v) for t, values in VALID_VALUES.items() for v in values]
)
def test_valid_values_are_accepted(conn: Connection, base: Base, target: str, value: str) -> None:
    put_value(conn, base, target, value)


CHECK_NAME = {
    "assessments.status": "ck_assessments_status",
    "assessments.review_status": "ck_assessments_review_status",
    "assessment_entries.status": "ck_assessment_entries_status",
    "comments.kind": "ck_comments_kind",
    "companies.type": "ck_companies_type",
    "users.role": "ck_users_role",
}


@pytest.mark.parametrize("target", list(VALID_VALUES))
def test_unknown_values_are_rejected(conn: Connection, base: Base, target: str) -> None:
    with pytest.raises(IntegrityError) as err, conn.begin_nested():
        put_value(conn, base, target, UNKNOWN)
    assert err.value.orig.diag.constraint_name == CHECK_NAME[target]  # type: ignore[union-attr]


# ---- 入力（#11） ----

ENTRY = (
    "INSERT INTO assessment_entries (assessment_id, item_id, status, evidence, planned_date)"
    " VALUES (:a, :i, :s, '根拠', :d)"
)


@pytest.mark.parametrize("status", ["done", "not_applicable"])
def test_finished_entry_has_no_planned_date(conn: Connection, base: Base, status: str) -> None:
    a = add_version(conn, base)
    violates(
        conn,
        "ck_assessment_entries_planned_date",
        ENTRY,
        a=a,
        i=base.item,
        s=status,
        d="2027-01-31",
    )


@pytest.mark.parametrize("status", ["in_progress", "not_done"])
def test_unfinished_entry_can_have_planned_date(conn: Connection, base: Base, status: str) -> None:
    a = add_version(conn, base)
    conn.execute(text(ENTRY), {"a": a, "i": base.item, "s": status, "d": "2027-01-31"})


# ---- コメント（#12） ----

COMMENT = (
    "INSERT INTO comments (assessment_id, parent_id, author_id, kind, body)"
    " VALUES (:a, :p, :u, :k, :b)"
)


def add_comment(conn: Connection, a: int, u: int, kind: str, parent: int | None = None) -> int:
    return insert(conn, COMMENT, a=a, p=parent, u=u, k=kind, b="本文")


@pytest.mark.parametrize("body", ["", "  ", FULL_WIDTH_SPACE, "\n", *INVISIBLE])
def test_blank_comment_is_rejected(conn: Connection, base: Base, body: str) -> None:
    a = add_version(conn, base, 1, "approved")
    violates(conn, "ck_comments_body", COMMENT, a=a, p=None, u=base.reviewer, k="question", b=body)


def test_answer_requires_parent(conn: Connection, base: Base) -> None:
    a = add_version(conn, base, 1, "approved")
    violates(
        conn, "ck_comments_parent", COMMENT, a=a, p=None, u=base.approver, k="answer", b="回答"
    )


@pytest.mark.parametrize("kind", ["question", "change_request"])
def test_question_has_no_parent(conn: Connection, base: Base, kind: str) -> None:
    a = add_version(conn, base, 1, "approved")
    q = add_comment(conn, a, base.reviewer, "question")
    violates(conn, "ck_comments_parent", COMMENT, a=a, p=q, u=base.reviewer, k=kind, b="本文")


def test_answer_parent_must_be_in_same_version(conn: Connection, base: Base) -> None:
    a1 = add_version(conn, base, 1, "approved")
    a2 = add_version(conn, base, 2, "approved")
    q = add_comment(conn, a1, base.reviewer, "question")
    add_comment(conn, a1, base.approver, "answer", parent=q)  # 同じ版なら入る
    violates(
        conn,
        "fk_comments_parent_same_assessment",
        COMMENT,
        a=a2,
        p=q,
        u=base.approver,
        k="answer",
        b="回答",
    )


# ---- 一意・既定値（#13） ----


def test_email_is_unique_ignoring_case(conn: Connection, base: Base) -> None:
    violates(
        conn, "uq_users_email_lower", USER, c=base.supplier, e="Editor@Example.COM", r="approver"
    )


def test_is_active_defaults_to_true(conn: Connection, base: Base) -> None:
    value = conn.execute(text("SELECT is_active FROM users WHERE id = :id"), {"id": base.editor})
    assert value.scalar_one() is True


def test_duplicate_item_code_fails(conn: Connection, base: Base) -> None:
    violates(
        conn,
        "uq_measure_items_code",
        "INSERT INTO measure_items (code, title, description, sort_order)"
        " VALUES ('SB', '別', '', 3)",
    )


def test_duplicate_entry_for_same_item_fails(conn: Connection, base: Base) -> None:
    a = add_version(conn, base)
    conn.execute(text(ENTRY), {"a": a, "i": base.item, "s": "done", "d": None})
    conn.execute(text(ENTRY), {"a": a, "i": base.item2, "s": "done", "d": None})  # 別の項目は入る
    violates(conn, "uq_assessment_entries_item", ENTRY, a=a, i=base.item, s="done", d=None)


def test_duplicate_comment_read_fails(conn: Connection, base: Base) -> None:
    a = add_version(conn, base, 1, "approved")
    c = add_comment(conn, a, base.reviewer, "question")
    sql = "INSERT INTO comment_reads (user_id, comment_id) VALUES (:u, :c)"
    conn.execute(text(sql), {"u": base.editor, "c": c})
    violates(conn, "pk_comment_reads", sql, u=base.editor, c=c)


# ---- 消せない（#14） ----

DELETE = {
    "companies": "DELETE FROM companies WHERE id = :id",
    "ecus": "DELETE FROM ecus WHERE id = :id",
    "users": "DELETE FROM users WHERE id = :id",
}


@pytest.mark.parametrize("table", list(DELETE))
def test_cannot_delete_rows_with_history(conn: Connection, base: Base, table: str) -> None:
    add_version(conn, base, 1, "approved")
    target = {"companies": base.supplier, "ecus": base.ecu, "users": base.editor}[table]
    # 会社はユーザーと ECU の両方から参照されるので、どの外部キーで止まるかは決めない。
    # 「その表を参照する外部キー」で止まったことだけを確かめる
    with pytest.raises(IntegrityError) as err, conn.begin_nested():
        conn.execute(text(DELETE[table]), {"id": target})
    name = err.value.orig.diag.constraint_name  # type: ignore[union-attr]
    assert name.startswith("fk_") and name.endswith(f"_{table}")
