# 設計判断と、採らなかった場合に起きること

計画書 第6章・第8章。各スプリントの最後に、Claude が `/design-decisions` の手順で、そのスプリントの判断を**実際のコードを例に**説明し直し、下の「スプリントごとの説明」に足す。途中で変えた判断も追加する（元の行は消さず「変更：日付・理由」を足す）。

## 予定している判断（計画書 第8章）

| スプリント | 設計判断 | 採らなかったら起きること |
| --- | --- | --- |
| 1 | テーブルの変更を Alembic で管理する | 手作業の ALTER だと、ローカルと AWS でテーブルの形がずれ、移行時に API が起動しない。どの変更がいつ入ったかも追えない |
| 1 | 承認済みの版は上書きせず、新しい版を作る | メーカーが確認した内容が後から黙って変わり、「いつ、何を確認したのか」を説明できない |
| 2 | nginx が /api を中継し、画面と API を同じオリジンにする | CORS の設定が必要になる。緩く設定すると、別のサイトからログイン中のユーザーとして API を呼ばれる可能性がある |
| 2 | パスワードを bcrypt でハッシュ化する | DB が漏れたとき、全員のパスワードがそのまま読める。他のサービスでの使い回しも破られる |
| 3 | 全 API で、ログインユーザーの会社でデータを絞り込む | URL の ECU の ID を書き換えるだけで、他社の対策状況が読める（IDOR）。サプライヤ間で機密が漏れる |
| 3 | 他社のデータには 403 ではなく 404 を返す | 403 だと「その ID の ECU は存在する」と分かり、ID を順に試すだけで他社の ECU の数が推測できる |
| 3 | 状態の変更を API 側で検証する | 画面のボタンを隠すだけだと、API を直接呼べば承認を飛ばしたり、承認済みの版を書き換えたりできる |
| 3 | 申請者本人は承認できない（職務分離） | 1人で入力と承認ができ、承認が形だけになる。誤りや不正を社内で止められない |
| 3 | コメントも会社で絞り込む | 対策状況を守っても、コメント API から他社の質問や回答（弱点の説明など）が漏れる |
| 4 | GitHub Actions でテストを自動実行する | 他社データが見えるような変更が入っても、AWS に載せるまで気づかない |
| 4 | RDS をプライベートサブネットに置き、EC2 からだけ接続を許す | DB がインターネットから直接接続を受け、パスワードの総当たりを受ける |
| 5 | EC2 への接続に SSH ではなく Systems Manager を使う | 22番ポートを開けると世界中から総当たりを受ける。鍵ファイルの管理も必要になる |
| 5 | 構成を Terraform で作り、終わったら destroy する | 画面で作ったリソースの消し忘れでクレジットが減り続ける。同じ構成を作り直せない |
| 5・6 | DynamoDB は画面の読み方から先にキーを決める | RDB と同じ感覚でテーブルを作ると、一覧表示のたびに全件読み出し（Scan）になり、遅く、無料枠も早く消費する |

## スプリントごとの説明

### スプリント1（2026-11-22〜11-24。SC3-2・8・9）

#### 1. テーブルの変更を Alembic で管理する

- **判断**：テーブルの形は、手で ALTER せず、Alembic の変更履歴（`backend/alembic/versions/`）だけで変える
- **実際のコード**：`backend/alembic/versions/2026_11_22_1946-3abdc64d9531_create_tables.py`（9つのテーブルと制約を作る1つ目の変更履歴）。モデル（`backend/app/models.py`）と変更履歴がずれていないかを、テストで毎回比べる
- **採らなかったら何が起きるか**：手元で `ALTER TABLE` を打って直すと、AWS の RDS（Day 12）には同じ変更が入らない。API は起動するが、その列を読むところで落ちる。どの変更がいつ入ったかも追えない
- **外すと落ちるテスト**：`tests/test_migrations.py::test_models_match_migrations`（モデルだけを変えて変更履歴を作り忘れると落ちる）、`test_downgrade_base_then_upgrade_again`
- **車載ソフト開発に例えると**：ECU の不揮発メモリのレイアウト変更を、変換の手順（マイグレーション）つきで版管理するのと同じ
- **ISO/SAE 21434**：構成管理（変更を追える状態にしておく）

#### 2. 承認済みの版は上書きせず、新しい版を作る

- **判断**：承認済みの版に保存すると、その版は変えずに「版＋1」の下書きを作り、承認済みの入力を写す
- **実際のコード**：`backend/app/api/ecus.py:227` の `new_version`

  ```python
  last = db.scalar(select(func.max(Assessment.version)).where(Assessment.ecu_id == ecu_id))
  draft = Assessment(ecu_id=ecu_id, version=(last or 0) + 1, status="draft")
  ```

  DB でも、作業中の版は1つの ECU に1つまで（`backend/app/models.py:181` の `uq_assessments_one_open_per_ecu`）
