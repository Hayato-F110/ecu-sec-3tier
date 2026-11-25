# 引き継ぎ

最終更新：2026-11-25 19:30

## いまの状態

- スプリント1：完了。設計判断とふりかえり（KPT）はオーナーが承認
- スプリント2（11/25〜11/27 23:00、ゴール「ローカルで3層が動き、ログインできる」）：SC3-10・11・31 は完了。残りは SC3-12（進行中）・SC3-26・SC3-29（どちらも期限 11/27）
- SC3-12（Day 6、ログイン）：PR #22（ブランチ `feature/SC3-12-auth`）。`/code-review` は2回目で終了（上限2回）、security-reviewer も済み。API 306件・画面 67件・Hook 93件が緑。**残りはテストの一覧 #20（ブラウザでの手の確かめ）だけ**。済んだらマージして Jira を完了に
- バックログからスプリントに入れた（オーナー、11/25）：SC3-32・34・35・38 → スプリント3、SC3-33・36 → スプリント4、SC3-37 → スプリント5。開始日・期限はスプリントの中に収まっている（11/25 に確かめた）
- CLI の認証は `aws login`（オーナーの決定）。Terraform がこの認証で動くかは、Day 12 の前に公式の資料で確かめる

## 次にやること

1. SC3-12 の #20：オーナーが `.env` に `JWT_SECRET_KEY`・`SEED_USER_PASSWORD` を足したら、`docker compose exec api python -m app.seed --set-passwords`（または `docker compose up -d --build` のあと）→ `node --test tests/web/`（`SEED_USER_PASSWORD` を環境変数で渡す）→ オーナーにブラウザでの確かめの手順を渡す → 結果を PR に書く → マージ → Jira で完了（完了条件の証拠の表をコメントに）
2. SC3-26・SC3-29（期限 11/27）
3. **スプリント3の計画（11/28）で、ストーリーポイントを実績と一緒に見直す**（11/25 にオーナーが決めた。スクラムガイド「プロダクトバックログ」「スプリントプランニング」の節）

## オーナーにお願いすること

1. `.env` に `JWT_SECRET_KEY`（32バイト以上の乱数）と `SEED_USER_PASSWORD`（15文字以上、72バイトまで）を足す。足すまで `docker compose up` は止まる
2. 決めてほしいこと：パスワードのポリシー（NIST SP 800-63B 第4版：15文字以上、文字の種類の決まりなし、定期的な変更なし、よく使われるパスワードの一覧との照合）を Day 10（SC3-16）の説明に足すか。おすすめは足す
3. 決めてほしいこと：Hook `guard-cite-sources` の誤検知（手順のサービスが分からないと AWS と見なす。PowerShell の手順と「Jira」の語が同じ返答にあると止まる）をバックログの課題にするか。おすすめは課題にする

## つまずき防止のメモ

- Docker Desktop が起動していないと、テストは DB に接続できず全部止まる。Docker Desktop は `$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe` にある（Program Files ではない）
- 検査の出力はパイプにつながず、`tmp/` のファイルに書いてから読む（Hook が止める）
- Git Bash で `origin/main:パス` を使うときは `MSYS_NO_PATHCONV=1`（パスに書き換えられる）
- `node -e` に正規表現のバックスラッシュを書くと Hook が止める。スクリプトは `tmp/` のファイルに
- コマンドの中に `.env` の文字があると、コメントでも Hook `protect-secrets` が止める。直しのスクリプトはファイルに書いてから流す
- nginx のテスト：`node --test tests/web/`（3層が動いているときだけ。ログインして呼ぶ確かめは `SEED_USER_PASSWORD` を環境変数で渡したときだけ）
- FastAPI 0.165 は include_router したルーターを展開せずに持つ（`original_router`）。登録された API の一覧は `tests/test_auth.py` の `api_routes` でたどる
- Jira の開始日（customfield_10015）は遷移と一緒に設定できない。遷移のあと `editJiraIssue` で
- 作業時間は `node tmp/worktime.mjs YYYY-MM-DD < /dev/null`（「〜時間〜分」で出る）
- 画面のテスト（Vitest）は、作業フォルダのドライブ名が小文字の `c:` だと、今あるテストまで「Vitest failed to find the current suite」で全部落ちる。PowerShell で `Set-Location "C:\Users\..."`（大文字）にしてから流す（原因は確かめていない）
- Python などで画面のファイルを書き換えたら、`npx prettier --write` をかける（保存時の整形が掛からない）
- Hook を import する確かめ用のスクリプトの名前を、Hook の名前で終わらせない（Hook の本体が動いて入力を待ち続ける。11/25）
- `/code-review` は終わるまで待つ形で動く（数分）。呼ぶ前に「目安の時間」と「待つ間に進める課題」を書く（仕組みは SC3-32）
