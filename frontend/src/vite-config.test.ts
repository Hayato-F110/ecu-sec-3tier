import { describe, expect, it } from "vitest";

import config from "../vite.config";

describe("開発用のサーバーの設定", () => {
  it("中継するのは /api/ の下だけ（nginx の location /api/ と同じ範囲。/api-keys などは画面の URL のまま）", () => {
    expect(Object.keys(config.server?.proxy ?? {})).toEqual(["/api/"]);
  });
});
