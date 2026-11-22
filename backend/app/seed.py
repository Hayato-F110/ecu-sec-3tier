"""ダミーデータの投入。すべて架空（実在の会社・ECU・対策の情報は含まない）。

使い方（backend で）：uv run python -m app.seed
- 乱数の種を固定しているので、何度作り直しても同じデータになる
- 会社が1件でもあれば何もしない（2回流しても増えない）
- パスワードは Day 6（bcrypt）まで「!」（ログインできない印）。平文のパスワードを置かない
- メールは example.com（例示専用に予約されたドメイン）、IP は 192.0.2.0/24（文書用に予約された範囲）
"""

import random
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    Assessment,
    AssessmentEntry,
    AuditLog,
    Comment,
    CommentRead,
    Company,
    Ecu,
    MeasureItem,
    User,
)

SEED = 2026
# パスワードではなく「ログインできない」印
LOCKED_PASSWORD = "!"  # noqa: S105
START = datetime(2026, 11, 1, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))

MEASURE_ITEMS = [
    (
        "SECURE_BOOT",
        "セキュアブート",
        "起動時にソフトの署名を確かめ、改ざんされたソフトを動かさない",
    ),
    (
        "SECOC",
        "メッセージ認証（SecOC）",
        "車内ネットワークのメッセージに認証子を付け、なりすましを防ぐ",
    ),
    ("DEBUG_PORT", "デバッグポートの無効化", "出荷品で JTAG などのデバッグ用の口を閉じる"),
    ("KEY_MGMT", "鍵管理", "鍵を安全な領域に置き、書き込み・更新の手順を決める"),
    ("UPDATE_SIG", "更新ソフトの署名検証", "書き換えるソフトの署名を確かめてから更新する"),
    ("VULN_MON", "脆弱性の監視", "使っている部品の脆弱性情報を集めて評価する"),
    ("DIAG_AUTH", "診断アクセスの認証", "診断機からの書き換え・読み出しの前に認証する"),
    ("IDS", "侵入検知", "車内ネットワークの異常な通信を見つけて記録する"),
    ("SEC_LOG", "セキュリティログ", "セキュリティに関わる出来事を記録し、改ざんを防ぐ"),
    ("CRYPTO", "暗号の実装", "推奨される暗号の方式と鍵の長さを使う"),
]
ECU_NAMES = [
    "ゲートウェイ",
    "ボディ制御",
    "パワートレイン制御",
    "ブレーキ制御",
    "ステアリング制御",
    "メーター",
    "車載情報機器",
    "テレマティクス",
    "運転支援",
    "バッテリー管理",
]
VEHICLE_MODELS = ["架空車 Alpha", "架空車 Beta", "架空車 Gamma"]
SUPPLIER_LETTERS = ["a", "b", "c", "d"]
ECUS_PER_SUPPLIER = [8, 8, 7, 7]  # 合計 30
ENTRY_STATUSES = ["done", "done", "done", "in_progress", "not_done", "not_applicable"]


@dataclass
class SupplierUsers:
    company: Company
    admin: User
    editor: User
    approver: User


class Clock:
    """作成日時を少しずつ進める（同じ時刻ばかりにしない）。"""

    def __init__(self) -> None:
        self.now = START

    def tick(self, minutes: int = 37) -> datetime:
        self.now += timedelta(minutes=minutes)
        return self.now


def new_user(company: Company, prefix: str, role: str) -> User:
    return User(
        company_id=company.id,
        email=f"{prefix}-{role}@example.com",
        password_hash=LOCKED_PASSWORD,
        role=role,
    )


def seed(session: Session) -> bool:
    """ダミーデータを入れる。入れたら True、すでにデータがあれば何もせず False。"""
    if session.scalar(select(func.count()).select_from(Company)):
        return False

    # 暗号用ではない。毎回同じ並びにするため
    rng = random.Random(SEED)  # noqa: S311
    clock = Clock()

    oem = Company(name="架空自動車 株式会社", type="oem")
    session.add(oem)
    session.flush()
    oem_admin = new_user(oem, "oem", "sys_admin")
    reviewer = new_user(oem, "oem", "reviewer")
    session.add_all([oem_admin, reviewer])

    items = [
        MeasureItem(code=code, title=title, description=desc, sort_order=n)
        for n, (code, title, desc) in enumerate(MEASURE_ITEMS, start=1)
    ]
    session.add_all(items)

    suppliers: list[SupplierUsers] = []
    for letter in SUPPLIER_LETTERS:
        company = Company(name=f"架空電装 {letter.upper()} 社", type="supplier")
        session.add(company)
        session.flush()
        su = SupplierUsers(
            company,
            new_user(company, letter, "supplier_admin"),
            new_user(company, letter, "editor"),
            new_user(company, letter, "approver"),
        )
        session.add_all([su.admin, su.editor, su.approver])
        suppliers.append(su)
    session.flush()

    for su, letter, count in zip(suppliers, SUPPLIER_LETTERS, ECUS_PER_SUPPLIER, strict=True):
        for i in range(count):
            ecu = Ecu(
                supplier_id=su.company.id,
                name=ECU_NAMES[i % len(ECU_NAMES)],
                part_no=f"DMY-{letter.upper()}{i + 1:03d}",
                vehicle_model=VEHICLE_MODELS[i % len(VEHICLE_MODELS)],
            )
            session.add(ecu)
            session.flush()
            add_history(session, rng, clock, ecu, su, reviewer, items, pattern=i % 4)

    session.flush()
    return True


