"""ECU の一覧・取得・下書き保存の API のテスト（docs/test-plans/SC3-9.md の #1〜#12）。

ダミーデータ（app/seed.py）の ECU は、会社ごとに番号順で次の版を持つ：
  DMY-x001：承認済みだけ / DMY-x002：承認済み＋承認待ち / DMY-x003：承認済み＋差し戻し /
  DMY-x004：下書きだけ（x は会社の記号 A〜D）
"""

from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Assessment, AssessmentEntry, AuditLog, Ecu, MeasureItem
from tests.api_helpers import Api

A_EDITOR = "a-editor@example.com"
A_APPROVER = "a-approver@example.com"
A_ADMIN = "a-supplier_admin@example.com"
B_EDITOR = "b-editor@example.com"
OEM_ADMIN = "oem-sys_admin@example.com"
OEM_REVIEWER = "oem-reviewer@example.com"

APPROVED_ONLY = "DMY-A001"
PENDING = "DMY-A002"
REJECTED = "DMY-A003"
DRAFT = "DMY-A004"
NO_SUCH_ECU = 999_999


# ---- DB の様子を見る道具 ----


def versions(s: Session, ecu: Ecu) -> list[Assessment]:
    s.expire_all()
    return list(
        s.scalars(
            select(Assessment).where(Assessment.ecu_id == ecu.id).order_by(Assessment.version)
        )
    )


def entries_of(s: Session, a: Assessment) -> list[tuple]:
    rows = s.scalars(
        select(AssessmentEntry)
        .where(AssessmentEntry.assessment_id == a.id)
        .order_by(AssessmentEntry.item_id)
    )
    return [(e.item_id, e.status, e.evidence, e.planned_date) for e in rows]


def snapshot(s: Session) -> tuple:
    """DB が変わらなかったことを確かめるための、版・入力・監査ログの写し。"""
    s.expire_all()
    vs = [
        (a.id, a.ecu_id, a.version, a.status, a.reject_reason)
        for a in s.scalars(select(Assessment).order_by(Assessment.id))
    ]
    es = [
        (e.id, e.status, e.evidence, e.planned_date)
        for e in s.scalars(select(AssessmentEntry).order_by(AssessmentEntry.id))
    ]
    logs = s.scalar(select(func.count()).select_from(AuditLog))
    return vs, es, logs


def item_ids(s: Session) -> list[int]:
    return list(s.scalars(select(MeasureItem.id).order_by(MeasureItem.sort_order)))


def full_body(s: Session, status: str = "in_progress", evidence: str = "テストの根拠") -> dict:
    planned = "2027-03-31" if status in ("in_progress", "not_done") else None
    return {
        "entries": [
            {"item_id": i, "status": status, "evidence": evidence, "planned_date": planned}
            for i in item_ids(s)
        ]
    }


def draft_url(ecu: Ecu | int) -> str:
    return f"/api/ecus/{ecu if isinstance(ecu, int) else ecu.id}/draft"


def assessment_url(ecu: Ecu | int) -> str:
    return f"/api/ecus/{ecu if isinstance(ecu, int) else ecu.id}/assessment"


# ---- #1・#2 一覧 ----


def test_list_shows_only_own_company_ecus(api: Api) -> None:
    res = api.get("/api/ecus", A_EDITOR)
    assert res.status_code == 200
    body = res.json()
    own = set(
        api.session.scalars(select(Ecu.id).where(Ecu.supplier_id == api.user(A_EDITOR).company_id))
    )
    assert {e["id"] for e in body} == own
    assert all(e["part_no"].startswith("DMY-A") for e in body)


def test_list_shows_latest_version_and_status(api: Api) -> None:
    body = {e["part_no"]: e for e in api.get("/api/ecus", A_EDITOR).json()}
    assert (body[APPROVED_ONLY]["latest_version"], body[APPROVED_ONLY]["latest_status"]) == (
        1,
        "approved",
    )
    assert (body[PENDING]["latest_version"], body[PENDING]["latest_status"]) == (2, "pending")
    assert (body[REJECTED]["latest_version"], body[REJECTED]["latest_status"]) == (2, "rejected")
    assert (body[DRAFT]["latest_version"], body[DRAFT]["latest_status"]) == (1, "draft")


@pytest.mark.parametrize("email", [A_APPROVER, A_ADMIN])
def test_every_supplier_role_can_list(api: Api, email: str) -> None:
    assert api.get("/api/ecus", email).status_code == 200


