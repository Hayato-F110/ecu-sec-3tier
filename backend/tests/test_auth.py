"""本人確認（JWT）のテスト（docs/test-plans/SC3-12.md の #7・#8・#10・#13）。

完了条件：未ログインでは全 API が 401。
どの理由で断っても同じ 401・同じ本文・WWW-Authenticate: Bearer。
"""

import shutil
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
import pytest
from pydantic import SecretStr, ValidationError

from tests.api_helpers import Api
from tests.conftest import TEST_JWT_SECRET_KEY
from tests.permissions_table import PUBLIC, ROUTES

# 完了条件の対象：ログイン以外の全 API（#8 で、登録されたルートと突き合わせる）。
# 一覧は権限の表（tests/permissions_table.py。SC3-13）だけに置き、ここではそこから作る
ENDPOINTS = [(r.method, r.path.replace("{ecu_id}", "{ecu}")) for r in ROUTES]
BODY = {"entries": [{"item_id": 1, "status": "done", "evidence": "根拠"}]}
NO_SUCH_ECU = 999_999
REPO_ROOT = Path(__file__).resolve().parents[2]


def encode(claims: dict, key: str = TEST_JWT_SECRET_KEY, algorithm: str = "HS256") -> str:
    return jwt.encode(claims, key, algorithm=algorithm)


def future(minutes: int = 10) -> datetime:
    return datetime.now(UTC) + timedelta(minutes=minutes)


def bad_headers(api: Api) -> dict[str, dict[str, str]]:
    """401 になるはずのヘッダー。キーはテストの名前に出る。"""
    editor = api.user("a-editor@example.com")
    uid = str(editor.id)
    bearer = lambda token: {"Authorization": f"Bearer {token}"}  # noqa: E731
    return {
        "none": {},
        "no_bearer_word": {"Authorization": encode({"sub": uid, "exp": future()})},
        "basic": {"Authorization": "Basic YTpi"},
        "broken": bearer("abc.def.ghi"),
        "wrong_key": bearer(encode({"sub": uid, "exp": future()}, key="x" * 40)),
        "expired": bearer(encode({"sub": uid, "exp": future(-1)})),
        "no_exp": bearer(encode({"sub": uid})),
        "no_sub": bearer(encode({"exp": future()})),
        "alg_none": bearer(jwt.encode({"sub": uid, "exp": future()}, None, algorithm="none")),
        "hs512": bearer(encode({"sub": uid, "exp": future()}, algorithm="HS512")),
        "no_such_user": bearer(encode({"sub": "999999", "exp": future()})),
        "sub_number": bearer(encode({"sub": editor.id, "exp": future()})),
        "sub_zero": bearer(encode({"sub": "0", "exp": future()})),
        "sub_negative": bearer(encode({"sub": "-1", "exp": future()})),
        "sub_fullwidth": bearer(encode({"sub": "４", "exp": future()})),
        "sub_spaces": bearer(encode({"sub": f" {uid}", "exp": future()})),
        "sub_19_digits": bearer(encode({"sub": "9" * 19, "exp": future()})),
        "dev_header_only": {"X-Dev-User-Id": uid},
    }


def call(api: Api, method: str, path: str, ecu_id: int, headers: dict[str, str]):
    url = path.format(ecu=ecu_id)
    if method == "GET":
        return api.client.get(url, headers=headers)
    return api.client.put(url, json=BODY, headers=headers)


def ecu_ids(api: Api) -> dict[str, int]:
    """自社（A の入力者から見て）・他社・存在しない番号"""
    return {
        "own": api.ecu("DMY-A004").id,
        "other": api.ecu("DMY-B004").id,
        "missing": NO_SUCH_ECU,
    }


# ---- #7 完了条件：未ログインでは全 API が 401 ----


@pytest.mark.parametrize(("method", "path"), ENDPOINTS)
def test_every_api_rejects_every_bad_token_with_same_401(api: Api, method: str, path: str) -> None:
    bodies = set()
    for case, headers in bad_headers(api).items():
        for which, ecu_id in ecu_ids(api).items():
            res = call(api, method, path, ecu_id, headers)
            assert res.status_code == 401, (case, which, res.text)
            assert res.headers.get("www-authenticate") == "Bearer", (case, which)
            bodies.add(res.text)
    # どの理由でも、どの ECU でも同じ本文（期限切れ・利用者の有無・ECU の有無を明かさない）
    assert len(bodies) == 1, bodies


@pytest.mark.parametrize(("method", "path"), ENDPOINTS)
@pytest.mark.parametrize("email", ["a-editor@example.com", "oem-reviewer@example.com"])
def test_inactive_user_with_valid_token_is_401(
    api: Api, method: str, path: str, email: str
) -> None:
    user = api.user(email)
    headers = api.headers_for(user)  # 有効なうちに作ったトークン
    user.is_active = False
    api.session.commit()
    res = call(api, method, path, api.ecu("DMY-A004").id, headers)
    assert res.status_code == 401
    assert res.headers.get("www-authenticate") == "Bearer"


