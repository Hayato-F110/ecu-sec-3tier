"""DB への接続。"""

from sqlalchemy import URL, Engine, create_engine
from sqlalchemy.orm import sessionmaker

from app.config import get_settings


def make_engine(url: URL | None = None) -> Engine:
    # pool_pre_ping：使う前に接続が生きているか確かめる（DB の再起動のあとも動く）
    return create_engine(url or get_settings().database_url(), pool_pre_ping=True)


def make_session_factory(engine: Engine) -> sessionmaker:
    return sessionmaker(bind=engine, expire_on_commit=False)