@pytest.mark.parametrize("email", [OEM_ADMIN, OEM_REVIEWER])
def test_oem_users_cannot_use_supplier_list(api: Api, email: str) -> None:
    assert api.get("/api/ecus", email).status_code == 403


# ---- #4・#5 取得 ----


def test_get_returns_all_items_in_order(api: Api) -> None:
    res = api.get(assessment_url(api.ecu(DRAFT)), A_EDITOR)
    assert res.status_code == 200
    body = res.json()
    assert [e["item_id"] for e in body["entries"]] == item_ids(api.session)
    assert body["assessment"]["status"] == "draft"


@pytest.mark.parametrize(
    ("part_no", "version", "status"),
    [(APPROVED_ONLY, 1, "approved"), (PENDING, 2, "pending"), (REJECTED, 2, "rejected")],
)
def test_get_returns_open_version_else_latest_approved(
    api: Api, part_no: str, version: int, status: str
) -> None:
    body = api.get(assessment_url(api.ecu(part_no)), A_APPROVER).json()
    assert (body["assessment"]["version"], body["assessment"]["status"]) == (version, status)


def test_get_other_company_ecu_is_404_same_as_missing(api: Api) -> None:
    other = api.get(assessment_url(api.ecu(DRAFT)), B_EDITOR)
    missing = api.get(assessment_url(NO_SUCH_ECU), B_EDITOR)
    assert other.status_code == 404
    assert (other.status_code, other.json()) == (missing.status_code, missing.json())


@pytest.mark.parametrize("email", [OEM_ADMIN, OEM_REVIEWER])
def test_oem_users_cannot_get_supplier_drafts(api: Api, email: str) -> None:
    """メーカーは承認済みの版だけを見る（Day 5・9）。この API では ECU の有無も明かさない。"""
    res = api.get(assessment_url(api.ecu(DRAFT)), email)
    missing = api.get(assessment_url(NO_SUCH_ECU), email)
    assert res.status_code in (403, 404)
    assert (res.status_code, res.json()) == (missing.status_code, missing.json())


# ---- #6〜#9 下書き保存 ----


def test_save_overwrites_existing_draft(api: Api) -> None:
    ecu = api.ecu(DRAFT)
    before = versions(api.session, ecu)
    logs_before = snapshot(api.session)[2]

    res = api.put(draft_url(ecu), full_body(api.session, "done", "対応済みの根拠"), A_EDITOR)

    assert res.status_code == 200
    after = versions(api.session, ecu)
    assert [(a.id, a.version, a.status) for a in after] == [
        (a.id, a.version, "draft") for a in before
    ]
    assert {e[1:] for e in entries_of(api.session, after[0])} == {("done", "対応済みの根拠", None)}
    assert snapshot(api.session)[2] == logs_before + 1
    assert res.json()["assessment"]["version"] == 1


def test_save_on_approved_creates_new_version_and_keeps_approved(api: Api) -> None:
    ecu = api.ecu(APPROVED_ONLY)
    [approved] = versions(api.session, ecu)
    approved_row = (approved.id, approved.status, approved.approved_by, approved.approved_at)
    approved_entries = entries_of(api.session, approved)
    logs_before = snapshot(api.session)[2]

    res = api.put(draft_url(ecu), full_body(api.session), A_EDITOR)

    assert res.status_code == 200
    v1, v2 = versions(api.session, ecu)
    assert (v1.id, v1.status, v1.approved_by, v1.approved_at) == approved_row
    assert entries_of(api.session, v1) == approved_entries
    assert (v2.version, v2.status) == (2, "draft")
    assert {e[1] for e in entries_of(api.session, v2)} == {"in_progress"}
    assert snapshot(api.session)[2] > logs_before
    assert res.json()["assessment"]["version"] == 2


def test_partial_save_on_approved_copies_other_items(api: Api) -> None:
    """送らなかった項目は、前の承認済みの版の値を写す。"""
    ecu = api.ecu(APPROVED_ONLY)
    [approved] = versions(api.session, ecu)
    old = {e[0]: e[1:] for e in entries_of(api.session, approved)}
    first = item_ids(api.session)[0]
    body = {"entries": [{"item_id": first, "status": "not_applicable", "evidence": "対象外"}]}

    assert api.put(draft_url(ecu), body, A_EDITOR).status_code == 200

    _, v2 = versions(api.session, ecu)
    new = {e[0]: e[1:] for e in entries_of(api.session, v2)}
    assert new[first] == ("not_applicable", "対象外", None)
    assert {k: v for k, v in new.items() if k != first} == {
        k: v for k, v in old.items() if k != first
    }


