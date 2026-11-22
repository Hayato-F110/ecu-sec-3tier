# Claude Code の設定（Hook・スキル・サブエージェント）

nori-adventure（2026-11）の設定を、このプロジェクト向けに引き継いだもの（2026-11-22）。各 Hook のファイルの先頭に、作った理由（起きた事故）を書いてある。

## Hook（`.claude/hooks/`、つなぎ方は `.claude/settings.json`）

| Hook | いつ | 何をする | 引き継ぎ |
| --- | --- | --- | --- |
| protect-secrets | 道具の前（読み書き・コマンド） | `.env`・鍵・`~/.aws`・`~/.ssh`・`secrets/`・**`*.tfstate`・`*.tfvars`** に触る操作と、鍵らしい文字列の書き込みを止める | 引き継ぎ＋Terraform を追加 |
| guard-aws-cost | 道具の前（.tf の書き込み・コマンド） | NAT Gateway・マルチ AZ・Secrets Manager・ドメイン購入・RDS の外部公開・22番ポート・Elastic IP を止め、micro・small より大きいインスタンスは確認を出す | **新規**（計画書 第5章・第8章） |
| guard-delete | 道具の前（コマンド） | 消す操作・履歴の書き換えに、オーナーの確認を出す | そのまま |
| guard-no-verify | 道具の前（コマンド） | `git commit --no-verify` などの確認を飛ばす指定を止める | そのまま |
| guard-inline-backslash | 道具の前（コマンド） | `python -c`・`node -e` の中の Windows のパス・正規表現のバックスラッシュを止める | そのまま |
| guard-long-foreground | 道具の前（コマンド） | 長い処理（**pytest・docker compose build/up・terraform plan/apply/destroy**・E2E・CI の見張り）を表で流すのと、検査をパイプにつなぐのを止める | 対象をこのプロジェクト向けに変更 |
| review-before-pr | 道具の前（`gh pr create`） | コードを変える PR で、最後のコミットのあとに `/code-review` を呼んでいなければ止める。ただし、その場所でレビューを1回以上していて、PR の説明に「直しの証拠の表」があれば通す | 対象の場所を `backend/`・`frontend/`・`infra/` などに変更。**直しの証拠の表で通す仕組みを追加**（nori の NORI-83 で作る予定だったもの。2026-11-22 にオーナーが承認） |
| guard-jira-fields | 道具の前（Jira の作成・編集・遷移） | ポイント・期限・開始日の抜けと、スプリントへ入れる操作を止める | 課題キーと欄の ID を `project.json` から読むように変更。ポイントの欄は SC3 では `customfield_10016`（nori の `customfield_10034` は SC3 にない） |
| guard-done-evidence | 道具の前（Jira の遷移） | 「完了」に移す前に、この会話でその課題に「完了条件」「証拠」の列がある表のコメントを書いたかを確かめる。なければ、または表に「未達」があれば止める | **新規**（harvest-before-done の代わり。2026-11-22 にオーナーが承認） |
| japanese-reply | 道具の前・応答の終わり | 英語だけの行があれば止める | そのまま |
| japanese-reminder | 道具の後 | 日本語の決まりを一言差し込む | そのまま |
| plain-terms | 応答の終わり | `plain-terms.json` の用語を説明なしで使ったら止める | そのまま（用語の一覧も引き継ぎ） |
| wait-needs-next | 応答の終わり | 「待つ」と書いたのに「待つ間に進める課題：」がなければ止める | そのまま |
| guard-cite-sources | 応答の終わり（その回の文章すべて） | AWS・GitHub・Atlassian の画面の操作の手順に、そのサービスの公式の資料の URL がなければ止める。手順の数え方：箇条書き（1. ・ ① 表の行）の操作の行（過去形の報告は除く。まとまりにサービスの名前か画面の部品の言葉が要る）と、サービスの名前のある矢印・階層（「KMS」→「キー」、KMS > キー）を合わせて2つ以上。ブログ・質問サイトは出典にしない。ほかの Stop の Hook が止めたあとの書き直しは調べない（抜け道） | 新規（2026-11-22。AWS の手順を記憶で書き、画面の変更に気づかなかったため） |
| save-agent-report | サブエージェントの終わり | 報告の全文を `.claude/agent-reports/` に保存する | そのまま |
| format-and-lint | 道具の後（編集） | Python は ruff、画面は Prettier・ESLint、Terraform は `terraform fmt` | このプロジェクト向けに書き直し |

