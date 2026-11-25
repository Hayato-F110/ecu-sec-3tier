"""パスワード（bcrypt）とトークン（JWT）。

- パスワードは bcrypt のハッシュだけを DB に置く（守りの決まり6）
- トークンは HS256 で署名した JWT。中身は利用者の番号（sub）と期限（exp）だけ
"""

from datetime import UTC, datetime, timedelta
from functools import cache

import jwt
from pwdlib import PasswordHash
from pwdlib.exceptions import PwdlibError
from pwdlib.hashers.bcrypt import BcryptHasher

from app.config import Settings

ALGORITHM = "HS256"
# bcrypt が扱えるのは 72バイトまで（bcrypt 5 は超えると切り捨てずに ValueError）
MAX_PASSWORD_BYTES = 72
# ダミーデータの「ログインできない」印（app.seed）。ハッシュの形をしていないので、どの値とも合わない
LOCKED = "!"

_hasher = PasswordHash((BcryptHasher(),))


def hash_password(password: str) -> str:
    """bcrypt のハッシュ（塩は毎回ちがう）。72バイトを超えると ValueError。"""
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise ValueError(f"パスワードは {MAX_PASSWORD_BYTES} バイトまで")
    return _hasher.hash(password)


def verify_hash(password: str, password_hash: str) -> bool:
    """1回の照合。ハッシュの形が壊れていても例外にせず「合わない」とする。"""
    try:
        return _hasher.verify(password, password_hash)
    except PwdlibError, ValueError:
        return False


@cache
def _dummy_hash() -> str:
    # 照合の相手がいないときに使う。最初に使うときに1回だけ計算する
    return _hasher.hash("dummy-password-for-timing")


def verify_password(password: str, password_hash: str | None) -> bool:
    """利用者のパスワードを確かめる。どの経路でも bcrypt の照合をちょうど1回だけ行う。

    利用者がいない・ロック（"!"）・72バイト超でも、ダミーのハッシュと照合してから False を返す。
    照合を飛ばすと、応答の速さで「そのメールアドレスの利用者がいるか」が分かってしまう
    （C 言語でいう、memcmp の早期 return で比較時間から一致した長さが漏れるのと同じ）。
    """
    fits = len(password.encode("utf-8")) <= MAX_PASSWORD_BYTES
    usable = password_hash is not None and password_hash != LOCKED
    target = password_hash if (usable and fits) else _dummy_hash()
    candidate = password if fits else ""
    matched = verify_hash(candidate, target)  # pyright: ignore[reportArgumentType]
    return matched and usable and fits


def create_access_token(user_id: int, settings: Settings) -> str:
    expire = datetime.now(UTC) + timedelta(minutes=settings.access_token_expire_minutes)
    claims = {"sub": str(user_id), "exp": expire}
    return jwt.encode(claims, settings.jwt_secret_key.get_secret_value(), algorithm=ALGORITHM)


def user_id_from_token(token: str, settings: Settings) -> int | None:
    """署名・期限・形を確かめて、利用者の番号を返す。どこかがおかしければ None。"""
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret_key.get_secret_value(),
            algorithms=[ALGORITHM],  # 1つだけ許す（"none" や別の方式の偽造を通さない）
            options={"require": ["exp", "sub"]},
        )
    except jwt.InvalidTokenError:
        return None
    sub = claims["sub"]
    # 半角の数字だけ、18桁まで（BIGINT に収まる）。"0"・"-1"・全角・空白は断る
    if not (isinstance(sub, str) and sub.isascii() and sub.isdigit() and len(sub) <= 18):
        return None
    user_id = int(sub)
    return user_id if user_id >= 1 else None
