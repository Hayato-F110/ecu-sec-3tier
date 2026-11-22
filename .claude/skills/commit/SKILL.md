---
name: commit
description: 変更を確かめ、課題キー（SC3-xx）付きのメッセージでコミットする。秘密情報・tfstate・人の名前・会社の情報の混入を確かめる
disable-model-invocation: true
argument-hint: "[課題キー 例: SC3-13]"
---

コミットします。課題キー：$ARGUMENTS

1. `git status`、`git diff`、`git diff --staged` で変更を確かめる
2. コミットの前に確かめる（1つでも当てはまれば止めて知らせる）
   - main の上にいないか（いれば `feature/SC3-xx-短い説明` のブランチを作る）
   - 秘密情報（`.env`、鍵、トークン、DB のパスワード、JWT の鍵）が入っていないか
   - Terraform の状態・変数のファイル（`*.tfstate`、`*.tfvars`）、`.terraform/` が入っていないか
   - 人の名前（「オーナー」と書く）、会社の情報・実在の ECU の情報が入っていないか（ダミーデータは架空の名前だけ）
   - `tmp/`、`.venv/`、`node_modules/`、画面の写しが入っていないか
   - 関係のない変更が混ざっていないか（混ざっていれば、コミットを分ける）
3. 静的解析と、変えたファイルに関わるテストを流し、通ることを確かめる（落ちたら直してから。テストは裏で動かす）
   - Python：`uv run ruff check .` と関係する `uv run pytest <ファイル>`
   - 画面：`npm run lint` と関係する `npm test -- <ファイル>`
   - Hook：`node --test tests/hooks/`
   - push・PR の前には全体の検査を流す（CLAUDE.md「検査のコマンド」）
4. メッセージ：`SC3-xx 要約`（日本語。課題キーがなければブランチ名から読み取る。Jira に取り込む前の作業は `SC3-TBD`）。必要なら本文に「なぜ」を1〜3行。最後に、システムの指示にある Co-Authored-By の行を付ける
5. ファイルを名前で指定して `git add` し（`git add -A` は使わない）、コミットする。結果（コミットの ID と要約）を報告する

push と PR 作成は、このスキルでは行わない（必要なら続けて行う）。