引き継がなかったもの：`approval-jira`・`harvest-before-done`（ゲームのルールとテストの一覧の「刈り取り」の表を読む。このプロジェクトにはその表がない）。harvest-before-done が防いでいた失敗（完了条件を読み直さずに完了にする）は、新しい `guard-done-evidence` で防ぐ。

テスト：`node --test tests/hooks/`（Node の標準のテスト機能。追加の依存なし）

## 権限（`.claude/settings.json` の permissions）

- **deny**（実行させない）：秘密のファイルの読み取り、force push・main への直接の push、リポジトリの公開範囲の変更・削除、**IAM ユーザー・アクセスキーの作成、アカウント・請求の操作、`terraform state rm`**、Jira の削除系
- **ask**（毎回オーナーの確認）：**`terraform apply`・`destroy`・`import`、`aws * create/delete/terminate/put/modify/update`、S3 への書き込み・削除、DB のデータを消す操作（`docker compose down -v`・`alembic downgrade`）**、ファイルの削除、履歴の書き換え、`gh repo create`、`winget install`
- **allow**（確認なし）：git の読み取り、Hook のテスト、pytest・ruff、`docker compose ps/logs`、`terraform fmt/validate/plan`、`aws sts get-caller-identity`

## スキル（`.claude/skills/`）

| スキル | 使うとき | 引き継ぎ |
| --- | --- | --- |
| `/start-day` | 1日の始め | 引き継ぎ＋Day 番号・AWS の日の手順 |
| `/end-day` | 1日の終わり | 引き継ぎ＋実際の作業時間・AWS の後片付け |
| `/story` | ストーリー1つを進める（Plan → 承認 → テストを先に → 実装 → 確かめてコミット） | **新規**（計画書 第6章） |
| `/aws-session` | AWS を使う日の始め・終わり・月次 | **新規**（計画書 第5章） |
| `/design-decisions` | 各スプリントの最終日 | **新規**（計画書 第6章・第8章） |
| `/commit` | コミット | 確かめる項目をこのプロジェクト向けに |
| `/review` | 変更のレビュー（コードは変えない） | 照らすルールをデータ分離・認可に |
| `/sec-check` | セキュリティの全体確認 | データ分離・AWS を追加 |
| `/retro` | スプリントのふりかえり | 計画書 第7章の形に |
| `/away` | オーナーの離席中 | AWS を動かしたままにしない決まりを追加 |
| `/explain` | 概念の説明（ローカルでは無効） | 例をこのプロジェクトの技術に |
| `/qcd` | Claude Code の使い方の振り返り（ローカルでは無効） | AWS の費用の観点を追加 |
| `/whats-new` | Claude Code の新機能 | ほぼそのまま |

引き継がなかったもの：`/blender-start`・`/game-rule`（ゲーム専用）。

## サブエージェント（`.claude/agents/`、どれも読むだけ）

| 名前 | 見るもの | 引き継ぎ |
| --- | --- | --- |
| security-reviewer | 会社ごとのデータ分離・認可・認証・状態の変更・秘密情報 | privacy-reviewer を作り直し |
| aws-cost-reviewer | Terraform の費用と公開範囲 | **新規**（kids-ui-reviewer の代わり） |
| test-plan-reviewer | 仕様（`docs/spec.md`）とテストの一覧・テストのコードの突き合わせ | 突き合わせる先をゲームのルールから仕様に |
