"""テストの共通の準備。

開発用の DB（.env の POSTGRES_DB）には触らず、同じ PostgreSQL にテスト専用の DB を作り直して使う。
"""

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import URL, Connection, Engine, create_engine, text

from app.config import get_db_settings

# API のテストの準備（db_session・api）
pytest_plugins = ["tests.api_helpers"]

TEST_DB = "ecu_sec_test"

# テスト用の JWT の鍵（本物の鍵ではない）。環境変数は .env より優先されるので、手元の .env の値に
# テストが左右されない。設定を読む前（このファイルを読み込んだ時点）に入れる
TEST_JWT_SECRET_KEY = "test-only-jwt-secret-key-0123456789abcdef"  # noqa: S105
os.environ["JWT_SECRET_KEY"] = TEST_JWT_SECRET_KEY
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
    settings = get_db_settings()
    # DB の作成・削除はトランザクションの外で行う必要がある（AUTOCOMMIT）
    # 管理用の DB（postgres）につないで作り直す。開発用の DB につなぐと、POSTGRES_DB が
    # テスト用の名前のとき（CI など）に「つないでいる DB は消せない」で落ちる
    admin = create_engine(settings.database_url("postgres"), isolation_level="AUTOCOMMIT")
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
