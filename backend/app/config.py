"""設定。値はリポジトリの直下の .env（Git の対象外）と環境変数から読む。

コードに接続先やパスワードを直書きしない。
AWS では同じ名前の値を SSM Parameter Store から渡す（Phase 3）。
"""

from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL

# backend/app/config.py → リポジトリの直下
REPO_ROOT = Path(__file__).resolve().parents[2]
MIN_KEY_BYTES = 32


class DbSettings(BaseSettings):
    """DB の接続先だけ。マイグレーション（Alembic）・ダミーデータ・テストの準備はこれだけを読む
    （JWT の鍵がなくても動く）。"""

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


class Settings(DbSettings):
    """API が使う設定（DB の接続先＋認証）。"""

    # トークン（JWT）に署名する鍵。既定の値は置かない（鍵がなければ起動しない）。
    # HS256 の鍵は 32バイト以上（RFC 7518 3.2：ハッシュの長さ以上）
    jwt_secret_key: SecretStr
    # トークンの有効期限（分）。切れたらログインし直す。
    # 上限は1日：取り消しの仕組みがないので長くしない（大きすぎる値は日時の計算で 500 にもなる）
    access_token_expire_minutes: int = Field(default=30, ge=1, le=1440)

    @field_validator("jwt_secret_key")
    @classmethod
    def key_is_long_enough(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value().encode("utf-8")) < MIN_KEY_BYTES:
            # 値そのものはエラーに出さない
            raise ValueError(f"JWT_SECRET_KEY は {MIN_KEY_BYTES} バイト以上にしてください")
        return value


def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]（値は .env・環境変数から入る）


def get_db_settings() -> DbSettings:
    return DbSettings()  # pyright: ignore[reportCallIssue]（値は .env・環境変数から入る）
