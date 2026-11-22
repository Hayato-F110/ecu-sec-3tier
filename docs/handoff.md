# 引き継ぎ

最終更新：2026-11-22 20:20（Day 1 の日に、Day 2 まで完了・Day 3 の途中。5時間の使用量が 97% のため中断）

## いまの状態

- スプリント1（11/22〜11/24、SC3-2・8・9）を開始済み。スプリント2〜6 も作成済み（オーナー）
- SC3-2（Day 1）：進行中。残りは AWS の準備（下の「オーナーにお願いすること」）と `aws sts get-caller-identity` の確認
- SC3-8（Day 2）：**完了**（PR #5。9テーブル・DB の制約・ダミーデータ・テスト150件）
- SC3-9（Day 3）：**進行中**。ブランチ `feature/SC3-9-ecu-api`（プッシュ済み・PR はまだ）
  - 設計案はオーナーが承認済み（仮の本人確認 `X-Dev-User-Id`、既定は無効。3つの API。詳細は `docs/test-plans/SC3-9.md`）
  - テストを先に書いた段階：`backend/tests/test_api_ecus.py`・`test_auth_dev.py`・`test_app.py`・`api_helpers.py`。実装の前に流して、新しいテストが落ちることを確かめた（`app.deps` がない）
  - test-plan-reviewer の指摘を仕分けて、テストの一覧に #14〜#18 と「調べる順番」を足した。**テストのコードには、まだ #14〜#18 を入れていない**
- PR #6 で Hook `guard-cite-sources` を足した（外部サービスの画面の手順に、公式の資料の URL がなければ止める。AWS の手順を記憶で書いたため）
- AWS の消し残しの確認は終わり：11月の明細はリクエストの回数だけで 0.00 ドル。保存・稼働の料金はない。KMS のカスタマー管理型のキーは空（オーナー確認）。S3 のバケットの中身は Day 14 の始めに CLI で確かめる

## 次にやること

1. SC3-9：テストに #14〜#18 を足す → 実装（`app/main.py`・`deps.py`・`schemas.py`・`api/ecus.py`、config に `dev_auth_enabled`、Dockerfile と docker compose の api）→ 緑 → `/code-review`（2回まで）と security-reviewer → PR → `/docs` で確かめる → SC3-9 に証拠の表 → 完了
   - 監査ログの ip：TestClient の接続元は "testclient" なので、IP アドレスでなければ空にする
2. AWS の準備の手順を、公式の資料で確かめて出典つきでオーナーに渡す（予算 → IAM ユーザーと MFA → アクセスキー → CLI）
3. SC3-2 を完了にする（`aws sts get-caller-identity` のあと、証拠の表をコメント）
4. Hook `guard-cite-sources` の誤った止め方を直す：2026-11-22 20:20 に、手順ではない文章（レビューの指摘を並べた表の行。「を開いて」などの言葉と GitHub・Jira の名前が同じ回にあった）で止まった。止まった文章を記録から探して、テストに足してから直す
5. 今日の devlog（`docs/devlog/2026-11-22.md`）に、Day 2・3 の作業、失敗（AWS の手順を記憶で書いた）、学び、実際の作業時間（オーナーに聞く）を足す

## オーナーにお願いすること

1. AWS：ゼロ支出予算、練習用 IAM ユーザーと MFA、IAM ユーザーへの請求の画面の公開、CLI 用のアクセスキー（手順は Claude が公式の資料で確かめてから渡す）
2. AWS CLI と Terraform を入れて、ご自身のターミナルで `aws configure`

## つまずき防止のメモ

- PostgreSQL は 18 を使う（Day 12 に RDS の対応版を確かめる）。データの置き場所は `/var/lib/postgresql`
- テストは同じ PostgreSQL に `ecu_sec_test`・`ecu_sec_test_migrations` を作り直して流す。開発用の `ecu_sec` には触らない
- alembic.ini は ASCII だけにする（Windows では cp932 で読まれ、日本語で止まる）
- 接続先は `127.0.0.1`（`localhost` だと Windows で IPv6 を先に試して約2秒待つ）
- Alembic の自動比較は CHECK 制約と索引の条件の違いを見ない。制約のテストは変更履歴で作った DB に対して流す
- Git Bash で `python -m app.seed` の日本語が化けるときは `PYTHONIOENCODING=utf-8`
- VS Code の「python.terminal.useEnvFile を有効に」は有効にしない
- Jira のポイントの欄は `customfield_10016`。欄と遷移の ID は `.claude/hooks/project.json`
- 長い処理（pytest・docker compose build・terraform）は裏で動かす
