"""テストの共通の準備。

開発用の DB（.env の POSTGRES_DB）には触らず、同じ PostgreSQL にテスト専用の DB を作り直して使う。
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import URL, Connection, Engine, create_engine, text

from app.config import get_settings

TEST_DB = "ecu_sec_test"
BACKEND_DIR = Path(__file__).resolve().parents[1]


def alembic_config(url: URL) -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    # env.py はこの値があれば .env の DB ではなく、ここに向ける
    cfg.attributes["url"] = url
    return cfg


def recreate_test_database(name: str) -> URL:
    """テスト専用の DB を空にして作り直す。名前はこのファイルの定数だけ（外から受け取らない）。"""
    if not name.startswith(TEST_DB):
        raise ValueError(f"テスト用以外の DB は作り直さない：{name}")
    settings = get_settings()
    # DB の作成・削除はトランザクションの外で行う必要がある（AUTOCOMMIT）
    admin = create_engine(settings.database_url(), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    admin.dispose()
    return settings.database_url(name)


@pytest.fixture(scope="session")
def test_url() -> URL:
    return recreate_test_database(TEST_DB)


@pytest.fixture(scope="session")
def engine(test_url: URL) -> Iterator[Engine]:
    command.upgrade(alembic_config(test_url), "head")
    eng = create_engine(test_url)
    yield eng
    eng.dispose()


@pytest.fixture
def conn(engine: Engine) -> Iterator[Connection]:
    """テストごとのトランザクション。終わったら取り消すので、テスト同士が影響しない。"""
    with engine.connect() as connection:
        tx = connection.begin()
        yield connection
        tx.rollback()
