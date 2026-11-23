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

## 次にやること

1. SC3-9：PR を出す → マージ → SC3-9 に証拠の表をコメント → 完了
2. AWS の準備の手順を、公式の資料で確かめて出典つきでオーナーに渡す（予算 → IAM ユーザーと MFA → アクセスキー → CLI）
3. SC3-2 を完了にする（`aws sts get-caller-identity` のあと、証拠の表をコメント）
4. Hook `guard-cite-sources` の誤った止め方を直す（2026-11-22 20:20、手順ではない説明の表で止まった。2026-11-23 も、claude.ai のページの書き出しの説明と、「予算 → IAM ユーザーと MFA → アクセスキー → CLI」という項目の並び〔矢印でつないだ並びを手順とみなしたとみられる。推測〕で止まった）。止まった文章をテストに足してから直す
5. Day 4（SC3-10）：画面（React の雛形・nginx・ECU 一覧と入力画面）

## バックログに入れる候補（今のスプリントには入れない。Jira に課題を作る）

- Day 8：差し戻しを下書きに戻したとき前の申請者が残る。申請の API で申請者を必ず書き直し、「差し戻しのあと別の人が再申請 → 今の申請者は承認できない」のテストを入れる（docs/test-plans/SC3-9.md）
- Day 4：nginx の後ろに置くと監査ログの ip が nginx のものになる。uvicorn の `--forwarded-allow-ips` を nginx だけに限って設定する
- Phase 3 まで：API が DB の管理者ユーザーでつないでいる。アプリ用のユーザーを分け、監査ログは追加・読み取りだけにする
- テストの道具：Starlette が `httpx` を非推奨にし `httpx2` を勧めている（警告）。公式の変更履歴とセキュリティ情報を確かめてから替える（2026-11-23 は公式サイトに接続できず確かめられなかった）

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
