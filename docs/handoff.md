# 引き継ぎ

最終更新：2026-11-24 18:50（週の使用量 99% で止めた）

## いまの状態

- スプリント1（SC3-2・8・9）：すべて完了。ふりかえり `docs/retro/sprint-1.md` と設計判断はオーナーの**承認待ち**
- スプリント2（11/25〜11/27）：SC3-10・SC3-31 は完了（先に着手）。残りは SC3-11（進行中）・SC3-12（Day 6）・SC3-26・SC3-29
- SC3-11（Day 5、進行中・開始日 11/24）：ブランチ `feature/SC3-11-matrix`（push 済み）。テストの一覧 `docs/test-plans/SC3-11.md` を書いた。test-plan-reviewer の結果は `.claude/agent-reports/` にある（未読）
- CLI の認証は `aws login`（オーナーの決定）。Terraform がこの認証で動くかは、Day 12 の前に公式の資料で確かめる

## 次にやること

1. `node tmp/worktime.mjs 2026-11-24` で 11/24 の作業時間を出し、devlog と SC3-11 のコメントに書く
2. test-plan-reviewer の報告を読み、テストの一覧を直す → 設計案をオーナーに出して承認をもらう（`/story`）
3. SC3-11：テストを先に → 実装（`GET /api/matrix`、画面 `/matrix`）→ `/code-review`（データ分離に関わるので2回まで）・security-reviewer → PR
4. SC3-11 の「見積もりの見直し」（Day 1〜5 の実際の時間から）

## オーナーにお願いすること

1. ふりかえりと設計判断の承認（`docs/retro/sprint-1.md`・`docs/design-decisions.md` の「スプリント1」）

## つまずき防止のメモ

- Docker Desktop が起動していないと、テストは DB に接続できず全部止まる
- 検査の出力はパイプにつながず、`tmp/` のファイルに書いてから読む（Hook が止める）
- Git Bash で `origin/main:パス` を使うときは `MSYS_NO_PATHCONV=1`（パスに書き換えられる）
- `node -e` に正規表現のバックスラッシュを書くと Hook が止める。スクリプトは `tmp/` のファイルに
- nginx のテスト：`node --test tests/web/`（3層が動いているときだけ）
- Jira の開始日（customfield_10015）は遷移と一緒に設定できない。遷移のあと `editJiraIssue` で
- 作業時間は `node tmp/worktime.mjs YYYY-MM-DD`