def test_save_on_ecu_without_versions_creates_version_1(api: Api) -> None:
    supplier = api.user(A_EDITOR).company_id
    ecu = Ecu(supplier_id=supplier, name="新しい ECU", part_no="DMY-A999", vehicle_model="架空車")
    api.session.add(ecu)
    api.session.commit()

    res = api.put(draft_url(ecu), full_body(api.session), A_EDITOR)

    assert res.status_code == 200
    [v1] = versions(api.session, ecu)
    assert (v1.version, v1.status) == (1, "draft")
    assert len(entries_of(api.session, v1)) == len(item_ids(api.session))


def test_save_on_rejected_returns_to_draft(api: Api) -> None:
    ecu = api.ecu(REJECTED)
    v1_before, v2_before = versions(api.session, ecu)

    res = api.put(draft_url(ecu), full_body(api.session, "done", "直した根拠"), A_EDITOR)

    assert res.status_code == 200
    v1, v2 = versions(api.session, ecu)
    assert (v2.id, v2.version, v2.status) == (v2_before.id, 2, "draft")
    assert {e[1:] for e in entries_of(api.session, v2)} == {("done", "直した根拠", None)}
    assert (v1.id, v1.status) == (v1_before.id, "approved")


def test_save_on_pending_is_409_and_changes_nothing(api: Api) -> None:
    before = snapshot(api.session)
    res = api.put(draft_url(api.ecu(PENDING)), full_body(api.session), A_EDITOR)
    assert res.status_code == 409
    assert snapshot(api.session) == before


# ---- #10・#11 他社・役割 ----


def test_save_other_company_ecu_is_404_and_changes_nothing(api: Api) -> None:
    before = snapshot(api.session)
    other = api.put(draft_url(api.ecu(DRAFT)), full_body(api.session), B_EDITOR)
    missing = api.put(draft_url(NO_SUCH_ECU), full_body(api.session), B_EDITOR)
    assert other.status_code == 404
    assert (other.status_code, other.json()) == (missing.status_code, missing.json())
    assert snapshot(api.session) == before


@pytest.mark.parametrize("email", [A_APPROVER, A_ADMIN, OEM_ADMIN, OEM_REVIEWER])
def test_only_editor_can_save(api: Api, email: str) -> None:
    before = snapshot(api.session)
    res = api.put(draft_url(api.ecu(DRAFT)), full_body(api.session), email)
    assert res.status_code == 403
    assert snapshot(api.session) == before


# ---- #12 不正な入力 ----


def bad_bodies(s: Session) -> dict[str, Any]:
    first, second = item_ids(s)[:2]

    def one(**kw: Any) -> dict:
        return {"entries": [{"item_id": first, "status": "done", "evidence": "根拠"} | kw]}

    return {
        "unknown_status": one(status="unknown_value"),
        "unknown_item": one(item_id=999_999),
        "duplicate_item": {
            "entries": [
                {"item_id": first, "status": "done", "evidence": "1"},
                {"item_id": first, "status": "done", "evidence": "2"},
            ]
        },
        "planned_date_on_done": one(status="done", planned_date="2027-01-01"),
        "planned_date_on_not_applicable": one(status="not_applicable", planned_date="2027-01-01"),
        "evidence_too_long": one(evidence="あ" * 2001),
        "empty_entries": {"entries": []},
        "no_entries_key": {},
        "bad_date": one(status="in_progress", planned_date="2027-13-40"),
        "second_ok_first_bad": {
            "entries": [
                {"item_id": second, "status": "done", "evidence": "正しい"},
                {"item_id": first, "status": "unknown_value", "evidence": "誤り"},
            ]
        },
    }


@pytest.mark.parametrize(
    "case",
    [
        "unknown_status",
        "unknown_item",
        "duplicate_item",
        "planned_date_on_done",
        "planned_date_on_not_applicable",
        "evidence_too_long",
        "empty_entries",
        "no_entries_key",
        "bad_date",
        "second_ok_first_bad",
    ],
)
def test_invalid_body_is_422_and_changes_nothing(api: Api, case: str) -> None:
    before = snapshot(api.session)
    res = api.put(draft_url(api.ecu(APPROVED_ONLY)), bad_bodies(api.session)[case], A_EDITOR)
    assert res.status_code == 422
    assert snapshot(api.session) == before


def test_evidence_of_exactly_2000_chars_is_ok(api: Api) -> None:
    first = item_ids(api.session)[0]
    body = {"entries": [{"item_id": first, "status": "done", "evidence": "あ" * 2000}]}
    assert api.put(draft_url(api.ecu(DRAFT)), body, A_EDITOR).status_code == 200