def test_valid_token_is_accepted(api: Api) -> None:
    """#7 の 401 が「何でも断る」実装で通らないことの確かめ"""
    assert api.get("/api/ecus", "a-editor@example.com").status_code == 200
    assert api.get("/api/matrix", "oem-reviewer@example.com").status_code == 200


# ---- #8 新しい API が #7 から漏れない ----


def api_routes(routes) -> set[tuple[str, str]]:
    """登録されたルートの（メソッド, パス）。取り込んだルーターの中もたどる。

    FastAPI 0.165 は include_router したルーターを、中身を展開せず入れ物（original_router を持つ）
    のまま app.routes に置く。このアプリは include_router に prefix を渡さない（各 APIRouter の
    prefix はルートのパスに入っている）ので、パスはそのまま使える。
    """
    from fastapi.routing import APIRoute

    found = set()
    for route in routes:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            found |= api_routes(inner.routes)
        elif isinstance(route, APIRoute) and route.path.startswith("/api/"):
            found |= {(m, route.path.replace("{ecu_id}", "{ecu}")) for m in route.methods}
    return found


def test_every_api_route_is_covered(api: Api) -> None:
    registered = api_routes(api.client.app.routes)
    assert registered - PUBLIC == set(ENDPOINTS)
    assert PUBLIC <= registered
    # 公開の仕組み（OpenAPI の一覧）とも一致する（たどり方が FastAPI の変更で外れたら気づく）
    documented = {
        (method.upper(), path.replace("{ecu_id}", "{ecu}"))
        for path, ops in api.client.app.openapi()["paths"].items()
        for method in ops
    }
    assert registered == documented


# ---- #10 設定 ----


def settings_with(**values):
    from app.config import Settings

    base = {"postgres_db": "x", "postgres_user": "x", "postgres_password": "x"}
    return Settings(_env_file=None, **(base | values))  # pyright: ignore[reportCallIssue]


def test_secret_key_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    with pytest.raises(ValidationError):
        settings_with()


@pytest.mark.parametrize("key", ["a" * 31, "あ" * 10])  # 31バイト・30バイト（UTF-8）
def test_short_secret_key_is_rejected(key: str) -> None:
    with pytest.raises(ValidationError):
        settings_with(jwt_secret_key=key)


def test_secret_key_of_32_bytes_and_expiry_default() -> None:
    s = settings_with(jwt_secret_key="a" * 32)
    assert isinstance(s.jwt_secret_key, SecretStr)
    assert s.access_token_expire_minutes == 30


def test_dev_auth_setting_is_gone() -> None:
    s = settings_with(jwt_secret_key="a" * 32, dev_auth_enabled=True)
    assert not hasattr(s, "dev_auth_enabled")


# ---- #13 仮の本人確認の消し残しがない ----


def test_no_dev_auth_left_in_repository() -> None:
    git = shutil.which("git")
    assert git is not None, "git が見つからない"
    # 固定の引数だけで、外からの入力は渡さない。
    # -z：日本語や空白を含むファイル名を、引用符を付けずに NUL で区切って出す
    out = subprocess.run(  # noqa: S603
        [git, "ls-files", "-z"], cwd=REPO_ROOT, capture_output=True, check=True
    ).stdout
    files = [name for name in out.decode("utf-8").split("\0") if name]
    words = ("X-Dev-User-Id", "DEV_AUTH_ENABLED", "dev-user-id", "dev_auth_enabled")
    found = []
    for name in files:
        # 文書（docs/）と、この確かめ自身は除く
        if name.startswith("docs/") or name.endswith("tests/test_auth.py"):
            continue
        path = REPO_ROOT / name
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError, FileNotFoundError:
            continue
        found += [f"{name}: {w}" for w in words if w in text]
    assert found == []


# ---- 1回目のレビューの直し ----


def test_db_settings_do_not_need_jwt_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """マイグレーション・ダミーデータは、JWT の鍵がなくても DB につなげる"""
    from app.config import DbSettings

    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    s = DbSettings(  # pyright: ignore[reportCallIssue]
        _env_file=None, postgres_db="x", postgres_user="x", postgres_password="x"
    )
    assert s.database_url().database == "x"


def test_env_example_has_no_usable_jwt_key() -> None:
    """見本のファイルの鍵は空（見本の値のまま起動して、公開の鍵で署名しない）"""
    lines = (REPO_ROOT / "env.example").read_text(encoding="utf-8").splitlines()
    values = [line.split("=", 1)[1] for line in lines if line.startswith("JWT_SECRET_KEY=")]
    assert values == [""]


# ---- 2回目のレビューの直し ----


@pytest.mark.parametrize("minutes", [0, 1441, 99_999_999_999])
def test_expiry_minutes_out_of_range_is_rejected(minutes: int) -> None:
    """有効期限は 1〜1440分。大きすぎる値はログインの日時の計算で 500 になるので、起動で断る"""
    with pytest.raises(ValidationError):
        settings_with(jwt_secret_key="a" * 32, access_token_expire_minutes=minutes)


def test_expiry_minutes_of_one_day_is_ok() -> None:
    assert settings_with(jwt_secret_key="a" * 32, access_token_expire_minutes=1440)
