// PreToolUse の Hook：計画書の第5章「費用ゼロのガードレール」と、第8章の設計判断（RDS を外に出さない・SSH を開けない）を、
// 書くだけでなく仕組みで守る。Terraform のファイル（.tf）に書き込む内容と、aws CLI のコマンドを見る。
//   - 止める（終了コード 2）：NAT Gateway、RDS のマルチ AZ、Secrets Manager（代わりに SSM Parameter Store の標準）、
//     ドメインの購入、RDS の外部公開、22 番ポート（SSH。代わりに Systems Manager）、Elastic IP
//   - オーナーに確認を出す（permissionDecision: "ask"）：micro・small 以外のインスタンスの大きさ
// 文字列での判定なので完全ではない（変数で組み立てた値は見抜けない）。terraform plan の確認と、/aws-session の手順で補う。
// 公式：https://code.claude.com/docs/en/hooks （PreToolUse の終了コード 2 と hookSpecificOutput.permissionDecision）

const BLOCK = 2;

/** Terraform の内容で止めるもの：[正規表現, 理由] */
const TF_BLOCK = [
  [/resource\s+"aws_nat_gateway"/, "NAT Gateway（東京で月45ドル前後の見込み）。EC2 はパブリックサブネットに置き、セキュリティグループで ALB からだけ許す"],
  [/\bmulti_az\s*=\s*true\b/, "RDS のマルチ AZ（料金がほぼ2倍）。シングル AZ にする"],
  [/resource\s+"aws_secretsmanager_secret/, "Secrets Manager（有料）。代わりに SSM Parameter Store の標準（aws_ssm_parameter、type = \"SecureString\"）を使う"],
  [/resource\s+"aws_route53domains_(registered_)?domain"/, "ドメインの購入。HTTPS は CloudFront の標準ドメインで代用する"],
  [/\bpublicly_accessible\s*=\s*true\b/, "RDS の外部公開。RDS はプライベートサブネットに置き、EC2 のセキュリティグループからだけ許す（設計判断・スプリント4）"],
  [/\b(from_port|to_port)\s*=\s*22\b/, "22 番ポート（SSH）を開けている。EC2 への接続は Systems Manager を使う（設計判断・スプリント5）"],
  [/resource\s+"aws_eip"/, "Elastic IP（使っていない間も課金される）。ALB と CloudFront の名前で届くので要らない"],
];

/** aws CLI で止めるもの */
const CLI_BLOCK = [
  [/\baws\s+ec2\s+create-nat-gateway\b/, "NAT Gateway の作成"],
  [/\baws\s+ec2\s+allocate-address\b/, "Elastic IP の確保"],
  [/\baws\s+route53domains\s+register-domain\b/, "ドメインの購入"],
  [/\baws\s+secretsmanager\s+create-secret\b/, "Secrets Manager の作成（SSM Parameter Store の標準を使う）"],
  [/\baws\s+rds\b[^\n;&|]*--multi-az\b/, "RDS のマルチ AZ"],
];

// 大きさの指定（"db.t4g.micro"・"t3.small" など）。micro・small 以外は確認を出す
const SIZE = /\b(instance_class|instance_type)\s*=\s*"([^"]+)"/g;
const SMALL_SIZE = /\.(micro|small)$/;

/** Terraform の内容の判定。{ block: 理由[], ask: 理由[] } */
export const checkTerraform = (text) => {
  const result = { block: [], ask: [] };
  if (typeof text !== "string") return result;
  // コメントの行（# と //）は見ない
  const code = text
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
  for (const [pattern, reason] of TF_BLOCK) if (pattern.test(code)) result.block.push(reason);
  for (const m of code.matchAll(SIZE)) {
    if (!SMALL_SIZE.test(m[2])) result.ask.push(`${m[1]} = "${m[2]}"（micro・small より大きい）`);
  }
  return result;
};

/** aws CLI の判定。止める理由の配列 */
export const checkCli = (command) => {
  if (typeof command !== "string") return [];
  return CLI_BLOCK.filter(([pattern]) => pattern.test(command)).map(([, reason]) => reason);
};

const writtenText = (toolName, toolInput) => {
  if (toolName === "Write") return toolInput.content;
  if (toolName === "Edit") return toolInput.new_string;
  if (toolName === "MultiEdit") return (toolInput.edits ?? []).map((e) => e.new_string).join("\n");
  return null;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  const input = JSON.parse((await readStdin()) || "{}");
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};

  if (toolName === "Bash" || toolName === "PowerShell") {
    const reasons = checkCli(toolInput.command);
    if (reasons.length === 0) return;
    process.stderr.write(
      `止めました：${reasons.join("・")} は、費用ゼロのガードレール（計画書の第5章・CLAUDE.md「費用ゼロ」）に反します。` +
        "どうしても要るときは、理由と見込みの費用をオーナーに出して、オーナーが自分で実行します。\n",
    );
    process.exit(BLOCK);
  }

  const filePath = String(toolInput.file_path ?? "");
  if (!/\.tf$/.test(filePath)) return;
  const { block, ask } = checkTerraform(writtenText(toolName, toolInput));
  if (block.length > 0) {
    process.stderr.write(
      `止めました：Terraform に、費用ゼロのガードレールか設計判断に反するものがあります。\n- ${block.join("\n- ")}\n` +
        "書き方を変えてください。どうしても要るときは、理由と見込みの費用をオーナーに出して、承認をもらってから。\n",
    );
    process.exit(BLOCK);
  }
  if (ask.length > 0) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `インスタンスの大きさが、無料の範囲を超えるおそれがあります：${ask.join("、")}。オーナーが確かめます。`,
        },
      }),
    );
  }
};

// テストから import したときは動かさない（ほかの Hook と同じ書き方）
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("guard-aws-cost.mjs")) {
  main().catch((error) => {
    // 読めないときは止める（お金を守る Hook なので、安全な側に倒す）
    console.error(`guard-aws-cost の実行に失敗したため、止めました：${error.message}`);
    process.exit(BLOCK);
  });
}
