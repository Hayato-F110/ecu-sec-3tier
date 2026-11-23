"""アプリの入口。

起動：uv run uvicorn app.main:create_app --factory
（読み込んだだけで .env を読まないよう、アプリは関数で作る）
"""

import logging

from fastapi import FastAPI

from app.api import ecus
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
    return app
