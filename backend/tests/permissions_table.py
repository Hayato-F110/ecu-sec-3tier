"""全部の API の権限の表（docs/test-plans/SC3-13.md）。API の一覧はここだけに置く。

新しい API を足したら、ここに行を足す。足さないと tests/test_permissions.py の #2 が落ちる。
URL に番号を持つ API は、`foreign` に「他社のデータを読もうとする組み合わせ」を必ず書く
（CLAUDE.md 守りの決まり7：新しい API には、他社のユーザーで呼んで 404 になるテストを入れる）。

各行の関数は、テストの DB（ダミーデータ入り）を受け取って、URL の番号や本文を返す。
"""

from collections.abc import Callable
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Company, Ecu, MeasureItem

SUPPLIER = "supplier"
OEM = "oem"
SUPPLIER_ROLES = ("editor", "approver", "supplier_admin")
OEM_ROLES = ("sys_admin", "reviewer")

A_USERS = ("a-editor@example.com", "a-approver@example.com", "a-supplier_admin@example.com")
B_USERS = ("b-editor@example.com", "b-approver@example.com", "b-supplier_admin@example.com")
OEM_USERS = ("oem-sys_admin@example.com", "oem-reviewer@example.com")

# A 社の ECU の形（seed.py）。版なしの ECU は、ダミーデータにないのでテストの中で作る
A_SHAPES = ("DMY-A001", "DMY-A002", "DMY-A003", "DMY-A004")
NO_VERSION_PART_NO = "TEST-A-NOVERSION"
OEM_OWNED_PART_NO = "TEST-OEM-OWNED"

Params = dict[str, int]


def ecu_by_part_no(s: Session, part_no: str) -> Ecu:
    return s.scalars(select(Ecu).where(Ecu.part_no == part_no)).one()


def company_named_like(s: Session, kind: str, letter: str | None = None) -> Company:
    query = select(Company).where(Company.type == kind).order_by(Company.id)
    companies = list(s.scalars(query))
    if letter is None:
        return companies[0]
    found = next((c for c in companies if c.name.endswith(f"{letter.upper()} 社")), None)
    assert found is not None, f"{letter.upper()} 社がない（ダミーデータの会社名の形が変わった？）"
    return found


def make_ecu(s: Session, company: Company, part_no: str) -> Ecu:
    """テストの中で ECU を作る（同じ品番があればそれを返す。持ち主の会社が違えば落とす）。"""
    found = s.scalars(select(Ecu).where(Ecu.part_no == part_no)).one_or_none()
    if found is not None:
        assert found.supplier_id == company.id, f"{part_no} の持ち主が {company.name} ではない"
        return found
    ecu = Ecu(supplier_id=company.id, name=f"テスト {part_no}", part_no=part_no, vehicle_model="X")
    s.add(ecu)
    s.commit()
    return ecu


def missing_ecu_id(s: Session) -> int:
    """存在しない ECU の番号（最大の番号＋1000）。存在しないことを確かめてから返す。"""
    candidate = (s.scalar(select(func.max(Ecu.id))) or 0) + 1000
    assert s.get(Ecu, candidate) is None
    return candidate


def a_ecu_targets(s: Session) -> list[Params]:
    """A 社の ECU の全部の形（版なしを含む）。"""
    a = company_named_like(s, SUPPLIER, "a")
    ecus = [ecu_by_part_no(s, p) for p in A_SHAPES]
    ecus.append(make_ecu(s, a, NO_VERSION_PART_NO))
    return [{"ecu_id": e.id} for e in ecus]


def ecu_foreign(s: Session) -> list[tuple[str, Params]]:
    """B 社の全部の役割 × A 社の ECU の全部の形。"""
    return [(email, target) for email in B_USERS for target in a_ecu_targets(s)]


def ecu_own(s: Session) -> Params:
    # 下書きだけの ECU（承認待ちの版があると保存が 409 になるため）
    return {"ecu_id": ecu_by_part_no(s, "DMY-A004").id}


def ecu_missing(s: Session) -> Params:
    return {"ecu_id": missing_ecu_id(s)}


def ecu_probes(s: Session) -> list[Params]:
    """会社の種類の食い違う利用者で試す番号：A 社の ECU・存在しない番号・持ち主がメーカーの ECU。"""
    oem = company_named_like(s, OEM)
    return [ecu_own(s), ecu_missing(s), {"ecu_id": make_ecu(s, oem, OEM_OWNED_PART_NO).id}]


def ecu_pending(s: Session) -> Params:
    # 入力者が申請した承認待ちの ECU（承認者の承認・差し戻しが 200 になる形）
    return {"ecu_id": ecu_by_part_no(s, "DMY-A002").id}


def reject_body(_s: Session) -> dict:
    return {"reason": "権限のテスト"}


def ecu_unreviewed(s: Session) -> Params:
    # 承認済み（未確認）だけの ECU（確認者の修正依頼が 200 になる形）
    return {"ecu_id": ecu_by_part_no(s, "DMY-A001").id}


