"""承認フロー（申請・承認・差し戻し）の API のテスト（docs/test-plans/SC3-14.md。SC3-25 を含む）。

ダミーデータ（app/seed.py）の A 社の ECU：
  DMY-A001：承認済みだけ / DMY-A002：承認済み＋承認待ち（a-editor が申請）/
  DMY-A003：承認済み（修正依頼）＋差し戻し / DMY-A004：下書きだけ
権限の表（tests/permissions_table.py）の行は、実装と同じ PR で足す（#11）。
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Assessment, AssessmentEntry, AuditLog, Ecu, MeasureItem, User
from tests.api_helpers import Api
from tests.test_api_ecus import (
    A_ADMIN,
    A_APPROVER,
    A_EDITOR,
    APPROVED_ONLY,
    B_APPROVER,
    DRAFT,
    NO_SUCH_ECU,
    OEM_REVIEWER,
    PENDING,
    REJECTED,
    assessment_url,
    draft_url,
    entries_of,
    full_body,
    snapshot,
    versions,
)
from tests.test_constraints import INVISIBLE

ROLE_DENIED = "この操作はできません"
SELF_REVIEW = "申請者本人は承認・差し戻しできません"
INCOMPLETE = "未入力の項目があります"
REASON = "根拠の説明が足りません"


def url(ecu: Ecu | int, action: str) -> str:
    return f"/api/ecus/{ecu if isinstance(ecu, int) else ecu.id}/{action}"


def submit(api: Api, ecu: Ecu | int, email: str = A_EDITOR, body: object = None):
    return api.post(url(ecu, "submit"), body, email)


def approve(api: Api, ecu: Ecu | int, email: str = A_APPROVER, body: object = None):
    return api.post(url(ecu, "approve"), body, email)


def reject(api: Api, ecu: Ecu | int, reason: object = REASON, email: str = A_APPROVER):
    return api.post(url(ecu, "reject"), {"reason": reason}, email)


def open_of(s: Session, ecu: Ecu) -> Assessment:
    return [a for a in versions(s, ecu) if a.status != "approved"][-1]


def matrix_row(api: Api, ecu: Ecu) -> dict:
    res = api.get("/api/matrix", OEM_REVIEWER)
    assert res.status_code == 200, res.text
    return next(r for r in res.json()["rows"] if r["ecu_id"] == ecu.id)


def new_ecu(s: Session, supplier_of: Ecu) -> Ecu:
    """版がまだない自社の ECU"""
    ecu = Ecu(
        supplier_id=supplier_of.supplier_id,
        name="テスト用 ECU",
        part_no="DMY-A999",
        vehicle_model="架空の車",
    )
    s.add(ecu)
    s.flush()
    return ecu


def set_role(s: Session, email: str, role: str) -> None:
    s.scalars(select(User).where(User.email == email)).one().role = role
    s.flush()


def second_editor(api: Api) -> str:
    """A 社の2人目の入力者（ダミーデータでは入力者は1社に1人）"""
    me = api.user(A_EDITOR)
    email = "a-editor2@example.com"
    api.session.add(User(company_id=me.company_id, email=email, password_hash="!", role="editor"))
    api.session.flush()
    return email


# ---- #1 入力 → 申請 → 承認で、メーカーのマトリクスに出る ----


def test_save_submit_approve_shows_in_matrix(api: Api) -> None:
    ecu = api.ecu(APPROVED_ONLY)
    assert matrix_row(api, ecu)["version"] == 1

    assert api.put(draft_url(ecu), full_body(api.session, "done"), A_EDITOR).status_code == 200
    assert matrix_row(api, ecu)["version"] == 1  # 保存のあとも前の承認版
    assert submit(api, ecu).status_code == 200
    assert matrix_row(api, ecu)["version"] == 1  # 申請のあとも前の承認版
    res = approve(api, ecu)
    assert res.status_code == 200, res.text

    row = matrix_row(api, ecu)
    assert row["version"] == 2
    assert row["review_status"] == "unreviewed"
    assert {c["status"] for c in row["cells"]} == {"done"}


# ---- #2 申請 ----


def test_submit_draft_becomes_pending_with_submitter(api: Api) -> None:
    ecu = api.ecu(DRAFT)
    res = submit(api, ecu)
    assert res.status_code == 200, res.text
    assert res.json()["assessment"]["status"] == "pending"
    a = open_of(api.session, ecu)
    assert a.status == "pending"
    assert a.submitted_by == api.user(A_EDITOR).id
    assert a.submitted_at is not None


@pytest.mark.parametrize("part_no", [PENDING, REJECTED, APPROVED_ONLY, None])
def test_submit_other_than_draft_is_409(api: Api, part_no: str | None) -> None:
    ecu = api.ecu(part_no) if part_no else new_ecu(api.session, api.ecu(DRAFT))
    before = snapshot(api.session)
    res = submit(api, ecu)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] != INCOMPLETE
    assert snapshot(api.session) == before


# ---- #3 承認 ----


def test_approve_pending(api: Api) -> None:
    ecu = api.ecu(PENDING)
    res = approve(api, ecu)
    assert res.status_code == 200, res.text
    a = versions(api.session, ecu)[-1]
    assert a.status == "approved"
    assert a.approved_by == api.user(A_APPROVER).id
    assert a.approved_at is not None
    assert a.review_status == "unreviewed"
    assert a.reviewed_by is None


@pytest.mark.parametrize("part_no", [DRAFT, REJECTED, APPROVED_ONLY, None])
@pytest.mark.parametrize("action", ["approve", "reject"])
def test_approve_or_reject_other_than_pending_is_409(
    api: Api, part_no: str | None, action: str
) -> None:
    ecu = api.ecu(part_no) if part_no else new_ecu(api.session, api.ecu(DRAFT))
    before = snapshot(api.session)
    res = approve(api, ecu) if action == "approve" else reject(api, ecu)
    assert res.status_code == 409, res.text
    assert snapshot(api.session) == before


# ---- #4 差し戻し ----


def test_reject_pending_then_save_returns_to_draft(api: Api) -> None:
    ecu = api.ecu(PENDING)
    res = reject(api, ecu)
    assert res.status_code == 200, res.text
    a = open_of(api.session, ecu)
    assert (a.status, a.reject_reason) == ("rejected", REASON)

    assert api.put(draft_url(ecu), full_body(api.session, "done"), A_EDITOR).status_code == 200
    assert open_of(api.session, ecu).status == "draft"


def test_second_reject_overwrites_reason(api: Api) -> None:
    """決めたこと4：理由は最後のものだけを残す"""
    ecu = api.ecu(PENDING)
    assert reject(api, ecu, "1回目の理由").status_code == 200
    assert api.put(draft_url(ecu), full_body(api.session, "done"), A_EDITOR).status_code == 200
    assert submit(api, ecu).status_code == 200
    assert reject(api, ecu, "2回目の理由").status_code == 200
    assert open_of(api.session, ecu).reject_reason == "2回目の理由"


# ---- #6 職務分離：申請者本人は承認も差し戻しもできない ----


@pytest.mark.parametrize("action", ["approve", "reject"])
def test_submitter_cannot_review_own_submission(api: Api, action: str) -> None:
    ecu = api.ecu(DRAFT)
    assert submit(api, ecu).status_code == 200
    # 役割を承認者に変える。入力者のままだと役割の 403 で先に断られ、
    # 職務分離を確かめたことにならない
    set_role(api.session, A_EDITOR, "approver")
    before = snapshot(api.session)
    res = approve(api, ecu, A_EDITOR) if action == "approve" else reject(api, ecu, email=A_EDITOR)
    assert res.status_code == 403
    assert res.json()["detail"] == SELF_REVIEW
    assert snapshot(api.session) == before


# ---- #7 差し戻しの理由 ----


BAD_REASONS = {
    "空": "",
    "空白": "   ",
    "全角の空白": "　　",
    "改行とタブ": " \t\n",
    "NUL": "理由\x00",
    "長すぎる": "あ" * 2001,
    **{f"見えない空白 U+{ord(c[0]):04X}": c for c in INVISIBLE},
}


@pytest.mark.parametrize("case", list(BAD_REASONS))
def test_bad_reject_reason_is_422(api: Api, case: str) -> None:
    ecu = api.ecu(PENDING)
    before = snapshot(api.session)
    res = reject(api, ecu, BAD_REASONS[case])
    assert res.status_code == 422, res.text
    assert snapshot(api.session) == before


def test_missing_reject_reason_is_422(api: Api) -> None:
    ecu = api.ecu(PENDING)
    before = snapshot(api.session)
    assert api.post(url(ecu, "reject"), {}, A_APPROVER).status_code == 422
    assert api.post(url(ecu, "reject"), None, A_APPROVER).status_code == 422
    assert snapshot(api.session) == before


def test_lone_surrogate_in_reason_is_422(api: Api) -> None:
    ecu = api.ecu(PENDING)
    headers = {**api.headers(A_APPROVER), "Content-Type": "application/json"}
    res = api.client.post(url(ecu, "reject"), content='{"reason":"\\ud800"}', headers=headers)
    assert res.status_code == 422


def test_reason_of_exactly_2000_chars_is_ok(api: Api) -> None:
    assert reject(api, api.ecu(PENDING), "あ" * 2000).status_code == 200


# ---- #8 承認済みの版は上書きしない ----


def test_new_version_on_change_requested_becomes_approved_and_keeps_v1(api: Api) -> None:
    ecu = api.ecu(REJECTED)  # 版1：承認済み（修正依頼）、版2：差し戻し
    v1 = versions(api.session, ecu)[0]
    v1_entries = entries_of(api.session, v1)
    assert api.put(draft_url(ecu), full_body(api.session, "done"), A_EDITOR).status_code == 200
    assert submit(api, ecu).status_code == 200
    assert reject(api, ecu).status_code == 200
    assert matrix_row(api, ecu)["version"] == 1  # 差し戻しのあとも前の承認版
    assert api.put(draft_url(ecu), full_body(api.session, "done"), A_EDITOR).status_code == 200
    assert submit(api, ecu).status_code == 200
    assert approve(api, ecu).status_code == 200

    v1_after, v2 = versions(api.session, ecu)
    assert (v2.version, v2.status, v2.review_status) == (2, "approved", "unreviewed")
    assert v1_after.review_status == "change_requested"
    assert entries_of(api.session, v1_after) == v1_entries
    assert matrix_row(api, ecu)["version"] == 2


# ---- #9 SC3-25：再申請で申請者を書き直す ----


def test_resubmit_rewrites_submitter(api: Api) -> None:
    x, y = A_EDITOR, second_editor(api)
    ecu = api.ecu(DRAFT)
    assert submit(api, ecu, x).status_code == 200
    first_at = open_of(api.session, ecu).submitted_at
    assert reject(api, ecu).status_code == 200
    assert api.put(draft_url(ecu), full_body(api.session, "done"), y).status_code == 200
    assert submit(api, ecu, y).status_code == 200

    a = open_of(api.session, ecu)
    assert a.submitted_by == api.user(y).id
    assert a.submitted_at > first_at

    set_role(api.session, x, "approver")
    set_role(api.session, y, "approver")
    res = approve(api, ecu, y)
    assert res.status_code == 403
    assert res.json()["detail"] == SELF_REVIEW
    assert approve(api, ecu, x).status_code == 200


def test_third_approver_can_approve_resubmission(api: Api) -> None:
    y = second_editor(api)
    ecu = api.ecu(DRAFT)
    assert submit(api, ecu).status_code == 200
    assert reject(api, ecu).status_code == 200
    assert api.put(draft_url(ecu), full_body(api.session, "done"), y).status_code == 200
    assert submit(api, ecu, y).status_code == 200
    assert approve(api, ecu, A_APPROVER).status_code == 200


# ---- #10 監査ログ ----


def last_log(s: Session) -> AuditLog:
    s.expire_all()
    return s.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(1)).one()


@pytest.mark.parametrize(
    ("part_no", "action", "email"),
    [
        (DRAFT, "submit", A_EDITOR),
        (PENDING, "approve", A_APPROVER),
        (PENDING, "reject", A_APPROVER),
    ],
)
def test_workflow_audit_log(api: Api, part_no: str, action: str, email: str) -> None:
    from app.config import get_settings
    from app.deps import get_db
    from app.main import create_app

    app = create_app(get_settings())
    app.dependency_overrides[get_db] = lambda: api.session
    client = TestClient(app, client=("203.0.113.5", 50000))
    ecu = api.ecu(part_no)
    body = {"reason": REASON} if action == "reject" else None
    res = client.post(url(ecu, action), json=body, headers=api.headers(email))
    assert res.status_code == 200, res.text

    log = last_log(api.session)
    assert log.action == action
    assert log.user_id == api.user(email).id
    # 対象はどの場合も、その ECU のいちばん新しい版
    assert log.target == f"assessment:{versions(api.session, ecu)[-1].id}"
    assert str(log.ip) == "203.0.113.5"
    assert REASON not in (log.target or "")


# ---- #11 役割・本文の形（権限の表の行は実装と同じ PR で足す） ----


@pytest.mark.parametrize("email", [A_APPROVER, A_ADMIN])
def test_only_editor_can_submit(api: Api, email: str) -> None:
    before = snapshot(api.session)
    res = submit(api, api.ecu(DRAFT), email)
    assert (res.status_code, res.json()["detail"]) == (403, ROLE_DENIED)
    assert snapshot(api.session) == before


@pytest.mark.parametrize("email", [A_EDITOR, A_ADMIN])
@pytest.mark.parametrize("action", ["approve", "reject"])
def test_only_approver_can_review(api: Api, email: str, action: str) -> None:
    ecu = api.ecu(PENDING)
    before = snapshot(api.session)
    res = approve(api, ecu, email) if action == "approve" else reject(api, ecu, email=email)
    assert (res.status_code, res.json()["detail"]) == (403, ROLE_DENIED)
    assert snapshot(api.session) == before


@pytest.mark.parametrize("body", [None, {}])
def test_submit_and_approve_accept_no_body_or_empty(api: Api, body: object) -> None:
    assert submit(api, api.ecu(DRAFT), body=body).status_code == 200
    assert approve(api, api.ecu(PENDING), body=body).status_code == 200


@pytest.mark.parametrize("extra", [{"submitted_by": 1}, {"approved_by": 1}, {"status": "approved"}])
@pytest.mark.parametrize("action", ["submit", "approve"])
def test_extra_fields_are_422(api: Api, extra: dict, action: str) -> None:
    before = snapshot(api.session)
    res = (
        submit(api, api.ecu(DRAFT), body=extra)
        if action == "submit"
        else approve(api, api.ecu(PENDING), body=extra)
    )
    assert res.status_code == 422, res.text
    assert snapshot(api.session) == before


def test_extra_field_in_reject_is_422(api: Api) -> None:
    before = snapshot(api.session)
    res = api.post(
        url(api.ecu(PENDING), "reject"), {"reason": REASON, "approved_by": 1}, A_APPROVER
    )
    assert res.status_code == 422
    assert snapshot(api.session) == before


# ---- #13 申請のとき、全項目が入力済み ----


def make_incomplete(api: Api, ecu: Ecu, how: str) -> None:
    a = open_of(api.session, ecu)
    rows = list(
        api.session.scalars(
            select(AssessmentEntry)
            .where(AssessmentEntry.assessment_id == a.id)
            .order_by(AssessmentEntry.item_id)
        )
    )
    if how == "行がない":
        api.session.delete(rows[0])
    elif how == "根拠が空白だけ":
        rows[0].evidence = " 　"
    elif how == "対応中で予定日なし":
        rows[0].status, rows[0].planned_date = "in_progress", None
    elif how == "未対応で予定日なし":
        rows[0].status, rows[0].planned_date = "not_done", None
    elif how == "対策項目が増えた":
        api.session.add(
            MeasureItem(code="NEW", title="新しい項目", description="x", sort_order=999)
        )
    api.session.flush()


@pytest.mark.parametrize(
    "how",
    [
        "行がない",
        "根拠が空白だけ",
        # 根拠が空（NULL）の行は、DB の NOT NULL で作れないので確かめない（行がない場合で確かめる）
        "対応中で予定日なし",
        "未対応で予定日なし",
        "対策項目が増えた",
    ],
)
def test_submit_with_incomplete_entries_is_409(api: Api, how: str) -> None:
    ecu = api.ecu(DRAFT)
    make_incomplete(api, ecu, how)
    before = snapshot(api.session)
    res = submit(api, ecu)
    assert (res.status_code, res.json()["detail"]) == (409, INCOMPLETE)
    assert snapshot(api.session) == before


# ---- #14 確定のときの DB の制約違反は 409 ----


@pytest.mark.parametrize("action", ["submit", "approve", "reject"])
def test_commit_conflict_is_409_and_changes_nothing(
    api: Api, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    from sqlalchemy.exc import IntegrityError

    def conflict() -> None:
        raise IntegrityError("COMMIT", {}, Exception("conflict"))

    before = snapshot(api.session)
    monkeypatch.setattr(api.session, "commit", conflict)
    if action == "submit":
        res = submit(api, api.ecu(DRAFT))
    elif action == "approve":
        res = approve(api, api.ecu(PENDING))
    else:
        res = reject(api, api.ecu(PENDING))
    monkeypatch.undo()
    assert res.status_code == 409
    assert snapshot(api.session) == before


# ---- #15 調べる順番 ----


def test_other_company_reject_with_empty_reason_is_404(api: Api) -> None:
    other = api.post(url(api.ecu(PENDING), "reject"), {"reason": ""}, B_APPROVER)
    missing = api.post(url(NO_SUCH_ECU, "reject"), {"reason": ""}, B_APPROVER)
    assert other.status_code == missing.status_code == 404
    # 自社の ECU かの確かめ（own_ecu）の 404。
    # API がない「存在しない URL」の 404（Not Found）と見分ける
    assert other.json() == missing.json() == {"detail": "見つかりません"}


@pytest.mark.parametrize("email", [A_EDITOR, A_ADMIN])
def test_wrong_role_reject_with_empty_reason_is_403_before_422(api: Api, email: str) -> None:
    res = reject(api, api.ecu(PENDING), "", email)
    assert (res.status_code, res.json()["detail"]) == (403, ROLE_DENIED)


# ---- #16 取得の応答：差し戻しの理由と can_review ----


def test_reject_reason_only_while_rejected(api: Api) -> None:
    ecu = api.ecu(REJECTED)
    res = api.get(assessment_url(ecu), A_EDITOR).json()
    assert res["assessment"]["status"] == "rejected"
    assert res["assessment"]["reject_reason"]

    api.put(draft_url(ecu), full_body(api.session, "done"), A_EDITOR)
    res = api.get(assessment_url(ecu), A_EDITOR).json()
    assert res["assessment"]["status"] == "draft"
    assert res["assessment"]["reject_reason"] is None


@pytest.mark.parametrize(
    ("part_no", "email", "expected"),
    [
        (PENDING, A_APPROVER, True),
        (PENDING, A_EDITOR, False),
        (PENDING, A_ADMIN, False),
        (DRAFT, A_APPROVER, False),
        (REJECTED, A_APPROVER, False),
        (APPROVED_ONLY, A_APPROVER, False),
    ],
)
def test_can_review(api: Api, part_no: str, email: str, expected: bool) -> None:
    res = api.get(assessment_url(api.ecu(part_no)), email)
    assert res.status_code == 200
    assert res.json()["can_review"] is expected


def test_cannot_review_own_submission_in_get(api: Api) -> None:
    ecu = api.ecu(DRAFT)
    assert submit(api, ecu).status_code == 200
    set_role(api.session, A_EDITOR, "approver")
    assert api.get(assessment_url(ecu), A_EDITOR).json()["can_review"] is False
    assert api.get(assessment_url(ecu), A_APPROVER).json()["can_review"] is True


def test_matrix_does_not_show_reject_reason(api: Api) -> None:
    res = api.get("/api/matrix", OEM_REVIEWER)
    assert "reject_reason" not in res.text
    assert "（ダミー）根拠の説明が足りないため差し戻します" not in res.text
