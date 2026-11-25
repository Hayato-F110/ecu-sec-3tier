"""仮の本人確認（X-Dev-User-Id）のテスト（docs/test-plans/SC3-9.md の #3）。

Day 6 に JWT へ差し替えるまでの仮の仕組み。既定は無効で、無効なら必ず 401 になることを確かめる。
"""

import pytest
from sqlalchemy.orm import Session

from tests.api_helpers import Api, make_api

ENDPOINTS = [
    ("GET", "/api/ecus"),
    ("GET", "/api/ecus/{ecu}/assessment"),
    ("PUT", "/api/ecus/{ecu}/draft"),
    ("GET", "/api/matrix"),
]
BODY = {"entries": [{"item_id": 1, "status": "done", "evidence": "根拠"}]}


def call(api: Api, method: str, path: str, headers: dict[str, str]):
    url = path.format(ecu=api.ecu("DMY-A004").id)
    if method == "GET":
        return api.client.get(url, headers=headers)
    return api.client.put(url, json=BODY, headers=headers)


@pytest.mark.parametrize(("method", "path"), ENDPOINTS)
@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-Dev-User-Id": ""},
        {"X-Dev-User-Id": "abc"},
        {"X-Dev-User-Id": "999999"},
        {"X-Dev-User-Id": "-1"},
    ],
    ids=["none", "empty", "not_number", "no_such_user", "negative"],
)
def test_missing_or_unknown_user_is_401(api: Api, method: str, path: str, headers: dict) -> None:
    assert call(api, method, path, headers).status_code == 401


@pytest.mark.parametrize(("method", "path"), ENDPOINTS)
def test_inactive_user_is_401(api: Api, method: str, path: str) -> None:
    user = api.user("a-editor@example.com")
    user.is_active = False
    api.session.commit()
    assert call(api, method, path, {"X-Dev-User-Id": str(user.id)}).status_code == 401


@pytest.mark.parametrize("email", ["oem-reviewer@example.com", "oem-sys_admin@example.com"])
def test_inactive_oem_user_cannot_read_matrix(api: Api, email: str) -> None:
    """マトリクスで本当に漏れるのは、無効になったメーカーの利用者（サプライヤは 403 で止まる）。"""
    user = api.user(email)
    user.is_active = False
    api.session.commit()
    res = api.client.get("/api/matrix", headers={"X-Dev-User-Id": str(user.id)})
    assert res.status_code == 401


@pytest.mark.parametrize(("method", "path"), ENDPOINTS)
def test_disabled_dev_auth_rejects_valid_header(
    db_session: Session, method: str, path: str
) -> None:
    api = make_api(db_session, dev_auth_enabled=False)
    headers = api.headers("a-editor@example.com")
    assert call(api, method, path, headers).status_code == 401


def test_enabled_dev_auth_warns_at_startup(caplog: pytest.LogCaptureFixture) -> None:
    """有効のまま出してしまったときに気づけるよう、起動時に警告を出す。"""
    from app.config import get_settings
    from app.main import create_app

    settings = get_settings().model_copy(update={"dev_auth_enabled": True})
    with caplog.at_level("WARNING"):
        create_app(settings)
    assert any("X-Dev-User-Id" in r.getMessage() for r in caplog.records)


def test_disabled_dev_auth_does_not_warn(caplog: pytest.LogCaptureFixture) -> None:
    from app.config import get_settings
    from app.main import create_app

    settings = get_settings().model_copy(update={"dev_auth_enabled": False})
    with caplog.at_level("WARNING"):
        create_app(settings)
    assert not any("X-Dev-User-Id" in r.getMessage() for r in caplog.records)


def test_dev_auth_is_disabled_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """設定を何も書かなければ無効（AWS などに、うっかり有効のまま出さない）。"""
    from app.config import Settings

    monkeypatch.delenv("DEV_AUTH_ENABLED", raising=False)
    settings = Settings(_env_file=None, postgres_db="x", postgres_user="x", postgres_password="x")
    assert settings.dev_auth_enabled is False
