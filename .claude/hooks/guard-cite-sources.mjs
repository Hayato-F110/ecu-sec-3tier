// Stop の Hook：応答に外部サービス（AWS・GitHub・Atlassian）の画面の操作の手順があるのに、
// 公式の資料の URL（出典）がなければ止める（終了コード 2）。
// 理由：CLAUDE.md「実装・調査・オーナーへの操作の指示の前に、毎回、各技術の最新の公開仕様を確認する。
//       公式ドキュメントで確かめ、出典を添える。記憶だけで書かない」。
//       2026-11-22 に、AWS の画面の手順（KMS・Tag Editor・EC2 グローバルビュー）を記憶で書き、
//       Tag Editor が Resource Explorer に変わっていたことと、EC2 グローバルビューの場所の誤りに
//       気づかなかった。文の決まりだけでは守れなかったので、この Hook で止める（オーナーに提案した）。
// 出典は「公式の資料」の URL だけを認める（ブログ・まとめは不可）。
// 同じ止め方を続けないよう、止めたあとの再実行（stop_hook_active）では止めない。

const BLOCK = 2;

// 外部サービスの名前（画面の手順かどうかの手がかり）
const SERVICE =
  /AWS|コンソール|KMS|IAM|EC2|S3|RDS|Secrets Manager|請求とコスト管理|請求書|Resource Explorer|Tag Editor|タグエディタ|Budgets|予算|CloudShell|Systems Manager|GitHub|Jira|Atlassian|Confluence/;
// 画面の操作の言葉
const UI_VERB = /を開く|を開き|を押す|を押し|を選ぶ|を選び|左のメニュー|クリック|タブ|に切り替え/;
// 箇条書き・番号つきの行
const LIST_ITEM = /^\s*(\d+[.)．]|[-*・])\s+/;
// 公式の資料
const OFFICIAL =
  /https:\/\/(docs\.aws\.amazon\.com|aws\.amazon\.com|repost\.aws|docs\.github\.com|support\.atlassian\.com|confluence\.atlassian\.com|developer\.atlassian\.com)\//;

/** 画面の操作の手順の数（箇条書きの操作の行と、「〜」→「〜」の矢印の数） */
const countSteps = (text) => {
  let steps = 0;
  for (const line of text.split("\n")) {
    if (LIST_ITEM.test(line) && UI_VERB.test(line)) steps += 1;
    steps += (line.match(/」\s*→\s*「/g) ?? []).length;
  }
  return steps;
};

/** 止める理由（文字列）か、止めないなら null */
export const findStepsWithoutSource = (text) => {
  if (typeof text !== "string" || text === "") return null;
  const plain = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  if (!SERVICE.test(plain)) return null;
  if (countSteps(plain) < 2) return null;
  if (OFFICIAL.test(text)) return null;
  return "外部サービスの画面の手順があるのに、公式の資料の URL（出典）がない";
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  const input = JSON.parse((await readStdin()) || "{}");
  if (input.stop_hook_active) return;
  const reason = findStepsWithoutSource(input.last_assistant_message);
  if (reason === null) return;
  process.stderr.write(
    `止めました：${reason}（CLAUDE.md「最新の公開仕様を確認する。公式ドキュメントで確かめ、出典を添える」）。` +
      "手順を公式の資料（docs.aws.amazon.com・docs.github.com・support.atlassian.com など）で確かめ、" +
      "画面の名前が資料と違えば直し、出典の URL を添えて書き直してください。" +
      "確かめられなかった手順は「確かめられなかった」と書いてください。\n",
  );
  process.exit(BLOCK);
};

// テストから import したときは動かさない（ほかの Hook と同じ書き方）
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("guard-cite-sources.mjs")) {
  main().catch((error) => {
    // 読めないときは通す（応答を止め続けないため）
    console.error(`guard-cite-sources を実行できませんでした（通します）：${error.message}`);
  });
}
