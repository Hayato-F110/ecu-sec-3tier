// 画面のコンテナ（nginx）の動きを、動いている3層に対して確かめる。
// 使い方：docker compose up -d のあと `node --test tests/web/`。
// ログインして呼ぶ確かめは、ダミーデータのパスワードを環境変数 SEED_USER_PASSWORD で渡したときだけ動く
//   PowerShell：$env:SEED_USER_PASSWORD = "…"; node --test tests/web/
// 3層が動いていなければ、すべて飛ばす（落とさない）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { before, describe, it } from "node:test";

const BASE = process.env.WEB_BASE_URL ?? "http://127.0.0.1:8080";
const CSP_START = "default-src 'self'";

let up = false;
before(async () => {
  up = await fetch(`${BASE}/`).then(
    (r) => r.ok,
    () => false,
  );
});

const check = (name, fn) =>
  it(name, async (t) => {
    if (!up) return t.skip(`${BASE} が動いていない`);
    await fn(t);
  });

const login = (email, password) =>
  fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

describe("nginx（frontend/nginx.conf）", () => {
  check("/api/ の下は、パスを変えずに API へ中継する（ログインして、トークンで一覧を読む）", async (t) => {
    const password = process.env.SEED_USER_PASSWORD;
    if (!password) return t.skip("SEED_USER_PASSWORD が渡されていない");
    const res = await login("a-editor@example.com", password);
    assert.equal(res.status, 200);
    const { access_token: token } = await res.json();
    const r = await fetch(`${BASE}/api/ecus`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(await r.json()));
  });

  check("ログインの API も中継する。違うパスワードは 401", async () => {
    const r = await login("a-editor@example.com", "wrong password");
    assert.equal(r.status, 401);
    assert.ok(r.headers.get("content-security-policy")?.startsWith(CSP_START));
  });

  check("/api/ecus をヘッダーなしで呼ぶと 401", async () => {
    const r = await fetch(`${BASE}/api/ecus`);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), "Bearer");
  });

  check("ない JS・CSS は 404（index.html を 200 で返さない）。404 にも守りのヘッダーが付く", async () => {
    const r = await fetch(`${BASE}/assets/no-such-file.js`);
    assert.equal(r.status, 404);
    assert.ok(r.headers.get("content-security-policy")?.startsWith(CSP_START));
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  });

  check("API の失敗の応答（401）にも守りのヘッダーが付く（/api/ に add_header を足すと消えるのを見張る）", async () => {
    const r = await fetch(`${BASE}/api/ecus/999999/assessment`);
    assert.equal(r.status, 401);
    assert.ok(r.headers.get("content-security-policy")?.startsWith(CSP_START));
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  });

  check("/api/matrix をヘッダーなしで呼ぶと 401（nginx が API へ中継している）", async () => {
    const r = await fetch(`${BASE}/api/matrix`);
    assert.equal(r.status, 401);
    assert.ok(r.headers.get("content-security-policy")?.startsWith(CSP_START));
  });

  for (const path of ["/", "/ecus/3", "/matrix", "/login"]) {
    check(`${path} は index.html を毎回確かめさせ（no-cache）、守りのヘッダーも付く`, async () => {
      const r = await fetch(`${BASE}${path}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(r.headers.get("cache-control"), "no-cache");
      assert.ok(r.headers.get("content-security-policy")?.startsWith(CSP_START));
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    });
  }
});

// ---- SC3-26：監査ログの接続元の IP（API は nginx から来た X-Forwarded-For だけを信じる） ----
// nginx は、届いた X-Forwarded-For の右に本当の接続元を足して API へ渡す（$proxy_add_x_forwarded_for）。
// API（uvicorn）は FORWARDED_ALLOW_IPS に書いたアドレスから来た要求でだけ、このヘッダーを右から読み、
// 信じないアドレスに当たったところを接続元にする。左に書かれた嘘のアドレスは使わない。
// 出典：https://uvicorn.dev/settings/ ・ https://uvicorn.dev/deployment/
const FAKE_IP = "203.0.113.9"; // 説明用のアドレス（RFC 5737）。どこにも届かない

const docker = (args) =>
  execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

// compose の設定を、変数を埋めた形で読む（YAML を自分で解かない）
const composeConfig = () => JSON.parse(docker(["config", "--format", "json"]));

// DB のコンテナの中で SQL を流す。利用者と DB の名前はコンテナの環境変数から取る（値をテストに持ち込まない）
const psql = (sql) =>
  docker([
    "exec",
    "-T",
    "db",
    "sh",
    "-c",
    `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "${sql}"`,
  ]).trim();

const lastAuditId = () =>
  Number(psql("SELECT coalesce(max(id), 0) FROM audit_logs"));
const auditIpsAfter = (id) =>
  psql(
    `SELECT coalesce(host(ip), '') FROM audit_logs WHERE id > ${id} AND action = 'login_failed' ORDER BY id`,
  )
    .split("\n")
    .filter((s) => s !== "");

// 動いている web のコンテナの、compose のネットワークの上のアドレス
const webAddress = () => {
  const id = docker(["ps", "-q", "web"]).trim();
  return execFileSync(
    "docker",
    [
      "inspect",
      id,
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
    ],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split(" ")[0];
};

const loginWithForwardedFor = (base) =>
  fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": FAKE_IP },
    body: JSON.stringify({
      email: "a-editor@example.com",
      password: "wrong password",
    }),
  });

describe("監査ログの接続元の IP（SC3-26）", () => {
  it("compose：API が信じるアドレス（FORWARDED_ALLOW_IPS）は、web の固定のアドレス1つだけ", (t) => {
    let config;
    try {
      config = composeConfig();
    } catch (e) {
      return t.skip(
        `docker compose config を読めない：${e.message.split("\n")[0]}`,
      );
    }
    const nets = config.services.web.networks ?? {};
    const fixed = Object.values(nets)
      .map((n) => n?.ipv4_address)
      .filter(Boolean);
    assert.equal(
      fixed.length,
      1,
      "web にはネットワークの上の固定のアドレス（ipv4_address）が1つある",
    );
    assert.equal(
      config.services.api.environment?.FORWARDED_ALLOW_IPS,
      fixed[0],
    );
  });

  check(
    "nginx 経由：X-Forwarded-For の嘘のアドレスも、nginx のアドレスも監査ログに残らない",
    async (t) => {
      const before = lastAuditId();
      const nginx = webAddress();
      const r = await loginWithForwardedFor(BASE);
      assert.equal(r.status, 401);
      const ips = auditIpsAfter(before);
      assert.equal(ips.length, 1, "ログインの失敗が1行だけ増える");
      t.diagnostic(`残った接続元：${ips[0]}（nginx：${nginx}）`);
      assert.notEqual(ips[0], FAKE_IP, "左に書かれた嘘のアドレスを信じない");
      assert.notEqual(
        ips[0],
        nginx,
        "nginx から来た X-Forwarded-For を読んで、nginx の向こうの接続元を残す",
      );
    },
  );

  check(
    "API を直接呼んだとき（8000番）：X-Forwarded-For を信じない",
    async () => {
      const api = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";
      const before = lastAuditId();
      const r = await loginWithForwardedFor(api);
      assert.equal(r.status, 401);
      const ips = auditIpsAfter(before);
      assert.equal(ips.length, 1, "ログインの失敗が1行だけ増える");
      assert.notEqual(ips[0], FAKE_IP, "nginx 以外から来たヘッダーは使わない");
    },
  );
});
