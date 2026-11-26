"""API がほかのサイトからの呼び出し（CORS）を許していないことを見張る（docs/test-plans/SC3-42.md）。

CORS（ブラウザが、別のサイトの画面から API の応答を読むのを許すかの決まり）：
応答に `Access-Control-Allow-Origin` などが付いていなければ、
ブラウザは別のサイトの画面に応答を読ませない。
今は画面と API を同じ入口（nginx）から配るので、CORS の許可は要らない。
だれかが緩い設定（`allow_origins=["*"]` など）を足したら、ここで落ちる。
"""

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.api_helpers import Api
from tests.test_auth import api_routes

EVIL = "https://evil.example"
OWN_ECU = "DMY-A004"  # A 社の ECU（入力者が読める）
EDITOR = "a-editor@example.com"


def routes(app: FastAPI) -> list[tuple[str, str]]:
    found = sorted(api_routes(app.routes))
    assert found, "API の一覧が空（空のまま通らないように）"
    return found


def cors_headers(res) -> list[str]:
    return [k for k in res.headers if k.lower().startswith("access-control-")]


def simple_request(client: TestClient, api: Api, method: str, path: str):
    """ほかのサイトの画面からの、ログインした人のトークン付きの呼び出し"""
    url = path.replace("{ecu}", str(api.ecu(OWN_ECU).id))
    headers = {**api.headers(EDITOR), "Origin": EVIL}
    body = {} if method in ("POST", "PUT", "PATCH") else None
    return client.request(method, url, headers=headers, json=body)


def preflight(client: TestClient, api: Api, method: str, path: str):
    """ブラウザが本番の呼び出しの前に送る問い合わせ（OPTIONS）"""
    url = path.replace("{ecu}", str(api.ecu(OWN_ECU).id))
    return client.options(
        url,
        headers={
            "Origin": EVIL,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )


def check_no_cors(client: TestClient, api: Api, app: FastAPI) -> None:
    for method, path in routes(app):
        res = simple_request(client, api, method, path)
        assert cors_headers(res) == [], f"#1 {method} {path}: {cors_headers(res)}"
        res = preflight(client, api, method, path)
        assert cors_headers(res) == [], f"#2 {method} {path}: {cors_headers(res)}"
        assert res.status_code != 200, f"#2 {method} {path}: 事前の問い合わせが 200"


# ---- #1・#2 今のアプリは、ほかのサイトに CORS を許していない ----


def test_api_does_not_allow_other_sites(api: Api) -> None:
    check_no_cors(api.client, api, api.client.app)


# ---- #3 上の確かめが、緩い設定を本当に見つけられること ----


@pytest.fixture
def loose_cors_client(db_session: Session) -> Iterator[tuple[TestClient, FastAPI]]:
    from app.config import get_settings
    from app.deps import get_db
    from app.main import create_app

    app = create_app(get_settings())
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    def override_db() -> Iterator[Session]:
        yield db_session

    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as client:
        yield client, app


def test_check_catches_loose_cors(api: Api, loose_cors_client) -> None:
    client, app = loose_cors_client
    with pytest.raises(AssertionError, match="#1"):
        check_no_cors(client, api, app)
    # 事前の問い合わせ（#2）も、緩い設定なら見つかる
    method, path = routes(app)[0]
    res = preflight(client, api, method, path)
    assert cors_headers(res) != []
    assert res.status_code == 200
