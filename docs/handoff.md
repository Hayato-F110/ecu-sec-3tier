# 引き継ぎ

最終更新：2026-11-23 17:56（Day 3 の作業。SC3-9 の実装とレビューが済み、PR を出す段階）

## いまの状態

- スプリント1（11/22〜11/24、SC3-2・8・9）。Jira の終わりは 11/24 23:00（日本時間）
- SC3-2（Day 1）：進行中。残りは AWS の準備（下の「オーナーにお願いすること」）と `aws sts get-caller-identity` の確認
- SC3-8（Day 2）：完了（PR #5）
- SC3-9（Day 3）：進行中。ブランチ `feature/SC3-9-ecu-api`
  - 3つの API（ECU の一覧・対策状況の取得・下書きの保存）、仮の本人確認 `X-Dev-User-Id`（既定は無効）、API のコンテナ（`docker compose up -d` でテーブルの作成とダミーデータの投入まで行う）
  - テスト 246件が合格。`/code-review` 2回（上限）と security-reviewer を受けて直した。直しの証拠は PR の説明
  - 手元の `/docs` と同じ API で、日本語の根拠を保存して取得できること、他社の ECU は 404 になることを確かめた
- 初学者向けの学習マニュアル（34枚のスライド）を作った：<https://claude.ai/artifact/YRYHcnsstw3GfbUk4ZmZbC>（非公開）

## 作業中（2026-11-23 18:50、使用量 95% で中断）

- SC3-10（Day 4、スプリント2）を先に着手。Jira は進行中・開始日 11/23。ブランチ `feature/SC3-10-frontend`（WIP コミット済み、未 push）
- 設計案はオーナー承認済み：`C:\Users\hayat\.claude\plans\goofy-wobbling-church-of-fff166cd-2acc-4825-9153-99ff9be02539.md`
- 済み：`frontend/` の雛形・API を呼ぶ関数・一覧と入力画面・nginx.conf・Dockerfile・compose の web（127.0.0.1:8080）。テスト 21件は空の実装で赤 → 実装で緑（21 passed）
- 残り：① 型の直し（`vi.fn<typeof fetch>`）のあとに `npm test`・`npm run lint`・`npm run build` を流し直す ② `docker compose build web`（ビルドの結果は `tmp/web-build.txt`）→ `up -d` でブラウザ確認（`.env` の `DEV_AUTH_ENABLED=true` はオーナーの作業）③ `/code-review` 1回・security-reviewer ④ PR
- バックログ SC3-25〜28 はオーナーがスプリントに入れた（26→2、25→3、27・28→4）

## 次にやること

1. AWS の準備：手順は 2026-11-23 に公式の資料で確かめて出典つきでオーナーに渡した。IAM ユーザーの作成の画面の手順だけは資料になく確かめられなかった（「新しい画面ではコンソールにサインインできる IAM ユーザーを作れない」という注意がある）。オーナーの作業を待つ
2. SC3-2 を完了にする（`aws sts get-caller-identity` のあと、証拠の表をコメント）
3. Day 4（SC3-10）：画面（React の雛形・nginx・ECU 一覧と入力画面）

## バックログ（2026-11-23 に Jira に作った。どのスプリントに入れるかはオーナーが決める）

- SC3-25：差し戻しのあとの再申請で、申請者を必ず書き直す（Day 8・11/29）
- SC3-26：nginx の後ろでも監査ログに本当の接続元の ip を残す（Day 4・11/25）
- SC3-27：API 用の DB ユーザーを分け、監査ログを追加・読み取りだけにする（Day 12・12/3）
- SC3-28：テストの道具を httpx から httpx2 に替える（Day 11・12/2）

## オーナーにお願いすること

1. AWS：ゼロ支出予算、練習用 IAM ユーザーと MFA、IAM ユーザーへの請求の画面の公開、CLI 用のアクセスキー（手順は Claude が公式の資料で確かめてから渡す）
2. AWS CLI と Terraform を入れて、ご自身のターミナルで `aws configure`

## つまずき防止のメモ

- Docker Desktop が起動していないと、テストは DB に接続できず準備の段階で全部止まる（`dockerDesktopLinuxEngine` が見つからない）
- Git Bash の curl で日本語の本文を送ると UTF-8 にならず 400 になる。日本語は Python（`tmp/save_ja.py`）か `/docs` から送る
- 検査（pytest など）の出力はパイプにつながず、`tmp/` のファイルに書いてから読む（Hook が止める）
- PostgreSQL は 18 を使う（Day 12 に RDS の対応版を確かめる）
- テストは同じ PostgreSQL に `ecu_sec_test`・`ecu_sec_test_migrations` を作り直して流す。開発用の `ecu_sec` には触らない
- alembic.ini は ASCII だけにする（Windows では cp932 で読まれ、日本語で止まる）
- 接続先は `127.0.0.1`（`localhost` だと Windows で IPv6 を先に試して約2秒待つ）
- Alembic の自動比較は CHECK 制約と索引の条件の違いを見ない。制約のテストは変更履歴で作った DB に対して流す
- Jira のポイントの欄は `customfield_10016`。欄と遷移の ID は `.claude/hooks/project.json`