- **採らなかったら何が起きるか**：サプライヤが承認済みの版を書き換えると、メーカーが確認した内容が、黙って変わる。監査で「11/1 に何を確認したか」を問われても、もう答えられない
- **外すと落ちるテスト**：`tests/test_api_ecus.py::test_save_on_approved_creates_new_version_and_keeps_approved`、`tests/test_constraints.py::test_only_one_open_version_per_ecu`
- **車載ソフト開発に例えると**：リリースしたソフトの版は書き換えず、直しは新しい版番号で出す
- **ISO/SAE 21434**：サイバーセキュリティの証拠（作業成果物）を、変えられない形で残す

#### 3. 他社の ECU には 403 ではなく 404 を返す

- **判断**：自社の ECU かを、ECU を探す条件に入れる。他社の ECU も、存在しない番号も、同じ 404 にする
- **実際のコード**：`backend/app/deps.py:66` の `own_ecu`

  ```python
  select(Ecu).where(Ecu.id == ecu_id, Ecu.supplier_id == user.company_id)
  ...
  raise HTTPException(status.HTTP_404_NOT_FOUND, detail="見つかりません")
  ```

- **採らなかったら何が起きるか**：まず ECU を番号だけで探すと、URL の番号を1つずつ変えて GET するだけで、他社の対策状況が読める（IDOR：番号を書き換えて他人のデータを読む攻撃）。探してから 403 を返すと、読めはしないが「その番号の ECU はある」と分かる。番号を順に試せば、他社の ECU の数を数えられる
- **外すと落ちるテスト**：`tests/test_api_ecus.py::test_get_other_company_ecu_is_404_same_as_missing`、`test_other_company_any_role_any_state_is_404`
- **車載ソフト開発に例えると**：診断で、セキュリティアクセスの前は「その DID は存在しない」と同じ否定応答を返し、何が入っているかを明かさない
- **ISO/SAE 21434・TARA**：脅威「他社の機密の漏えい（情報の開示）」に対する管理策

#### 4. 職務分離などの決まりを、API だけでなく DB の制約でも守る

- **判断**：「申請者本人は承認できない」「差し戻しには理由が必須」を、DB の CHECK 制約にも書く
- **実際のコード**：`backend/app/models.py:163`

  ```python
  CheckConstraint("approved_by <> submitted_by", name="separation_of_duties"),
  ```

- **採らなかったら何が起きるか**：API の確かめだけだと、あとで足す API（Day 8 の承認）で確かめを書き忘れたとき、1人で入力して承認できてしまう。DB の制約があれば、書き忘れても保存の時点で止まる
- **外すと落ちるテスト**：`tests/test_constraints.py::test_submitter_cannot_approve_own_version`、`test_submitter_cannot_approve_own_version_by_update`、`test_reject_requires_reason`
- **車載ソフト開発に例えると**：ソフトの確かめに加えて、ハードの保護（書き込み禁止の領域）でも守る多重の防御
- **ISO/SAE 21434**：多層防御（1つの管理策が抜けても、次で止める）

#### 5. 仮の本人確認は、既定で無効にする（新しく決めた判断。SC3-9）

- **判断**：ログイン（Day 6）の前に画面と API を試すための仮の本人確認（ヘッダー `X-Dev-User-Id`）は、設定 `DEV_AUTH_ENABLED` を明示的に true にしたときだけ使える。有効なら起動時に警告を出す
- **実際のコード**：`backend/app/config.py:31` の `dev_auth_enabled: bool = False`、`backend/app/deps.py:44`

  ```python
  if not settings.dev_auth_enabled or x_dev_user_id is None:
      raise unauthorized
  ```

- **採らなかったら何が起きるか**：既定で有効だと、AWS に載せたときに設定し忘れれば、ヘッダーに番号を書くだけで、誰でもどの会社の人にもなりすませる
- **外すと落ちるテスト**：`tests/test_auth_dev.py::test_dev_auth_is_disabled_by_default`、`test_disabled_dev_auth_rejects_valid_header`
- **車載ソフト開発に例えると**：開発用のデバッグポートを、量産では既定で閉じておく
- **ISO/SAE 21434**：開発用の機能を、製品の状態で無効にする（量産前の無効化の確認）

#### 6. AWS の CLI は、長く使うアクセスキーではなく `aws login` で使う（新しく決めた判断）

- **判断**：計画は「練習用の IAM ユーザー（MFA あり）＋アクセスキー」だった。2026-11-24 にオーナーが、CLI の認証を `aws login`（コンソールのサインインから、一時的な認証情報をもらう方法）にすると決めた。IAM ユーザー SC3_01 と MFA は計画のまま
- **実際のコード**：なし（手元の設定 `%UserProfile%\.aws` だけ。リポジトリには入れない）。確かめ：`aws sts get-caller-identity` の Arn が `user/SC3_01`（SC3-2 のコメント）
- **採らなかったら何が起きるか**：期限のないアクセスキーが手元のファイルに平文で残る。漏れると、気づいて無効にするまで、誰でも練習用のアカウントでリソースを作れる（費用ゼロの決まりも破られる）
- **外すと落ちるテスト**：テストなし（手元の認証の設定のため）。Terraform がこの認証で動くかは、Day 12 の前に公式の資料で確かめる
- **車載ソフト開発に例えると**：固定の鍵を焼き込むのではなく、セッションごとに鍵を配る
- **ISO/SAE 21434**：鍵の管理（鍵の寿命を短くし、漏えいの影響を小さくする）
