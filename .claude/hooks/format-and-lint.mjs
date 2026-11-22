// PostToolUse の Hook：Claude がファイルを編集した直後に、整形と静的解析をかける。
// 人や AI の注意に頼らず、毎回かならず実行するための仕組み（kids-play・nori-adventure の Hook をもとにしている）。
// このプロジェクトでの対応：
//   - Python（backend/・tests/・tools/ の .py）：ruff format → ruff check --fix（残った指摘を Claude に返す）
//   - 画面（frontend/ の .ts・.tsx・.js・.css・.json など）：Prettier → ESLint（frontend/node_modules があるときだけ）
//   - Terraform（infra/ の .tf）：terraform fmt（terraform が入っているときだけ）
// 道具がまだ入っていないとき（Day 1 など）は、何もせずに通す。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// 終了コード2で終わると、標準エラーの文が Claude に渡る（編集はもう済んでいるので、取り消しはできない）
const FEEDBACK = 2;

const toSlash = (text) => text.replace(/\\/g, "/");

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

/** 指摘がなければ null、あれば出力の文を返す。道具そのものがなければ undefined */
const run = (cmd, args, cwd) => {
  try {
    execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });
    return null;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message;
  }
};

/** ruff の呼び方：backend の仮想環境 → PATH の ruff の順 */
const ruffCommand = (root) => {
  const venv = process.platform === "win32" ? "backend/.venv/Scripts/ruff.exe" : "backend/.venv/bin/ruff";
  const local = path.join(root, venv);
  return existsSync(local) ? local : "ruff";
};

/** frontend/node_modules の中の道具を node で直接呼ぶ（npx は Windows では .cmd で、シェルなしでは起動できない） */
const nodeTool = (root, script, args) => {
  const file = path.join(root, "frontend", "node_modules", script);
  if (!existsSync(file)) return undefined;
  return run(process.execPath, [file, ...args], path.join(root, "frontend"));
};

const main = async () => {
  const input = JSON.parse(await readStdin());
  const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string" || !existsSync(filePath)) return;

  const relative = toSlash(path.relative(root, filePath));
  // プロジェクトの外のファイルと、依存パッケージ・仮想環境には手を出さない
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  if (/(^|\/)(node_modules|\.venv|\.terraform)\//.test(relative)) return;

  const problems = [];

  if (relative.endsWith(".py")) {
    const ruff = ruffCommand(root);
    const formatError = run(ruff, ["format", filePath], root);
    if (formatError) problems.push(`ruff format:\n${formatError}`);
    if (formatError !== undefined) {
      const lintError = run(ruff, ["check", "--fix", filePath], root);
      if (lintError) problems.push(`ruff check:\n${lintError}`);
    }
  } else if (relative.startsWith("frontend/")) {
    const inFrontend = path.relative(path.join(root, "frontend"), filePath);
    const formatError = nodeTool(root, "prettier/bin/prettier.cjs", ["--write", "--ignore-unknown", inFrontend]);
    if (formatError) problems.push(`Prettier:\n${formatError}`);
    if (/\.(ts|tsx|js|jsx)$/.test(relative)) {
      const lintError = nodeTool(root, "eslint/bin/eslint.js", [inFrontend]);
      if (lintError) problems.push(`ESLint:\n${lintError}`);
    }
  } else if (relative.endsWith(".tf")) {
    const fmtError = run("terraform", ["fmt", filePath], root);
    if (fmtError) problems.push(`terraform fmt:\n${fmtError}`);
  }

  if (problems.length > 0) {
    console.error(`${relative} に指摘があります。直してください。\n${problems.join("\n")}`);
    process.exit(FEEDBACK);
  }
};

main().catch((error) => {
  // 整形の失敗で作業を止めない。知らせるだけにする
  console.error(`format-and-lint の実行に失敗しました：${error.message}`);
  process.exit(1);
});
