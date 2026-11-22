"""9つのテーブルの定義（docs/spec.md「データ（テーブル）」）。

DB の制約は二重の守り。同じ決まりを API でも守る（Phase 4 の DynamoDB には制約がないため）。
決まりの一覧と、DB では守らず API で守るものは docs/test-plans/SC3-8.md。

状態の値は PostgreSQL の ENUM 型ではなく、文字列＋CHECK 制約にする
（ENUM 型は値を足すのに別の手順が要り、DynamoDB へもそのまま移せないため）。
"""

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# 制約の名前の付け方。名前があると、エラーでどの決まりに違反したかが分かり、
# Alembic で制約を消す・変えるときにも名前で指定できる
NAMING = {
    "pk": "pk_%(table_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ix": "ix_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
}

# 決められた値（テストの VALID_VALUES と同じ）
COMPANY_TYPES = ("oem", "supplier")
ROLES = ("sys_admin", "reviewer", "supplier_admin", "editor", "approver")
ASSESSMENT_STATUSES = ("draft", "pending", "rejected", "approved")
OPEN_STATUSES = ("draft", "pending", "rejected")  # 作業中（ECU ごとに1つまで）
REVIEW_STATUSES = ("unreviewed", "confirmed", "change_requested")
ENTRY_STATUSES = ("done", "in_progress", "not_done", "not_applicable")
COMMENT_KINDS = ("question", "answer", "change_request")

# 空白（半角・全角）以外の文字が1つ以上ある。PostgreSQL の正規表現
NOT_BLANK = "~ '[^[:space:]　]'"


def one_of(column: str, values: tuple[str, ...]) -> str:
    listed = ", ".join(f"'{v}'" for v in values)
    return f"{column} IN ({listed})"


def restrict(target: str) -> ForeignKey:
    """参照されている行は消せない外部キー（履歴・監査ログが連鎖で消えないように）。"""
    return ForeignKey(target, ondelete="RESTRICT")


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


class Company(Base):
    __tablename__ = "companies"
    __table_args__ = (CheckConstraint(one_of("type", COMPANY_TYPES), name="type"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    type: Mapped[str] = mapped_column(String(20))


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(one_of("role", ROLES), name="role"),
        # 大文字・小文字を区別せずに一意（Foo@example.com と foo@example.com を別の人にしない）
        Index("uq_users_email_lower", func.lower(text("email")), unique=True),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    company_id: Mapped[int] = mapped_column(restrict("companies.id"), index=True)
    email: Mapped[str] = mapped_column(String(254))
    # Day 6 から bcrypt のハッシュ。それまでは「!」（ログインできない印）
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20))
    is_active: Mapped[bool] = mapped_column(server_default=text("true"))


