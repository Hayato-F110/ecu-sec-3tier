"""ECU の一覧・取得・下書き保存の API のテスト（docs/test-plans/SC3-9.md の #1〜#12・#14〜#18）。

ダミーデータ（app/seed.py）の ECU は、会社ごとに番号順で次の版を持つ：
  DMY-x001：承認済みだけ / DMY-x002：承認済み＋承認待ち / DMY-x003：承認済み＋差し戻し /
  DMY-x004：下書きだけ（x は会社の記号 A〜D）
"""

from datetime import UTC, datetime
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
B_APPROVER = "b-approver@example.com"
B_ADMIN = "b-supplier_admin@example.com"
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
        # PostgreSQL の text は NUL 文字を保存できない（入口で断らないと 500 になる）
        "nul_in_evidence": one(evidence="前\x00後"),
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
        "nul_in_evidence",
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


# ---- #14 他社のどの役割でも、どの状態の ECU でも 404 ----


@pytest.mark.parametrize("email", [B_EDITOR, B_APPROVER, B_ADMIN])
@pytest.mark.parametrize("part_no", [APPROVED_ONLY, PENDING, REJECTED, DRAFT])
def test_other_company_any_role_any_state_is_404(api: Api, email: str, part_no: str) -> None:
    """役割の 403 や状態の 409 より先に 404 を返し、他社の ECU の有無も状態も漏らさない。"""
    ecu = api.ecu(part_no)
    before = snapshot(api.session)

    got = api.get(assessment_url(ecu), email)
    got_missing = api.get(assessment_url(NO_SUCH_ECU), email)
    saved = api.put(draft_url(ecu), full_body(api.session), email)
    saved_missing = api.put(draft_url(NO_SUCH_ECU), full_body(api.session), email)

    assert (got.status_code, got.json()) == (404, got_missing.json())
    assert got_missing.status_code == 404
    assert (saved.status_code, saved.json()) == (404, saved_missing.json())
    assert saved_missing.status_code == 404
    assert snapshot(api.session) == before


# ---- #15 監査ログの中身 ----


def last_log(s: Session) -> AuditLog:
    s.expire_all()
    return s.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(1)).one()


@pytest.mark.parametrize(
    ("part_no", "action"),
    [
        (APPROVED_ONLY, "create_draft_version"),
        (DRAFT, "save_draft"),
        (REJECTED, "reopen_rejected"),
    ],
)
def test_save_audit_log_records_who_what_and_target(api: Api, part_no: str, action: str) -> None:
    ecu = api.ecu(part_no)
    logs_before = snapshot(api.session)[2]

    assert api.put(draft_url(ecu), full_body(api.session), A_EDITOR).status_code == 200

    saved = versions(api.session, ecu)[-1]
    log = last_log(api.session)
    assert snapshot(api.session)[2] == logs_before + 1
    assert (log.user_id, log.action, log.target) == (
        api.user(A_EDITOR).id,
        action,
        f"assessment:{saved.id}",
    )
    # TestClient の接続元は "testclient"（IP アドレスではない）ので、ip は空にする
    assert log.ip is None


# ---- #16 承認済みだけの ECU に2回続けて保存 ----


def test_second_save_on_approved_rewrites_version_2(api: Api) -> None:
    ecu = api.ecu(APPROVED_ONLY)
    first = api.put(draft_url(ecu), full_body(api.session, "in_progress", "1回目"), A_EDITOR)
    second = api.put(draft_url(ecu), full_body(api.session, "done", "2回目"), A_EDITOR)

    assert (first.status_code, second.status_code) == (200, 200)
    v1, v2 = versions(api.session, ecu)
    assert [(a.version, a.status) for a in (v1, v2)] == [(1, "approved"), (2, "draft")]
    assert {e[1:] for e in entries_of(api.session, v2)} == {("done", "2回目", None)}
    assert second.json()["assessment"]["version"] == 2


# ---- #17 承認済みの版が2つあれば、新しいほうを写す ----


def test_new_version_copies_newest_approved(api: Api) -> None:
    ecu = api.ecu(APPROVED_ONLY)
    editor, approver = api.user(A_EDITOR), api.user(A_APPROVER)
    now = datetime.now(UTC)
    v2 = Assessment(
        ecu_id=ecu.id,
        version=2,
        status="approved",
        submitted_by=editor.id,
        submitted_at=now,
        approved_by=approver.id,
        approved_at=now,
        review_status="unreviewed",
    )
    api.session.add(v2)
    api.session.flush()
    for item_id in item_ids(api.session):
        api.session.add(
            AssessmentEntry(
                assessment_id=v2.id, item_id=item_id, status="not_applicable", evidence="版2の値"
            )
        )
    api.session.commit()
    first = item_ids(api.session)[0]
    body = {"entries": [{"item_id": first, "status": "done", "evidence": "送った値"}]}

    assert api.put(draft_url(ecu), body, A_EDITOR).status_code == 200

    vs = versions(api.session, ecu)
    assert [(a.version, a.status) for a in vs] == [(1, "approved"), (2, "approved"), (3, "draft")]
    new = {e[0]: e[1:] for e in entries_of(api.session, vs[2])}
    assert new[first] == ("done", "送った値", None)
    assert {v for k, v in new.items() if k != first} == {("not_applicable", "版2の値", None)}


# ---- レビュー（2026-11-23）の指摘から足したテスト ----


