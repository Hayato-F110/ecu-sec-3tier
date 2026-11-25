# 引き継ぎ

最終更新：2026-11-25 19:15

## いまの状態

- スプリント1：完了
- スプリント2（11/25〜11/27 23:00、ゴール「ローカルで3層が動き、ログインできる」）：SC3-10・11・12・31 は完了。残りは SC3-26（進行中）・SC3-29（期限はどちらも 11/27）
- SC3-26（監査ログの接続元の IP）：ブランチ `feature/SC3-26-forwarded-ip`（まだ変更なし）。**設計はオーナーが承認済み（11/25）**
  - docker-compose.yml でネットワークのアドレスの範囲を決め、nginx（web）のアドレスを固定する
  - API に `FORWARDED_ALLOW_IPS`（web のアドレスだけ）を渡す
  - tests/web：nginx 経由で、左側に嘘のアドレス（203.0.113.9）を入れてログインに失敗し、DB の監査ログの最後の行の IP が、nginx のアドレスでも嘘のアドレスでもないことを `docker compose exec db psql` で確かめる。compose の `FORWARDED_ALLOW_IPS` と web の固定のアドレスが同じことも確かめる
  - 根拠：uvicorn 0.54.0 のソース（`uvicorn/config.py:363` 既定は 127.0.0.1,::1、`uvicorn/middleware/proxy_headers.py:169-187` 右から見て信じない最初のアドレス）。公式のサイト（uvicorn.org）は 11/25 に DNS の失敗で読めなかったので、着手の前にもう一度読む
  - 分かっている限界：Docker Desktop では、残るのは Docker のネットワークの入口のアドレスになる見込み（推測。テストで確かめる）
- 3層は起動したまま（`docker compose ps`）。`.env` にはオーナーが `JWT_SECRET_KEY`・`SEED_USER_PASSWORD` を入れ、14人のパスワードを入れ直した
- スプリント2の設計判断（`/design-decisions`）とふりかえり（`/retro`）は、SC3-26・29 が終わってから（スプリントの最後の作業のあと）行う

## 次にやること

1. SC3-26：uvicorn の公式の資料を読む → テストを先に（赤）→ compose を直す → `/code-review`（守りに関わるので2回まで）・security-reviewer → PR → マージ → Jira で完了
2. SC3-29（nginx は決めた Host 名だけに応答する）。SC3-26 をマージしたあとの main から始める
3. スプリント2の `/design-decisions` と `/retro`（11/27 まで）
4. **スプリント3の計画（11/28）**：ストーリーポイントを実績と一緒に見直す。スプリント3には SC3-32・34・35・38・39 が入っている

## オーナーにお願いすること

- なし（SC3-26 の設計は承認済み）

## つまずき防止のメモ

- Docker Desktop が起動していないと、テストは DB に接続できず全部止まる。Docker Desktop は `$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe` にある（Program Files ではない）
- 検査の出力はパイプにつながず、`tmp/` のファイルに書いてから読む（Hook が止める）
- Git Bash で `origin/main:パス` を使うときは `MSYS_NO_PATHCONV=1`（パスに書き換えられる）
- `node -e` に正規表現のバックスラッシュを書くと Hook が止める。スクリプトは `tmp/` のファイルに
- コマンドの中に `.env` の文字があると、コメントでも Hook `protect-secrets` が止める。直しのスクリプトはファイルに書いてから流す
- nginx のテスト：`node --test tests/web/`（3層が動いているときだけ。ログインして呼ぶ確かめは `SEED_USER_PASSWORD` を環境変数で渡したときだけ動き、Claude は値を知らないので飛ばされる）
- FastAPI 0.165 は include_router したルーターを展開せずに持つ（`original_router`）。登録された API の一覧は `tests/test_auth.py` の `api_routes` でたどる
- Jira の開始日（customfield_10015）は遷移と一緒に設定できない。遷移のあと `editJiraIssue` で
- 作業時間：前回の `/end-day` のコミットの時刻から数える `node tmp/worktime-since.mjs <時刻> < /dev/null`（0 時で区切らない決まりに合う）。日付で数える `tmp/worktime.mjs` もある
- 画面のテスト（Vitest）は、作業フォルダのドライブ名が小文字の `c:` だと全部落ちる。PowerShell で `Set-Location "C:\Users\..."`（大文字）にしてから流す
- Python などで画面のファイルを書き換えたら、`npx prettier --write` をかける（保存時の整形が掛からない）
- Hook `guard-cite-sources` は、返答に「Jira」などの語と番号付きの手順があると、AWS の手順と見なして止めることがある（SC3-39）。直るまでは、手順の返答にサービスの名前を混ぜない
- Hook を import する確かめ用のスクリプトの名前を、Hook の名前で終わらせない（Hook の本体が動いて入力を待ち続ける）
- `/code-review` は終わるまで待つ形で動く（数分）。呼ぶ前に「目安の時間」と「待つ間に進める課題」を書く（仕組みは SC3-32）
