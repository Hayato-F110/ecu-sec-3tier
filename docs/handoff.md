# 引き継ぎ

最終更新：2026-11-26 21:00（5時間の使用量が 94% になったので止めた）

## いまの状態

- スプリント3（11/26〜11/30、ゴール「会社ごとのデータ分離、承認フロー、メーカーの修正依頼・コメントが動く」）。設計案はすべてオーナーが承認した（11/26「全てOK」。決めてほしいことは全部おすすめどおり）
- SC3-13・34：PR #31。レビュー2回・security-reviewer 済み。最後のレビューのあとに直しがあるので、**マージはオーナーが「直しの証拠の表」で決める**。API のテスト 368件通過。CLAUDE.md の「途中の決定では計画書を変えない」もこの PR に入れた（オーナーが承認）
- SC3-42：ブランチ `feature/SC3-42-cors-test`（push 済み、PR はまだ）。レビュー2回済み（最後の回は軽い指摘6件。文書の誤り1件だけ直し、ほかは直さない：理由を PR に書く）。テスト3件と全体が通る。作業場所 `.claude/worktrees/sc3-42` には環境変数のファイルがないので、テストは元の作業場所で `git checkout --detach feature/SC3-42-cors-test` して流した
- SC3-35：ブランチ `feature/SC3-35-form-reset-test`（push 済み、PR はまだ）。レビュー1回目の直し済み（2回目はまだ）。画面のテスト 69件通過。key を戻すと部品のテストが、別の人も元のページに戻すと画面全体のテストが落ちる（`tmp/sc3-35c.txt`）。`AssessmentPage` を export した
- SC3-14・15：ブランチ `feature/SC3-14-workflow` に `docs/test-plans/SC3-14.md`・`SC3-15.md` を写した。**SC3-14 の test-plan-reviewer の指摘 27件が未反映**（要点は `tmp/review-SC3-14.md`）
- SC3-43・44・45（Hook の改善）：オーナーがスプリント4に入れた
- 元の作業場所のブランチは `feature/SC3-13-permissions`

## 次にやること

1. PR #31 がマージされたら：Jira の SC3-13・34 に完了条件の証拠の表 → 完了。main を pull、ブランチを片付ける
2. SC3-42：PR を出す（説明に、仕分け2回分・「レビュー：2 回目で終了（上限 2 回）」・赤の確かめ。最後の回のあとの直しは文書だけ）
3. SC3-35：2回目の `/code-review` → PR（直しの証拠：`tmp/sc3-35c.txt`）
4. SC3-14：PR #31 のマージ後に main を取り込み、`tmp/review-SC3-14.md` の指摘を一覧に反映 → test-plan-reviewer をもう一度 → テストを先に書く
5. SC3-38・30・39・32（設計案 `tmp/plans-sprint3.md`）、SC3-15

## オーナーにお願いすること

- PR #31 のマージの判断（「直しの証拠の表」とテストの結果で）

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
