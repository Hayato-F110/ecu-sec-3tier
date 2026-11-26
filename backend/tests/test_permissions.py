"""役割ごとの権限と会社ごとのデータ分離（docs/test-plans/SC3-13.md。SC3-13・SC3-34）。

期待値は tests/permissions_table.py の表。新しい API はその表に行を足す（#2 が強いる）。
「何も変わらない」は DB 全体（版・入力・監査ログの件数）のスナップショットで比べる。
"""

from datetime import UTC, datetime, timedelta

import jwt
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Assessment, Company, Ecu, User
from app.seed import LOCKED_PASSWORD
from tests.api_helpers import Api
from tests.conftest import TEST_JWT_SECRET_KEY
from tests.permissions_table import (
    A_SHAPES,
    A_USERS,
    B_USERS,
    OEM,
    OEM_ROLES,
    OEM_USERS,
    PUBLIC,
    ROUTES,
    SUPPLIER,
    SUPPLIER_ROLES,
    Route,
    company_named_like,
    ecu_by_part_no,
)
from tests.test_api_ecus import snapshot
from tests.test_auth import api_routes

ROUTE_IDS = [f"{r.method} {r.path}" for r in ROUTES]
PARAM_ROUTES = [r for r in ROUTES if "{" in r.path]
PARAM_IDS = [f"{r.method} {r.path}" for r in PARAM_ROUTES]


def call(api: Api, route: Route, params: dict, headers: dict):
    url = route.url(params)
    if route.method == "GET":
        return api.client.get(url, headers=headers)
    body = route.body(api.session) if route.body else {}
    return api.client.request(route.method, url, json=body, headers=headers)


def role_of(api: Api, email: str) -> str:
    return api.user(email).role


# ---- #1 権限の表のとおり ----


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize("email", A_USERS + OEM_USERS)
def test_permission_table(api: Api, route: Route, email: str) -> None:
    expected = route.allowed[role_of(api, email)]
    params = route.own(api.session)
    before = snapshot(api.session)
    res = call(api, route, params, api.headers(email))
    assert res.status_code == expected, res.text
    if route.writes and expected >= 400:
        assert snapshot(api.session) == before


# ---- #2 表と登録済みのルートの突き合わせ ----


def test_every_route_is_in_permission_table(api: Api) -> None:
    registered = api_routes(api.client.app.routes)
    assert registered, "登録された API が 0件（たどり方が外れている）"
    in_table = {(r.method, r.path.replace("{ecu_id}", "{ecu}")) for r in ROUTES}
    assert registered - PUBLIC == in_table
    # 表の役割は、全部の役割をちょうど持つ（役割を足したら表も直す）
    for route in ROUTES:
        assert set(route.allowed) == set(SUPPLIER_ROLES + OEM_ROLES), route.path


@pytest.mark.parametrize("route", PARAM_ROUTES, ids=PARAM_IDS)
def test_routes_with_ids_say_how_to_reach_other_company_data(api: Api, route: Route) -> None:
    """URL に番号を持つ API には、他社のデータの作り方と、存在しない番号がある（決まり7）。"""
    assert route.foreign is not None, route.path
    assert route.missing is not None, route.path
    cases = route.foreign(api.session)
    assert cases, route.path
    for email, _params in cases:
        assert api.user(email).company_id != api.user(A_USERS[0]).company_id


def test_there_are_routes_with_ids() -> None:
    """#3・#5 が空で通らない"""
    assert PARAM_ROUTES


# ---- #3 他社のデータは 404 ----


@pytest.mark.parametrize("route", PARAM_ROUTES, ids=PARAM_IDS)
def test_other_company_data_is_404_on_every_route_with_ids(api: Api, route: Route) -> None:
    cases = route.foreign(api.session)  # type: ignore[misc]
    # 前提：A 社の ECU の全部の形（版なしを含む）と、B 社の全部の役割がある
    assert len({p["ecu_id"] for _, p in cases}) == len(A_SHAPES) + 1
    assert {e for e, _ in cases} == set(B_USERS)
    no_version = [
        p
        for _, p in cases
        if not api.session.scalars(
            select(Assessment).where(Assessment.ecu_id == p["ecu_id"])
        ).first()
    ]
    assert no_version, "版なしの ECU がない"
    before = snapshot(api.session)
    for email, params in cases:
        res = call(api, route, params, api.headers(email))
        assert res.status_code == 404, (email, params, res.text)
    assert snapshot(api.session) == before


# ---- #4 一覧は自社の ECU だけ・全部 ----


@pytest.mark.parametrize("email", A_USERS + B_USERS)
def test_list_is_exactly_own_company_ecus(api: Api, email: str) -> None:
    user = api.user(email)
    expected = set(api.session.scalars(select(Ecu.id).where(Ecu.supplier_id == user.company_id)))
    assert expected
    res = api.get("/api/ecus", email)
    assert res.status_code == 200
    assert {row["id"] for row in res.json()} == expected


# ---- #5 番号を数える攻撃：他社のデータと存在しない番号の応答が同じ ----