def test_partial_save_on_new_ecu_returns_all_items(api: Api) -> None:
    """版のない ECU に一部だけ保存しても、取得では全項目が並び、未入力は空になる。"""
    supplier = api.user(A_EDITOR).company_id
    ecu = Ecu(supplier_id=supplier, name="新しい ECU", part_no="DMY-A998", vehicle_model="架空車")
    api.session.add(ecu)
    api.session.commit()
    first = item_ids(api.session)[0]
    body = {"entries": [{"item_id": first, "status": "done", "evidence": "1項目だけ"}]}

    assert api.put(draft_url(ecu), body, A_EDITOR).status_code == 200

    entries = api.get(assessment_url(ecu), A_EDITOR).json()["entries"]
    assert [e["item_id"] for e in entries] == item_ids(api.session)
    assert (entries[0]["status"], entries[0]["evidence"]) == ("done", "1項目だけ")
    assert {(e["status"], e["evidence"]) for e in entries[1:]} == {(None, None)}


@pytest.mark.parametrize("case", ["unknown_status", "empty_entries", "no_entries_key", "bad_date"])
def test_other_company_with_bad_body_is_404_same_as_missing(api: Api, case: str) -> None:
    """本文の形の検査（422）より先に 404 を返す。他社の ECU の有無を 422 との差で漏らさない。"""
    before = snapshot(api.session)
    body = bad_bodies(api.session)[case]
    other = api.put(draft_url(api.ecu(DRAFT)), body, B_EDITOR)
    missing = api.put(draft_url(NO_SUCH_ECU), body, B_EDITOR)
    assert (other.status_code, other.json()) == (404, missing.json())
    assert missing.status_code == 404
    assert snapshot(api.session) == before


def test_unparseable_json_is_same_422_for_any_ecu(api: Api) -> None:
    """JSON として読めない本文は、FastAPI が本人確認より前に 422 にする。ECU の有無は漏れない。"""
    headers = api.headers(B_EDITOR) | {"Content-Type": "application/json"}
    other = api.client.put(draft_url(api.ecu(DRAFT)), content="{", headers=headers)
    missing = api.client.put(draft_url(NO_SUCH_ECU), content="{", headers=headers)
    assert other.status_code == 422
    assert (other.status_code, other.json()) == (missing.status_code, missing.json())


def test_db_conflict_while_creating_version_is_409(
    api: Api, monkeypatch: pytest.MonkeyPatch
) -> None:
    """版を作る途中で DB の制約に反したら（同時の保存など）、500 ではなく 409。"""
    from sqlalchemy.exc import IntegrityError

    import app.api.ecus as ecus_api

    def conflict(*_args: object, **_kwargs: object) -> None:
        raise IntegrityError("INSERT", {}, Exception("uq_assessments_one_open_per_ecu"))

    monkeypatch.setattr(ecus_api, "new_version", conflict)
    before = snapshot(api.session)
    res = api.put(draft_url(api.ecu(APPROVED_ONLY)), full_body(api.session), A_EDITOR)
    assert res.status_code == 409
    assert snapshot(api.session) == before


# ---- レビュー2回目（2026-11-23）の指摘から足したテスト ----


def test_lone_surrogate_in_evidence_is_422(api: Api) -> None:
    """片割れのサロゲート（文字として不完全な値）も、500 ではなく 422。"""
    first = item_ids(api.session)[0]
    # JSON の中の \ud800 という書き方（Python の文字列では \\ud800）で送る
    raw = '{"entries":[{"item_id":' + str(first) + ',"status":"done","evidence":"\\ud800"}]}'
    before = snapshot(api.session)
    headers = api.headers(A_EDITOR) | {"Content-Type": "application/json"}
    res = api.client.put(draft_url(api.ecu(DRAFT)), content=raw, headers=headers)
    assert res.status_code == 422
    assert snapshot(api.session) == before


def test_pending_with_unknown_item_is_422_before_409(api: Api) -> None:
    """調べる順番：入力の誤り（422）を、状態（承認待ちの 409）より先に返す。"""
    before = snapshot(api.session)
    body = bad_bodies(api.session)["unknown_item"]
    res = api.put(draft_url(api.ecu(PENDING)), body, A_EDITOR)
    assert res.status_code == 422
    assert snapshot(api.session) == before


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("192.0.2.10", "192.0.2.10"),
        ("2001:db8::1", "2001:db8::1"),
        ("fe80::1%eth0", "fe80::1"),
        ("testclient", None),
        (None, None),
    ],
)
def test_client_ip_is_storable_in_inet(host: str | None, expected: str | None) -> None:
    """PostgreSQL の INET に入る形だけを返す。ゾーン ID（%eth0）は除き、IP でなければ空。"""
    from types import SimpleNamespace

    from app.api.ecus import client_ip

    request = SimpleNamespace(client=SimpleNamespace(host=host) if host else None)
    assert client_ip(request) == expected  # type: ignore[arg-type]


def test_commit_conflict_rolls_back_everything(api: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    """確定（commit）で制約に反しても 409。差し戻しからの戻しも、入力も、監査ログも残らない。"""
    from sqlalchemy.exc import IntegrityError

    def conflict() -> None:
        raise IntegrityError("COMMIT", {}, Exception("uq_assessments_one_open_per_ecu"))

    before = snapshot(api.session)
    monkeypatch.setattr(api.session, "commit", conflict)
    res = api.put(draft_url(api.ecu(REJECTED)), full_body(api.session, "done", "x"), A_EDITOR)
    monkeypatch.undo()
    assert res.status_code == 409
    assert snapshot(api.session) == before


# ---- #18 一覧：サプライヤのどの役割でも自社の ECU だけ ----


@pytest.mark.parametrize("email", [A_EDITOR, A_APPROVER, A_ADMIN])
def test_list_every_supplier_role_sees_only_own(api: Api, email: str) -> None:
    res = api.get("/api/ecus", email)
    assert res.status_code == 200
    own = set(
        api.session.scalars(select(Ecu.id).where(Ecu.supplier_id == api.user(email).company_id))
    )
    assert {e["id"] for e in res.json()} == own
