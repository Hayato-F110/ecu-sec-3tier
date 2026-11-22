// PreToolUse の Hook（transitionJiraIssue）：Jira の課題を「完了」に移す前に、この会話の中で、その課題に
// 「完了条件ごとの証拠の表」をコメントで書いたかを確かめる。なければ止める（終了コード 2）。
// 表の行に「未達」があるときも止める（未達が1つでもあれば完了にしない。CLAUDE.md「課題を完了にする前に」）。
// 理由：nori-adventure の 2026-11-14、完了条件を読み直さずに課題を完了にし（NORI-71）、未達の1か所をほかの課題に
//       移して閉じるよう勧めた（NORI-69）。文章の決まりでは止まらず、Hook（harvest-before-done）にした。
//       このプロジェクトには、その Hook が読む「刈り取りの表」がないので、コメントの表を見る形で作り直した
//       （2026-11-22 にオーナーが承認）。
// 表とみなすもの：Markdown の表で、見出しの行に「完了条件」と「証拠」の列があるもの。
// 限界：見るのはこの会話の記録だけ。前の会話で書いたコメントは数えないので、そのときはもう一度書く。
//       表の中身が正しいか（証拠が本当にあるか）はオーナーが見る。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BLOCK = 2;
const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = JSON.parse(readFileSync(path.join(here, "project.json"), "utf8"));
const KEY = String(PROJECT.jiraKey).toUpperCase();
const DONE_IDS = new Set((PROJECT.doneTransitionIds ?? []).map(String));

/** 課題キーを「SC3-12」の形にそろえる（URL の …/browse/SC3-12 も受ける）。読めなければ null */
export const keyOf = (value) => {
  const m = String(value ?? "").match(/([A-Za-z][A-Za-z0-9_]*-\d+)(?!.*[A-Za-z][A-Za-z0-9_]*-\d+)/);
  return m ? m[1].toUpperCase() : null;
};

/**
 * 「完了」へ移す遷移か。ID は project.json の doneTransitionIds。名前は遷移そのものの名前で、行き先の状態の名前と
 * 違うことがある（例：「Review->Done」）ので、「完了」か done を含めば完了とみなす（/code-review の指摘 3）
 */
// 2 回目の /code-review（指摘 1・6）：SC3 の遷移は 11 未着手・21 進行中・31 完了だけ（project.json に確かめた記録）。
// 名前は「完了」で終わるもの（「未完了に戻す」は除く）と、単語の done（undone・not done は除く）を見る
const DONE_NAME = /(?<!未)完了(?!に戻)|(?<!un|not\s)\bdone\b/i;
export const isDoneTransition = (input) =>
  DONE_IDS.has(String(input?.transitionId ?? input?.transition?.id ?? "")) ||
  DONE_NAME.test(String(input?.transitionName ?? input?.transition?.name ?? ""));

const cellsOf = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/**
 * コメントの本文から、証拠の表（見出しに「完了条件」と「証拠」の列があり、中身の行が1つ以上ある表）を探す。
 * 「未達」は、見出しが「結果」か「判定」の列があればその列だけ、なければ「未達」だけのセルを数える
 * （条件の文の中の「未達」という語で止めないため。/code-review の指摘 4）。
 * 返す値：{ table: 表があるか, unmet: 未達の行の数 }
 */
