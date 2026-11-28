"""メーカーの確認（確認完了・修正依頼）の API のテスト（docs/test-plans/SC3-15.md の #1〜#3・#8）。

ダミーデータ（app/seed.py）の A 社の ECU：
  DMY-A001：承認済み（未確認）だけ / DMY-A002：承認済み（確認完了）＋承認待ち /
  DMY-A003：承認済み（修正依頼中）＋差し戻し / DMY-A004：下書きだけ
権限の表（tests/permissions_table.py）の行は、実装と同じ PR で足す。
"""

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Assessment, AuditLog, Comment, Ecu
from tests.api_helpers import Api
from tests.test_api_ecus import (
    A_APPROVER,
    A_EDITOR,
    APPROVED_ONLY,
    DRAFT,
    NO_SUCH_ECU,
    OEM_ADMIN,
    OEM_REVIEWER,
    PENDING,
    REJECTED,
    draft_url,
    entries_of,
    full_body,
    snapshot,
    versions,
)
from tests.test_api_workflow import approve, matrix_row, new_ecu, submit
from tests.test_constraints import INVISIBLE

REASON = "根拠の説明が足りません。試験の結果を添えてください"
CONFIRM = {"result": "confirmed"}
NO_APPROVED = "承認済みの版がありません"
ALREADY_REVIEWED = "この版はすでに確認済みです"
STALE_VERSION = "新しい版が承認されました。見直してください"


def review_url(ecu: Ecu | int) -> str:
    return f"/api/matrix/ecus/{ecu if isinstance(ecu, int) else ecu.id}/review"


def approved_of(s: Session, ecu: Ecu) -> Assessment:
    """最新の承認済みの版"""
    return [a for a in versions(s, ecu) if a.status == "approved"][-1]


def seen_version(api: Api, ecu: Ecu | int) -> int:
    """画面で見ている版の番号（最新の承認済みの版。なければ 1）"""
    if isinstance(ecu, int):
        return 1
    approved = [a for a in versions(api.session, ecu) if a.status == "approved"]
    return approved[-1].version if approved else 1


def confirm(api: Api, ecu: Ecu | int, email: str = OEM_REVIEWER, version: int | None = None):
    body = CONFIRM | {"version": version or seen_version(api, ecu)}
    return api.post(review_url(ecu), body, email)


def request_change(
    api: Api,
    ecu: Ecu | int,
    reason: object = REASON,
    email: str = OEM_REVIEWER,
    version: int | None = None,
):
    body = {
        "result": "change_requested",
        "reason": reason,
        "version": version or seen_version(api, ecu),
    }
    return api.post(review_url(ecu), body, email)


def last_log(s: Session) -> AuditLog:
    s.expire_all()
    return s.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(1)).one()


# ---- #1 確認完了 ----


def test_confirm_records_reviewer_and_shows_in_matrix(api: Api) -> None:
    ecu = api.ecu(APPROVED_ONLY)
    res = confirm(api, ecu)
    assert res.status_code == 200, res.text
    assert res.json()["review_status"] == "confirmed"

    api.session.expire_all()
    a = approved_of(api.session, ecu)
    assert a.review_status == "confirmed"
    assert a.reviewed_by == api.user(OEM_REVIEWER).id
    assert a.reviewed_at is not None
    assert matrix_row(api, ecu)["review_status"] == "confirmed"


def test_confirm_does_not_take_reason(api: Api) -> None:
    """確認完了に理由の欄はない（打ち間違いを黙って捨てない）"""
    ecu = api.ecu(APPROVED_ONLY)
    before = snapshot(api.session)
    res = api.post(review_url(ecu), CONFIRM | {"version": 1, "reason": REASON}, OEM_REVIEWER)
    assert res.status_code == 422
    assert snapshot(api.session) == before


# ---- #2 修正依頼（理由が必須）・状態の検証 ----


