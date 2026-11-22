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
  test("画面の操作の手順でなければ止めない", () => {
    assert.equal(findStepsWithoutSource("AWS の請求は今月 0 ドルでした。"), null);
    assert.equal(findStepsWithoutSource("1. テストを書く\n2. 実装する\n3. PR を出す"), null);
    assert.equal(findStepsWithoutSource("Jira の SC3-8 を完了にしました。"), null);
  });
  test("コードブロックの中の言葉は見ない", () => {
    assert.equal(findStepsWithoutSource("```\n1. AWS のコンソールを開く\n2. 押す\n```"), null);
  });
});
