// Stop の Hook：作業の途中にオーナーのメッセージが届いた回は、最後の返答に「## 途中のメッセージへの答え」の
// 見出しがなければ止める（終了コード 2）。
// 理由：作業の合間（道具を呼ぶあいだ）に書いた文は、オーナーの画面では折りたたまれて見えないことがある。
//       2026-11-25 に、React と nginx の質問への答え（表）を合間に書き、オーナーには見えず、2回聞き直させた。
//       オーナーが対策を求めた。最後の返答は折りたたまれないので、答えはそこに書き直す。
// 範囲：前回の返答の終わり（記録の stop_hook_summary）のあとに届いたメッセージ（記録の queued_command のうち
//       origin.kind が human のもの。2026-11-25 の会話の記録で確かめた）。
// 止めたあとの書き直しの回（stop_hook_active）は、Hook が止めた区切りを越えて、回の始まり（オーナーが送った
// メッセージ）までさかのぼって数える。ほかの Hook に止められた書き直しで、答えを落とさないため（2回目の /code-review）。
// 抜け道（直していない。2026-11-25）：
// - 作業の途中に手元のコマンド（/context など）を使うと、その出力を回の始まりと見て、前のメッセージを数えない
// - Esc で止めたあとに画像つきで送ったメッセージは回の始まりと見ず、前の回のメッセージも数える（止めすぎる側）
// - この Hook が止めた書き直しの回は、ほかの Stop の Hook（日本語・用語・出典）が stop_hook_active で検査しない

import { readFileSync } from "node:fs";

const BLOCK = 2;
export const HEADING = "## 途中のメッセージへの答え";

/** オーナーが新しく送ったメッセージ（回の始まり）。道具の結果や、Claude Code が足す文（isMeta）は除く */
const isOwnerPrompt = (entry) => {
  if (entry?.type !== "user" || entry.isMeta) return false;
  const c = entry.message?.content;
  if (typeof c === "string") return true;
  return Array.isArray(c) && c.length > 0 && c.every((x) => x?.type === "text");
};

/** この回に、作業の途中で届いたオーナーのメッセージの文章。
 *  区切り：前回の返答の終わり（stop_hook_summary。Hook が止めたときにも残る）か、
 *  オーナーが新しく送ったメッセージ（Esc で止めた回は stop_hook_summary が残らないため）のどちらか近いほう */
export const queuedMessagesOfThisTurn = (jsonl, { acrossStops = false } = {}) => {
  const messages = [];
  for (const line of jsonl.split("\n").reverse()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!acrossStops && entry?.type === "system" && entry?.subtype === "stop_hook_summary") break;
    if (isOwnerPrompt(entry)) break;
    if (entry?.attachment?.type !== "queued_command") continue;
    // 裏の作業の終わりの知らせ（origin.kind = task-notification）も同じ種類で残るので、人のものだけ数える
    if (entry.attachment.origin?.kind !== "human") continue;
    // 命令（! の bash など）は答えが要らないので、ふつうのメッセージ（commandMode = prompt）だけ数える
    const mode = entry.attachment.commandMode;
    if (mode !== undefined && mode !== "prompt") continue;
    const prompt = entry.attachment.prompt;
    const text = Array.isArray(prompt)
      ? prompt.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
      : typeof prompt === "string"
        ? prompt
        : "";
    messages.unshift(text.trim() === "" ? "（文字なし。画像など）" : text);
  }
  return messages;
};

/** 行の始めの見出しがあり、その下に中身があるか（コードブロックの中・かぎかっこの引用は数えない） */
const hasAnswerSection = (text) => {
  if (typeof text !== "string") return false;
  // 見出しのあとの付け足し（（2件）など）も通す。Windows の改行（CRLF）は、m フラグの ^ と $ が \r の前後でも
  // 合うので、そのままでよい（テストで確かめた）
  const plain = text.replace(/```[\s\S]*?```/g, "");
  const m = plain.match(/^ {0,3}## 途中のメッセージへの答え(?:[ \t]*|[（(][^\n]*)$/m);
  if (m === null) return false;
  const after = plain.slice(m.index + m[0].length);
  const body = after.split(/^#{1,2} /m)[0]; // 次の同じか上の見出しまで
  return body.trim() !== "";
};

/** 止める理由（文字列）か、止めないなら null */
export const findMissingAnswerSection = (queued, lastMessage) => {
  if (queued.length === 0) return null;
  if (hasAnswerSection(lastMessage)) return null;
  return `作業の途中にオーナーのメッセージが ${queued.length} 件届いたのに、最後の返答に「${HEADING}」の見出しと答えがない`;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  const input = JSON.parse((await readStdin()) || "{}");
  if (typeof input.transcript_path !== "string") return;
  const queued = queuedMessagesOfThisTurn(readFileSync(input.transcript_path, "utf8"), {
    acrossStops: input.stop_hook_active === true,
  });
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
