import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

// docs/test-plans/SC3-11.md の #17：ページの切り替え
const stubApi = () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = url.startsWith("/api/matrix") ? { items: [], rows: [] } : [];
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => vi.unstubAllGlobals());

describe("ページの切り替え", () => {
  it("自社 ECU 一覧と一括確認マトリクスを、リンクで行き来できる", async () => {
    const fetchMock = stubApi();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "自社 ECU 一覧" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "一括確認マトリクス" }));
    expect(
      await screen.findByRole("heading", { name: "一括確認マトリクス" }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/matrix", expect.anything());

    fireEvent.click(screen.getByRole("link", { name: "自社 ECU 一覧" }));
    expect(
      await screen.findByRole("heading", { name: "自社 ECU 一覧" }),
    ).toBeTruthy();
  });
});
