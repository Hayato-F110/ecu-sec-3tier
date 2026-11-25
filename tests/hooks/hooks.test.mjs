// .claude/hooks/ の判定の関数のテスト。Node の標準のテスト機能だけを使う（追加の依存なし）。
// 実行：node --test tests/hooks/
// nori-adventure の tests/hooks/*.test.ts（Vitest）から、このプロジェクトで使う判定を選んで移した。
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkCli, checkTerraform } from "../../.claude/hooks/guard-aws-cost.mjs";
import {
  asTransition,
  doneDecision,
  evidenceTableOf,
  keyOf,
} from "../../.claude/hooks/guard-done-evidence.mjs";
import { findDestructive } from "../../.claude/hooks/guard-delete.mjs";
import { findInlineBackslashRisk } from "../../.claude/hooks/guard-inline-backslash.mjs";
import {
  findMissingJiraFields,
  findSprintAssignment,
  findSprintMove,
  JIRA_KEY,
} from "../../.claude/hooks/guard-jira-fields.mjs";
import { findCheckPipe, findLongForeground } from "../../.claude/hooks/guard-long-foreground.mjs";
import { findSkippedCheck } from "../../.claude/hooks/guard-no-verify.mjs";
import { findEnglishLines } from "../../.claude/hooks/japanese-reply.mjs";
import { findUndefinedTerms } from "../../.claude/hooks/plain-terms.mjs";
import { findPathReason, findSecretInText } from "../../.claude/hooks/protect-secrets.mjs";
import {
  hasFixEvidenceTable,
  isCodeFile,
  prBodyOf,
  reviewDecision,
} from "../../.claude/hooks/review-before-pr.mjs";
import { findWaitWithoutNext } from "../../.claude/hooks/wait-needs-next.mjs";
import { findStepsWithoutSource } from "../../.claude/hooks/guard-cite-sources.mjs";
import {
  findMissingAnswerSection,
  HEADING,
  queuedMessagesOfThisTurn,
} from "../../.claude/hooks/answer-in-final.mjs";

const ROOT = "C:/work/repo";

describe("protect-secrets", () => {
  test("秘密のファイルを止める", () => {
    for (const p of [".env", "backend/.env", ".env.local", "id_ed25519", "infra/terraform.tfstate",
      "infra/terraform.tfstate.backup", "infra/prod.tfvars", "~/.aws/credentials", "secrets/db.txt"]) {
      assert.notEqual(findPathReason(p, ROOT, ROOT), null, p);
    }
  });
  test("見本や普通のファイルは通す", () => {
    for (const p of ["env.example", "backend/app/main.py", "infra/main.tf", "infra/variables.tf"]) {
      assert.equal(findPathReason(p, ROOT, ROOT), null, p);
    }
  });
  test("鍵らしい文字列を見つける（テストの中では組み立てて書く）", () => {
    assert.notEqual(findSecretInText(`key = ${"AKIA"}${"A".repeat(16)}`), null);
    assert.notEqual(findSecretInText(`-----BEGIN ${"RSA PRIVATE"} KEY-----`), null);
    assert.equal(findSecretInText("password_hash = bcrypt.hash(pw)"), null);
  });
});

describe("guard-delete", () => {
  test("消す操作・履歴の書き換えを見つける", () => {
    assert.equal(findDestructive("rm -f a.txt", "Bash"), "rm");
    assert.equal(findDestructive("git reset --hard HEAD~1", "Bash"), "git reset --hard");
    assert.equal(findDestructive("git push --force origin x", "Bash"), "git push --force");
    assert.equal(findDestructive("Remove-Item tmp -Recurse", "PowerShell"), "Remove-Item");
  });
  test("例外（マージ済みのブランチの -d）とふつうの操作は通す", () => {
    assert.equal(findDestructive("git branch -d feature/SC3-1-x", "Bash"), null);
    assert.equal(findDestructive("git status && git diff", "Bash"), null);
  });
});

describe("guard-no-verify", () => {
  test("確認を飛ばす指定を止める", () => {
    assert.notEqual(findSkippedCheck('git commit --no-verify -m "x"'), null);
    assert.notEqual(findSkippedCheck("git commit -nm x"), null);
  });
  test("コミットの文の中の言葉では止めない", () => {
    assert.equal(findSkippedCheck('git commit -m "--no-verify を使わない"'), null);
  });
});

describe("guard-inline-backslash", () => {
  test("インラインのコードの Windows のパスを止める", () => {
    assert.notEqual(findInlineBackslashRisk(String.raw`python -c "open('C:\data\x.txt')"`), null);
  });
  test("ファイルを実行するのは通す", () => {
    assert.equal(findInlineBackslashRisk(String.raw`python tools\seed.py`), null);
  });
});

describe("guard-long-foreground", () => {
  test("長い処理を表で流すと止める", () => {
    assert.equal(findLongForeground("uv run pytest", false), "pytest");
    assert.equal(findLongForeground("cd backend && pytest -q", false), "pytest");
    assert.equal(findLongForeground("docker compose up", false), "docker compose up（-d なし）");
    assert.equal(findLongForeground("terraform -chdir=infra apply", false), "terraform plan / apply / destroy");
    assert.equal(findLongForeground("gh pr checks 3 --watch", false), "CI の見張り");
  });
  test("裏で動かす・すぐ終わるものは通す", () => {
    assert.equal(findLongForeground("uv run pytest", true), null);
    assert.equal(findLongForeground("docker compose up -d db", false), null);
    assert.equal(findLongForeground("docker compose ps", false), null);
    assert.equal(findLongForeground('git commit -m "pytest を足す"', false), null);
  });
  test("検査をパイプにつなぐと止める（終了コードが隠れる）", () => {
    assert.notEqual(findCheckPipe("uv run pytest | tail -5"), null);
    assert.equal(findCheckPipe("set -o pipefail; uv run pytest | tail -5"), null);
    assert.equal(findCheckPipe("uv run pytest > tmp/check.txt 2>&1"), null);
  });
});

