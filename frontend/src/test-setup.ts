import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// テストごとに、描いた画面を片付ける（Testing Library の自動の片付けは Vitest の globals が有効なときだけ働くため）
afterEach(() => {
  cleanup();
});
