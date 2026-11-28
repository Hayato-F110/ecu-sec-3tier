"""API の入力と出力の形（Pydantic）。形の誤りは 422 になる。"""

import re
from datetime import date
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from app.models import INVISIBLE_SPACES

EntryStatus = Literal["done", "in_progress", "not_done", "not_applicable"]
EVIDENCE_MAX = 2000


def storable_text(value: str) -> str:
    """DB に保存でき、応答で返せる文字だけを許す。

    PostgreSQL の text は NUL 文字を保存できず、片割れのサロゲートは UTF-8 にできない。
    どちらも入口で断る（断らないと DB や応答の作成で 500 になる）。
    """
    if "\x00" in value or any(0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise ValueError("使えない文字が含まれています")
    return value


StorableText = Annotated[str, Field(max_length=EVIDENCE_MAX), AfterValidator(storable_text)]

# 空白（半角・全角・改行など）と見えない文字以外が1つ以上あるか。DB の制約（models.NOT_BLANK）の
# 見えない文字の集まりを使い、API で先に断る（DB の制約に当たって 500 にしない）。Python の \s は
# PostgreSQL の [:space:] より少し広い（U+001C〜U+001F・U+0085 も空白と数える）ので、
# API のほうが厳しい
VISIBLE = re.compile(f"[^\\s{INVISIBLE_SPACES}]")


def has_visible(value: str | None) -> bool:
    return value is not None and VISIBLE.search(value) is not None


def not_blank(value: str) -> str:
    if not has_visible(value):
        raise ValueError("空白だけにはできません")
    return value


ReasonText = Annotated[StorableText, AfterValidator(not_blank)]


class EcuSummary(BaseModel):
    id: int
    name: str
    part_no: str
    vehicle_model: str
    latest_version: int | None
    latest_status: str | None


class EntryIn(BaseModel):
    # 決められていない項目は受け付けない（打ち間違いを黙って捨てない）
    model_config = ConfigDict(extra="forbid")

    item_id: int
    status: EntryStatus
    evidence: StorableText
    planned_date: date | None = None

    @model_validator(mode="after")
    def planned_date_only_when_open(self) -> EntryIn:
        if self.planned_date is not None and self.status not in ("in_progress", "not_done"):
            raise ValueError("対応予定日は、対応中・未対応のときだけ入力できます")
        return self


class DraftIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entries: Annotated[list[EntryIn], Field(min_length=1)]

    @model_validator(mode="after")
    def no_duplicate_items(self) -> DraftIn:
        ids = [e.item_id for e in self.entries]
        if len(ids) != len(set(ids)):
            raise ValueError("同じ対策項目が2回あります")
        return self


class NoFieldsIn(BaseModel):
    """申請・承認の本文。なくても {} でもよいが、余計な欄（submitted_by など）は 422。
    記録する人は、本文ではなくログインした本人に決める"""

    model_config = ConfigDict(extra="forbid")


class RejectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: ReasonText


class ConfirmIn(BaseModel):
    """メーカーの確認完了。理由の欄はない"""

    model_config = ConfigDict(extra="forbid")

    result: Literal["confirmed"]


class ChangeRequestIn(BaseModel):
    """メーカーの修正依頼。理由が必須（空白だけ・長すぎるのは 422）"""

    model_config = ConfigDict(extra="forbid")

    result: Literal["change_requested"]
    reason: ReasonText


class ReviewOut(BaseModel):
    ecu_id: int
    version: int
    review_status: str


class AssessmentOut(BaseModel):
    id: int
    version: int
    status: str
    # 状態が差し戻しのときだけ入る。差し戻しのあと保存しても DB には前の理由が残るので、
    # 古い理由を今の差し戻しと読み違えないように、API が返すかを決める
    reject_reason: str | None = None


class EntryOut(BaseModel):
    """対策項目ごとの入力。まだ入力のない項目は status・evidence が空（null）。"""

    item_id: int
    code: str
    title: str
    status: str | None
    evidence: str | None
    planned_date: date | None


class AssessmentView(BaseModel):
    assessment: AssessmentOut | None
    entries: list[EntryOut]
    # ログインした人がこの版を承認・差し戻しできるか（承認者で、申請者本人でなく、承認待ち）。
    # 画面はこの欄でボタンを出し分ける（決まりを API の1か所に置く）
    can_review: bool = False


# ---- 一括確認マトリクス（メーカー用）。返す欄はここで決めたものだけ ----
# 根拠の説明・対応予定日・差し戻しの理由・申請者・承認者は、承認済みの版でも返さない
# （docs/test-plans/SC3-11.md）。欄を足すときは、テストの決めた集合も直す


class MatrixItem(BaseModel):
    id: int
    code: str
    title: str


class MatrixCell(BaseModel):
    item_id: int
    status: str | None


class MatrixRow(BaseModel):
    """1つの ECU。版・確認状況・セルは、最新の承認済みの版から取る。なければすべて空。"""

    ecu_id: int
    supplier_id: int
    supplier_name: str
    ecu_name: str
    part_no: str
    vehicle_model: str
    version: int | None
    review_status: str | None
    cells: list[MatrixCell]


class MatrixView(BaseModel):
    items: list[MatrixItem]
    rows: list[MatrixRow]


# ---- ログイン（SC3-12） ----


class LoginIn(BaseModel):
    # 知らない項目（role など）は 422。送られた値は応答に返さない（app.main の validation_error）
    model_config = ConfigDict(extra="forbid")

    # 長さの上限：メールアドレスは users.email と同じ 254。パスワードは大きな本文で遅くしないため
    email: Annotated[str, Field(max_length=254), AfterValidator(storable_text)]
    password: Annotated[str, Field(max_length=1024), AfterValidator(storable_text)]


class TokenOut(BaseModel):
    access_token: str
    # 種類の名前で、秘密の値ではない
    token_type: Literal["bearer"] = "bearer"  # noqa: S105
    expires_in: int  # 秒
    # 画面がログインのあとに移る先を選ぶため（メーカーはマトリクス、サプライヤは自社 ECU 一覧）。
    # 権限の判断には使わない（API が毎回 DB の役割で判断する）
    role: str
