"""アプリの入口。

起動：uv run uvicorn app.main:create_app --factory
（読み込んだだけで .env を読まないよう、アプリは関数で作る）
"""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api import ecus, matrix
from app.config import Settings, get_settings
from app.db import make_engine, make_session_factory

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    if settings.dev_auth_enabled:
        # 有効のまま手元の外へ出すと、ヘッダーに番号を入れるだけで誰にでもなりすませる
        logger.warning(
            "仮の本人確認（X-Dev-User-Id）が有効です。手元の開発専用。"
            "手元の外では DEV_AUTH_ENABLED を false にしてください"
        )
    app = FastAPI(
        title="ECU セキュリティ対策状況の管理システム（練習用・ダミーデータ）",
        version="0.1.0",
    )
    app.state.settings = settings
    # 接続はここでは開かない（最初の問い合わせのときに開く）
    app.state.session_factory = make_session_factory(make_engine(settings.database_url()))
    app.include_router(ecus.router)
    app.include_router(matrix.router)
    app.add_exception_handler(RequestValidationError, validation_error)
    return app


async def validation_error(_request: Request, exc: Exception) -> JSONResponse:
    """入力の誤り（422）。送られた値（input）は応答に入れない。

    既定の応答は送られた値をそのまま返すため、UTF-8 にできない値で 500 になる。
    また、送られたものを返さないほうが、ほかの人の画面にそのまま出る心配もない。
    """
    if not isinstance(exc, RequestValidationError):  # 登録した型でしか呼ばれない
        raise exc
    errors = [{"type": e["type"], "loc": e["loc"], "msg": e["msg"]} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": errors})
