# 引き継ぎ

最終更新：2026-11-22（Day 1 の途中）

## いまの状態

- Day 1（フェーズ 0 準備）の途中。Claude 側の準備（Git、CLAUDE.md、Hook・スキル・サブエージェント、docs、docker compose の DB）はできた
- まだコミットしていない（main に最初のコミットを作る予定）。GitHub のリポジトリ・Jira のプロジェクトはまだない
- Jira の課題キーは仮に `SC3`（`.claude/hooks/project.json`）。Jira のプロジェクトを作ったら実際のキーにそろえる

## オーナーにお願いすること（Day 1 の完了条件に必要）

1. AWS：無料プランのままか・残りのクレジットの確認、練習用 IAM ユーザーの作成と MFA、Budgets（予算のアラート）の設定。手順は Claude が公式ドキュメントで確かめてから渡す
2. AWS CLI と Terraform を入れる（`winget install`。確認の画面が出る）。入れたら `aws configure` は**オーナーが自分のターミナルで**行う（アクセスキーを Claude に見せない）
3. `env.example` を `.env` に写して、パスワードを長い乱数に変える（Claude は `.env` を読み書きしない）
4. GitHub のリポジトリを作る（非公開をおすすめ。理由：練習の途中の記録を含むため。公開は最後に決める）
5. Jira のプロジェクトを作る（キー・エピック6つ・Day 1〜18 のストーリー）。作成は Claude が MCP でできる（1件で試してから）

## 次にやること

1. 最初のコミット（main）
2. オーナーの `.env` ができたら `docker compose up -d` で PostgreSQL を起動し、`docker compose ps` で healthy を確かめる
3. Jira・GitHub の準備（オーナーの承認のあと）
4. Day 1 の完了条件：`aws sts get-caller-identity` が練習用 IAM ユーザーで成功する
5. Day 2：テーブル設計と Alembic（`/story` で Plan から）

## つまずき防止のメモ

- PostgreSQL は 18 を使う（19.0 は 2026-11-19 公開で新しすぎ、RDS の対応が未確認）。Day 12 に RDS の対応版を確かめる
- PostgreSQL 18 の公式イメージは、データの置き場所が `/var/lib/postgresql`（17 までの `/var/lib/postgresql/data` から変わった）。docker compose はそれに合わせてある
- 長い処理（pytest・docker compose build・terraform）は裏で動かす（Hook `guard-long-foreground` が止める）
