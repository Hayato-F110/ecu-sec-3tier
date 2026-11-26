# 引き継ぎ

最終更新：2026-11-26 19:20

## いまの状態

- スプリント2：完了（11/26 にオーナーが前倒しで完了にした）。設計判断とふりかえりは main に入った（PR #27・#28）
- スプリント3（11/26 19:04〜11/30 23:00、ゴール「会社ごとのデータ分離、承認フロー、メーカーの修正依頼・コメントが動く」）：11件・25ポイント。すべて未着手か進行中
- SC3-13（Day 7）と SC3-34：進行中。**同じ PR で直す**（11/26 にオーナーが決めた）
  - ブランチ `feature/SC3-13-permissions`（push 済み）。テストの一覧 `docs/test-plans/SC3-13.md` だけをコミットした
  - test-plan-reviewer の指摘 17件を反映済み。**オーナーの設計案の承認待ち**（承認の前は実装しない）
  - オーナーに決めてもらうこと：サプライヤの管理者が、自社の下書き・承認待ちの中身を読めること（今の実装は読める。おすすめは仕様に一文足して「読める」のまま）
- SC3-42（CORS のテスト）：設計案の下書きを `tmp/plan-SC3-42.md` に置いた（Git の対象外）。承認されたら `docs/test-plans/SC3-42.md` に写す
- 3層は起動している（ネットワーク 172.30.0.0/24、nginx 172.30.0.10）

## 次にやること

1. SC3-13・34：オーナーの承認 → テストを先に書く（#9 は赤、#1〜#8 は壊して落ちることを確かめる）→ `supplier_user` に会社の種類の確かめ → `/code-review`（守りに関わるので2回まで）・security-reviewer → PR
2. SC3-42（下書きあり）、SC3-30・39・32・25・35・38、SC3-14（Day 8）・15（Day 9）

## オーナーにお願いすること

- SC3-13・34 の設計案（テストの一覧）の承認
- サプライヤの管理者が下書きの中身を読めることの決定
- SC3-42 の設計案の承認

## つまずき防止のメモ

- Docker Desktop が起動していないと、テストは DB に接続できず全部止まる。Docker Desktop は `$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe` にある（Program Files ではない）。PC を止めると3層も止まるので、`/start-day` で実際に確かめる
- compose のネットワークの設定を変えたら、`docker compose down`（`-v` なし）してから `up -d`。起動の直後は API の準備（DB の変更・ダミーデータ）に数秒かかるので、`curl` で 401 が返るのを待ってからテストを流す（`tmp/recreate-and-test.sh`）
- nginx は 127.0.0.1・localhost の Host にだけ応答する（SC3-29）。ほかの名前で開くと応答なしで切られる
- 検査の出力はパイプにつながず、`tmp/` のファイルに書いてから読む（Hook が止める）
- Git Bash で `origin/main:パス` を使うときは `MSYS_NO_PATHCONV=1`（パスに書き換えられる）
- `node -e` に正規表現のバックスラッシュを書くと Hook が止める。スクリプトは `tmp/` のファイルに
- コマンドの中に `.env` の文字があると、コメントでも Hook `protect-secrets` が止める。直しのスクリプトはファイルに書いてから流す
- nginx のテスト：`node --test tests/web/`（3層が動いているときだけ。ログインして呼ぶ確かめは `SEED_USER_PASSWORD` を環境変数で渡したときだけ動く）。オーナーに流してもらうときは、`.env` から読み込むコマンドを渡す（見本の文字を置かない。メモリーの決まり）
- `tests/web/nginx.test.mjs` は Prettier の対象外の書き方。ファイル全体に `prettier --write` をかけない（差分が膨らむ）
- FastAPI 0.165 は include_router したルーターを展開せずに持つ（`original_router`）。登録された API の一覧は `tests/test_auth.py` の `api_routes` でたどる
- Jira の開始日（customfield_10015）は遷移と一緒に設定できない。遷移のあと `editJiraIssue` で
- 作業時間：前回の `/end-day` のコミットの時刻から数える `node tmp/worktime-since.mjs <時刻> < /dev/null`
- 画面のテスト（Vitest）は、作業フォルダのドライブ名が小文字の `c:` だと全部落ちる。PowerShell で `Set-Location "C:\Users\..."`（大文字）にしてから流す
- Hook `guard-cite-sources` は、返答にサービスの名前と番号付きの手順があると、AWS の手順と見なして止めることがある（SC3-39）。直るまでは、手順の返答にサービスの名前を混ぜない
- `/code-review` は終わるまで待つ形で動く（数分）。呼ぶ前に「目安の時間」と「待つ間に進める課題」を書く（仕組みは SC3-32）
- Starlette の公式サイト（www.starlette.io）は 11/26 に名前の解決に失敗した。手元の `backend/.venv/Lib/site-packages/starlette/` のソースで確かめられる
