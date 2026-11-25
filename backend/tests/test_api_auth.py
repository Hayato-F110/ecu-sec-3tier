"""ログインの API のテスト（docs/test-plans/SC3-12.md の #1〜#6・#11）。"""

from datetime import UTC, datetime

import jwt
import pytest
from sqlalchemy import Connection, select
from sqlalchemy.orm import Session

from app.models import AuditLog, User
from tests.api_helpers import Api, make_api
from tests.conftest import TEST_JWT_SECRET_KEY

URL = "/api/auth/login"
# テスト用の架空の値
PASSWORD = "correct horse battery staple"  # noqa: S105
ROLES = [
    "oem-sys_admin@example.com",
    "oem-reviewer@example.com",
    "a-supplier_admin@example.com",
    "a-editor@example.com",
    "a-approver@example.com",
    "b-editor@example.com",
]
FAILED_TEXT = "メールアドレスかパスワードが違います"


@pytest.fixture
def with_passwords(api: Api) -> Api:
    """ROLES の利用者に PASSWORD を設定する（bcrypt は遅いので1回だけ計算して使い回す）"""
    from app.security import hash_password

    hashed = hash_password(PASSWORD)
    for email in ROLES:
        api.user(email).password_hash = hashed
    api.session.commit()
    return api


def login(api: Api, email: str, password: str):
    return api.client.post(URL, json={"email": email, "password": password})


# ---- #1・#2 成功 ----


@pytest.mark.parametrize("email", ROLES)
def test_every_role_can_log_in(with_passwords: Api, email: str) -> None:
    from app.config import get_settings

    api = with_passwords
    before = datetime.now(UTC).timestamp()
    res = login(api, email, PASSWORD)
    assert res.status_code == 200, res.text
    body = res.json()
    minutes = get_settings().access_token_expire_minutes
    assert body["token_type"] == "bearer"
    assert body["role"] == api.user(email).role  # 画面の移動先を選ぶため
    assert body["expires_in"] == minutes * 60
    assert jwt.get_unverified_header(body["access_token"])["alg"] == "HS256"
    claims = jwt.decode(body["access_token"], TEST_JWT_SECRET_KEY, algorithms=["HS256"])
    assert claims["sub"] == str(api.user(email).id)
    assert before + minutes * 60 - 5 <= claims["exp"] <= before + minutes * 60 + 5
    # そのトークンで API を呼べる
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    expected = 403 if email.startswith("oem-") else 200  # 一覧はサプライヤ用
    assert api.client.get("/api/ecus", headers=headers).status_code == expected


def test_email_is_case_insensitive(with_passwords: Api) -> None:
    assert login(with_passwords, "A-Editor@Example.com", PASSWORD).status_code == 200


# ---- #3・#4 失敗はどれも同じ。照合は1回 ----


def failure_cases(api: Api) -> dict[str, tuple[str, str]]:
    inactive = api.user("b-editor@example.com")
    inactive.is_active = False
    # bcrypt の形でないハッシュ（空・壊れた値）。照合を飛ばすと時間で利用者の有無が分かる
    api.user("c-approver@example.com").password_hash = ""
    api.user("d-approver@example.com").password_hash = "$2b$broken"
    api.session.commit()
    long_password = "あ" * 25  # 75バイト（UTF-8）
    return {
        "no_such_email": ("nobody@example.com", PASSWORD),
        "wrong_password": ("a-editor@example.com", "wrong password"),
        "inactive": ("b-editor@example.com", PASSWORD),
        "locked": ("c-editor@example.com", PASSWORD),  # ダミーデータのまま（"!"）
        "empty_password": ("a-editor@example.com", ""),
        "too_long_existing": ("a-editor@example.com", long_password),
        "too_long_missing": ("nobody@example.com", long_password),
        "empty_hash": ("c-approver@example.com", PASSWORD),
        "broken_hash": ("d-approver@example.com", PASSWORD),
    }


def test_failures_are_all_the_same_401(with_passwords: Api, monkeypatch) -> None:
    import app.security as security

    api = with_passwords
    calls: list[str] = []
    original = security.verify_hash

    def counting(password: str, password_hash: str) -> bool:
        calls.append(password_hash)
        return original(password, password_hash)

    monkeypatch.setattr(security, "verify_hash", counting)
    bodies = set()
    for case, (email, password) in failure_cases(api).items():
        calls.clear()
        res = login(api, email, password)
        assert res.status_code == 401, (case, res.text)
        assert "access_token" not in res.text, case
        assert len(calls) == 1, (case, len(calls))  # どの経路でも照合はちょうど1回
        # 照合の相手はいつも本物の bcrypt のハッシュ（計算を飛ばす経路がない）
        assert calls[0].startswith("$2b$") and len(calls[0]) == 60, (case, calls[0])
        bodies.add(res.text)
    assert len(bodies) == 1, bodies
    assert FAILED_TEXT in bodies.pop()
    # 成功のときも1回
    calls.clear()
    assert login(api, "a-editor@example.com", PASSWORD).status_code == 200
    assert len(calls) == 1


