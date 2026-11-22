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


# ---- 監査ログ（守りの決まり5：すべての状態変更とコメントを残す） ----


def test_every_comment_has_audit_log(seeded: Connection) -> None:
    missing = scalar(
        seeded,
        """
        SELECT count(*) FROM comments m
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_logs l
          WHERE l.target = 'comment:' || m.id AND l.user_id = m.author_id
        )""",
    )
    assert missing == 0


def test_every_state_change_has_audit_log(seeded: Connection) -> None:
    """申請・承認・確認の各日時に、同じ人・同じ日時の監査ログがある。
    （差し戻しには日時の列がないので、ここでは確かめない）"""
    missing = scalar(
        seeded,
        """
        SELECT count(*) FROM assessments a, LATERAL (VALUES
            ('submit', a.submitted_by, a.submitted_at),
            ('approve', a.approved_by, a.approved_at),
            (CASE a.review_status WHEN 'confirmed' THEN 'confirm'
                                  WHEN 'change_requested' THEN 'request_change' END,
             a.reviewed_by, a.reviewed_at)
          ) AS e(action, who, at)
        WHERE e.who IS NOT NULL AND e.at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs l
            WHERE l.target = 'assessment:' || a.id AND l.user_id = e.who
              AND l.created_at = e.at AND l.action = e.action)""",
    )
    assert missing == 0


def test_comment_audit_logs_name_the_kind(seeded: Connection) -> None:
    wrong = scalar(
        seeded,
        """
        SELECT count(*) FROM comments m JOIN audit_logs l ON l.target = 'comment:' || m.id
        WHERE l.action <> 'comment_' || m.kind OR l.created_at <> m.created_at""",
    )
    assert wrong == 0


def test_audit_logs_follow_event_order(seeded: Connection) -> None:
    """出来事の日時が、申請 → 承認 → コメント → 確認 → 次の版の申請の順になっている
    （テストの一覧 #21）。監査ログの日時は出来事の日時と同じ（上のテストで確かめる）。"""
    wrong = scalar(
        seeded,
        """
        SELECT count(*) FROM assessments a
        WHERE a.submitted_at >= a.approved_at
           OR a.approved_at >= a.reviewed_at
           -- コメントは承認のあと、確認の前
           OR EXISTS (
             SELECT 1 FROM comments m
             WHERE m.assessment_id = a.id
               AND (m.created_at <= a.approved_at OR m.created_at >= a.reviewed_at))
           -- 回答は質問のあと
           OR EXISTS (
             SELECT 1 FROM comments ans JOIN comments q ON q.id = ans.parent_id
             WHERE ans.assessment_id = a.id AND ans.created_at <= q.created_at)
           -- 次の版の申請は、前の版の確認のあと
           OR EXISTS (
             SELECT 1 FROM assessments nxt
             WHERE nxt.ecu_id = a.ecu_id AND nxt.version = a.version + 1
               AND nxt.submitted_at <= a.reviewed_at)""",
    )
    assert wrong == 0


def test_audit_requires_time() -> None:
    """監査ログの日時を空にすると、NULL を入れる前に止まる。"""
    from app.models import User
    from app.seed import audit

    with pytest.raises(ValueError, match="監査ログの日時が空"):
        audit(Session(), User(id=1), "submit", "assessment:1", None)


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
