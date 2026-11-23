# 引き継ぎ

最終更新：2026-11-23 18:35（`/end-day`。5時間の使用量 95% で止めた）

## いまの状態

- スプリント1（11/22〜11/24、SC3-2・8・9）。Jira の終わりは 11/24 23:00（日本時間）
- SC3-2（Day 1）：進行中。残りは AWS の準備（オーナーの作業）と `aws sts get-caller-identity` の確認
- SC3-8・SC3-9：完了（PR #5・#7）
- SC3-10（Day 4、スプリント2）：オーナーの指示で先に着手。Jira は進行中・開始日 11/23
  - ブランチ `feature/SC3-10-frontend`（途中の作業をコミット済み `a5a1c0d`、**未 push**）
  - 設計案（承認済み）：`C:\Users\hayat\.claude\plans\goofy-wobbling-church-of-fff166cd-2acc-4825-9153-99ff9be02539.md`
  - 済み：`frontend/`（雛形、API を呼ぶ関数、ECU 一覧と入力画面、nginx.conf、Dockerfile）、compose の `web`（127.0.0.1:8080）。テスト 21件は赤 → 緑
  - このブランチの `docs/handoff.md` の変更は古い。main と食い違うので、作業の再開時に `git checkout origin/main -- docs/handoff.md` で main に合わせる
- 学習マニュアル（34枚）：<https://claude.ai/artifact/YRYHcnsstw3GfbUk4ZmZbC>（非公開）

## 次にやること（Day 4 の続き）

1. `feature/SC3-10-frontend` に戻り、`cd frontend && npm test`・`npm run lint`・`npm run build` を流す（テストのファイルの型を `vi.fn<typeof fetch>` に直したあと、まだ流していない）
2. `docker compose up -d --build` → ブラウザで `http://127.0.0.1:8080`：A 社の入力者の ID で一覧 → 入力 → 保存 → 開き直す。他社の ECU の番号で「見つかりません」。`curl -I` で守りのヘッダー
3. `/code-review` 1回・security-reviewer → PR → マージ
4. AWS の準備が済めば SC3-2 を完了にする（証拠の表をコメントしてから）
5. 11/24 はスプリント1の最終日：`/design-decisions` と `/retro`

## バックログ（オーナーがスプリントに入れた）

- SC3-26：nginx の後ろでも監査ログに本当の接続元の ip を残す（スプリント2）
- SC3-25：差し戻しのあとの再申請で、申請者を必ず書き直す（スプリント3）
- SC3-27：API 用の DB ユーザーを分ける・SC3-28：httpx2（スプリント4）

## オーナーにお願いすること

1. AWS：ゼロ支出予算、練習用 IAM ユーザーと MFA、請求の画面の公開、CLI 用のアクセスキー、AWS CLI と `aws configure`（手順は 2026-11-23 に出典つきで渡した）
2. 画面で試す前に、`.env` に `DEV_AUTH_ENABLED=true` を書く（試し終わったら false に戻す）

## つまずき防止のメモ

- Docker Desktop が起動していないと、テストは DB に接続できず全部止まる
- Git Bash の curl で日本語の本文を送ると 400 になる。日本語は Python（`tmp/save_ja.py`）か `/docs` から送る
- 検査の出力はパイプにつながず、`tmp/` のファイルに書いてから読む（Hook が止める）
- 画面のテスト：画面の片付けは `frontend/src/test-setup.ts` の `cleanup`（Vitest の globals を使わないため）
- TypeScript は 6.0.3（7.0 は typescript-eslint が未対応。対応したら上げる）
- 作業時間は `node tmp/worktime.mjs YYYY-MM-DD`（会話の記録から。tmp は Git の対象外）
- PostgreSQL は 18。alembic.ini は ASCII だけ。接続先は `127.0.0.1`
- Jira のポイントの欄は `customfield_10016`。欄と遷移の ID は `.claude/hooks/project.json`