describe("guard-jira-fields", () => {
  const base = { projectKey: JIRA_KEY, issueType: "ストーリー" };
  test("ポイント・期限・開始日がなければ止める", () => {
    assert.equal(findMissingJiraFields({ ...base, additional_fields: {} }).length, 3);
  });
  test("そろっていれば通す。よそのプロジェクトとエピックは見ない", () => {
    const ok = { customfield_10016: 3, duedate: "2026-12-01", customfield_10015: "2026-11-30" };
    assert.equal(findMissingJiraFields({ ...base, additional_fields: ok }).length, 0);
    // nori-adventure のポイントの欄（このプロジェクトにはない）を使ったら止める
    assert.equal(findMissingJiraFields({ ...base, additional_fields: { ...ok, customfield_10034: 3 } }).length, 1);
    assert.equal(findMissingJiraFields({ projectKey: "OTHER", additional_fields: {} }).length, 0);
    assert.equal(findMissingJiraFields({ ...base, issueType: "エピック", additional_fields: {} }).length, 0);
  });
  test("スプリントに入れる操作を止める（入れるのはオーナー）", () => {
    assert.equal(findSprintAssignment({ ...base, assignToSprint: 12 }).length, 1);
    assert.equal(
      findSprintMove("mcp__x__editJiraIssue", { issueIdOrKey: `${JIRA_KEY}-3`, fields: { sprint: 1 } }).length,
      1,
    );
    assert.equal(findSprintMove("mcp__x__editJiraIssue", { issueIdOrKey: "OTHER-3", fields: { sprint: 1 } }).length, 0);
  });
});

describe("guard-aws-cost", () => {
  test("費用ゼロのガードレールに反する Terraform を止める", () => {
    assert.equal(checkTerraform('resource "aws_nat_gateway" "n" {}').block.length, 1);
    assert.equal(checkTerraform("  multi_az = true").block.length, 1);
    assert.equal(checkTerraform("  publicly_accessible = true").block.length, 1);
    assert.equal(checkTerraform("  from_port = 22\n  to_port = 22").block.length, 1);
    assert.equal(checkTerraform('resource "aws_secretsmanager_secret" "s" {}').block.length, 1);
  });
  test("大きなインスタンスは確認を出し、micro・small とコメントは通す", () => {
    assert.equal(checkTerraform('instance_class = "db.m5.large"').ask.length, 1);
    const ok = checkTerraform('instance_class = "db.t4g.micro"\ninstance_type = "t3.small"\n# multi_az = true');
    assert.deepEqual(ok, { block: [], ask: [] });
  });
  test("aws CLI の有料の操作を止める", () => {
    assert.equal(checkCli("aws ec2 create-nat-gateway --subnet-id x").length, 1);
    assert.equal(checkCli("aws sts get-caller-identity").length, 0);
  });
});

describe("guard-done-evidence", () => {
  const TABLE = ["| 完了条件 | 証拠 | 結果 |", "| --- | --- | --- |", "| テストが通る | PR #3 | 達成 |"].join("\n");
  // 会話の記録の形：道具の呼び出し（assistant）と、その結果（user）
  const comment = (key, body, id = "t1", isError = false) => [
    { message: { content: [{ type: "tool_use", id, name: "mcp__x__addOrEditJiraIssueComment", input: { issueIdOrKey: key, commentBody: body } }] } },
    { message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] } },
  ];
  const done = (key) => ({ issueIdOrKey: key, transitionId: "31" });

  test("証拠の表のコメントがなければ止める", () => {
    assert.notEqual(doneDecision(done("SC3-8"), []), null);
    // 別の課題に書いた表は数えない
    assert.notEqual(doneDecision(done("SC3-8"), comment("SC3-9", TABLE)), null);
    // 失敗したコメントは数えない
    assert.notEqual(doneDecision(done("SC3-8"), comment("SC3-8", TABLE, "t1", true)), null);
    // 表でない文だけのコメントは数えない
    assert.notEqual(doneDecision(done("SC3-8"), comment("SC3-8", "完了条件はすべて満たしました")), null);
  });
  test("表に「未達」があれば止める", () => {
    const unmet = `${TABLE}\n| CI が緑 | なし | 未達 |`;
    assert.match(doneDecision(done("SC3-8"), comment("SC3-8", unmet)), /未達/);
  });
  test("表があれば通す。完了でない遷移・よそのプロジェクトは見ない", () => {
    assert.equal(doneDecision(done("SC3-8"), comment("sc3-8", TABLE)), null);
    assert.equal(doneDecision({ issueIdOrKey: "SC3-8", transitionName: "完了" }, comment("SC3-8", TABLE)), null);
    assert.equal(doneDecision({ issueIdOrKey: "SC3-8", transitionId: "21" }, []), null);
    assert.equal(doneDecision(done("OTHER-1"), []), null);
  });
  test("/code-review の指摘の直し", () => {
    // 指摘 1：番号の ID で指定したら、別の課題の表で通さずに止める
    const byId = comment("10050", TABLE);
    assert.match(doneDecision({ issueIdOrKey: "10023", transitionId: "31" }, byId), /課題キー/);
    // 指摘 2：見出しだけの表は数えない
    assert.notEqual(doneDecision(done("SC3-8"), comment("SC3-8", "| 完了条件 | 証拠 |\n| --- | --- |")), null);
    // 指摘 3：「完了」「done」を含む遷移の名前も見る
    assert.notEqual(doneDecision({ issueIdOrKey: "SC3-8", transitionName: "Review->Done" }, []), null);
    // 指摘 4：条件の文の中の「未達」では止めない。結果の列の「未達」では止める
    const wording = "| 完了条件 | 証拠 | 結果 |\n| --- | --- | --- |\n| 未達の行がないこと | PR #5 | 達成 |";
    assert.equal(doneDecision(done("SC3-8"), comment("SC3-8", wording)), null);
  });
  test("2 回目の /code-review の指摘の直し", () => {
    // 指摘 1・6：「未完了に戻す」「undone」は完了とみなさない。「完了にする」は完了とみなす
    assert.equal(doneDecision({ issueIdOrKey: "SC3-8", transitionName: "未完了に戻す" }, []), null);
    assert.equal(doneDecision({ issueIdOrKey: "SC3-8", transitionName: "Mark undone" }, []), null);
    assert.notEqual(doneDecision({ issueIdOrKey: "SC3-8", transitionName: "完了にする" }, []), null);
    // 指摘 2：汎用の書き込みの遷移と、状態の欄の編集も見る
    const viaExecute = asTransition("mcp__x__executeWrite", {
      name: "transitionIssue",
      inputs: { issueIdOrKey: "SC3-8", transition: { id: "31" } },
    });
    assert.notEqual(doneDecision(viaExecute, []), null);
    const viaEdit = asTransition("mcp__x__editJiraIssue", { issueIdOrKey: "SC3-8", fields: { resolution: "完了" } });
    assert.notEqual(doneDecision(viaEdit, []), null);
    assert.equal(asTransition("mcp__x__editJiraIssue", { issueIdOrKey: "SC3-8", fields: { summary: "x" } }), null);
    // 指摘 4：結果の列がないとき、「未達（理由）」も数える
    const noResult = "| 完了条件 | 証拠 | 状態 |\n| --- | --- | --- |\n| CI が緑 | なし | 未達（Day 11 で作る） |";
    assert.match(doneDecision(done("SC3-8"), comment("SC3-8", noResult)), /未達/);
    // 指摘 5：「完了条件（期待する結果）」の列を結果の列と取り違えない
    const tricky = "| 完了条件（期待する結果） | 証拠 | 結果 |\n| --- | --- | --- |\n| テストが通る | PR #3 | 未達 |";
    assert.match(doneDecision(done("SC3-8"), comment("SC3-8", tricky)), /未達/);
  });
  test("名前での完了の指定と、URL の課題キーを読む", () => {
    assert.notEqual(doneDecision({ issueIdOrKey: "SC3-8", transitionName: "Done" }, []), null);
    assert.equal(keyOf("https://example.atlassian.net/browse/SC3-12"), "SC3-12");
    assert.deepEqual(evidenceTableOf("| 項目 | 結果 |\n| --- | --- |\n| a | 未達 |"), { table: false, unmet: 0 });
  });
});

