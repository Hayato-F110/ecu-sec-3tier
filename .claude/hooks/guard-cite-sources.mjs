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
// 開く・押す・選ぶは、直前に「を」「から」「で」があるときだけ。間の「お・ご」（をお選びください）は許す。
// 「開けます・開けません」（開ける・開けられる）は操作とみなさない
// （2026-11-23：「開く PC の書体」「ご本人だけが開けます」を操作と数えて誤って止めたため）
const OPEN_PUSH_SELECT =
  /(を|から|で)\s*[おご]?(開[くきい]|開け(?!ま)|押[すしせ]|選[ぶびんべ])/;
// 「入力」は「を・に・へ入力」と「」と入力」のときだけ（「入力できる」「入力画面」「出力と入力」は操作でない。
// 2026-11-24：完了条件「ブラウザから入力できる」を操作と数えて誤って止めたため。SC3-31）
const INPUT = "(?:[をにへ]|」と)\\s*入力";
const UI_VERB = new RegExp(
  `${OPEN_PUSH_SELECT.source}|を?入れ|${INPUT}|左のメニュー|クリック|タブ|に切り替え`,
);
// かっこの中の矢印を数える手がかり：はっきりした操作の言葉か、作成・入力（その行のどこか）と、
// 英語の画面の名前（Billing・Create など）か画面の部品の言葉（かっこの中）
// （「手に入れる」「タブ区切り」のような、操作でない言葉は含めない）
const ACTION = new RegExp(`${OPEN_PUSH_SELECT.source}|クリック|に切り替え|作成|を作[るりっ]|${INPUT}`);
const SCREEN_IN_PARENS = /[A-Z][a-z]{2,}|メニュー|ボタン|画面|コンソール|検索欄/;
// 画面の部品の言葉。手順のまとまりに、これかサービスの名前が1つもなければ手順とみなさない
// （「1. 「A 案」を選ぶ」のような、決めてほしいことの一覧を止めないため）
const CHROME = /メニュー|ボタン|画面|タブ|コンソール|検索欄|リージョン/;
// 過去形で終わる行（「〜を入れた」などの作業の報告）は、操作の手順とみなさない
const PAST = /た[。）)]?\s*\|?\s*$/;
// 箇条書き・番号つき・①②・表の行（日本語では「・」のあとに空白がないことが多い）
const LIST_ITEM = /^\s*(\d+[.)．]\s*|[-*]\s+|・\s*|[①-⑳]\s*|\|)/;
const TABLE_ROW = /^\s*\|/;
const ROW_LABEL = /^(\s*\|\s*)([A-Z])(\d+)(\s*\|)/;
// 表の1列目が「S1」「S2」「S3」のような番号の並びなら、指摘・項目の番号として扱う（AWS の S3 と数えない。
// 2026-11-24：指摘の番号 S3 を AWS の S3 と見なして誤って止めたため。SC3-31）。
// 同じ文字で違う数字が2つ以上あるときだけ（1列目にサービスの S3 を並べた表は、番号とみなさない）
const withoutRowLabels = (block) => {
  const numbersByLetter = new Map();
  for (const l of block) {
    const m = l.match(ROW_LABEL);
    if (m) numbersByLetter.set(m[2], (numbersByLetter.get(m[2]) ?? new Set()).add(m[3]));
  }
  return block.map((l) => {
    const m = l.match(ROW_LABEL);
    return m && numbersByLetter.get(m[2]).size >= 2 ? l.replace(ROW_LABEL, "$1#$4") : l;
  });
};

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

/** 行を、いちばん外側のかっこ（全角・半角、入れ子も）の外の文と、かっこの中の文に分ける */
const splitParens = (line) => {
  let depth = 0;
  let outside = "";
  let inner = "";
  const groups = [];
  for (const ch of line) {
    if (ch === "（" || ch === "(") {
      if (depth === 0) {
        outside += "P";
        inner = "";
      } else inner += ch;
      depth += 1;
    } else if ((ch === "）" || ch === ")") && depth > 0) {
      depth -= 1;
      if (depth === 0) groups.push(inner);
      else inner += ch;
    } else if (depth > 0) inner += ch;
    else outside += ch;
  }
  if (depth > 0) groups.push(inner); // 閉じていないかっこ
  return { outside, groups };
};

