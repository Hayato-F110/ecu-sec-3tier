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
const API_BASE = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";

const docker = (args) =>
  execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

// compose の設定を JSON で読む（YAML を自分で解かない）。--no-interpolate：.env の値（パスワード・鍵）を埋め込まない。
// 比べる値（FORWARDED_ALLOW_IPS・ipv4_address）は compose に直接書いてあるので、埋めなくても比べられる。
// 出典：https://docs.docker.com/reference/cli/docker/compose/config/
const composeConfig = () =>
  JSON.parse(docker(["config", "--no-interpolate", "--format", "json"]));

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

// compose に書いた web の固定のアドレス（ipv4_address）。ネットワークごとに1つ
const fixedWebAddresses = (config) =>
  Object.values(config.services.web.networks ?? {})
    .map((n) => n?.ipv4_address)
    .filter(Boolean);

// 動いている web のコンテナの、つながっているすべてのネットワークの上のアドレス
const webAddresses = (id) =>
  execFileSync(
    "docker",
    [
      "inspect",
      id,
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
    .trim()
    .split(" ")
    .filter((s) => s !== "");

// 3層が動き、この compose の web と db を docker で操作できるときだけ流す。できなければ飛ばす（ファイルの冒頭の決まり）
const checkDocker = (name, fn) =>
  check(name, async (t) => {
    let webId;
    try {
      webId = docker(["ps", "-q", "web"]).trim();
      docker(["exec", "-T", "db", "true"]);
    } catch (e) {
      return t.skip(`docker compose を操作できない：${e.message.split("\n")[0]}`);
    }
    if (!webId) return t.skip("この compose の web が動いていない");
    await fn(t, webId);
  });

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
    } catch {
      // エラーの文は出さない（設定の中身の一部が混ざることがあるため）
      return t.skip("docker compose config を読めない");
    }
    const fixed = fixedWebAddresses(config);
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

  checkDocker(
    "nginx 経由：X-Forwarded-For の嘘のアドレスも、nginx のアドレスも監査ログに残らない",
    async (t, webId) => {
      // nginx のアドレス＝compose に書いた固定のアドレスと、動いているコンテナの実際のアドレスのすべて
      const nginx = [
        ...new Set([
          ...fixedWebAddresses(composeConfig()),
          ...webAddresses(webId),
        ]),
      ];
      assert.ok(nginx.length > 0, "nginx のアドレスが分からないまま比べない");
      const before = lastAuditId();
      const r = await loginWithForwardedFor(BASE);
      assert.equal(r.status, 401);
      const ips = auditIpsAfter(before);
      assert.equal(ips.length, 1, "ログインの失敗が1行だけ増える");
      t.diagnostic(`残った接続元：${ips[0]}（nginx：${nginx.join(", ")}）`);
      assert.notEqual(ips[0], FAKE_IP, "左に書かれた嘘のアドレスを信じない");
      assert.ok(
        !nginx.includes(ips[0]),
        "nginx から来た X-Forwarded-For を読んで、nginx の向こうの接続元を残す",
      );

      // 「違う」だけでなく「正しい値」か：同じ PC から API を直接呼んだときの接続元と同じになる
      // （Docker Desktop ではどちらもネットワークの入口のアドレス）
      const before2 = lastAuditId();
      const direct = await loginWithForwardedFor(API_BASE);
      assert.equal(direct.status, 401);
      const directIps = auditIpsAfter(before2);
      assert.equal(directIps.length, 1, "ログインの失敗が1行だけ増える");
      assert.equal(ips[0], directIps[0], "nginx 経由でも、直接呼んだときと同じ接続元が残る");
    },
  );

  // SC3-26 の完了条件「nginx 経由で保存したときの監査ログの ip」。下書きの今の入力をそのまま保存し直すので、
  // 入力の中身は変わらず、監査ログに save_draft が1行増えるだけ。パスワードを渡したときだけ動く。
  // 注意：読んでから保存し直すまでの数秒の間に画面で同じ下書きを保存すると、その入力を古い値で上書きする。流す間は画面で保存しない
  checkDocker(
    "nginx 経由で保存：監査ログの ip は嘘のアドレスでも nginx のアドレスでもなく、直接つないだときの接続元",
    async (t, webId) => {
      const password = process.env.SEED_USER_PASSWORD;
      if (!password) return t.skip("SEED_USER_PASSWORD が渡されていない");
      const res = await login("a-editor@example.com", password);
      assert.equal(res.status, 200);
      const { access_token: token } = await res.json();
      const auth = { Authorization: `Bearer ${token}` };

      // 下書きの ECU と、その今の入力（入力済みの項目だけ）を探す
      const ecus = await (await fetch(`${BASE}/api/ecus`, { headers: auth })).json();
      let target;
      for (const ecu of ecus.filter((e) => e.latest_status === "draft")) {
        const view = await (
          await fetch(`${BASE}/api/ecus/${ecu.id}/assessment`, { headers: auth })
        ).json();
        const entries = view.entries
          .filter((e) => e.status !== null && e.evidence !== null)
          .map(({ item_id, status, evidence, planned_date }) => ({
            item_id,
            status,
            evidence,
            planned_date,
          }));
        if (view.assessment?.status === "draft" && entries.length > 0) {
          target = { id: ecu.id, entries };
          break;
        }
      }
      if (!target) return t.skip("a-editor に、入力のある下書きの ECU がない");

      const nginx = [
        ...new Set([
          ...fixedWebAddresses(composeConfig()),
          ...webAddresses(webId),
        ]),
      ];
      assert.ok(nginx.length > 0, "nginx のアドレスが分からないまま比べない");
      // 比べる相手：API を直接呼んだときの接続元。存在しない利用者で失敗させる
      // （SC3-36 でログインの回数の制限が入っても、a-editor が締め出されないように）
      const before0 = lastAuditId();
      const directRes = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "no-such-user@example.com", password: "x" }),
      });
      assert.equal(directRes.status, 401);
      const [direct] = auditIpsAfter(before0);
      assert.ok(direct, "直接呼んだときの接続元が監査ログに残る");

      const before = lastAuditId();
      const put = await fetch(`${BASE}/api/ecus/${target.id}/draft`, {
        method: "PUT",
        headers: {
          ...auth,
          "Content-Type": "application/json",
          "X-Forwarded-For": FAKE_IP,
        },
        body: JSON.stringify({ entries: target.entries }),
      });
      assert.equal(put.status, 200);
      const ip = psql(
        `SELECT coalesce(host(ip), '') FROM audit_logs WHERE id > ${before} AND action = 'save_draft' ORDER BY id`,
      )
        .split("\n")
        .filter((s) => s !== "");
      assert.equal(ip.length, 1, "保存の監査ログが1行だけ増える");
      t.diagnostic(`保存の接続元：${ip[0]}（直接：${direct}、nginx：${nginx.join(", ")}）`);
      assert.notEqual(ip[0], FAKE_IP, "左に書かれた嘘のアドレスを信じない");
      assert.ok(!nginx.includes(ip[0]), "nginx のアドレスではない");
      assert.equal(ip[0], direct, "直接つないだときと同じ接続元（ブラウザ側）");
    },
  );

  // 直しそのものではなく、信じる相手を広げすぎた設定（"*" や、入口を含む範囲）を見張る
  checkDocker(
    "API を直接呼んだとき（8000番）：X-Forwarded-For を信じない",
    async () => {
      const before = lastAuditId();
      const r = await loginWithForwardedFor(API_BASE);
      assert.equal(r.status, 401);
      const ips = auditIpsAfter(before);
      assert.equal(ips.length, 1, "ログインの失敗が1行だけ増える");
      assert.notEqual(ips[0], FAKE_IP, "nginx 以外から来たヘッダーは使わない");
    },
  );
});