describe("review-before-pr：最後のレビューのあとの直しと、直しの証拠の表", () => {
  const CWD = "C:/w/repo";
  const review = (id, timestamp = "2026-11-22T10:00:00Z") => [
    { cwd: CWD, timestamp, message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill: "code-review" } }] } },
    { cwd: CWD, timestamp, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "ok" }] } },
  ];
  // このブランチの最初のコミットの時刻（これよりあとのレビューだけを、表での例外に数える）
  const branchStart = "2026-11-22T09:00:00Z";
  const commit = { cwd: CWD, message: { content: [{ type: "tool_use", id: "c", name: "Bash", input: { command: 'git commit -m "x"' } }] } };
  const base = { command: "gh pr create --body-file tmp/pr-body.md", cwd: CWD, diffFiles: [".claude/hooks/x.mjs"] };
  const TABLE = [
    "## 直しの証拠の表",
    "",
    "| コミット | どの指摘の直しか | 何が変わるか | 直しを戻すと落ちるテスト |",
    "| --- | --- | --- | --- |",
    "| abc123 | 2 回目の 1 | 完了の名前を広く見る | 指摘の直しのテスト |",
  ].join("\n");

  test("最後のコミットのあとにレビューがあれば通す", () => {
    assert.equal(reviewDecision({ ...base, entries: [commit, ...review("r1")] }).block, false);
  });
  test("レビューのあとに直したら止める。直しの証拠の表があれば通す", () => {
    const entries = [...review("r1"), commit];
    assert.equal(reviewDecision({ ...base, entries, branchStart }).block, true);
    assert.equal(reviewDecision({ ...base, entries, prBody: TABLE, branchStart }).block, false);
  });
  test("レビューを1回もしていなければ、表があっても止める", () => {
    assert.equal(reviewDecision({ ...base, entries: [commit], prBody: TABLE, branchStart }).block, true);
  });
  test("前の PR のときのレビュー（ブランチの最初のコミットより前）は数えない", () => {
    const entries = [...review("old", "2026-11-22T08:00:00Z"), commit];
    assert.equal(reviewDecision({ ...base, entries, prBody: TABLE, branchStart }).block, true);
    // ブランチの始まりが分からないときは、表での例外を使わない
    assert.equal(reviewDecision({ ...base, entries: [...review("r1"), commit], prBody: TABLE }).block, true);
  });
  test("表の見分け：見出しだけ・列が違う・中身の行がないものは表とみなさない", () => {
    assert.equal(hasFixEvidenceTable(TABLE), true);
    assert.equal(hasFixEvidenceTable("## 直しの証拠の表\n\nなし"), false);
    assert.equal(hasFixEvidenceTable("## 直しの証拠の表\n\n| 項目 | 結果 |\n| --- | --- |\n| a | b |"), false);
    assert.equal(hasFixEvidenceTable(TABLE.split("\n").slice(0, 4).join("\n")), false);
    // コードブロックの中の見本の表は数えない
    assert.equal(hasFixEvidenceTable(["```markdown", TABLE, "```"].join("\n")), false);
  });
  test("PR の説明を --body-file と --body から読む", () => {
    // 場所は大文字と小文字をそのまま使う（大文字と小文字を区別する OS でも読めるように）
    assert.equal(prBodyOf("gh pr create --body-file tmp/b.md", CWD, (f) => `read:${f}`), "read:C:/w/repo/tmp/b.md");
    // 前にある git commit -F（コミットの文のファイル）を、PR の説明と取り違えない
    assert.equal(
      prBodyOf("git commit -F tmp/msg.txt && gh pr create --body-file tmp/pr.md", CWD, (f) => `read:${f}`),
      "read:C:/w/repo/tmp/pr.md",
    );
    assert.equal(prBodyOf('gh pr create --title t --body "本文"', CWD), "本文");
    assert.equal(prBodyOf("gh pr create --fill", CWD), "");
  });
});

