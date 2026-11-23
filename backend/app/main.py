"""アプリの入口。

起動：uv run uvicorn app.main:create_app --factory
（読み込んだだけで .env を読まないよう、アプリは関数で作る）
"""

from fastapi import FastAPI

from app.api import ecus
from app.config import Settings, get_settings
from app.db import make_engine, make_session_factory


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(
        title="ECU セキュリティ対策状況の管理システム（練習用・ダミーデータ）",
        version="0.1.0",
    )
    app.state.settings = settings
    # 接続はここでは開かない（最初の問い合わせのときに開く）
    app.state.session_factory = make_session_factory(make_engine(settings.database_url()))
    app.include_router(ecus.router)
    return app
