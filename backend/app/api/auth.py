"""ログイン（SC3-12）。メールアドレスとパスワードが合えば、トークン（JWT）を返す。

- 失敗の理由（メールアドレスがない・パスワードが違う・無効な利用者・パスワード未設定の
  「!」）は区別せず、同じ 401。失敗の回数の制限はまだない（SC3-36）
- どの経路でもパスワードの照合を1回だけ行う（app.security.verify_password）
- 成功も失敗も監査ログに残す。入力されたメールアドレス・パスワード・トークンは残さない
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select

from app import security
from app.api.ecus import client_ip
from app.config import Settings
from app.deps import Db, get_settings_dep
from app.models import AuditLog, User
from app.schemas import LoginIn, TokenOut

router = APIRouter(prefix="/api/auth", tags=["auth"])

FAILED = "メールアドレスかパスワードが違います"


@router.post("/login")
def login(
    body: LoginIn,
    request: Request,
    db: Db,
    settings: Annotated[Settings, Depends(get_settings_dep)],
) -> TokenOut:
    # メールアドレスは大文字・小文字を区別しない（users の一意の索引も lower(email)）
    user = db.scalars(
        select(User).where(func.lower(User.email) == func.lower(body.email))
    ).one_or_none()
    ok = security.verify_password(body.password, user.password_hash if user else None)
    ok = ok and user is not None and user.is_active

    action = "login_succeeded" if ok else "login_failed"
    user_id = user.id if user else None
    target = f"user:{user_id}" if user_id else "user:unknown"
    db.add(AuditLog(user_id=user_id, action=action, target=target, ip=client_ip(request)))
    db.commit()

    if not ok or user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=FAILED)
    return TokenOut(
        access_token=security.create_access_token(user.id, settings),
        expires_in=settings.access_token_expire_minutes * 60,
    )
