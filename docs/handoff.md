# 引き継ぎ

最終更新：2026-11-22 18:20（Day 1 の途中）

## いまの状態

- Day 1（SC3-2）を作業中。Claude 側の準備（Git、CLAUDE.md、Hook・スキル・サブエージェント、docs、docker compose の DB）はできた
- GitHub：https://github.com/Hayato-F110/ecu-sec-3tier （公開。2026-11-22 にオーナーが決めた。コミットの作者のメールは、このリポジトリの設定で GitHub の非公開用のメール）
- Jira：プロジェクト「ECUセキュリティ対策管理」（キー SC3）。エピック6件（SC3-1・3〜7）、ストーリー18件（Day 1〜18 ＝ SC3-2・8〜24。ポイント各5、開始日・期限は 11/22〜12/9 の毎日）
- 作業中のブランチ：`feature/SC3-2-jira-done-evidence`（Jira の欄 ID のそろえと、新しい Hook `guard-done-evidence`）
- オーナーが `.env` を作った（Claude は中身を読まない）

## オーナーにお願いすること

1. Docker Desktop を起動する（2026-11-22 18:10 の時点で止まっていた）
2. AWS：プランとクレジットの確認、Budgets（ゼロ支出予算）、練習用 IAM ユーザーと MFA、IAM ユーザーへの請求の画面の公開、CLI 用のアクセスキー
3. AWS CLI と Terraform を入れて（`winget install --id Amazon.AWSCLI --exact`・`winget install --id Hashicorp.Terraform --exact`）、ご自身のターミナルで `aws configure`
4. Jira で、スプリント1（Day 1〜3 ＝ SC3-2・8・9）を作って課題を入れる（スプリントの作成・割り当ては Claude からはしない決まり）

## 次にやること

1. Docker が起動したら `docker compose up -d` で PostgreSQL を起動し、`docker compose ps` で healthy を確かめる
2. `aws configure` が済んだら `aws sts get-caller-identity` を確かめる → SC3-2 の完了条件。証拠の表を SC3-2 のコメントに書いてから「完了」に
3. Day 2（SC3-8）：テーブル設計と Alembic（`/story SC3-8` で Plan から）

## つまずき防止のメモ

- PostgreSQL は 18 を使う（19.0 は 2026-11-19 公開で新しすぎ、RDS の対応が未確認）。Day 12 に RDS の対応版を確かめる
- PostgreSQL 18 の公式イメージは、データの置き場所が `/var/lib/postgresql`（17 までの `/var/lib/postgresql/data` から変わった）。docker compose はそれに合わせてある
- backend/ を作った日（`uv` で仮想環境を作ったあと）に、`.vscode/settings.json` へ Python の場所（`backend/.venv/Scripts/python.exe`）と pytest の設定（場所 `backend`・引数 `tests`）を足す。仮想環境がないうちに書くと、VS Code が「インタープリター パスを解決できません」と出す
- VS Code の「python.terminal.useEnvFile を有効に」の知らせは、有効にしない（ターミナルに DB のパスワードが入るため。docker compose と API は `.env` を自分で読む）
- Jira のポイントの欄は `customfield_10016`（nori の `customfield_10034` は SC3 にない）。欄と遷移の ID は `.claude/hooks/project.json`
- 長い処理（pytest・docker compose build・terraform）は裏で動かす（Hook `guard-long-foreground` が止める）
