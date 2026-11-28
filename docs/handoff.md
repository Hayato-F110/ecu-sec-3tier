# 引き継ぎ

最終更新：2026-11-28 17:05（作業中）

## いまの状態

- スプリント3（11/26〜11/30）。Jira の期限では SC3-14（Day 8）が 11/29、SC3-15（Day 9）が 11/30。設計案はすべてオーナーが承認済み（11/26）
- 11/28 にマージ：PR #38（スクラムガイド 2020 の写し `docs/reference/scrum-guide/`）、#39（SC3-49：文が0件なら `/code-review` を通す。完了にした）。main で Hook のテスト 105件通過
- SC3-50（知らせなしの `/code-review` を本当に止める仕組み）：オーナーがスプリント4に入れた
- SC3-14：API はマージ済み。**画面の PR（テストの一覧の #12）がまだ**。SC3-25 は SC3-14 と一緒に完了にする
- SC3-38：ブランチ `feature/SC3-38-keep-draft-on-relogin`（作業場所 `.claude/worktrees/sc3-38`）。11/28 に main を取り込んだ。PR の説明の下書きは `tmp/pr-38.md`（元の作業場所）。**`/code-review` がまだ**

## 次にやること

1. SC3-38：`/code-review`（守りに関わるので2回まで）→ PR（`tmp/pr-38.md`）
2. SC3-14 の画面の PR（#12）
3. SC3-30、SC3-15（Day 9）
4. 不安定なテスト：`App.test.tsx` の「一覧に移り、以後の API に Authorization: Bearer が付く（#15）」が、SC3-38 のブランチで5回に1回落ちた（main では8回とも通った）。見出しが出た時点で、一覧の API をまだ呼んでいないことがある。待ち方を `vi.waitFor` にする案

## オーナーにお願いすること

- なし（11/27 に記憶から書いたスクラムガイドの節は、11/28 に原文と合っていることを確かめた）

## つまずき防止のメモ

- **画面のテスト（Vitest）は、作業フォルダのドライブ名が小文字の `c:` だと全部落ちる**（「Vitest failed to find the current suite」）。Bash では `cd /c/...` してから流す。11/27 も、作業場所が `c:\` に変わった直後に起きた
- `python` は `backend/.venv` を指す。python-pptx などはシステムの Python 3.14 に入っている
- worktree には `.env` がないので、API のテストは元の作業場所で `git checkout --detach <ブランチ>` して流す
- GitHub はマージのときにリモートのブランチを消す。`git push origin --delete` の「remote ref does not exist」は失敗ではない
- Jira の遷移は `transitionId`（31 完了・21 進行中）。開始日（customfield_10015）は遷移と別に `editJiraIssue` で
- Docker Desktop が起動していないと、テストは DB に接続できず全部止まる（`$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe`）
- compose のネットワークを変えたら `docker compose down`（`-v` なし）→ `up -d`。起動直後は数秒待つ（`tmp/recreate-and-test.sh`）
- nginx は 127.0.0.1・localhost の Host にだけ応答する（SC3-29）
- 検査の出力はパイプにつながず、`tmp/` のファイルに書いてから読む（Hook が止める）
- Git Bash で `origin/main:パス` を使うときは `MSYS_NO_PATHCONV=1`
- `node -e` に正規表現のバックスラッシュを書くと Hook が止める。スクリプトは `tmp/` のファイルに
- コマンドの中に `.env` の文字があると、Hook `protect-secrets` が止める
- `tests/web/nginx.test.mjs` に `prettier --write` をかけない
- FastAPI 0.165 の API の一覧は `tests/test_auth.py` の `api_routes` でたどる
- 作業時間：前回の `/end-day` のコミットの時刻から `node tmp/worktime-since.mjs <時刻> < /dev/null`
- Starlette の公式サイトが引けないときは `backend/.venv/Lib/site-packages/starlette/` のソースで確かめる