def change_request_body(_s: Session) -> dict:
    # DMY-A001 の承認済みの版は v1 だけ
    return {"result": "change_requested", "reason": "権限のテスト", "version": 1}


def draft_body(s: Session) -> dict:
    first_item = s.scalars(select(MeasureItem.id).order_by(MeasureItem.sort_order)).first()
    return {"entries": [{"item_id": first_item, "status": "done", "evidence": "権限のテスト"}]}


def no_params(_s: Session) -> Params:
    return {}


@dataclass(frozen=True)
class Route:
    method: str
    path: str  # 登録されたとおりのパス（例 /api/ecus/{ecu_id}/assessment）
    kind: str  # SUPPLIER（サプライヤの会社だけ）か OEM（メーカーの会社だけ）
    # 自社のデータに対する、役割ごとの期待の状態の番号（会社の種類が合う利用者）
    allowed: dict[str, int]
    own: Callable[[Session], Params] = no_params
    # 他社のデータを読もうとする（呼ぶ人, 番号）の組み合わせ。URL に番号を持つ API では必須
    foreign: Callable[[Session], list[tuple[str, Params]]] | None = None
    # 他社のデータと存在しない番号に返す状態の番号。ふつうは 404。メーカー用の API では、
    # サプライヤは ECU を探す前に 403 になるので 403（どちらでも、他社と存在しない番号で同じ応答）
    foreign_status: int = 404
    missing: Callable[[Session], Params] | None = None
    # 会社の種類が食い違う利用者で試す番号
    probes: Callable[[Session], list[Params]] = field(default=lambda s: [{}])
    body: Callable[[Session], dict] | None = None

    @property
    def writes(self) -> bool:
        return self.method != "GET"

    def url(self, params: Params) -> str:
        return self.path.format(**params)


SUPPLIER_READ = dict.fromkeys(SUPPLIER_ROLES, 200) | dict.fromkeys(OEM_ROLES, 403)

ROUTES: tuple[Route, ...] = (
    Route("GET", "/api/ecus", SUPPLIER, SUPPLIER_READ),
    Route(
        "GET",
        "/api/ecus/{ecu_id}/assessment",
        SUPPLIER,
        SUPPLIER_READ,
        own=ecu_own,
        foreign=ecu_foreign,
        missing=ecu_missing,
        probes=ecu_probes,
    ),
    Route(
        "PUT",
        "/api/ecus/{ecu_id}/draft",
        SUPPLIER,
        {"editor": 200, "approver": 403, "supplier_admin": 403} | dict.fromkeys(OEM_ROLES, 403),
        own=ecu_own,
        foreign=ecu_foreign,
        missing=ecu_missing,
        probes=ecu_probes,
        body=draft_body,
    ),
    Route(
        "POST",
        "/api/ecus/{ecu_id}/submit",
        SUPPLIER,
        {"editor": 200, "approver": 403, "supplier_admin": 403} | dict.fromkeys(OEM_ROLES, 403),
        own=ecu_own,
        foreign=ecu_foreign,
        missing=ecu_missing,
        probes=ecu_probes,
    ),
    Route(
        "POST",
        "/api/ecus/{ecu_id}/approve",
        SUPPLIER,
        {"editor": 403, "approver": 200, "supplier_admin": 403} | dict.fromkeys(OEM_ROLES, 403),
        own=ecu_pending,
        foreign=ecu_foreign,
        missing=ecu_missing,
        probes=ecu_probes,
    ),
    Route(
        "POST",
        "/api/ecus/{ecu_id}/reject",
        SUPPLIER,
        {"editor": 403, "approver": 200, "supplier_admin": 403} | dict.fromkeys(OEM_ROLES, 403),
        own=ecu_pending,
        foreign=ecu_foreign,
        missing=ecu_missing,
        probes=ecu_probes,
        body=reject_body,
    ),
    Route(
        "GET",
        "/api/matrix",
        OEM,
        dict.fromkeys(OEM_ROLES, 200) | dict.fromkeys(SUPPLIER_ROLES, 403),
    ),
    # メーカー用で URL に番号を持つ。サプライヤは ECU を探す前に 403 なので、他社（B 社）から
    # 呼んでも存在しない番号と同じ 403（存在は漏れない。#5 で確かめる）
    Route(
        "POST",
        "/api/matrix/ecus/{ecu_id}/review",
        OEM,
        {"reviewer": 200, "sys_admin": 403} | dict.fromkeys(SUPPLIER_ROLES, 403),
        own=ecu_unreviewed,
        foreign=ecu_foreign,
        foreign_status=403,
        missing=ecu_missing,
        probes=ecu_probes,
        body=change_request_body,
    ),
)

# だれでも呼べる API（権限の表の対象外。test_api_auth.py で確かめる）
PUBLIC = {("POST", "/api/auth/login")}
