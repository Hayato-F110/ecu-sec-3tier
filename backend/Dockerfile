# API（処理の層）のコンテナ。uv の公式の手順に合わせる：
# https://docs.astral.sh/uv/guides/integration/docker/
FROM python:3.14-slim

# uv は版を固定して入れる（公式：「pin to a specific uv version」）
COPY --from=ghcr.io/astral-sh/uv:0.13.9 /uv /uvx /bin/

# 起動を速くするため事前にコンパイル／キャッシュを使うときの警告を消す／開発用の依存は入れない／
# Python は image のものを使う（uv にダウンロードさせない）
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_DEV=1 \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

# 依存だけを先に入れる（コードを変えても、この層は作り直さずに済む）
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-project

# コードを写し、lock と pyproject.toml が食い違っていないことを確かめて入れる
COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked

# root ではない利用者で動かす（乗っ取られても、コンテナの中でできることを減らす）
RUN useradd --system --no-create-home app
USER app

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
# アプリは関数で作る（app/main.py）ので --factory
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