def test_change_request_keeps_reason_as_comment(api: Api) -> None:
    ecu = api.ecu(APPROVED_ONLY)
    res = request_change(api, ecu)
    assert res.status_code == 200, res.text
    assert res.json()["review_status"] == "change_requested"

    api.session.expire_all()
    a = approved_of(api.session, ecu)
    assert a.review_status == "change_requested"
    assert a.reviewed_by == api.user(OEM_REVIEWER).id
    comments = list(api.session.scalars(select(Comment).where(Comment.assessment_id == a.id)))
    assert [(c.kind, c.body, c.author_id, c.item_id, c.parent_id) for c in comments] == [
        ("change_request", REASON, api.user(OEM_REVIEWER).id, None, None)
    ]
    assert matrix_row(api, ecu)["review_status"] == "change_requested"


@pytest.mark.parametrize(
    "case",
    ["missing", "none", "empty", "spaces", "full_width_space", "newlines", "invisible", "too_long"],
)
def test_bad_change_request_reason_is_422(api: Api, case: str) -> None:
    ecu = api.ecu(APPROVED_ONLY)
    body: dict = {"result": "change_requested", "version": 1}
    reasons = {
        "none": None,
        "empty": "",
        "spaces": "   ",
        "full_width_space": "　",
        "newlines": "\n\t\n",
        "invisible": "".join(INVISIBLE),
        "too_long": "あ" * 2001,
    }
    if case != "missing":
        body["reason"] = reasons[case]
    before = snapshot(api.session)
    res = api.post(review_url(ecu), body, OEM_REVIEWER)
    assert res.status_code == 422, res.text
    assert snapshot(api.session) == before


def test_reason_of_exactly_2000_chars_is_ok(api: Api) -> None:
    assert request_change(api, api.ecu(APPROVED_ONLY), "あ" * 2000).status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"result": "approved", "version": 1},
        {"result": "unreviewed", "version": 1},
        None,
        # 見ていた版の番号は必須（どの版を見て判断したかを API が確かめる）
        {"result": "confirmed"},
        {"result": "change_requested", "reason": REASON},
        {"result": "confirmed", "version": 0},
        {"result": "confirmed", "version": "1"},
    ],
)
def test_unknown_result_is_422(api: Api, body: object) -> None:
    before = snapshot(api.session)
    res = api.post(review_url(api.ecu(APPROVED_ONLY)), body, OEM_REVIEWER)
    assert res.status_code == 422, res.text
    assert snapshot(api.session) == before


@pytest.mark.parametrize("extra", ["reviewed_by", "review_status", "assessment_id", "item_id"])
def test_extra_fields_are_422(api: Api, extra: str) -> None:
    """記録する人・版は本文ではなく、ログインした本人と最新の承認済みの版に決める"""
    before = snapshot(api.session)
    body = {"result": "change_requested", "reason": REASON, "version": 1, extra: 1}
    res = api.post(review_url(api.ecu(APPROVED_ONLY)), body, OEM_REVIEWER)
    assert res.status_code == 422, res.text
    assert snapshot(api.session) == before


@pytest.mark.parametrize("action", ["confirm", "request_change"])
@pytest.mark.parametrize("shape", ["draft_only", "no_version"])
def test_no_approved_version_is_409(api: Api, action: str, shape: str) -> None:
    ecu = api.ecu(DRAFT) if shape == "draft_only" else new_ecu(api.session, api.ecu(DRAFT))
    api.session.commit()
    assert [a for a in versions(api.session, ecu) if a.status == "approved"] == []
    before = snapshot(api.session)
    res = confirm(api, ecu) if action == "confirm" else request_change(api, ecu)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == NO_APPROVED
    assert snapshot(api.session) == before


@pytest.mark.parametrize("action", ["confirm", "request_change"])
@pytest.mark.parametrize("part_no", [PENDING, REJECTED])
def test_already_reviewed_is_409(api: Api, action: str, part_no: str) -> None:
    """確認完了（DMY-A002）・修正依頼中（DMY-A003）の版は、もう一度は記録できない"""
    ecu = api.ecu(part_no)
    expected = "confirmed" if part_no == PENDING else "change_requested"
    assert approved_of(api.session, ecu).review_status == expected  # ダミーデータの前提
    before = snapshot(api.session)
    res = confirm(api, ecu) if action == "confirm" else request_change(api, ecu)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == ALREADY_REVIEWED
    assert snapshot(api.session) == before


