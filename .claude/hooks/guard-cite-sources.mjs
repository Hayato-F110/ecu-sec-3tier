// Stop の Hook：応答に外部サービス（AWS・GitHub・Atlassian）の画面の操作の手順があるのに、
// 公式の資料の URL（出典）がなければ止める（終了コード 2）。
// 理由：CLAUDE.md「実装・調査・オーナーへの操作の指示の前に、毎回、各技術の最新の公開仕様を確認する。
//       公式ドキュメントで確かめ、出典を添える。記憶だけで書かない」。
//       2026-11-22 に、AWS の画面の手順（KMS・Tag Editor・EC2 グローバルビュー）を記憶で書き、
//       Tag Editor が Resource Explorer に変わっていたことと、EC2 グローバルビューの場所の誤りに
//       気づかなかった。文の決まりだけでは守れなかったので、この Hook で止める（オーナーに提案した）。
// 出典は「公式の資料」の URL だけを認める（ブログ・まとめ・利用者どうしの質問サイトは不可）。
// 手順のサービス（AWS・GitHub・Atlassian）ごとに、そのサービスの公式の URL が要る。
// 同じ止め方を続けないよう、止めたあとの再実行（stop_hook_active）では止めない。

// 抜け道（直さないと決めたもの）：ほかの Stop の Hook が止めたあとの書き直し（stop_hook_active）は
// 調べない。止め続けないための仕組みを、ほかの Stop の Hook と共有しているため（2026-11-22 のレビュー）。

import { readFileSync } from "node:fs";

import { textsOfThisTurn } from "./japanese-reply.mjs";

const BLOCK = 2;

// 外部サービスの名前（画面の手順かどうかの手がかり）
const SERVICE = new RegExp(
  [
    "AWS",
    "コンソール",
    "KMS",
    "IAM",
    "EC2",
    "S3",
    "RDS",
    "VPC",
    "ALB",
    "Lambda",
    "API Gateway",
    "DynamoDB",
    "CloudFront",
    "CloudWatch",
    "CloudShell",
    "Systems Manager",
    "Secrets Manager",
    "Cost Explorer",
    "Billing",
    "Budgets",
    "請求とコスト管理",
    "請求書",
    "無料利用枠",
    "予算",
    "Resource Explorer",
    "Tag Editor",
    "タグエディタ",
    "GitHub",
    "Jira",
    "Atlassian",
    "Confluence",
  ].join("|"),
);
// 画面の操作の言葉（「を開いて」「を選んで」などの形も含める）。
// 開く・押す・選ぶは、直前に「を」があるときだけ（2026-11-23：「開く PC の書体」「ご本人だけが開けます」を
// 操作と数えて誤って止めたため）
const UI_VERB =
  /を\s*(開[くきいけ]|押[すしせ]|選[ぶびんべ])|を?入れ|入力|左のメニュー|クリック|タブ|に切り替え/;
// 画面の部品の言葉。手順のまとまりに、これかサービスの名前が1つもなければ手順とみなさない
// （「1. 「A 案」を選ぶ」のような、決めてほしいことの一覧を止めないため）
const CHROME = /メニュー|ボタン|画面|タブ|コンソール|検索欄|リージョン/;
// 過去形で終わる行（「〜を入れた」などの作業の報告）は、操作の手順とみなさない
const PAST = /た[。）)]?\s*\|?\s*$/;
// 箇条書き・番号つき・①②・表の行（日本語では「・」のあとに空白がないことが多い）
const LIST_ITEM = /^\s*(\d+[.)．]\s*|[-*]\s+|・\s*|[①-⑳]\s*|\|)/;

// 手順のサービスごとの公式の資料（ブログ・利用者どうしの質問サイトは不可）。
// ホスト名のあとは、英数字・「.」・「-」以外（「/」・空白・句読点・かっこ・「>」など）
const OFFICIAL = {
  aws: /https:\/\/(docs\.aws\.amazon\.com|aws\.amazon\.com(?!\/blogs))(?![\w.-])/,
  github: /https:\/\/docs\.github\.com(?![\w.-])/,
  atlassian: /https:\/\/(support|confluence|developer)\.atlassian\.com(?![\w.-])/,
};
const providersOf = (text) => {
  const found = new Set();
  for (const m of text.matchAll(new RegExp(SERVICE.source, "g"))) {
    if (m[0] === "GitHub") found.add("github");
    else if (/Jira|Atlassian|Confluence/.test(m[0])) found.add("atlassian");
    else found.add("aws");
  }
  return found;
};

