/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 開発用のサーバー（npm run dev）でも、/api/ を API（127.0.0.1:8000）へ中継して同じオリジンにする。
// docker compose では nginx が同じ役をする（frontend/nginx.conf）。中継する範囲は nginx の location /api/ と
// そろえる（"/api" だと /api-keys のような画面の URL まで API へ送ってしまう）
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api/": "http://127.0.0.1:8000" },
  },
  test: {
    environment: "jsdom",
    restoreMocks: true,
    // vi.stubGlobal で差し替えた fetch を、テストごとに元に戻す
    unstubGlobals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