def test_second_review_after_confirm_is_409(api: Api) -> None:
    ecu = api.ecu(APPROVED_ONLY)
    assert confirm(api, ecu).status_code == 200
    res = request_change(api, ecu)
    assert res.status_code == 409
    assert res.json()["detail"] == ALREADY_REVIEWED


@pytest.mark.parametrize("action", ["confirm", "request_change"])
def test_review_of_older_version_than_latest_approved_is_409(api: Api, action: str) -> None:
    """確認者が v1 を見ている間に v2 が承認されたら、見ていない v2 に記録しない"""
    ecu = api.ecu(APPROVED_ONLY)
    assert api.put(draft_url(ecu), full_body(api.session, "done"), A_EDITOR).status_code == 200
    assert submit(api, ecu).status_code == 200
    assert approve(api, ecu).status_code == 200
    assert seen_version(api, ecu) == 2
    before = snapshot(api.session)
    res = (
        confirm(api, ecu, version=1) if action == "confirm" else request_change(api, ecu, version=1)
    )
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == STALE_VERSION
    assert snapshot(api.session) == before


def test_missing_ecu_is_404(api: Api) -> None:
    """確認者には全社の ECU が見えるので、隠す相手はなく、ない番号だけが 404。
    文まで比べる（API がないときの FastAPI の 404「Not Found」と見分ける）"""
    before = snapshot(api.session)
    for res in (confirm(api, NO_SUCH_ECU), request_change(api, NO_SUCH_ECU)):
        assert res.status_code == 404
        assert res.json() == {"detail": "見つかりません"}
    assert snapshot(api.session) == before


@pytest.mark.parametrize("email", [OEM_ADMIN, A_EDITOR, A_APPROVER])
def test_only_reviewer_can_review(api: Api, email: str) -> None:
    """システム管理者は読むだけ。サプライヤは確認できない（権限の表でも確かめる）"""
    before = snapshot(api.session)
    assert request_change(api, api.ecu(APPROVED_ONLY), email=email).status_code == 403
    assert snapshot(api.session) == before


def test_review_targets_latest_approved_version_while_new_version_is_open(api: Api) -> None:
    """承認待ちの新しい版があっても、記録するのは最新の承認済みの版（作業中の版は変えない）"""
    ecu = api.ecu(APPROVED_ONLY)
    assert api.put(draft_url(ecu), full_body(api.session, "done"), A_EDITOR).status_code == 200
    assert submit(api, ecu).status_code == 200
    assert request_change(api, ecu).status_code == 200
    api.session.expire_all()
    v1, v2 = versions(api.session, ecu)
    assert (v1.status, v1.review_status) == ("approved", "change_requested")
    assert (v2.status, v2.review_status) == ("pending", None)


# ---- #3 修正依頼から新しい版（完了条件） ----


def test_change_request_then_new_version_is_approved(api: Api) -> None:
    ecu = api.ecu(APPROVED_ONLY)
    v1_entries = entries_of(api.session, approved_of(api.session, ecu))
    assert request_change(api, ecu).status_code == 200

    # サプライヤの入力者が保存すると、版＋1の下書き（承認済みの版は変えない）
    res = api.put(draft_url(ecu), full_body(api.session, "not_applicable"), A_EDITOR)
    assert res.status_code == 200, res.text
    assert res.json()["assessment"]["version"] == 2
    assert res.json()["assessment"]["status"] == "draft"

    # 承認までは、メーカーには前の版と「修正依頼中」を見せる
    assert submit(api, ecu).status_code == 200
    row = matrix_row(api, ecu)
    assert (row["version"], row["review_status"]) == (1, "change_requested")

    assert approve(api, ecu).status_code == 200
    row = matrix_row(api, ecu)
    assert (row["version"], row["review_status"]) == (2, "unreviewed")
    assert {c["status"] for c in row["cells"]} == {"not_applicable"}

    # 前の版は、入力も確認状況もそのまま
    api.session.expire_all()
    v1 = versions(api.session, ecu)[0]
    assert (v1.status, v1.review_status) == ("approved", "change_requested")
    assert entries_of(api.session, v1) == v1_entries


# ---- #8 監査ログ（確認の分。コメントの分は SC3-15 の次の PR） ----


