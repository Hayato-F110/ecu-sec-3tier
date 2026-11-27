"""API のテストの共通の準備（tests/conftest.py から読み込む）。

- ダミーデータ（app.seed）を入れた DB を、テストごとのトランザクションの中で使う（終わると取り消す）
- 本物のトークン（JWT）をテストの中で設定の鍵で署名して作り、`Authorization: Bearer` で API を呼ぶ。
  毎回ログインすると bcrypt の計算で遅くなるため（ログインそのものは test_api_auth.py で確かめる）
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
    """テストから API を呼ぶ道具。email を渡すと、その人のトークンを付ける。"""

    client: Any  # fastapi.testclient.TestClient
    session: Session

    def user(self, email: str) -> User:
        return self.session.scalars(select(User).where(User.email == email)).one()

    def ecu(self, part_no: str) -> Ecu:
        return self.session.scalars(select(Ecu).where(Ecu.part_no == part_no)).one()

    def headers_for(self, user: User) -> dict[str, str]:
        from app.config import get_settings
        from app.security import create_access_token

        return {"Authorization": f"Bearer {create_access_token(user.id, get_settings())}"}

    def headers(self, email: str | None) -> dict[str, str]:
        return self.headers_for(self.user(email)) if email else {}

    def get(self, path: str, email: str | None = None, headers: dict | None = None):
        return self.client.get(path, headers=headers or self.headers(email))

    def put(self, path: str, body: object, email: str | None = None, headers: dict | None = None):
        return self.client.put(path, json=body, headers=headers or self.headers(email))

    def post(
        self,
        path: str,
        body: object = None,
        email: str | None = None,
        headers: dict | None = None,
    ):
        """body が None なら本文なしで送る（申請・承認は本文なしで呼ぶ）"""
        return self.client.post(path, json=body, headers=headers or self.headers(email))


@pytest.fixture
def db_session(conn: Connection) -> Iterator[Session]:
    with Session(bind=conn, join_transaction_mode="create_savepoint") as session:
        seed(session)
        session.commit()
        yield session


def make_api(session: Session) -> Api:
    from fastapi.testclient import TestClient

    from app.config import get_settings
    from app.deps import get_db
    from app.main import create_app

    app = create_app(get_settings())

    def override_db() -> Iterator[Session]:
        yield session

    app.dependency_overrides[get_db] = override_db
    return Api(TestClient(app), session)


@pytest.fixture
def api(db_session: Session) -> Api:
    return make_api(db_session)
