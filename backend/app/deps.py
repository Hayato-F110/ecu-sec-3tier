"""API の共通の部品：DB の接続、本人確認、会社ごとの絞り込み。

調べる順番（docs/test-plans/SC3-9.md）：ログイン（401）→ メーカーか（403）→ 自社の ECU か（404）
→ 役割（403）。FastAPI は依存（Depends）を、本文の形の検査（422）より先に解くので、
本文が壊れていても、他社の ECU には 404 が先に返る。
"""

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Path, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Ecu, User

SUPPLIER_ROLES = ("supplier_admin", "editor", "approver")
# PostgreSQL の BIGINT の上限。これを超える番号を DB に渡すとエラー（500）になるので、入口で止める
BIGINT_MAX = 2**63 - 1


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as session:
        yield session


Db = Annotated[Session, Depends(get_db)]


def current_user(
    db: Db,
    settings: Annotated[Settings, Depends(get_settings_dep)],
    x_dev_user_id: Annotated[str | None, Header()] = None,
) -> User:
    """仮の本人確認（Day 6 に JWT へ差し替える）。どの理由で断っても同じ 401 を返す。"""
    unauthorized = HTTPException(status.HTTP_401_UNAUTHORIZED, detail="ログインが必要です")
    if not settings.dev_auth_enabled or x_dev_user_id is None:
        raise unauthorized
    # 半角の数字だけ、18桁まで（BIGINT に収まる）。"-1"・全角の数字・空は断る
    if not (x_dev_user_id.isascii() and x_dev_user_id.isdigit() and len(x_dev_user_id) <= 18):
        raise unauthorized
    user = db.get(User, int(x_dev_user_id))
    if user is None or not user.is_active:
        raise unauthorized
    return user


def supplier_user(user: Annotated[User, Depends(current_user)]) -> User:
    """サプライヤ用の API。メーカーの利用者は ECU を探す前に 403（ECU の有無を明かさない）。"""
    if user.role not in SUPPLIER_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="この操作はできません")
    return user


SupplierUser = Annotated[User, Depends(supplier_user)]
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


def editor_of_own_ecu(ecu: OwnEcu, user: SupplierUser) -> tuple[Ecu, User]:
    """下書きを保存できるのは入力者だけ。自社の ECU かを先に調べる（404 → 403 の順）。"""
    if user.role != "editor":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="この操作はできません")
    return ecu, user
