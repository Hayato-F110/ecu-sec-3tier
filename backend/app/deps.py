"""API の共通の部品：DB の接続、本人確認、会社ごとの絞り込み。

調べる順番（docs/test-plans/SC3-9.md・SC3-13.md）：ログイン（401）→ 会社の種類と役割が合うか（403）
→ 自社の ECU か（404）→ 操作の役割（403）。
FastAPI は依存（Depends）を、本文の形の検査（422）より先に解くので、
本文の形が誤っていても、他社の ECU には 404 が先に返る。
ただし JSON として読めない本文は、依存より前に 422 になる
（どの ECU でも同じ応答なので、存在は漏れない）。
"""

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, HTTPException, Path, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Company, Ecu, User
from app.security import user_id_from_token

SUPPLIER_ROLES = ("supplier_admin", "editor", "approver")
# PostgreSQL の BIGINT の上限。これを超える番号を DB に渡すとエラー（500）になるので、入口で止める
BIGINT_MAX = 2**63 - 1


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as session:
        yield session


Db = Annotated[Session, Depends(get_db)]


# auto_error=False：ヘッダーがないときも FastAPI の既定の応答にせず、下で同じ 401 を返す
bearer = HTTPBearer(auto_error=False)


def current_user(
    db: Db,
    settings: Annotated[Settings, Depends(get_settings_dep)],
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> User:
    """本人確認（Authorization: Bearer のトークン）。どの理由で断っても同じ 401 を返す。

    期限切れ・署名の誤り・利用者がいない・無効な利用者を区別しない（理由を明かさない）。
    """
    unauthorized = HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        detail="ログインが必要です",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if credentials is None:
        raise unauthorized
    user_id = user_id_from_token(credentials.credentials, settings)
    if user_id is None:
        raise unauthorized
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise unauthorized
    return user


def supplier_user(user: Annotated[User, Depends(current_user)], db: Db) -> User:
    """サプライヤ用の API。サプライヤの会社の、サプライヤの役割の利用者だけ。

    役割に加えて会社の種類も確かめる（SC3-34。役割と会社の種類が合うことは DB の制約で守っていない。
    メーカーの会社に「入力者」ができても、サプライヤ用の API を通さない）。
    それ以外の利用者は ECU を探す前に 403（ECU の有無を明かさない）。
    """
    company = db.get(Company, user.company_id)
    if user.role not in SUPPLIER_ROLES or company is None or company.type != "supplier":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="この操作はできません")
    return user


SupplierUser = Annotated[User, Depends(supplier_user)]

OEM_ROLES = ("sys_admin", "reviewer")


def oem_user(user: Annotated[User, Depends(current_user)], db: Db) -> User:
    """メーカー用の API。メーカーの会社のシステム管理者・確認者だけ。

    役割に加えて会社の種類も確かめる（役割と会社の種類が合うことは DB の制約で守っていない。
    サプライヤの会社に「確認者」ができても、全社のデータを読ませない）。
    URL に番号のない API なので、隠す相手がなく、404 ではなく 403（docs/test-plans/SC3-11.md）。
    """
    company = db.get(Company, user.company_id)
    if user.role not in OEM_ROLES or company is None or company.type != "oem":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="この操作はできません")
    return user


OemUser = Annotated[User, Depends(oem_user)]
EcuId = Annotated[int, Path(ge=1, le=BIGINT_MAX)]


def own_ecu(ecu_id: EcuId, user: SupplierUser, db: Db) -> Ecu:
    """ログインした人の会社の ECU だけを返す。他社の ECU も、存在しない番号も、同じ 404。"""
    ecu = db.scalars(
        select(Ecu).where(Ecu.id == ecu_id, Ecu.supplier_id == user.company_id)
    ).one_or_none()
    if ecu is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="見つかりません")
    return ecu


OwnEcu = Annotated[Ecu, Depends(own_ecu)]


def any_ecu(ecu_id: EcuId, user: OemUser, db: Db) -> Ecu:
    """メーカーには全社の ECU が見える（隠す相手がない）。存在しない番号だけが 404。
    サプライヤは oem_user で ECU を探す前に 403（他社の ECU でも、ない番号でも同じ応答）"""
    ecu = db.get(Ecu, ecu_id)
    if ecu is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="見つかりません")
    return ecu


AnyEcu = Annotated[Ecu, Depends(any_ecu)]


def reviewer_of_ecu(ecu: AnyEcu, user: OemUser) -> tuple[Ecu, User]:
    """確認完了・修正依頼ができるのは確認者だけ（システム管理者は読むだけ）。404 → 403 の順"""
    if user.role != "reviewer":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="この操作はできません")
    return ecu, user


def editor_of_own_ecu(ecu: OwnEcu, user: SupplierUser) -> tuple[Ecu, User]:
    """下書きを保存できるのは入力者だけ。自社の ECU かを先に調べる（404 → 403 の順）。"""
    if user.role != "editor":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="この操作はできません")
    return ecu, user


def approver_of_own_ecu(ecu: OwnEcu, user: SupplierUser) -> tuple[Ecu, User]:
    """承認・差し戻しができるのは承認者だけ。自社の ECU かを先に調べる（404 → 403 の順）。
    申請者本人かどうか（職務分離）は、状態を確かめたあとに API の中で調べる"""
    if user.role != "approver":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="この操作はできません")
    return ecu, user