/** 1行の中の矢印・階層（「KMS」→「キー」、KMS > キー）の数 */
const arrowsOf = (line) => {
  let n = 0;
  // 「」で囲んだ名前どうしの矢印：前後のどちらかがサービスの名前のときだけ（状態の流れを数えない）
  for (const m of line.matchAll(/「([^」]+)」\s*[→>＞]\s*(?=「([^」]+)」)/g)) {
    if (SERVICE.test(m[1]) || SERVICE.test(m[2])) n += 1;
  }
  // 「」のない矢印・階層：行にサービスの名前と操作の言葉があるときだけ
  // （2026-11-23：「予算 → IAM ユーザーと MFA → アクセスキー → CLI」という項目の並びを、
  //  画面の階層と数えて誤って止めたため）
  if (SERVICE.test(line) && UI_VERB.test(line)) {
    const unquoted = line.replace(/「[^」]*」/g, "Q");
    n += (unquoted.match(/(?<!Q)\s[→>＞]\s(?!Q)/g) ?? []).length;
  }
  return n;
};

/** 画面の操作の手順の数と、手順に出てくる文章（どのサービスの手順かを見るため） */
const countSteps = (text) => {
  const lines = text.split("\n");
  let steps = 0;
  let stepText = "";
  for (let i = 0; i < lines.length; ) {
    if (!LIST_ITEM.test(lines[i])) {
      // 箇条書きでない行は、矢印・階層だけを数える
      const n = arrowsOf(lines[i]);
      if (n > 0) {
        steps += n;
        stepText += `${lines[i]}\n`;
      }
      i += 1;
      continue;
    }
    // 続いている箇条書きを1つのまとまりとして見る
    let j = i;
    while (j < lines.length && LIST_ITEM.test(lines[j])) j += 1;
    const block = lines.slice(i, j);
    const intro = i > 0 ? lines[i - 1] : "";
    const onScreen = block.some((l) => SERVICE.test(l) || CHROME.test(l));
    for (const line of block) {
      const isStep = onScreen && UI_VERB.test(line) && !PAST.test(line) ? 1 : 0;
      // 1行で数えるのは、操作の行（1）と、その行の矢印の数の多いほう
      const n = Math.max(isStep, arrowsOf(line));
      if (n > 0) steps += n;
    }
    if (onScreen) stepText += `${intro}\n${block.join("\n")}\n`;
    i = j;
  }
  return { steps, stepText };
};

/** 止める理由（文字列）か、止めないなら null。コードブロックの中の言葉と、コードの中の URL は見ない */
export const findStepsWithoutSource = (text) => {
  if (typeof text !== "string" || text === "") return null;
  const noBlocks = text.replace(/```[\s\S]*?```/g, "");
  // 手順を数えるときは、インラインのコード（`IAM`）の中の文字も見る
  const forSteps = noBlocks.replace(/`([^`\n]*)`/g, "$1");
  // 出典の URL は、コードの外にあるものだけを認める
  const forUrls = noBlocks.replace(/`[^`\n]*`/g, "");
  if (!SERVICE.test(forSteps)) return null;
  const { steps, stepText } = countSteps(forSteps);
  if (steps < 2) return null;
  const providers = providersOf(stepText);
  const missing = [...(providers.size > 0 ? providers : ["aws"])].filter(
    (p) => !OFFICIAL[p].test(forUrls),
  );
  if (missing.length === 0) return null;
  return `外部サービスの画面の手順があるのに、公式の資料の URL（出典）がない（${missing.join("・")}）`;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  const input = JSON.parse((await readStdin()) || "{}");
  if (input.stop_hook_active) return;
  // 最後の文章だけでなく、この回に書いた文章をすべて見る（道具の前に書いた手順も含める）
  let texts = [];
  if (typeof input.transcript_path === "string") {
    try {
      texts = textsOfThisTurn(readFileSync(input.transcript_path, "utf8"));
    } catch {
      texts = [];
    }
  }
  if (typeof input.last_assistant_message === "string") texts.push(input.last_assistant_message);
  const reason = findStepsWithoutSource(texts.join("\n"));
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