/** 文の中の矢印・階層の数（「」で囲んだ名前どうしと、「」のないもの） */
const countArrows = (text, lineHasService) => {
  let n = 0;
  // 「」で囲んだ名前どうしの矢印：前後のどちらかがサービスの名前のときだけ（状態の流れを数えない）
  for (const m of text.matchAll(/「([^」]+)」\s*[→>＞]\s*(?=「([^」]+)」)/g)) {
    if (SERVICE.test(m[1]) || SERVICE.test(m[2])) n += 1;
  }
  // 「」のない矢印・階層：行にサービスの名前があるときだけ
  if (lineHasService) {
    const unquoted = text.replace(/「[^」]*」/g, "Q");
    n += (unquoted.match(/(?<!Q)\s[→>＞]\s(?!Q)/g) ?? []).length;
  }
  return n;
};

/** 1行の中の矢印・階層（「KMS」→「キー」、KMS > キー）の数 */
const arrowsOf = (line) => {
  const hasService = SERVICE.test(line);
  const { outside, groups } = splitParens(line);
  // かっこの外（表・別の行・本文の画面の場所）は、これまでどおり数える
  let n = countArrows(outside, hasService);
  // かっこの中は、画面の場所らしいときだけ数える。項目の並び（「（予算 → IAM ユーザーと MFA → アクセスキー
  // → CLI）」）を、画面の階層と数えて誤って止めたため（2026-11-23）
  for (const g of groups) {
    // サービスの名前（Secrets Manager など）は画面の名前の手がかりにしない（項目の並びにも出るため）
    const withoutServices = g.replace(new RegExp(SERVICE.source, "g"), "");
    if (ACTION.test(line) || SCREEN_IN_PARENS.test(withoutServices)) {
      n += countArrows(g, hasService);
    }
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
    const block = withoutRowLabels(lines.slice(i, j));
    const intro = i > 0 ? lines[i - 1] : "";
    const hasClue = (l) => SERVICE.test(l) || CHROME.test(l);
    const onScreen = block.some(hasClue);
    // 表の見出しの行か、表の直前の行（「GitHub のリポジトリで：」）に手がかりがあれば、表の全部の行が画面の行
    const tableOnScreen = TABLE_ROW.test(block[0]) && (hasClue(block[0]) || hasClue(intro));
    const counted = [];
    for (const line of block) {
      // 表の行は、その行か表の見出し・直前の行にサービスの名前か画面の部品があるときだけ、操作の言葉で数える。
      // 表は予定・仕分け・証拠のまとめにも使い、ほかの行の「AWS」で全部の行を手順と数えてしまうため
      // （2026-11-24：予定の表と、指摘の仕分けの表で誤って止めた。SC3-31）。矢印の数え方は変えない
      const rowOnScreen = TABLE_ROW.test(line) ? tableOnScreen || hasClue(line) : onScreen;
      const isStep = rowOnScreen && UI_VERB.test(line) && !PAST.test(line) ? 1 : 0;
      // 1行で数えるのは、操作の行（1）と、その行の矢印の数の多いほう
      const n = Math.max(isStep, arrowsOf(line));
      if (n > 0) {
        steps += n;
        counted.push(line);
      }
    }
    // どのサービスの手順かは、手順と数えた行と、まとまりの直前の行（「AWS のコンソールで」など）で決める。
    // 手順を含まない表（Jira の行がある済み・未済の表など）を材料にすると、要らない出典を求めてしまう
    // （2026-11-24：AWS の手順に AWS の出典があるのに、同じ回の済み・未済の表の Jira で止めた。SC3-31）。
    // そこにサービスの名前がなければ、手順を含むまとまり全体（見出しの項目「- GitHub の設定で：」など）から探す
    if (counted.length > 0) {
      const near = `${intro}\n${counted.join("\n")}`;
      stepText += `${providersOf(near).size > 0 ? near : `${intro}\n${block.join("\n")}`}\n`;
    }
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
