// 画面のコンテナ（nginx）の動きを、動いている3層に対して確かめる。
// 使い方：docker compose up -d のあと `node --test tests/web/`（.env に DEV_AUTH_ENABLED=true が要る）。
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
    await fn();
  });

describe("nginx（frontend/nginx.conf）", () => {
  check("/api/ の下は、パスを変えずに API へ中継する（変数の proxy_pass でも）", async () => {
    const r = await fetch(`${BASE}/api/ecus`, {
      headers: { "X-Dev-User-Id": "4" },
    });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(await r.json()));
  });

  check("ない JS・CSS は 404（index.html を 200 で返さない）。404 にも守りのヘッダーが付く", async () => {
    const r = await fetch(`${BASE}/assets/no-such-file.js`);
    assert.equal(r.status, 404);
    assert.ok(r.headers.get("content-security-policy")?.startsWith(CSP_START));
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  });

  for (const path of ["/", "/ecus/3"]) {
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
