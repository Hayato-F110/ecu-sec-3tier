"""API のテストの共通の準備（tests/conftest.py から読み込む）。

- ダミーデータ（app.seed）を入れた DB を、テストごとのトランザクションの中で使う（終わると取り消す）
- 仮の本人確認（X-Dev-User-Id）を有効にしたアプリを、TestClient で呼ぶ
- app.main などはここで読み込まず、使うときに読み込む（API がまだない段階でも、
  DB のテストは読み込みで落ちないように）
"""

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from sqlalchemy import Connection, select
from sqlalchemy.orm import Session

from app.models import Ecu, User
from app.seed import seed


@dataclass
class Api:
    """テストから API を呼ぶ道具。email を渡すと、その人のヘッダーを付ける。"""

    client: Any  # fastapi.testclient.TestClient
    session: Session

    def user(self, email: str) -> User:
        return self.session.scalars(select(User).where(User.email == email)).one()

    def ecu(self, part_no: str) -> Ecu:
        return self.session.scalars(select(Ecu).where(Ecu.part_no == part_no)).one()

    def headers(self, email: str | None) -> dict[str, str]:
        return {"X-Dev-User-Id": str(self.user(email).id)} if email else {}

    def get(self, path: str, email: str | None = None, headers: dict | None = None):
        return self.client.get(path, headers=headers or self.headers(email))

    def put(self, path: str, body: object, email: str | None = None, headers: dict | None = None):
        return self.client.put(path, json=body, headers=headers or self.headers(email))


@pytest.fixture
def db_session(conn: Connection) -> Iterator[Session]:
    with Session(bind=conn, join_transaction_mode="create_savepoint") as session:
        seed(session)
        session.commit()
        yield session


def make_api(session: Session, dev_auth_enabled: bool = True) -> Api:
    from fastapi.testclient import TestClient

    from app.config import get_settings
    from app.deps import get_db
    from app.main import create_app

    settings = get_settings().model_copy(update={"dev_auth_enabled": dev_auth_enabled})
    app = create_app(settings)

    def override_db() -> Iterator[Session]:
        yield session

    app.dependency_overrides[get_db] = override_db
    return Api(TestClient(app), session)


@pytest.fixture
def api(db_session: Session) -> Api:
    return make_api(db_session)
