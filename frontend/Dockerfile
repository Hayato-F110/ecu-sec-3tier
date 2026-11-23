# 画面のコンテナ。2段階で作る：Node で画面をビルドし、できた静的なファイルだけを nginx に載せる
# （Node や依存のパッケージは最終のコンテナに入らない＝小さく、攻撃に使える道具が少ない）

# 1段階目：ビルド。Node 26（LTS、2026-11-23 に nodejs.org で確かめた）
FROM node:26.13.1-alpine AS build
WORKDIR /app
# 依存を先に入れる（package*.json が変わらなければ、この層は作り直さない）
COPY package.json package-lock.json .npmrc ./
# lockfile のとおりに入れる（版が勝手に変わらない）
RUN npm ci
COPY . .
RUN npm run build

# 2段階目：配る。nginx 1.30（安定版、2026-11-23 に nginx.org で確かめた）
FROM nginx:1.30.7-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