describe("japanese-reply / plain-terms / wait-needs-next / review-before-pr", () => {
  test("英語だけの行を見つける", () => {
    assert.equal(findEnglishLines("Now I will run the tests here.").length, 1);
    assert.equal(findEnglishLines("テストを流します（`uv run pytest`）。").length, 0);
  });
  test("説明なしの用語を見つける", () => {
    assert.deepEqual(findUndefinedTerms("HUD を直した", ["HUD"]), ["HUD"]);
    assert.deepEqual(findUndefinedTerms("HUD（上の表示）を直した", ["HUD"]), []);
  });
  test("待つと書いたら、待つ間に進める課題が要る", () => {
    assert.notEqual(findWaitWithoutNext("CI を裏で見張ります。"), null);
    assert.equal(findWaitWithoutNext("CI を裏で見張ります。\n待つ間に進める課題：SC3-5"), null);
  });
  test("コードの場所を見分ける", () => {
    assert.equal(isCodeFile("backend/app/main.py"), true);
    assert.equal(isCodeFile("infra/main.tf"), true);
    assert.equal(isCodeFile("docs/handoff.md"), false);
  });
});

describe("guard-cite-sources（外部サービスの画面の手順には公式の出典）", () => {
  const AWS_STEPS =
    "**手順**\n1. コンソールで「KMS」を開く\n2. 左のメニューの「カスタマー管理型のキー」を押す\n";
  test("AWS の画面の手順に出典がなければ止める", () => {
    assert.notEqual(findStepsWithoutSource(AWS_STEPS), null);
  });
  test("公式の資料の URL があれば通す", () => {
    const ok = `${AWS_STEPS}出典：https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html\n`;
    assert.equal(findStepsWithoutSource(ok), null);
    const pricing = `${AWS_STEPS}出典：https://aws.amazon.com/kms/pricing/\n`;
    assert.equal(findStepsWithoutSource(pricing), null);
  });
  test("公式でない URL（ブログ・まとめ）では通さない", () => {
    const blog = `${AWS_STEPS}出典：https://example.com/aws-kms-howto\n`;
    assert.notEqual(findStepsWithoutSource(blog), null);
  });
  test("GitHub・Atlassian の画面の手順にも公式の出典が要る", () => {
    const gh = "1. GitHub のリポジトリの Settings を開く\n2. 左のメニューの「Branches」を押す\n";
    assert.notEqual(findStepsWithoutSource(gh), null);
    assert.equal(
      findStepsWithoutSource(`${gh}出典：https://docs.github.com/ja/repositories\n`),
      null,
    );
    const jira = "1. Jira のボードを開く\n2. 「スプリントを作成」を押す\n";
    assert.notEqual(findStepsWithoutSource(jira), null);
    assert.equal(
      findStepsWithoutSource(`${jira}出典：https://support.atlassian.com/jira-software-cloud/\n`),
      null,
    );
  });
  test("2026-11-22 に記憶で書いた Tag Editor の手順を止める（再発の防止）", () => {
    const actual =
      "1. 上の検索欄に「Tag Editor」と入れ、「Resource Groups & Tag Editor」を開く\n" +
      "2. 左のメニューの「タグエディタ」（Tag Editor）を押す\n" +
      "3. 検索の条件を次のようにする\n4. 「リソースを検索」を押す\n";
    assert.notEqual(findStepsWithoutSource(actual), null);
    const arrows = "「Resource Groups & Tag Editor」→「Tag Editor」で、リージョンに「All regions」";
    assert.equal(findStepsWithoutSource(arrows), null); // 矢印1つだけなら手順とはみなさない
    assert.notEqual(findStepsWithoutSource(`「請求とコスト管理」→「請求書」→「サービス別の料金」`), null);
  });
  test("（レビュー1回目）「を開いて」「を選んで」の形と、空白のない「・」の箇条書きも手順とみなす", () => {
    const te = "1. AWS のコンソールを開いて「Billing」に入る\n2. 「請求書」を選んで中身を見る\n";
    assert.notEqual(findStepsWithoutSource(te), null);
    const dot = "・AWS のコンソールで「KMS」を開く\n・左のメニューの「キー」を押す\n";
    assert.notEqual(findStepsWithoutSource(dot), null);
  });
  test("（レビュー1回目）Lambda など、AWS と書かないサービスの手順も見る", () => {
    const lambda = "1. 「Lambda」の画面で「関数」を選び\n2. 「設定」タブに切り替える\n";
    assert.notEqual(findStepsWithoutSource(lambda), null);
  });
  test("（レビュー1回目）状態の流れの矢印と、決めてほしいことの一覧は止めない", () => {
    const flow = "Jira の SC3-9 で作ります。状態は「下書き」→「申請中」→「承認済み」と進みます。";
    assert.equal(findStepsWithoutSource(flow), null);
    const decision = "決めてほしいこと（GitHub の PR #6）\n1. A 案を選ぶ\n2. B 案を選ぶ\nおすすめ：A。";
    assert.equal(findStepsWithoutSource(decision), null);
  });
  test("（レビュー1回目）末尾に「/」のない公式の URL も出典とみなす。コードの中の URL は出典にしない", () => {
    assert.equal(findStepsWithoutSource(`${AWS_STEPS}出典：https://docs.aws.amazon.com\n`), null);
    assert.equal(findStepsWithoutSource(`${AWS_STEPS}（https://docs.aws.amazon.com）\n`), null);
    const inCode = `${AWS_STEPS}\`\`\`\nhttps://docs.aws.amazon.com/kms/\n\`\`\`\n`;
    assert.notEqual(findStepsWithoutSource(inCode), null);
  });
  // ---- レビュー2回目の指摘（直しを戻すと落ちる） ----
  test("（2回目-1）作業の報告（過去形）と、「」つきの選択肢の一覧は止めない", () => {
    const report =
      "完了したこと（GitHub の PR #7）\n- 承認の画面に「承認」ボタンを入れた\n- 「下書き」タブを開くテストを足した\n";
    assert.equal(findStepsWithoutSource(report), null);
    const choices = "決めてほしいこと（GitHub の PR #6）\n1. 「A 案」を選ぶ\n2. 「B 案」を選ぶ\n";
    assert.equal(findStepsWithoutSource(choices), null);
  });
  test("（2回目-2）「画面」とあっても、状態の流れの矢印は数えない", () => {
    const flow = "Jira の SC3-9。画面では「下書き」→「申請中」→「承認済み」と変わります。";
    assert.equal(findStepsWithoutSource(flow), null);
  });
  test("（2回目-3）インラインのコードで書いた手順も止める", () => {
    const code = "1. AWS で `IAM` → `Users` を開く\n2. `Create user` を押す\n";
    assert.notEqual(findStepsWithoutSource(code), null);
  });
  test("（2回目-4）①②・表の行・「>」の階層の書き方も手順とみなす", () => {
    assert.notEqual(findStepsWithoutSource("AWS のコンソールで\n① 「KMS」を開く\n② 「キー」を押す\n"), null);
    assert.notEqual(
      findStepsWithoutSource("| 1 | AWS のコンソールで「KMS」を開く |\n| 2 | 左のメニューの「キー」を押す |\n"),
      null,
    );
    assert.notEqual(
      findStepsWithoutSource("AWS コンソールの KMS > カスタマー管理型のキー を開く。次に Billing > 請求書 を開く。"),
      null,
    );
  });
  test("（2回目-5）手順のサービスに合う公式の URL が要る（AWS の手順に GitHub の URL では通さない）", () => {
    assert.notEqual(findStepsWithoutSource(`${AWS_STEPS}出典：https://docs.github.com/ja/actions\n`), null);
  });
  test("（2回目-6）AWS のブログと repost.aws は公式の出典とみなさない", () => {
    assert.notEqual(findStepsWithoutSource(`${AWS_STEPS}出典：https://aws.amazon.com/blogs/security/foo\n`), null);
    assert.notEqual(findStepsWithoutSource(`${AWS_STEPS}出典：https://repost.aws/questions/abc\n`), null);
  });
  test("（2回目-7）ホスト名のすぐあとに句読点や「>」が続く公式の URL も出典とみなす", () => {
    assert.equal(findStepsWithoutSource(`${AWS_STEPS}出典はhttps://docs.aws.amazon.com。\n`), null);
    assert.equal(findStepsWithoutSource(`${AWS_STEPS}<https://docs.aws.amazon.com>\n`), null);
  });
  test("（2回目-8）操作が1つだけの行は、1つと数える", () => {
    assert.equal(findStepsWithoutSource("1. 「KMS」→「キー」を開く (AWS)"), null);
  });
  // ---- 2026-11-23 に実際に誤って止めた文章（会話の記録から取り出した） ----
  test("（誤止め 2026-11-23-1）「を」のない「開く」「開けます」は操作とみなさない", () => {
    const actual =
      "- PowerPoint の形で取り出すときは、ページの「共有 › 書き出し」から .pptx にできます。" +
      "日本語の書体（Noto Sans JP）は .pptx には入らないため、開く PC の書体に置き換わります\n" +
      "- このページは今はご本人だけが開けます。ほかの人に見せるときは、ページの共有メニューで共有してください\n" +
      "（AWS は使っていません）\n";
    assert.equal(findStepsWithoutSource(actual), null);
  });
  test("（誤止め 2026-11-23-2）操作の言葉のない行の矢印（項目の並び）は手順とみなさない", () => {
    const actual =
      "## 次にやること\n\n" +
      "1. **AWS の準備の手順**を、公式の資料で確かめて出典つきでお渡しします" +
      "（予算 → IAM ユーザー〔AWS の利用者アカウント〕と MFA → アクセスキー → CLI）。" +
      "お渡ししたあとの画面での操作は、オーナーの作業です\n" +
      "2. Hook の誤った止め方を直す\n";
    assert.equal(findStepsWithoutSource(actual), null);
  });
  test("（誤止め 2026-11-23・レビュー1回目）操作の言葉のない画面の場所（表・別の行・かっこの外）は止める", () => {
    const table =
      "| 作業 | 画面の場所 |\n|---|---|\n| 予算 | Billing → Budgets → Create budget |\n" +
      "| ユーザー | IAM → Users → Create user |\n";
    assert.notEqual(findStepsWithoutSource(table), null);
    const nextLine = "AWS コンソールで次の場所へ：\nBilling → Budgets → Create budget\nそこで「作成」を押す\n";
    assert.notEqual(findStepsWithoutSource(nextLine), null);
    assert.notEqual(findStepsWithoutSource("場所：AWS コンソール → IAM → ユーザー\n"), null);
  });
  test("（誤止め 2026-11-23・レビュー1回目）「から選ぶ」「から開く」「で押す」も操作とみなす", () => {
    const steps = "1. AWS コンソールの右上のリージョンのメニューから選ぶ\n2. 一覧から開く\n3. 「作成」ボタンで押す\n";
    assert.notEqual(findStepsWithoutSource(steps), null);
  });
  test("（誤止め 2026-11-23・レビュー1回目）かっこの中の項目の並びは、「手に入れる」「タブ区切り」があっても止めない", () => {
    assert.equal(
      findStepsWithoutSource("1. AWS の準備（予算 → IAM ユーザーと MFA を手に入れる → アクセスキー → CLI）を進める\n"),
      null,
    );
    assert.equal(findStepsWithoutSource("- AWS の料金表（タブ区切り。予算 → IAM → CLI の順）を見る\n"), null);
  });
  // ---- 2026-11-24 に実際に誤って止めた文章（会話の記録から取り出した。SC3-31） ----
  test("（誤止め 2026-11-24-1）予定の表と「入力できる」は、画面の手順とみなさない", () => {
    const actual =
      "- **日付と Day**：暦の上ではスプリント1の最終日（Jira では今日 23:00 まで）です。作業は先に進めていて、Day 4（SC3-10）の続きです。AWS を使う日ではありません。\n" +
      "- **今日のゴール**：SC3-10 の完了条件「ブラウザから入力できる」を満たします。あわせて、スプリント1の締めとして設計判断の説明とふりかえりを書きます。\n" +
      "- **Jira**：引き継ぎのとおりでした。SC3-2 は進行中、SC3-8・9 は完了です。\n\n" +
      "### 作業の順番（今は 17:56。23:00 までの約5時間）\n\n" +
      "| # | 課題 | 完了条件 | 目安 |\n|---|---|---|---|\n" +
      "| 1 | SC3-10 | テスト・静的な検査（lint）・ビルドが通る | 0.3h |\n" +
      "| 2 | SC3-10 | `docker compose up` で動かし、ブラウザで一覧 → 入力 → 保存 → 開き直す。他社の ECU は「見つかりません」になる | 0.7h |\n" +
      "| 3 | SC3-10 | `/code-review` 1回と security-reviewer → PR → マージ → 証拠の表を書いて完了にする | 1.0h |\n" +
      "| 4 | スプリント1 | `/design-decisions` と `/retro`（23:00 まで） | 1.0h |\n" +
      "| 5 | SC3-2 | AWS の準備が済んでいれば、確認して完了にする | 0.3h |\n" +
      "| 6 | 残りの時間 | SC3-26（nginx の後ろでも監査ログに本当の接続元を残す。スプリント2）。SC3-10 の nginx とつながるため | 残り |\n";
    assert.equal(findStepsWithoutSource(actual), null);
  });
  test("（誤止め 2026-11-24-2）指摘の仕分けの表（番号 S1〜S3、「〜を開くテスト」）は、画面の手順とみなさない", () => {
    const actual =
      "| # | 指摘 | 仕分け |\n|---|---|---|\n" +
      "| S1 | 他社のユーザーが「版のない ECU」を開くテストがない（今回変えた枝） | **直す**（テストを足す） |\n" +
      "| S2 | `frontend/.dockerignore` に `.env` がない | **直す**（backend とそろえる） |\n" +
      "| S3 | nginx がどの Host 名でも受け付ける（DNS の付け替えの攻撃。悪いサイトが自分のドメイン名の行き先を 127.0.0.1 に変え、手元の画面を読む）。推測で、試していない | **この PR では直さず、バックログへ**。理由：条件が「仮の本人確認を有効にしたまま、悪いサイトを開く」に限られ、Day 6 で JWT に変われば、ヘッダーに番号を書くだけではなりすませなくなります。直すには nginx の書き方を資料で確かめ、手で試す必要があり、この PR の範囲を広げてしまいます |\n" +
      "| 参考 | `/api/` の失敗の応答にも守りのヘッダーが付くかのテストがない | **直す**（1件足す） |\n" +
      "| 参考 | 監査ログの IP | SC3-26 で扱う（予定どおり） |\n";
    assert.equal(findStepsWithoutSource(actual), null);
  });
  test("（誤止め 2026-11-24-3）手順でない表の Jira は、どのサービスの手順かの材料にしない（AWS の手順に AWS の出典があれば通す）", () => {
    const actual =
      "| 手順 | 状態 | 証拠 |\n|---|---|---|\n" +
      "| 3 AWS の後片付け | 対象外 | AWS を使っていない |\n" +
      "| 6 Jira | 済み | SC3-10 に作業時間 1.17 時間をコメントした（コメント 10179） |\n" +
      "| 8 PR | 済み | PR #10 をマージした |\n\n" +
      "学んだこと3行（devlog に反映済み）：\n\n" +
      "1. テストの赤は、空の実装を置いて「中身で落ちる」ことまで確かめる\n" +
      "2. 最新の版を入れる前に、周りの道具が対応している版の範囲を見る\n" +
      "3. 画面の守りは API 側で行い、画面は API の判断を伝えるだけにする\n\n" +
      "**① ルートユーザーで：IAM ユーザーに請求の画面を見せる設定**（出典：https://docs.aws.amazon.com/IAM/latest/UserGuide/tutorial_billing.html ）\n" +
      "1. ルートユーザーでコンソールにサインインする\n" +
      "2. 上の帯のアカウント名 → **Account**\n" +
      "3. **IAM User and Role Access to Billing Information** の **Edit**\n" +
      "4. **Activate IAM Access** にチェックを入れて **Update**\n";
    assert.equal(findStepsWithoutSource(actual), null);
    // Jira の画面の手順が本当にあれば、今までどおり Atlassian の出典を求める
    const jiraSteps = `${actual}\n1. Jira のボードを開く\n2. 「スプリントを作成」を押す\n`;
    assert.notEqual(findStepsWithoutSource(jiraSteps), null);
  });
  // ---- SC3-31 のレビュー1回目の指摘（直しを戻すと落ちる） ----
  test("（SC3-31 レビュー1-1）サービスの名前が箇条書きの見出しの項目にしかなくても、そのサービスの出典を求める", () => {
    const gh = "- GitHub の設定で：\n- Settings タブを開く\n- 「Branches」を選ぶ\n";
    assert.equal(findStepsWithoutSource(`${gh}出典：https://docs.github.com/ja/repositories\n`), null);
    assert.notEqual(findStepsWithoutSource(`${gh}出典：https://docs.aws.amazon.com/\n`), null);
  });
  test("（SC3-31 レビュー1-2）表の見出しの行か、表の直前の行にだけサービスの名前がある手順の表も止める", () => {
    const header = "| 手順 | GitHub での操作 |\n|---|---|\n| 1 | 「Settings」を開く |\n| 2 | 「Branches」を選ぶ |\n";
    assert.notEqual(findStepsWithoutSource(header), null);
    const intro = "GitHub のリポジトリで：\n| 1 | 「Settings」を開く |\n| 2 | 「Branches」を選ぶ |\n";
    assert.notEqual(findStepsWithoutSource(intro), null);
  });
  test("（SC3-31 レビュー1-3）1列目の S3 は、S1・S2 のような番号が並ぶ表のときだけ番号とみなす", () => {
    const s3 = "| S3 | 「Create bucket」を押す |\n| S3 | 「Permissions」を開く |\n";
    assert.notEqual(findStepsWithoutSource(s3), null);
  });
  test("（SC3-31 レビュー1-4）「入力」は「を・に・へ・と入力」だけ。「出力と入力」は数えない", () => {
    const noun = "- AWS の画面：出力と入力の欄を確かめる\n- IAM の入力できる欄を見る\n";
    assert.equal(findStepsWithoutSource(noun), null);
    const steps = "1. AWS コンソールの「名前」欄へ入力する\n2. 検索欄に「IAM」と入力する\n";
    assert.notEqual(findStepsWithoutSource(steps), null);
    // かっこの中の矢印も同じ決まり：「入力できる」では数えない
    assert.equal(findStepsWithoutSource("1. AWS の準備（予算 → IAM → CLI）で入力できる欄を見る\n"), null);
  });
  // ---- SC3-31 のレビュー2回目（最後の回）の指摘（直しを戻すと落ちる） ----
  test("（SC3-31 レビュー2-R1）1行目にだけ AWS とある手順の表も、「『画面の名前』を開く・押す」の行を数えて止める", () => {
    const table =
      "| # | 操作 |\n|---|---|\n| 1 | AWS コンソールで IAM を開く |\n| 2 | 「Users」を開く |\n| 3 | 「Create user」を押す |\n";
    assert.notEqual(findStepsWithoutSource(table), null);
  });
  test("（SC3-31 レビュー2-R2）AWS と GitHub の手順が同じ箇条書きにあれば、両方の出典を求める", () => {
    const both =
      "1. AWS コンソールで IAM を開く\n2. GitHub の Settings で\n3. 「Secrets」タブを開く\n4. 「New secret」を押す\n";
    assert.notEqual(findStepsWithoutSource(`${both}出典：https://docs.aws.amazon.com/IAM/\n`), null);
    assert.equal(
      findStepsWithoutSource(
        `${both}出典：https://docs.aws.amazon.com/IAM/ ・ https://docs.github.com/ja/actions\n`,
      ),
      null,
    );
  });
  test("（SC3-31 レビュー2-R3）箇条書きのすぐあとに続く表でも、表の見出しのサービスを見る", () => {
    const mixed =
      "- GitHub のリポジトリで：\n| 手順 | GitHub での操作 |\n|---|---|\n| 1 | 「Settings」を開く |\n| 2 | 「Branches」を選ぶ |\n";
    assert.notEqual(findStepsWithoutSource(mixed), null);
  });
  test("（SC3-31 レビュー2-R4）入力する値をコードで書いた「に `IAM` と入力する」も操作とみなす", () => {
    const steps = "1. AWS コンソールの検索欄に `IAM` と入力する\n2. 「Users」に `dev` と入力する\n";
    assert.notEqual(findStepsWithoutSource(steps), null);
  });
  test("（SC3-31 レビュー2-R5）表の直前の「画面で確かめること：」は、外部サービスの手がかりにしない", () => {
    const own = "AWS は今日は使いません。\n\n画面で確かめること：\n| 1 | 一覧を開く |\n| 2 | ECU を選ぶ |\n";
    assert.equal(findStepsWithoutSource(own), null);
  });
  test("（SC3-31 レビュー2-R6）「に入力できる」「欄に入力できる値」は操作とみなさない", () => {
    const can = "- AWS の画面：フォームに入力できる\n- IAM の欄に入力できる値を見る\n";
    assert.equal(findStepsWithoutSource(can), null);
  });
  test("（SC3-31）表の行は、その行にサービスの名前か画面の部品があるときだけ、操作の言葉で手順とみなす", () => {
    // 行ごとに画面の手がかりがある表は、今までどおり止める
    const rows =
      "| 手順 | 操作 |\n|---|---|\n| 1 | IAM の「Users」を開く |\n| 2 | 「Create user」ボタンを押す |\n";
    assert.notEqual(findStepsWithoutSource(rows), null);
    // 表のほかの行に AWS とあっても、手がかりのない行の「開く」は数えない
    const mixed =
      "| # | やること |\n|---|---|\n| 1 | AWS の予算を確かめる |\n| 2 | 一覧を開く |\n| 3 | 結果を選ぶ |\n";
    assert.equal(findStepsWithoutSource(mixed), null);
  });
  test("（SC3-31）「入力」は「を・に・へ・と入力」のときだけ操作とみなす（「入力できる」「入力画面」は数えない）", () => {
    const noun = "- AWS の準備：入力画面の説明を読む\n- IAM の入力できる欄を確かめる\n";
    assert.equal(findStepsWithoutSource(noun), null);
    const steps = "1. AWS コンソールの検索欄に「IAM」と入力する\n2. 「Users」に名前を入力する\n";
    assert.notEqual(findStepsWithoutSource(steps), null);
  });
  // ---- レビュー2回目の指摘（直しを戻すと落ちる） ----
  test("（誤止め・2回目-1）かっこの中でも、画面の名前のある場所は止める", () => {
    const parens =
      "1. 予算を作る（AWS コンソールの Billing → Budgets → Create budget）\n" +
      "2. IAM ユーザーを作る（IAM → Users → Create user）\n";
    assert.notEqual(findStepsWithoutSource(parens), null);
    assert.notEqual(findStepsWithoutSource("1. 名前を入力する（IAM → Users → Create user）\n"), null);
  });
  test("（誤止め・2回目-2）丁寧な形「をお選びください」「をお押しください」も操作とみなす", () => {
    const polite =
      "1. AWS コンソールの右上のリージョンのメニューで「東京」をお選びください\n" +
      "2. 「作成」ボタンをお押しください\n";
    assert.notEqual(findStepsWithoutSource(polite), null);
  });
  test("（誤止め・2回目-3）入れ子のかっこ・半角のかっこの中の項目の並びも止めない", () => {
    const nested =
      "1. **AWS の準備の手順**をお渡しします（予算 → IAM ユーザー（AWS の利用者アカウント）と MFA → アクセスキー → CLI）。\n" +
      "2. Hook を直す\n";
    assert.equal(findStepsWithoutSource(nested), null);
    const half = "1. AWS の準備の手順をお渡しします(予算 → IAM ユーザーと MFA → アクセスキー → CLI)。\n2. Hook を直す\n";
    assert.equal(findStepsWithoutSource(half), null);
  });
  test("（誤止め・2回目-3b）かっこの中のサービスの名前（Secrets Manager）は、画面の名前の手がかりにしない", () => {
    // 2026-11-22 の実際の文章
    const actual =
      "AWS の作業（リージョンを東京にする → Secrets Manager の消し残しの確認 → 予算 → IAM ユーザー → MFA → アクセスキー → CLI）が済んだら、教えてください。\n";
    assert.equal(findStepsWithoutSource(actual), null);
  });
  test("（誤止め・2回目-4）「」で囲んだ項目の並びも、かっこの中なら同じ決まり", () => {
    assert.equal(findStepsWithoutSource("1. AWS の準備を進めます（「予算」→「IAM ユーザー」→「アクセスキー」）\n"), null);
  });
  test("（誤止め・2回目-5）「を開けます」「で開けます」（開ける・開けられる）は操作とみなさない", () => {
    const can = "- このページは AWS コンソールの画面でオーナーだけがこのページを開けます\n- Chrome で開けます\n";
    assert.equal(findStepsWithoutSource(can), null);
  });
  test("（誤止め・2回目-6）「を」「から」「で」のそれぞれを操作とみなす", () => {
    const second = "2. AWS コンソールで「作成」を押す\n";
    assert.notEqual(findStepsWithoutSource(`1. メニューから選ぶ\n${second}`), null);
    assert.notEqual(findStepsWithoutSource(`1. 「作成」ボタンで押す\n${second}`), null);
    assert.notEqual(findStepsWithoutSource(`1. 一覧の「東京」を選ぶ\n${second}`), null);
  });
  test("（誤止め 2026-11-23）直しても、操作の言葉のある矢印の手順は止める", () => {
    assert.notEqual(findStepsWithoutSource("1. AWS で IAM → Users → Create user を押す\n"), null);
    assert.notEqual(findStepsWithoutSource("AWS コンソールで Billing → Budgets → Create budget を開く。"), null);
  });
  test("画面の操作の手順でなければ止めない", () => {
    assert.equal(findStepsWithoutSource("AWS の請求は今月 0 ドルでした。"), null);
    assert.equal(findStepsWithoutSource("1. テストを書く\n2. 実装する\n3. PR を出す"), null);
    assert.equal(findStepsWithoutSource("Jira の SC3-8 を完了にしました。"), null);
  });
  test("コードブロックの中の言葉は見ない", () => {
    assert.equal(findStepsWithoutSource("```\n1. AWS のコンソールを開く\n2. 押す\n```"), null);
  });
});