class Ecu(Base):
    __tablename__ = "ecus"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # 会社ごとのデータ分離の起点（Day 7 の絞り込みはこの列を使う）
    supplier_id: Mapped[int] = mapped_column(restrict("companies.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    part_no: Mapped[str] = mapped_column(String(50))
    vehicle_model: Mapped[str] = mapped_column(String(100))


class MeasureItem(Base):
    __tablename__ = "measure_items"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    code: Mapped[str] = mapped_column(String(30), unique=True)
    title: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer)


class Assessment(Base):
    """申請の単位（版）。承認済みの版は書き換えず、更新は新しい版を作る。"""

    __tablename__ = "assessments"
    __table_args__ = (
        UniqueConstraint("ecu_id", "version", name="uq_assessments_ecu_version"),
        CheckConstraint("version >= 1", name="version_positive"),
        CheckConstraint(one_of("status", ASSESSMENT_STATUSES), name="status"),
        CheckConstraint(
            f"review_status IS NULL OR {one_of('review_status', REVIEW_STATUSES)}",
            name="review_status",
        ),
        # 申請したあとの状態は、申請者と申請日時が必須
        CheckConstraint(
            "status = 'draft' OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL)",
            name="submitted_fields",
        ),
        # 承認済み ⇔ 承認者・承認日時・確認状況がそろう（空にして職務分離をすり抜けさせない）
        CheckConstraint(
            "(status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL"
            " AND review_status IS NOT NULL)"
            " AND (status = 'approved' OR (approved_by IS NULL AND approved_at IS NULL"
            " AND review_status IS NULL))",
            name="approved_fields",
        ),
        # 職務分離：申請者本人は承認できない
        CheckConstraint("approved_by <> submitted_by", name="separation_of_duties"),
        # 差し戻しには理由が必須（空白だけは不可）
        CheckConstraint(
            f"status <> 'rejected' OR (reject_reason IS NOT NULL AND reject_reason {NOT_BLANK})",
            name="reject_reason",
        ),
        # 確認完了・修正依頼中なら確認者と日時が必須。それ以外は空
        CheckConstraint(
            "(review_status IN ('confirmed', 'change_requested'))"
            " = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)"
            " AND (review_status IN ('confirmed', 'change_requested')"
            " OR (reviewed_by IS NULL AND reviewed_at IS NULL))",
            name="reviewed_fields",
        ),
        # 作業中の版は1つの ECU に1つまで（承認済みの版はいくつあってもよい）
        Index(
            "uq_assessments_one_open_per_ecu",
            "ecu_id",
            unique=True,
            postgresql_where=text(f"{one_of('status', OPEN_STATUSES)}"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    ecu_id: Mapped[int] = mapped_column(restrict("ecus.id"))
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20))
    submitted_by: Mapped[int | None] = mapped_column(restrict("users.id"))
    approved_by: Mapped[int | None] = mapped_column(restrict("users.id"))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reject_reason: Mapped[str | None] = mapped_column(Text)
    review_status: Mapped[str | None] = mapped_column(String(20))
    reviewed_by: Mapped[int | None] = mapped_column(restrict("users.id"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AssessmentEntry(Base):
    """版の中の、対策項目ごとの入力。"""

    __tablename__ = "assessment_entries"
    __table_args__ = (
        UniqueConstraint("assessment_id", "item_id", name="uq_assessment_entries_item"),
        CheckConstraint(one_of("status", ENTRY_STATUSES), name="status"),
        # 対応予定日は対応中・未対応のときだけ
        CheckConstraint(
            "planned_date IS NULL OR status IN ('in_progress', 'not_done')",
            name="planned_date",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    assessment_id: Mapped[int] = mapped_column(restrict("assessments.id"))
    item_id: Mapped[int] = mapped_column(restrict("measure_items.id"))
    status: Mapped[str] = mapped_column(String(20))
    evidence: Mapped[str] = mapped_column(Text)
    planned_date: Mapped[date | None] = mapped_column(Date)


class AuditLog(Base):
    """監査ログ。誰が・いつ・何を・どこから。書き込むのは API（Day 8〜10）。"""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(restrict("users.id"), index=True)
    action: Mapped[str] = mapped_column(String(50))
    target: Mapped[str] = mapped_column(String(200))
    ip: Mapped[str | None] = mapped_column(INET)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class Comment(Base):
    """メーカーとサプライヤのやり取り。回答は質問のスレッドにぶら下げる。"""

    __tablename__ = "comments"
    __table_args__ = (
        CheckConstraint(one_of("kind", COMMENT_KINDS), name="kind"),
        CheckConstraint(f"body {NOT_BLANK}", name="body"),
        # 回答は親（質問）が必須。質問・修正依頼はスレッドの先頭なので親なし
        CheckConstraint("(kind = 'answer') = (parent_id IS NOT NULL)", name="parent"),
        # 親は同じ版のコメント（複合の外部キーで守る。そのための一意の組）
        UniqueConstraint("id", "assessment_id", name="uq_comments_id_assessment"),
        ForeignKeyConstraint(
            ["parent_id", "assessment_id"],
            ["comments.id", "comments.assessment_id"],
            name="fk_comments_parent_same_assessment",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    assessment_id: Mapped[int] = mapped_column(restrict("assessments.id"), index=True)
    item_id: Mapped[int | None] = mapped_column(restrict("measure_items.id"))
    parent_id: Mapped[int | None] = mapped_column(BigInteger)
    author_id: Mapped[int] = mapped_column(restrict("users.id"))
    kind: Mapped[str] = mapped_column(String(20))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CommentRead(Base):
    """既読（未読表示に使う）。"""

    __tablename__ = "comment_reads"

    user_id: Mapped[int] = mapped_column(restrict("users.id"), primary_key=True)
    comment_id: Mapped[int] = mapped_column(restrict("comments.id"), primary_key=True)
    read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
