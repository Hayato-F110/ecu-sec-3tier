import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// npm test は frontend/ で動く。Dockerfile の `COPY . .` でビルドの段階に入れないものを確かめる
const lines = readFileSync(path.resolve(process.cwd(), ".dockerignore"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim());

describe("画面のイメージに入れないもの（frontend/.dockerignore）", () => {
  it.each([".env", ".env.*"])(
    "%s を入れない（VITE_ で始まる値は画面の JS に埋め込まれるため、秘密情報をビルドに渡さない）",
    (pattern) => {
      expect(lines).toContain(pattern);
    },
  );
});