@pytest.mark.parametrize(
    ("action", "logged"), [("confirm", "confirm"), ("request", "request_change")]
)
def test_review_audit_log(api: Api, action: str, logged: str) -> None:
    ecu = api.ecu(APPROVED_ONLY)
    res = confirm(api, ecu) if action == "confirm" else request_change(api, ecu)
    assert res.status_code == 200
    log = last_log(api.session)
    assert log.action == logged
    assert log.user_id == api.user(OEM_REVIEWER).id
    assert log.target == f"assessment:{approved_of(api.session, ecu).id}"
    # 理由（コメントの本文）は監査ログに入れない
    assert REASON not in log.target


def test_change_request_comment_is_in_audit_log(api: Api) -> None:
    """修正依頼のコメントも、監査ログでたどれる（守りの決まり5：コメントも監査ログに残す）"""
    ecu = api.ecu(APPROVED_ONLY)
    before = api.session.scalar(select(func.max(AuditLog.id)))
    assert request_change(api, ecu).status_code == 200
    api.session.expire_all()
    comment = api.session.scalars(
        select(Comment).where(Comment.assessment_id == approved_of(api.session, ecu).id)
    ).one()
    logs = api.session.scalars(select(AuditLog).where(AuditLog.id > before)).all()
    assert {(log.action, log.target) for log in logs} == {
        ("request_change", f"assessment:{comment.assessment_id}"),
        ("add_comment", f"comment:{comment.id}"),
    }
    assert {log.user_id for log in logs} == {api.user(OEM_REVIEWER).id}


def test_change_request_comment_time_is_review_time(api: Api) -> None:
    """コメントの日時と確認の日時は、同じ1回の操作なので同じ（並べたとき前後しない）"""
    ecu = api.ecu(APPROVED_ONLY)
    assert request_change(api, ecu).status_code == 200
    api.session.expire_all()
    a = approved_of(api.session, ecu)
    comment = api.session.scalars(select(Comment).where(Comment.assessment_id == a.id)).one()
    assert comment.created_at == a.reviewed_at


# ---- レビュー2回目の直し ----


@pytest.mark.parametrize("step", ["flush", "commit"])
def test_db_constraint_error_is_409_and_changes_nothing(
    api: Api, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    """修正依頼のコメントを DB に送るとき（flush）も確定のとき（commit）も、
    DB の制約違反は 500 ではなく 409 にし、何も残さない（ほかの書き込みの API とそろえる）"""
    from sqlalchemy.exc import IntegrityError

    s = api.session
    original_flush = s.flush

    def flush(*args, **kwargs):
        if any(isinstance(o, Comment) for o in s.new):
            raise IntegrityError("INSERT", {}, Exception("conflict"))
        return original_flush(*args, **kwargs)

    def commit() -> None:
        raise IntegrityError("COMMIT", {}, Exception("conflict"))

    before = snapshot(s)
    if step == "flush":
        monkeypatch.setattr(s, "flush", flush)
    else:
        monkeypatch.setattr(s, "commit", commit)
    res = request_change(api, api.ecu(APPROVED_ONLY))
    monkeypatch.undo()
    assert res.status_code == 409, res.text
    assert snapshot(s) == before


def test_version_newer_than_latest_approved_is_409_with_own_message(api: Api) -> None:
    """まだない先の版の番号は、「新しい版が承認されました」と言わない（確認者が誤解しない）"""
    ecu = api.ecu(APPROVED_ONLY)
    before = snapshot(api.session)
    res = confirm(api, ecu, version=5)
    assert res.status_code == 409
    assert res.json()["detail"] == "その版はまだ承認されていません"
    assert snapshot(api.session) == before


def test_review_time_is_db_time(api: Api) -> None:
    """確認の日時は DB の時計（ほかのコメント・監査ログと同じ時計）。並べたとき前後しない"""
    ecu = api.ecu(APPROVED_ONLY)
    assert request_change(api, ecu).status_code == 200
    api.session.expire_all()
    a = approved_of(api.session, ecu)
    log = api.session.scalars(
        select(AuditLog).where(AuditLog.action == "request_change").order_by(AuditLog.id.desc())
    ).first()
    assert log is not None
    assert a.reviewed_at == log.created_at