def add_history(
    session: Session,
    rng: random.Random,
    clock: Clock,
    ecu: Ecu,
    su: SupplierUsers,
    reviewer: User,
    items: list[MeasureItem],
    pattern: int,
) -> None:
    """ECU ごとの版の履歴。pattern で、どの状態の版を作るかを変える。
    0：承認済み（未確認）
    1：承認済み（確認完了、質問と回答あり）→ 新しい版が承認待ち
    2：承認済み（修正依頼中）→ 新しい版が差し戻し
    3：下書きだけ
    """
    if pattern == 3:
        draft = Assessment(ecu_id=ecu.id, version=1, status="draft")
        add_version(session, rng, draft, items)
        return

    # 出来事は「申請 → 承認 → コメント → 確認 → 次の版の申請」の順。
    # 監査ログの日時は、その出来事の日時（submitted_at など）をそのまま使う
    v1 = approved_version(clock, ecu, su)
    add_version(session, rng, v1, items)
    audit(session, su.editor, "submit", f"assessment:{v1.id}", v1.submitted_at)
    audit(session, su.approver, "approve", f"assessment:{v1.id}", v1.approved_at)

    if pattern == 0:
        return

    if pattern == 1:
        question = add_comment(session, clock, v1, reviewer, "question", items[0])
        answer = add_comment(session, clock, v1, su.approver, "answer", items[0], question)
        session.add_all(
            [
                CommentRead(user_id=su.approver.id, comment_id=question.id, read_at=clock.tick()),
                CommentRead(user_id=reviewer.id, comment_id=answer.id, read_at=clock.tick()),
            ]
        )
        review(session, clock, v1, reviewer, "confirmed")
        v2 = Assessment(
            ecu_id=ecu.id,
            version=2,
            status="pending",
            submitted_by=su.editor.id,
            submitted_at=clock.tick(),
        )
        add_version(session, rng, v2, items)
        audit(session, su.editor, "submit", f"assessment:{v2.id}", v2.submitted_at)
    else:
        request = add_comment(session, clock, v1, reviewer, "change_request", items[1])
        session.add(CommentRead(user_id=su.editor.id, comment_id=request.id, read_at=clock.tick()))
        review(session, clock, v1, reviewer, "change_requested")
        v2 = Assessment(
            ecu_id=ecu.id,
            version=2,
            status="rejected",
            submitted_by=su.editor.id,
            submitted_at=clock.tick(),
            reject_reason="（ダミー）根拠の説明が足りないため差し戻します",
        )
        add_version(session, rng, v2, items)
        audit(session, su.editor, "submit", f"assessment:{v2.id}", v2.submitted_at)
        audit(session, su.approver, "reject", f"assessment:{v2.id}", clock.tick())


def review(session: Session, clock: Clock, version: Assessment, reviewer: User, status: str):
    """メーカーの確認者が、確認完了か修正依頼を記録する。"""
    version.review_status = status
    version.reviewed_by = reviewer.id
    version.reviewed_at = clock.tick()
    action = "confirm" if status == "confirmed" else "request_change"
    audit(session, reviewer, action, f"assessment:{version.id}", version.reviewed_at)


def approved_version(clock: Clock, ecu: Ecu, su: SupplierUsers) -> Assessment:
    return Assessment(
        ecu_id=ecu.id,
        version=1,
        status="approved",
        submitted_by=su.editor.id,
        submitted_at=clock.tick(),
        approved_by=su.approver.id,
        approved_at=clock.tick(),
        review_status="unreviewed",
    )


def add_version(
    session: Session, rng: random.Random, version: Assessment, items: list[MeasureItem]
) -> None:
    session.add(version)
    session.flush()
    for item in items:
        status = rng.choice(ENTRY_STATUSES)
        planned = None
        if status in ("in_progress", "not_done"):
            planned = date(2027, 1, 1) + timedelta(days=rng.randrange(0, 180))
        session.add(
            AssessmentEntry(
                assessment_id=version.id,
                item_id=item.id,
                status=status,
                evidence=f"（ダミー）{item.title}の対応状況の説明",
                planned_date=planned,
            )
        )


def add_comment(
    session: Session,
    clock: Clock,
    version: Assessment,
    author: User,
    kind: str,
    item: MeasureItem,
    parent: Comment | None = None,
) -> Comment:
    body = {
        "question": f"（ダミー）{item.title}の根拠の資料を教えてください",
        "answer": "（ダミー）設計書の該当の節を追記しました",
        "change_request": f"（ダミー）{item.title}の対応予定日を見直してください",
    }[kind]
    comment = Comment(
        assessment_id=version.id,
        item_id=item.id,
        parent_id=parent.id if parent else None,
        author_id=author.id,
        kind=kind,
        body=body,
        created_at=clock.tick(),
    )
    session.add(comment)
    session.flush()
    # コメントも監査ログに残す（守りの決まり5）
    audit(session, author, f"comment_{kind}", f"comment:{comment.id}", comment.created_at)
    return comment


def audit(session: Session, user: User, action: str, target: str, at: datetime | None) -> None:
    session.add(
        AuditLog(
            user_id=user.id,
            action=action,
            target=target,
            ip=f"192.0.2.{user.id % 250 + 1}",
            created_at=at,
        )
    )


def main() -> None:
    from app.db import make_engine

    engine = make_engine()
    with Session(engine) as session, session.begin():
        inserted = seed(session)
    print("ダミーデータを入れた" if inserted else "データがすでにあるので何もしなかった")
    engine.dispose()


if __name__ == "__main__":
    main()
