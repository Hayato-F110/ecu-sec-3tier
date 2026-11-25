"""Alembic の実行の設定。

接続先は app/config.py（.env の POSTGRES_*）から組み立てる。alembic.ini にパスワードを書かない。
テストは config.attributes["url"] でテスト用の DB に向ける（tests/conftest.py）。

alembic.ini の設定（コメントは英語だけにしている。
Windows では cp932 で読まれ、日本語で止まるため）：
- file_template：変更履歴のファイル名の先頭に日時を付け、作った順に並ぶようにする
- timezone：その日時を日本時間にする
- sqlalchemy.url：使わない（パスワードを Git に入れないため、ここで .env から組み立てる）
- hooks：作った変更履歴を ruff で整える
"""

from alembic import context
from sqlalchemy import create_engine, pool

from app.config import get_db_settings
from app.models import Base

config = context.config
target_metadata = Base.metadata


def database_url():
    return config.attributes.get("url") or get_db_settings().database_url()


def run_migrations_offline() -> None:
    """DB につながずに SQL の文を出力する（alembic upgrade head --sql）。"""
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # 既定値の違いも、モデルと変更履歴の差として見つける
            compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
