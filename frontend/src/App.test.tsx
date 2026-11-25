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

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("仮のユーザー ID を変えたとき", () => {
  it("新しい応答が来るまで、前の人のマトリクスを出さない", async () => {
    sessionStorage.setItem("dev-user-id", "2");
    const matrix = {
      items: [{ id: 1, code: "SB", title: "セキュアブート" }],
      rows: [
        {
          ecu_id: 1,
          supplier_id: 100,
          supplier_name: "架空電装 A 社",
          ecu_name: "ゲートウェイ ECU",
          part_no: "DMY-A001",
          vehicle_model: "架空セダン",
          version: 1,
          review_status: "unreviewed",
          cells: [{ item_id: 1, status: "done" }],
        },
      ],
    };
    // 1回目（ID 2）は表を返し、2回目（ID 4）は返事が来ないままにする
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(matrix), { status: 200 }),
      )
      .mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/matrix"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText("DMY-A001")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "4" } });
    expect(await screen.findByText("読み込み中…")).toBeTruthy();
    expect(screen.queryByText("DMY-A001")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

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
