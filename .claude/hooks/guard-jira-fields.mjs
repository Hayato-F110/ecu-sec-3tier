// PreToolUse の Hook：Jira（このプロジェクトのキー。project.json）の課題を作るとき、ポイント・期限・開始日が入っていなければ、作る前に止める
// （スプリント2のふりかえりの改善③。2026-11-13 にオーナーが承認）。
// 理由：メモリー（jira-new-issue-fields）に書いても、11/13 に NORI-63・64 で開始日を入れ忘れた。文章の決まりでは止まらないので、仕組みで止める。
// あわせて、作るときにスプリントを指定したら止める（NORI-90。スプリント3のふりかえり I1。途中で見つけた課題はバックログへ）。
// 止めたら、標準エラーの文が Claude に渡る（終了コード 2）。

// このプロジェクトへの引き継ぎ：課題キーと欄の ID は .claude/hooks/project.json から読む（1 か所で変えられるように）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCK = 2;

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = JSON.parse(readFileSync(path.join(here, "project.json"), "utf8"));
export const JIRA_KEY = String(PROJECT.jiraKey).toUpperCase();
const F = PROJECT.jiraFields;

// 欄の ID は Jira のサイトの設定（project.json とメモリー jira-new-issue-fields と同じ）
const REQUIRED = [
  [F.storyPoints, `ポイント（${F.storyPoints}）`],
  ["duedate", "期限（duedate）"],
  [F.startDate, `開始日（${F.startDate}。予定の日）`],
];
// 取り違えやすい欄（チームの管理のボードでは使われない）
const WRONG = [[F.wrongStoryPoints, `${F.wrongStoryPoints} は使わない。ポイントは ${F.storyPoints}`]];
// ポイント・期限を付けない種類
const EXEMPT_TYPES = new Set(["epic", "エピック"]);

const isEmpty = (value) => value === undefined || value === null || value === "";

/** 止める理由（文字列の配列。空なら通す） */
export const findMissingJiraFields = (toolInput) => {
  if (!toolInput || String(toolInput.projectKey ?? "").toUpperCase() !== JIRA_KEY) return [];
  if (EXEMPT_TYPES.has(String(toolInput.issueType ?? "").toLowerCase())) return [];
  const fields = toolInput.additional_fields ?? {};
  const reasons = REQUIRED.filter(([key]) => isEmpty(fields[key])).map(([, label]) => `${label} がない`);
  for (const [key, label] of WRONG) {
    if (key in fields) reasons.push(label);
  }
  return reasons;
};

// スプリントの欄（NORI-90）。additional_fields は名前でも ID でも書ける（createJiraIssue の説明）ので、両方を見る
const SPRINT_KEYS = new Set([F.sprint, "sprint", "スプリント"]);

/** スプリントを指定していれば、止める理由を返す（NORI-90。途中で見つけた課題はバックログへ） */
export const findSprintAssignment = (toolInput) => {
  if (!toolInput || String(toolInput.projectKey ?? "").toUpperCase() !== JIRA_KEY) return [];
  const fields = toolInput.additional_fields ?? {};
  return noSprint(toolInput.assignToSprint) && !hasSprintField(fields) ? [] : ["スプリントの指定がある"];
};

// 空の配列・false・空白だけの文字列も「指定しない」として扱う（スプリントを外すときの書き方のため）
const noSprint = (value) =>
  isEmpty(value) ||
  value === false ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "string" && value.trim() === "");
const hasSprintField = (fields) =>
  Object.keys(fields ?? {}).some((key) => SPRINT_KEYS.has(key.toLowerCase()) && !noSprint(fields[key]));
/** 入れ子の中も含めて、スプリントの欄か sprintId に値があるか（executeWrite の inputs の形は操作ごとに違うため） */
const hasSprintDeep = (value) => {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, v]) =>
      ((SPRINT_KEYS.has(key.toLowerCase()) || key.toLowerCase() === "sprintid") && !noSprint(v)) ||
      hasSprintDeep(v),
  );
};
// 調べないのは、よそのプロジェクトのキーとはっきり分かるものだけ（番号の ID は NORI の課題かもしれないので調べる）
const isOtherProjectKey = (key) => {
  const k = String(key ?? "");
  return /^[A-Z][A-Z0-9_]*-\d+$/i.test(k) && !k.toUpperCase().startsWith(`${JIRA_KEY}-`);
};

