# 引き継ぎ

最終更新：2026-11-25 17:31

## いまの状態

- スプリント1（SC3-2・8・9）：完了（オーナーが 11/25 に Jira で完了にした）。設計判断はオーナーが承認。ふりかえり `docs/retro/sprint-1.md` は KPT の形に書き直した（オーナーの確認待ち）
- スプリント2（11/25〜11/27 23:00）：SC3-10・SC3-31 は完了。残りは SC3-11（進行中）・SC3-12（Day 6）・SC3-26・SC3-29
- SC3-11（Day 5、進行中・開始日 11/24）：ブランチ `feature/SC3-11-matrix`（main を取り込み、push 済み）。テストの一覧 `docs/test-plans/SC3-11.md` に test-plan-reviewer の指摘を反映する。オーナーの決定（11/25）：マトリクスはメーカーのシステム管理者にも見せる
- CLI の認証は `aws login`（オーナーの決定）。Terraform がこの認証で動くかは、Day 12 の前に公式の資料で確かめる

## 次にやること

1. SC3-11：テストの一覧に test-plan-reviewer の指摘（版1→2→3 の ECU、承認待ちだけの ECU、役割の食い違いの 403、全部の文字の欄の XSS）と管理者の決定を反映 → 設計案をオーナーに出して承認をもらう（`/story`）
2. SC3-11：テストを先に → 実装（`GET /api/matrix`、画面 `/matrix`）→ `/code-review`（データ分離に関わるので2回まで）・security-reviewer → PR
3. SC3-11 の「見積もりの見直し」（Day 1〜5 の実際の時間から）

## オーナーにお願いすること

1. 書き直したふりかえり（`docs/retro/sprint-1.md`）の確認

## つまずき防止のメモ

- Docker Desktop が起動していないと、テストは DB に接続できず全部止まる
- 検査の出力はパイプにつながず、`tmp/` のファイルに書いてから読む（Hook が止める）
- Git Bash で `origin/main:パス` を使うときは `MSYS_NO_PATHCONV=1`（パスに書き換えられる）
- `node -e` に正規表現のバックスラッシュを書くと Hook が止める。スクリプトは `tmp/` のファイルに
- nginx のテスト：`node --test tests/web/`（3層が動いているときだけ）
- Jira の開始日（customfield_10015）は遷移と一緒に設定できない。遷移のあと `editJiraIssue` で
- 作業時間は `node tmp/worktime.mjs YYYY-MM-DD`（「〜時間〜分」で出る）
- 画面のテスト（Vitest）は、作業フォルダのドライブ名が小文字の `c:` だと、今あるテストまで「Vitest failed to find the current suite」で全部落ちる。PowerShell で `Set-Location "C:\Users\..."`（大文字）にしてから流す（11/25。原因は確かめていない）
- Docker Desktop は `$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe` にある（Program Files ではない）