@pytest.mark.parametrize("route", PARAM_ROUTES, ids=PARAM_IDS)
def test_other_company_looks_the_same_as_missing(api: Api, route: Route) -> None:
    missing = route.missing(api.session)  # type: ignore[misc]
    for email, params in route.foreign(api.session):  # type: ignore[misc]
        headers = api.headers(email)
        other = call(api, route, params, headers)
        none = call(api, route, missing, headers)
        assert other.status_code == none.status_code == 404
        assert other.content == none.content
        assert other.headers.get("content-type") == none.headers.get("content-type")


# ---- #6 問い合わせの値を書き換える攻撃 ----


@pytest.mark.parametrize("path", ["/api/ecus", "/api/ecus/{ecu_id}/assessment"])
def test_query_parameters_do_not_widen_scope(api: Api, path: str) -> None:
    b = company_named_like(api.session, SUPPLIER, "b")
    url = path.format(ecu_id=ecu_by_part_no(api.session, "DMY-A004").id)
    plain = api.get(url, A_USERS[0])
    assert plain.status_code == 200
    for query in (
        f"?company_id={b.id}",
        f"?supplier_id={b.id}",
        f"?company_id={b.id}&supplier_id={b.id}",
    ):
        tampered = api.get(url + query, A_USERS[0])
        assert tampered.status_code == 200
        assert tampered.json() == plain.json(), query


# ---- #7 ヘッダーを書き換える攻撃（見張り。実装が読まないので赤にはならない） ----


@pytest.mark.parametrize("route", [r for r in ROUTES if not r.writes], ids=lambda r: r.path)
def test_extra_headers_do_not_change_anything(api: Api, route: Route) -> None:
    email = A_USERS[0] if route.kind == SUPPLIER else OEM_USERS[1]
    b = company_named_like(api.session, SUPPLIER, "b")
    oem_admin = api.user(OEM_USERS[0])
    params = route.own(api.session)
    plain = call(api, route, params, api.headers(email))
    assert plain.status_code == 200
    assert plain.content not in (b"", b"[]", b"{}")
    tampered = call(
        api,
        route,
        params,
        api.headers(email)
        | {"X-Company-Id": str(b.id), "X-User-Id": str(oem_admin.id), "X-Role": "sys_admin"},
    )
    assert tampered.status_code == plain.status_code
    assert tampered.content == plain.content


# ---- #8 本文・トークンを書き換える攻撃 ----


def test_extra_fields_in_draft_body_are_422_and_change_nothing(api: Api) -> None:
    route = next(r for r in ROUTES if r.path.endswith("/draft"))
    b = company_named_like(api.session, SUPPLIER, "b")
    b_ecu = api.session.scalars(select(Ecu).where(Ecu.supplier_id == b.id)).first()
    b_version = api.session.scalars(
        select(Assessment).join(Ecu).where(Ecu.supplier_id == b.id)
    ).first()
    assert b_ecu is not None and b_version is not None
    base = route.body(api.session)  # type: ignore[misc]
    entry = base["entries"][0]
    bodies = {
        "outer_ecu_id": base | {"ecu_id": b_ecu.id},
        "outer_supplier_id": base | {"supplier_id": b.id},
        "outer_company_id": base | {"company_id": b.id},
        "entry_assessment_id": {"entries": [entry | {"assessment_id": b_version.id}]},
    }
    url = route.url(route.own(api.session))
    before = snapshot(api.session)
    for case, body in bodies.items():
        res = api.put(url, body, A_USERS[0])
        assert res.status_code == 422, case
    assert snapshot(api.session) == before


def test_extra_claims_in_token_are_ignored(api: Api) -> None:
    editor = api.user(A_USERS[0])
    b = company_named_like(api.session, SUPPLIER, "b")
    claims = {
        "sub": str(editor.id),
        "exp": datetime.now(UTC) + timedelta(minutes=10),
        "company_id": b.id,
        "role": "sys_admin",
    }
    forged = {
        "Authorization": f"Bearer {jwt.encode(claims, TEST_JWT_SECRET_KEY, algorithm='HS256')}"
    }
    plain = api.get("/api/ecus", A_USERS[0])
    res = api.get("/api/ecus", headers=forged)
    assert res.status_code == 200
    assert res.json() == plain.json()
    assert api.get("/api/matrix", headers=forged).status_code == 403


# ---- #9 SC3-34：役割と会社の種類が食い違う利用者 ----


def odd_user(s: Session, company: Company, role: str) -> User:
    user = User(
        company_id=company.id,
        email=f"odd-{role}-{company.type}-{company.id}@example.com",
        password_hash=LOCKED_PASSWORD,
        role=role,
    )
    s.add(user)
    s.commit()
    return user


ODD = [(OEM, role) for role in SUPPLIER_ROLES] + [(SUPPLIER, role) for role in OEM_ROLES]


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
@pytest.mark.parametrize(("company_kind", "role"), ODD)
def test_role_and_company_type_must_match(
    api: Api, route: Route, company_kind: str, role: str
) -> None:
    company = company_named_like(
        api.session, company_kind, "a" if company_kind == SUPPLIER else None
    )
    user = odd_user(api.session, company, role)
    headers = api.headers_for(user)
    probes = route.probes(api.session)
    assert probes
    before = snapshot(api.session)
    for params in probes:
        res = call(api, route, params, headers)
        assert res.status_code == 403, (params, res.text)
    assert snapshot(api.session) == before
