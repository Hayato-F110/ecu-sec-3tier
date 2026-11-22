"""ダミーデータのテスト（docs/test-plans/SC3-8.md の #15〜#19）。"""

from collections.abc import Iterator

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.orm import Session

from app.seed import seed

TABLES = [
    "companies",
    "users",
    "ecus",
    "measure_items",
    "assessments",
    "assessment_entries",
    "audit_logs",
    "comments",
    "comment_reads",
]


def counts(conn: Connection) -> dict[str, int]:
    return {
        t: conn.execute(text(f"SELECT count(*) FROM {t}")).scalar_one()  # noqa: S608
        for t in TABLES
    }


def scalar(conn: Connection, sql: str) -> int:
    return conn.execute(text(sql)).scalar_one()


def run_seed(conn: Connection) -> bool:
    """テストのトランザクションの中で投入する。commit は保存点の確定だけで、
    テストの終わりに外側のトランザクションごと取り消される（conftest.py の conn）。"""
    with Session(bind=conn, join_transaction_mode="create_savepoint") as session:
        inserted = seed(session)
        session.commit()
    return inserted


@pytest.fixture
def seeded(conn: Connection) -> Iterator[Connection]:
    assert run_seed(conn) is True
    yield conn


# ---- #15 件数 ----


def test_every_table_has_rows(seeded: Connection) -> None:
    empty = [t for t, n in counts(seeded).items() if n == 0]
    assert empty == []


def test_master_counts(seeded: Connection) -> None:
    c = seeded
    assert scalar(c, "SELECT count(*) FROM companies") == 5
    assert scalar(c, "SELECT count(*) FROM companies WHERE type = 'oem'") == 1
    assert scalar(c, "SELECT count(*) FROM companies WHERE type = 'supplier'") == 4
    assert scalar(c, "SELECT count(*) FROM ecus") == 30
    assert scalar(c, "SELECT count(*) FROM measure_items") == 10


# ---- #16 2回流しても増えない ----


def test_seed_twice_does_not_add_rows(seeded: Connection) -> None:
    before = counts(seeded)
    assert min(before.values()) > 0  # 空のまま比べて合格にしない
    assert run_seed(seeded) is False
    assert counts(seeded) == before


# ---- #17 架空の値だけ ----


def test_dummy_values_only(seeded: Connection) -> None:
    c = seeded
    assert scalar(c, "SELECT count(*) FROM users WHERE email NOT LIKE '%@example.com'") == 0
    assert scalar(c, "SELECT count(*) FROM users WHERE password_hash <> '!'") == 0
    assert scalar(c, "SELECT count(*) FROM ecus WHERE part_no NOT LIKE 'DMY-%'") == 0


# ---- #18 DB が守らない、表をまたぐ決まり ----

# それぞれ「決まりを破っている行の数」を数える SQL。すべて 0 であること
CROSS_TABLE_RULES = {
    "ECU はサプライヤに属する": """
        SELECT count(*) FROM ecus e JOIN companies c ON c.id = e.supplier_id
        WHERE c.type <> 'supplier'""",
    "ECU のないサプライヤはない": """
        SELECT count(*) FROM companies c
        WHERE c.type = 'supplier'
          AND NOT EXISTS (SELECT 1 FROM ecus e WHERE e.supplier_id = c.id)""",
    "役割と会社の種類が合う": """
        SELECT count(*) FROM users u JOIN companies c ON c.id = u.company_id
        WHERE (c.type = 'oem' AND u.role NOT IN ('sys_admin', 'reviewer'))
           OR (c.type = 'supplier' AND u.role NOT IN ('supplier_admin', 'editor', 'approver'))""",
    "申請者は ECU の会社の入力者": """
        SELECT count(*) FROM assessments a JOIN ecus e ON e.id = a.ecu_id
        JOIN users u ON u.id = a.submitted_by
        WHERE u.company_id <> e.supplier_id OR u.role <> 'editor'""",
    "承認者は ECU の会社の承認者で、申請者と別の人": """
        SELECT count(*) FROM assessments a JOIN ecus e ON e.id = a.ecu_id
        JOIN users u ON u.id = a.approved_by
        WHERE u.company_id <> e.supplier_id OR u.role <> 'approver'
           OR a.approved_by = a.submitted_by""",
    "確認者はメーカーの確認者": """
        SELECT count(*) FROM assessments a JOIN users u ON u.id = a.reviewed_by
        JOIN companies c ON c.id = u.company_id
        WHERE c.type <> 'oem' OR u.role <> 'reviewer'""",
    "コメントを書いた人はメーカーか ECU の会社": """
        SELECT count(*) FROM comments m JOIN assessments a ON a.id = m.assessment_id
        JOIN ecus e ON e.id = a.ecu_id JOIN users u ON u.id = m.author_id
        JOIN companies c ON c.id = u.company_id
        WHERE c.type <> 'oem' AND u.company_id <> e.supplier_id""",
    "既読の人はメーカーか ECU の会社": """
        SELECT count(*) FROM comment_reads r JOIN comments m ON m.id = r.comment_id
        JOIN assessments a ON a.id = m.assessment_id JOIN ecus e ON e.id = a.ecu_id
        JOIN users u ON u.id = r.user_id JOIN companies c ON c.id = u.company_id
        WHERE c.type <> 'oem' AND u.company_id <> e.supplier_id""",
}


@pytest.mark.parametrize("rule", list(CROSS_TABLE_RULES))
def test_cross_table_rules(seeded: Connection, rule: str) -> None:
    assert scalar(seeded, CROSS_TABLE_RULES[rule]) == 0


# ---- #19 他社のテストの材料 ----


def test_at_least_two_suppliers_have_every_status(seeded: Connection) -> None:
    n = scalar(
        seeded,
        """
        SELECT count(*) FROM (
          SELECT e.supplier_id FROM assessments a JOIN ecus e ON e.id = a.ecu_id
          GROUP BY e.supplier_id
          HAVING count(DISTINCT a.status) = 4
        ) s""",
    )
    assert n >= 2
