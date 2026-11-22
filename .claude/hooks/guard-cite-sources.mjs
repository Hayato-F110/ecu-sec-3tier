// Stop の Hook：応答に外部サービス（AWS・GitHub・Atlassian）の画面の操作の手順があるのに、
// 公式の資料の URL（出典）がなければ止める（終了コード 2）。
// 理由：CLAUDE.md「実装・調査・オーナーへの操作の指示の前に、毎回、各技術の最新の公開仕様を確認する。
//       公式ドキュメントで確かめ、出典を添える。記憶だけで書かない」。
//       2026-11-22 に、AWS の画面の手順（KMS・Tag Editor・EC2 グローバルビュー）を記憶で書き、
//       Tag Editor が Resource Explorer に変わっていたことと、EC2 グローバルビューの場所の誤りに
//       気づかなかった。文の決まりだけでは守れなかったので、この Hook で止める（オーナーに提案した）。
// 出典は「公式の資料」の URL だけを認める（ブログ・まとめは不可）。
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
// 画面の操作の言葉（「を開いて」「を選んで」などの形も含める）
const UI_VERB =
  /を?開[くきいけ]|を?押[すしせ]|を?選[ぶびんべ]|を?入れ|入力|左のメニュー|クリック|タブ|に切り替え/;
// 画面の部品の手がかり（「」で囲んだ名前、メニュー・ボタンなど）。これがない行は手順とみなさない
// （「1. A 案を選ぶ」のような、決めてほしいことの一覧を止めないため）
const UI_TARGET = /「[^」]+」|メニュー|ボタン|画面|タブ|欄|コンソール/;
// 箇条書き・番号つきの行（日本語では「・」のあとに空白がないことが多い）
const LIST_ITEM = /^\s*(\d+[.)．]\s*|[-*]\s+|・\s*)/;
// 公式の資料（ホスト名のあとは「/」・空白・かっこ・行の終わりのどれか）
const OFFICIAL =
  /https:\/\/(docs\.aws\.amazon\.com|aws\.amazon\.com|repost\.aws|docs\.github\.com|support\.atlassian\.com|confluence\.atlassian\.com|developer\.atlassian\.com)(\/|\s|$|\)|）)/m;

/** 画面の操作の手順の数（箇条書きの操作の行と、サービスの名前か画面の言葉がある行の矢印の数） */
const countSteps = (text) => {
  let steps = 0;
  for (const line of text.split("\n")) {
    const onScreen = UI_TARGET.test(line) || SERVICE.test(line);
    if (LIST_ITEM.test(line) && UI_VERB.test(line) && onScreen) steps += 1;
    // 「下書き」→「申請中」のような状態の流れは数えない。矢印の前後の「」の中にサービスの名前があるか、
    // 行に画面の言葉があるときだけ数える
    const onUi = /メニュー|ボタン|画面|タブ|コンソール/.test(line);
    for (const m of line.matchAll(/「([^」]+)」\s*→\s*(?=「([^」]+)」)/g)) {
      if (onUi || SERVICE.test(m[1]) || SERVICE.test(m[2])) steps += 1;
    }
  }
  return steps;
};

/** 止める理由（文字列）か、止めないなら null。コードの中の言葉・URL は見ない */
export const findStepsWithoutSource = (text) => {
  if (typeof text !== "string" || text === "") return null;
  const plain = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  if (!SERVICE.test(plain)) return null;
  if (countSteps(plain) < 2) return null;
  if (OFFICIAL.test(plain)) return null;
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