# ---- #5 本文の形の誤り ----


@pytest.mark.parametrize(
    "body",
    [
        {"email": "a-editor@example.com"},
        {"password": PASSWORD},
        {"email": 1, "password": PASSWORD},
        {"email": "a-editor@example.com", "password": PASSWORD, "role": "sys_admin"},
    ],
    ids=["no_password", "no_email", "email_not_string", "extra_field"],
)
def test_malformed_body_is_422_without_echo(with_passwords: Api, body: dict) -> None:
    res = with_passwords.client.post(URL, json=body)
    assert res.status_code == 422
    assert PASSWORD not in res.text
    assert "sys_admin" not in res.text


# ---- #6 監査ログ ----


def committed_logs(api: Api) -> list[AuditLog]:
    api.session.rollback()  # 確定した行だけを見る
    return list(
        api.session.scalars(
            select(AuditLog)
            .where(AuditLog.action.in_(["login_succeeded", "login_failed"]))
            .order_by(AuditLog.id)
        )
    )


def test_login_success_and_failure_are_logged_without_secrets(with_passwords: Api) -> None:
    api = with_passwords
    editor = api.user("a-editor@example.com")
    editor_id = editor.id
    ok = login(api, "a-editor@example.com", PASSWORD)
    login(api, "a-editor@example.com", "wrong password")
    login(api, "nobody@example.com", "wrong password")
    logs = committed_logs(api)
    assert [(log.action, log.user_id) for log in logs] == [
        ("login_succeeded", editor_id),
        ("login_failed", editor_id),
        ("login_failed", None),
    ]
    token = ok.json()["access_token"]
    for log in logs:
        text = f"{log.action} {log.target}"
        for secret in (PASSWORD, "wrong password", token, "nobody@example.com", "a-editor"):
            assert secret not in text


# ---- #11 ダミーデータのパスワード ----


def test_seed_with_password_sets_bcrypt_hash_for_everyone(conn: Connection) -> None:
    from app.seed import seed

    with Session(bind=conn, join_transaction_mode="create_savepoint") as s:
        seed(s, password=PASSWORD)
        s.commit()
        hashes = list(s.scalars(select(User.password_hash)))
        assert hashes and all(h.startswith("$2b$") for h in hashes)
        api = make_api(s)
        assert login(api, "a-editor@example.com", PASSWORD).status_code == 200


def test_seed_without_password_keeps_everyone_locked(db_session: Session) -> None:
    assert set(db_session.scalars(select(User.password_hash))) == {"!"}


def test_set_passwords_changes_only_hashes(db_session: Session) -> None:
    from app.seed import set_passwords

    before = [
        (u.id, u.email, u.role, u.is_active)
        for u in db_session.scalars(select(User).order_by(User.id))
    ]
    count = set_passwords(db_session, PASSWORD)
    db_session.commit()
    db_session.expire_all()
    users = list(db_session.scalars(select(User).order_by(User.id)))  # 更新で順番が変わるため
    assert count == len(users)
    assert [(u.id, u.email, u.role, u.is_active) for u in users] == before
    assert all(u.password_hash.startswith("$2b$") for u in users)


# ---- 1回目のレビューの直し ----


def test_dummy_hash_is_ready_when_app_starts(db_session: Session) -> None:
    """起動のときにダミーのハッシュを計算しておく（最初のログインだけ遅い、をなくす）"""
    import app.security as security

    security._dummy_hash.cache_clear()
    make_api(db_session)
    assert security._dummy_hash.cache_info().currsize == 1


def test_seed_password_over_72_bytes_stops_with_message(monkeypatch) -> None:
    """72バイトを超えるパスワードは、DB につなぐ前に分かる文言で止める"""
    import sys

    from app import seed

    monkeypatch.setenv("SEED_USER_PASSWORD", "a" * 73)
    monkeypatch.setattr(sys, "argv", ["seed", "--set-passwords"])
    with pytest.raises(SystemExit, match="72 バイトまで"):
        seed.main()