/**
 * 作ったあとにスプリントへ入れる操作なら、止める理由を返す（NORI-90。2026-11-19 にオーナーが範囲を広げた）
 * editJiraIssue のスプリントの欄、transitionJiraIssue の sprintId、executeWrite のスプリントの操作・指定。
 * スプリントから外す（null・バックログへ）操作は通す
 */
export const findSprintMove = (toolName, toolInput) => {
  const name = String(toolName ?? "");
  const input = toolInput ?? {};
  if (name.endsWith("__editJiraIssue")) {
    if (isOtherProjectKey(input.issueIdOrKey)) return [];
    return hasSprintField(input.fields) || hasSprintField(input.additional_fields)
      ? ["編集でスプリントの欄を入れている"]
      : [];
  }
  if (name.endsWith("__transitionJiraIssue")) {
    if (isOtherProjectKey(input.issueIdOrKey)) return [];
    // sprintId のほか、遷移と一緒に送る fields・update のスプリントの欄も見る
    return noSprint(input.sprintId) && !hasSprintField(input.fields) && !hasSprintField(input.update)
      ? []
      : ["遷移でスプリントを指定している"];
  }
  if (name.endsWith("__executeWrite")) {
    const op = String(input.name ?? "");
    // スプリントから外す操作（remove…・…FromSprint）は通す
    const intoSprint = /sprint/i.test(op) && !/(remove|from)/i.test(op);
    return intoSprint || hasSprintDeep(input.inputs) ? ["汎用の書き込みでスプリントに入れている"] : [];
  }
  return [];
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  const input = JSON.parse((await readStdin()) || "{}");
  const moves = findSprintMove(input.tool_name, input.tool_input);
  if (moves.length > 0) {
    process.stderr.write(
      `止めました：${moves.join("・")}。スプリントに入れるのはオーナーです（スプリント3のふりかえり I1・NORI-90）。` +
        "スプリントの指定を外して操作し直してください。入れたいときはオーナーに聞き、オーナーが Jira の画面で入れます。\n",
    );
    process.exit(BLOCK);
  }
  if (!String(input.tool_name ?? "").endsWith("createJiraIssue")) return;
  // 両方の理由を 1 つの文にまとめる（片方を直して、もう片方でまた止まらないように）
  const messages = [];
  if (findSprintAssignment(input.tool_input).length > 0) {
    messages.push(
      "Jira の課題を作るときに、スプリントを指定しています（assignToSprint かスプリントの欄）。" +
        "途中で見つけた課題は、今のスプリントに入れずバックログへ置きます（スプリント3のふりかえり I1・NORI-90）。" +
        "スプリントの指定を外して作り直してください。スプリントに入れたいときは、作ったあとでオーナーに聞き、オーナーが入れます。",
    );
  }
  const reasons = findMissingJiraFields(input.tool_input);
  if (reasons.length > 0) {
    messages.push(
      `Jira の課題に ${reasons.join("・")}。additional_fields に入れて作り直してください。` +
        "作ったあとは getJiraIssue で読み直して確かめます（スプリントはオーナーが入れる）。",
    );
  }
  if (messages.length === 0) return;
  process.stderr.write(`止めました：${messages.join("\nあわせて：")}\n`);
  process.exit(BLOCK);
};

// テストから import したときは動かさない（guard-inline-backslash.mjs と同じ書き方）
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("guard-jira-fields.mjs")) {
  main().catch((error) => {
    // 入力を読めないときは通す（この Hook は進め方の決まりで、秘密を守るものではないため）
    console.error(`guard-jira-fields を実行できませんでした（通します）：${error.message}`);
  });
}
