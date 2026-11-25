# 引き継ぎ

最終更新：2026-11-25 18:24

## いまの状態

- スプリント1：完了。設計判断とふりかえり（KPT）はオーナーが承認
- スプリント2（11/25〜11/27 23:00、ゴール「ローカルで3層が動き、ログインできる」）：SC3-10・11・31 は完了。残りは SC3-12（進行中）・SC3-26・SC3-29（どちらも期限 11/27）
- SC3-12（Day 6、ログイン）：開始日 11/25。ブランチ `feature/SC3-12-auth`。テストの一覧の下書き `docs/test-plans/SC3-12.md`（test-plan-reviewer の確認中）。オーナーの決定（11/25）：パスワードは計画どおり bcrypt（pwdlib）
- バックログからスプリントに入れた（オーナー、11/25）：SC3-32・34・35 → スプリント3、SC3-33 → スプリント4
- CLI の認証は `aws login`（オーナーの決定）。Terraform がこの認証で動くかは、Day 12 の前に公式の資料で確かめる

## 次にやること

1. SC3-12：test-plan-reviewer の指摘をテストの一覧に反映 → 設計案をオーナーに出して承認をもらう（`/story`。決めてほしい3点：トークンはメモリだけ、ログインの成功・失敗を監査ログに、仮の本人確認を消す）
2. SC3-12：テストを先に → 実装 → `/code-review`（認証なので2回まで）・security-reviewer → PR
3. SC3-26・SC3-29
4. **スプリント3の計画（11/28）で、ストーリーポイントを実績と一緒に見直す**（11/25 にオーナーが決めた。今は直さない。スクラムガイド「プロダクトバックログ」「スプリントプランニング」の節）

## オーナーにお願いすること

1. SC3-12 の設計案の承認（test-plan-reviewer の確認のあとに出す）

## つまずき防止のメモ

- Docker Desktop が起動していないと、テストは DB に接続できず全部止まる。Docker Desktop は `$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe` にある（Program Files ではない）
- 検査の出力はパイプにつながず、`tmp/` のファイルに書いてから読む（Hook が止める）
- Git Bash で `origin/main:パス` を使うときは `MSYS_NO_PATHCONV=1`（パスに書き換えられる）
- `node -e` に正規表現のバックスラッシュを書くと Hook が止める。スクリプトは `tmp/` のファイルに
- nginx のテスト：`node --test tests/web/`（3層が動いているときだけ）
- Jira の開始日（customfield_10015）は遷移と一緒に設定できない。遷移のあと `editJiraIssue` で
- 作業時間は `node tmp/worktime.mjs YYYY-MM-DD < /dev/null`（「〜時間〜分」で出る）
- 画面のテスト（Vitest）は、作業フォルダのドライブ名が小文字の `c:` だと、今あるテストまで「Vitest failed to find the current suite」で全部落ちる。PowerShell で `Set-Location "C:\Users\..."`（大文字）にしてから流す（原因は確かめていない）
- Hook を import する確かめ用のスクリプトの名前を、Hook の名前で終わらせない（Hook の本体が動いて入力を待ち続ける。11/25）
- `/code-review` は終わるまで待つ形で動く（数分）。呼ぶ前に「目安の時間」と「待つ間に進める課題」を書く（仕組みは SC3-32）
