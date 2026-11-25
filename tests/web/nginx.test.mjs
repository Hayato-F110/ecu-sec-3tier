// 画面のコンテナ（nginx）の動きを、動いている3層に対して確かめる。
// 使い方：docker compose up -d のあと `node --test tests/web/`。
// ログインして呼ぶ確かめは、ダミーデータのパスワードを環境変数 SEED_USER_PASSWORD で渡したときだけ動く
//   PowerShell：$env:SEED_USER_PASSWORD = "…"; node --test tests/web/
// 3層が動いていなければ、すべて飛ばす（落とさない）。
import assert from "node:assert/strict";
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