describe("answer-in-final", () => {
  // 記録（jsonl）の形は、2026-11-25 の会話の記録で確かめた：
  // 作業中に届いたメッセージは attachment.type = queued_command、前回の返答の終わりは system の stop_hook_summary
  const queued = (text, kind = "human") =>
    JSON.stringify({
      type: "attachment",
      attachment: { type: "queued_command", origin: { kind }, prompt: [{ type: "text", text }] },
    });
  const stopSummary = JSON.stringify({ type: "system", subtype: "stop_hook_summary" });
  const assistant = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "作業中" }] } });

  test("この回に届いたメッセージだけを集める（前回の返答より前は数えない）", () => {
    const jsonl = [queued("前の回の質問"), stopSummary, assistant, queued("React って何?"), assistant, queued("表示されている?")].join("\n");
    assert.deepEqual(queuedMessagesOfThisTurn(jsonl), ["React って何?", "表示されている?"]);
  });
  test("裏の作業の終わりの知らせ（task-notification）は数えない", () => {
    const jsonl = [stopSummary, queued("<task-notification>…</task-notification>", "task-notification")].join("\n");
    assert.deepEqual(queuedMessagesOfThisTurn(jsonl), []);
  });
  test("prompt が文字列でも読める。壊れた行は飛ばす", () => {
    const line = JSON.stringify({
      type: "attachment",
      attachment: { type: "queued_command", origin: { kind: "human" }, prompt: "文字列の質問" },
    });
    assert.deepEqual(queuedMessagesOfThisTurn(["{壊れた", line].join("\n")), ["文字列の質問"]);
  });
  test("届いたメッセージがあり、最後の返答に見出しがなければ止める", () => {
    assert.notEqual(findMissingAnswerSection(["React って何?"], "作業の状況です。"), null);
    assert.notEqual(findMissingAnswerSection(["React って何?"], undefined), null);
  });
  test("見出しがあれば通す。届いたメッセージがなければ通す", () => {
    assert.equal(findMissingAnswerSection(["React って何?"], `${HEADING}\n\n| 用語 | 役割 |`), null);
    assert.equal(findMissingAnswerSection([], "作業の状況です。"), null);
  });
});
