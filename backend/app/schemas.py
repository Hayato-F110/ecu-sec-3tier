"""API の入力と出力の形（Pydantic）。形の誤りは 422 になる。"""

from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

EntryStatus = Literal["done", "in_progress", "not_done", "not_applicable"]
EVIDENCE_MAX = 2000


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
    evidence: Annotated[str, Field(max_length=EVIDENCE_MAX)]
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


class AssessmentOut(BaseModel):
    id: int
    version: int
    status: str


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
