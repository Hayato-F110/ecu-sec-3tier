// Stop の Hook：作業の途中にオーナーのメッセージが届いた回は、最後の返答に「## 途中のメッセージへの答え」の
// 見出しがなければ止める（終了コード 2）。
// 理由：作業の合間（道具を呼ぶあいだ）に書いた文は、オーナーの画面では折りたたまれて見えないことがある。
//       2026-11-25 に、React と nginx の質問への答え（表）を合間に書き、オーナーには見えず、2回聞き直させた。
//       オーナーが対策を求めた。最後の返答は折りたたまれないので、答えはそこに書き直す。
// 範囲：前回の返答の終わり（記録の stop_hook_summary）のあとに届いたメッセージ（記録の queued_command のうち
//       origin.kind が human のもの。2026-11-25 の会話の記録で確かめた）。
// 同じ止め方を続けないよう、止めたあとの再実行（stop_hook_active）では止めない。

import { readFileSync } from "node:fs";

const BLOCK = 2;
export const HEADING = "## 途中のメッセージへの答え";

/** この回（前回の返答の終わりのあと）に、作業の途中で届いたオーナーのメッセージの文章 */
export const queuedMessagesOfThisTurn = (jsonl) => {
  const messages = [];
  for (const line of jsonl.split("\n").reverse()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "system" && entry?.subtype === "stop_hook_summary") break;
    if (entry?.attachment?.type !== "queued_command") continue;
    // 裏の作業の終わりの知らせ（origin.kind = task-notification）も同じ種類で残るので、人のものだけ数える
    if (entry.attachment.origin?.kind !== "human") continue;
    const prompt = entry.attachment.prompt;
    const text = Array.isArray(prompt)
      ? prompt.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
      : typeof prompt === "string"
        ? prompt
        : "";
    messages.unshift(text);
  }
  return messages;
};

/** 止める理由（文字列）か、止めないなら null */
export const findMissingAnswerSection = (queued, lastMessage) => {
  if (queued.length === 0) return null;
  if (typeof lastMessage === "string" && lastMessage.includes(HEADING)) return null;
  return `作業の途中にオーナーのメッセージが ${queued.length} 件届いたのに、最後の返答に「${HEADING}」の見出しがない`;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  const input = JSON.parse((await readStdin()) || "{}");
  if (input.stop_hook_active) return;
  if (typeof input.transcript_path !== "string") return;
  const queued = queuedMessagesOfThisTurn(readFileSync(input.transcript_path, "utf8"));
  const reason = findMissingAnswerSection(queued, input.last_assistant_message);
  if (reason === null) return;
  const list = queued.map((q) => `- ${q.replace(/\s+/g, " ").slice(0, 80)}`).join("\n");
  process.stderr.write(
    `止めました：${reason}（作業の合間の文は、オーナーの画面で折りたたまれて見えないことがある。2026-11-25 のオーナーの指示）。\n` +
      `届いたメッセージ：\n${list}\n` +
      `「${HEADING}」の見出しを付け、それぞれへの答え（表や説明を含めて全部）を、この最後の返答に書き直してください。\n`,
  );
  process.exit(BLOCK);
};

// テストから import したときは動かさない（ほかの Hook と同じ書き方）
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("answer-in-final.mjs")) {
  main().catch((error) => {
    // 読めないときは通す（応答を止め続けないため）
    console.error(`answer-in-final を実行できませんでした（通します）：${error.message}`);
  });
}
