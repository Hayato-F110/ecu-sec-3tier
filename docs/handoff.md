# 引き継ぎ

最終更新：2026-11-28 18:40（作業中）

## いまの状態

- スプリント3（11/26〜11/30）。残りは SC3-15（Day 9。期限 11/30）・SC3-25・SC3-30。ほかの課題は完了
- 11/28 にマージ：[PR #38](https://github.com/Hayato-F110/ecu-sec-3tier/pull/38)（スクラムガイドの写し）、[#39](https://github.com/Hayato-F110/ecu-sec-3tier/pull/39)（SC3-49）、[#42](https://github.com/Hayato-F110/ecu-sec-3tier/pull/42)（SC3-38）、[#43](https://github.com/Hayato-F110/ecu-sec-3tier/pull/43)（SC3-52）、[#44](https://github.com/Hayato-F110/ecu-sec-3tier/pull/44)（SC3-14 の画面）。main で画面のテスト 101件・lint・build 通過
- SC3-14：完了（証拠の表は Jira のコメント）
- SC3-25：証拠の表は Jira のコメントに書いた（`backend/tests/test_api_workflow.py:274`）。表の「PR の検査で pytest が通過」は PR #36 の説明で確かめられなかったので、main で pytest を流し直している（`tmp/main-after-44-pytest.txt`）。通ったら表を直して完了にする
- SC3-50・SC3-51：オーナーがスプリント4に入れた。SC3-53（バグ）・SC3-54：バックログ。おすすめはスプリント4（オーナーが決める）
- GitHub の Autolink references（`SC3-` → Jira）を 11/28 09:05 ごろに設定した（オーナーが決めた）。設定は残っているが、PR #44 の画面で `SC3-14` がリンクにならない。設定の前の表示が残っているせいでも、前後の文字のせいでもないことは確かめた（説明を書き直しても、`SC3-14` だけの行でもならない）。リポジトリのファイルの中は、GitHub の決まりで自動リンクにならない
- PR の説明の `#12`（テストの一覧の番号）が、PR #12 へのリンクになってしまう。テストの番号は「項目12」のように書く

## 次にやること

1. SC3-25 を完了にする（pytest の結果を見てから）
2. **11/29 に [PR #44](https://github.com/Hayato-F110/ecu-sec-3tier/pull/44) を開き、説明の一番下の `SC3-14` がリンクになったかを見る**。それでもならなければ、調べるタスク（原因の候補：反映の遅れ、GitHub 側の不具合か文書にない決まり）を作ることをオーナーに提案する（おすすめはスプリント4）
3. SC3-15（Day 9）。そのあと SC3-30（11/28 にオーナーが決めた）
4. 11/30：スプリントの最終日。`/design-decisions`・`/retro`

## オーナーにお願いすること

- なし（11/28 にオーナーが決めたこと：devlog・引き継ぎ・設計の文書でも PR は URL のリンクで書く。前の devlog は直さない。ファイルの Jira キーは文字のまま。手順は `/end-day`・`/design-decisions` に書いた）

## つまずき防止のメモ

- **画面のテスト（Vitest）は、作業フォルダのドライブ名が小文字の `c:` だと全部落ちる**（「Vitest failed to find the current suite」）。Bash では `cd /c/...` してから流す。11/27 も、作業場所が `c:\` に変わった直後に起きた。11/28 には、`C:` でもバックグラウンドで流したときに1回だけ同じエラーが出た（前で流し直すと通った。原因は分からない）
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