export const evidenceTableOf = (body) => {
  const lines = String(body ?? "").split(/\r?\n/);
  let table = false;
  let unmet = 0;
  let header = null; // 今読んでいる証拠の表の見出し（表の外では null）
  let rows = 0;
  let unmetHere = 0;
  const close = () => {
    // 見出しだけで中身の行がない表は、表とみなさない（/code-review の指摘 2）
    if (header !== null && rows > 0) {
      table = true;
      unmet += unmetHere;
    }
    header = null;
  };
  for (const line of lines) {
    if (!line.trim().startsWith("|")) {
      close();
      continue;
    }
    const cells = cellsOf(line);
    if (header === null) {
      if (cells.some((c) => c.includes("完了条件")) && cells.some((c) => c.includes("証拠"))) {
        header = cells;
        rows = 0;
        unmetHere = 0;
      }
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // 表の区切りの行
    rows += 1;
    // 2 回目の /code-review（指摘 4・5）：結果の列は見出しが「結果」か「判定」ちょうどのものだけ。
    // ないときは、完了条件の列を除くセルで「未達」を含むものを数える
    const resultCol = header.findIndex((c) => c === "結果" || c === "判定");
    const isUnmet =
      resultCol >= 0
        ? (cells[resultCol] ?? "").includes("未達")
        : cells.some((c, i) => !(header[i] ?? "").includes("完了条件") && c.includes("未達"));
    if (isUnmet) unmetHere += 1;
  }
  close();
  return { table, unmet };
};

/** 会話の記録（JSONL を読んだもの）から、その課題に書いた、成功したコメントの本文を集める */
export const commentsFor = (entries, key) => {
  const failed = new Set();
  for (const e of entries) {
    for (const c of Array.isArray(e?.message?.content) ? e.message.content : []) {
      if (c?.type === "tool_result" && c.is_error === true) failed.add(c.tool_use_id);
    }
  }
  const bodies = [];
  for (const e of entries) {
    for (const c of Array.isArray(e?.message?.content) ? e.message.content : []) {
      if (c?.type !== "tool_use" || !String(c.name ?? "").endsWith("addOrEditJiraIssueComment")) continue;
      if (failed.has(c.id) || keyOf(c.input?.issueIdOrKey) !== key) continue;
      bodies.push(String(c.input?.commentBody ?? ""));
    }
  }
  return bodies;
};

/**
 * 道具の呼び出しを、遷移の形（issueIdOrKey・transitionId・transitionName）にそろえる。遷移でなければ null。
 * 2 回目の /code-review（指摘 2）：transitionJiraIssue のほか、汎用の書き込み（executeWrite の遷移の操作）と、
 * 課題の編集で状態（status）か解決（resolution）の欄を変えるものも、完了への移動とみなして見る
 */
export const asTransition = (toolName, toolInput) => {
  const name = String(toolName ?? "");
  const input = toolInput ?? {};
  if (name.endsWith("transitionJiraIssue")) return input;
  if (name.endsWith("executeWrite")) {
    if (!/transition/i.test(String(input.name ?? ""))) return null;
    const i = input.inputs ?? {};
    return {
      issueIdOrKey: i.issueIdOrKey ?? i.issueKey ?? i.issueId,
      transitionId: i.transitionId ?? i.transition?.id,
      transitionName: i.transitionName ?? i.transition?.name,
    };
  }
  if (name.endsWith("editJiraIssue")) {
    const fields = { ...(input.fields ?? {}), ...(input.additional_fields ?? {}) };
    const touches = Object.keys(fields).some((k) => /^(status|resolution|状態|解決状況)$/i.test(k));
    return touches ? { issueIdOrKey: input.issueIdOrKey, transitionName: "done" } : null;
  }
  return null;
};

/** 止める理由（文字列）か、止めないなら null */
export const doneDecision = (toolInput, entries) => {
  if (!isDoneTransition(toolInput)) return null;
  const key = keyOf(toolInput?.issueIdOrKey);
  // 番号だけの ID は、どの課題か確かめられない（別の課題の表で通ってしまう）ので、キーで指定させる（/code-review の指摘 1）
  if (key === null) {
    return `課題を番号の ID（${toolInput?.issueIdOrKey}）で指定しています。証拠の表と突き合わせるため、課題キー（${KEY}-xx）で指定し直してください。`;
  }
  // よそのプロジェクトの課題は見ない
  if (!key.startsWith(`${KEY}-`)) return null;
  const results = commentsFor(entries, key).map(evidenceTableOf);
  const last = results.filter((r) => r.table).at(-1);
  if (last === undefined) {
    return (
      `${key} に、完了条件ごとの証拠の表のコメントを、この会話の中でまだ書いていません。` +
      "getJiraIssue で完了条件を読み直し、見出しに「完了条件」「証拠」「結果」の列がある Markdown の表（証拠は PR・CI の実行・ファイル:行）を、" +
      "課題キーを指定して addOrEditJiraIssueComment で書いてから、もう一度「完了」に移してください（HTML の表は読めません）。"
    );
  }
  if (last.unmet > 0) {
    return (
      `${key} の証拠の表に「未達」が ${last.unmet} 行あります。未達が1つでもあれば完了にしません。` +
      "未達の部分をほかの課題に移すのは完了条件を書き換えることなので、選択肢としてオーナーに出してください。"
    );
  }
  return null;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  const input = JSON.parse((await readStdin()) || "{}");
  const transition = asTransition(input.tool_name, input.tool_input);
  if (transition === null) return;
  let entries = [];
  if (typeof input.transcript_path === "string") {
    try {
      entries = readFileSync(input.transcript_path, "utf8")
        .split("\n")
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        });
    } catch {
      entries = [];
    }
  }
  const reason = doneDecision(transition, entries);
  if (reason === null) return;
  process.stderr.write(`止めました：${reason}（CLAUDE.md「課題を完了にする前に」）\n`);
  process.exit(BLOCK);
};

// テストから import したときは動かさない（ほかの Hook と同じ書き方）
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("guard-done-evidence.mjs")) {
  main().catch((error) => {
    // 読めないときは通す（Hook の故障で Jira の操作を止め続けないため。通したことは知らせる）
    console.error(`guard-done-evidence を実行できませんでした（通します）：${error.message}`);
  });
}
