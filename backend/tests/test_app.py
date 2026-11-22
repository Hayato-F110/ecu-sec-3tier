"""アプリの入口のテスト（docs/test-plans/SC3-9.md の #13）。"""

from tests.api_helpers import Api


def test_docs_and_openapi_are_available(api: Api) -> None:
    assert api.client.get("/docs").status_code == 200
    spec = api.client.get("/openapi.json")
    assert spec.status_code == 200
    paths = spec.json()["paths"]
    assert {"/api/ecus", "/api/ecus/{ecu_id}/assessment", "/api/ecus/{ecu_id}/draft"} <= set(paths)
