---
name: start-day
description: 1日の作業を始める。引き継ぎ（docs/handoff.md）・devlog・Jira・docs/schedule.md から、今日のゴール（計画書 第4章のその日の完了条件）と作業の順番を示し、最初の作業に入る
disable-model-invocation: true
argument-hint: "[確認だけ]"
---

1日の作業を始めます。次の順で進めてください。

1. `date` で今日の日付と時刻を確かめる（記憶や推測で書かない）
2. 読む：`docs/handoff.md`（最初に）、`CLAUDE.md`、最新の `docs/devlog/YYYY-MM-DD.md`、`docs/schedule.md`（Day ごとの「やること」と「その日の完了条件」）
3. `git status`・`git branch -a`・`gh pr list` で、作業中のブランチと未マージの PR を確かめる。`.claude/agent-reports/` に 48 時間の中のサブエージェントの報告があれば一覧にし、引き継ぎに「受け取れていない」とある報告がないか確かめる
4. Jira で、今のスプリントの課題の状態を確かめる（`searchJiraIssuesUsingJql`、`project = <キー> AND sprint in openSprints()`。キーは `.claude/hooks/project.json`）。引き継ぎと違う点があれば知らせる。スプリントの日付は Jira から読む（引き継ぎの日付は古いことがある）
5. **AWS を使う日（Day 12〜17）なら**、作業の前に `/aws-session 開始` の手順をオーナーと行う
6. 次を簡潔に示す
   - 今日の Day 番号・ゴール（`docs/schedule.md` の「その日の完了条件」）と、スプリントの残り日数
   - 作業の順番（課題キー・完了条件・目安時間。1日5時間）
   - 今日オーナーにお願いすること（AWS・GitHub・Jira の画面での操作、承認が要ること、お金や外部サービスに関わること）。最初にまとめて伝える
   - 遅れがあれば、削る候補（スプリントの範囲の変更はオーナーの承認が要る）。Day 5 なら見積もりの見直しも
   - **今日学ぶこと**：「流行の技術」「Claude の使い方」「セキュリティ」の3つに分けて、それぞれ1〜3行。今日の作業で実際に使うものだけを書き、仕事（車載ソフト開発）のどこで使えるかを添える。セキュリティは ISO/SAE 21434・TARA との対応を一言
   - **今日出てくる用語**（表。列は「用語｜略称｜読み方｜一言の意味」。前の devlog で説明済みのものは除く）
7. 引数が「確認だけ」なら、ここで止める。それ以外は、CLAUDE.md の進め方（`/story`）に沿って最初の作業に入る（作業を始めた課題は Jira で「進行中」にし、開始日を実際の日にする）
