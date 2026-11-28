"""役割ごとの権限と会社ごとのデータ分離（docs/test-plans/SC3-13.md。SC3-13・SC3-34）。

期待値は tests/permissions_table.py の表。新しい API はその表に行を足す（#2 が強いる）。
「何も変わらない」は DB 全体（版・入力・監査ログの件数）のスナップショットで比べる。
"""

import re
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ROLES, Assessment, Company, Ecu, User
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
    # 表の役割は、アプリの全部の役割（DB の制約と同じ一覧）をちょうど持つ。役割を足したら表も直す
    assert set(SUPPLIER_ROLES + OEM_ROLES) == set(ROLES)
    for route in ROUTES:
        assert set(route.allowed) == set(ROLES), route.path
    # #1 で呼ぶ利用者も、全部の役割をちょうど持つ
    assert {role_of(api, e) for e in A_USERS + OEM_USERS} == set(ROLES)
    # #3・#5 で他社として呼ぶ B 社の利用者も、サプライヤの全部の役割を持つ
    assert {role_of(api, e) for e in B_USERS} == set(SUPPLIER_ROLES)


@pytest.mark.parametrize("route", PARAM_ROUTES, ids=PARAM_IDS)
def test_routes_with_ids_say_how_to_reach_other_company_data(api: Api, route: Route) -> None:
    """URL に番号を持つ API には、他社のデータの作り方と、存在しない番号がある（決まり7）。"""
    assert route.foreign is not None, route.path
    assert route.missing is not None, route.path
    cases = route.foreign(api.session)
    assert cases, route.path
    for email, params in cases:
        caller = api.user(email)
        assert caller.company_id != api.user(A_USERS[0]).company_id
        # 対象は DB に本当にあり、持ち主は呼ぶ人と別のサプライヤ
        # （存在しない番号どうしの比べで空回りしない）
        ecu = api.session.get(Ecu, params["ecu_id"])
        assert ecu is not None, (route.path, params)
        assert ecu.supplier_id != caller.company_id, (route.path, params)
        owner = api.session.get(Company, ecu.supplier_id)
        assert owner is not None and owner.type == SUPPLIER, (route.path, params)
    # 会社の種類が食い違う利用者で試す番号（#9）も、URL の番号を全部埋める
    names = set(re.findall(r"{(\w+)}", route.path))
    for params in route.probes(api.session):
        assert set(params) == names, (route.path, params)


def test_routes_with_ids_use_ecu_id() -> None:
    """#3 の前提の確かめ（A 社の ECU の全部の形）は ECU の番号の形だけ。
    ほかの番号（コメントの番号など）の API を足したら、#3 にその形の前提の確かめを足す。
    """
    for route in PARAM_ROUTES:
        assert set(re.findall(r"{(\w+)}", route.path)) == {"ecu_id"}, route.path


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
    # 形が本当にそろっている：最新の版の状態が、承認済み・承認待ち・差し戻し・下書き、
    # と版なし（None）
    latest = set()
    for _, p in cases:
        newest = api.session.scalars(
            select(Assessment)
            .where(Assessment.ecu_id == p["ecu_id"])
            .order_by(Assessment.version.desc())
        ).first()
        latest.add(newest.status if newest else None)
    assert latest == {"approved", "pending", "rejected", "draft", None}
    before = snapshot(api.session)
    for email, params in cases:
        res = call(api, route, params, api.headers(email))
        assert res.status_code == route.foreign_status, (email, params, res.text)
    assert snapshot(api.session) == before


def test_foreign_status_is_403_only_for_oem_routes() -> None:
    """403 にしてよいのは、サプライヤが ECU を探す前に断られるメーカー用の API だけ。
    サプライヤ用の API で他社に 403 を返すと、存在が漏れる（決まり2）"""
    for route in PARAM_ROUTES:
        assert route.foreign_status == (403 if route.kind == OEM else 404), route.path


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
        assert other.status_code == none.status_code == route.foreign_status
        assert other.content == none.content
        assert other.headers.get("content-type") == none.headers.get("content-type")


# ---- #6 問い合わせの値を書き換える攻撃 ----


@pytest.mark.parametrize("path", ["/api/ecus", "/api/ecus/{ecu_id}/assessment"])
def test_query_parameters_do_not_widen_scope(api: Api, path: str) -> None:
    b = company_named_like(api.session, SUPPLIER, "b")
    url = path.format(ecu_id=ecu_by_part_no(api.session, "DMY-A004").id)
    plain = api.get(url, A_USERS[0])
    assert plain.status_code == 200
    if path == "/api/ecus":
        # 比べる元の応答そのものが自社の ECU だけ（全社の一覧どうしの比べで通らない）
        a = api.user(A_USERS[0]).company_id
        own = set(api.session.scalars(select(Ecu.id).where(Ecu.supplier_id == a)))
        assert {row["id"] for row in plain.json()} == own
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


@pytest.mark.parametrize(
    "route",
    [r for r in ROUTES if r.writes and not r.path.endswith("/draft")],
    ids=lambda r: f"{r.method} {r.path}",
)
def test_extra_fields_in_other_write_bodies_are_422(api: Api, route) -> None:
    """下書きの保存以外の書き込み（申請・承認・差し戻し）でも、他社の番号などの余計な欄は 422"""
    b = company_named_like(api.session, SUPPLIER, "b")
    b_ecu = api.session.scalars(select(Ecu).where(Ecu.supplier_id == b.id)).first()
    assert b_ecu is not None
    role = next(r for r, code in route.allowed.items() if code == 200)
    # メーカー用の API（確認）は、メーカーの利用者で呼ぶ
    email = next(e for e in A_USERS + OEM_USERS if e.split("@")[0].endswith(f"-{role}"))
    base = route.body(api.session) if route.body else {}
    url = route.url(route.own(api.session))
    before = snapshot(api.session)
    for extra in ({"ecu_id": b_ecu.id}, {"supplier_id": b.id}, {"company_id": b.id}):
        res = api.client.request(route.method, url, json=base | extra, headers=api.headers(email))
        assert res.status_code == 422, (extra, res.text)
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
