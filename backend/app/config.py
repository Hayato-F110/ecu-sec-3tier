"""設定。値はリポジトリの直下の .env（Git の対象外）と環境変数から読む。

コードに接続先やパスワードを直書きしない。
AWS では同じ名前の値を SSM Parameter Store から渡す（Phase 3）。
"""

from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL

# backend/app/config.py → リポジトリの直下
REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    # 環境変数が .env より優先される（CI や AWS では環境変数で渡す）
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    postgres_db: str
    postgres_user: str
    # SecretStr：print やログに出しても「**********」になる
    postgres_password: SecretStr
    # localhost にすると Windows では IPv6（::1）を先に試し、断られるまで約2秒待つ。
    # docker compose は 127.0.0.1 で待ち受けているので、それに合わせる
    postgres_host: str = "127.0.0.1"
    postgres_port: int = 5432

    def database_url(self, database: str | None = None) -> URL:
        """接続先。database を渡すと、その DB（テスト用など）に向ける。"""
        return URL.create(
            "postgresql+psycopg",
            username=self.postgres_user,
            password=self.postgres_password.get_secret_value(),
            host=self.postgres_host,
            port=self.postgres_port,
            database=database or self.postgres_db,
        )


def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]（値は .env・環境変数から入る）
