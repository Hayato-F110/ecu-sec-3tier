import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { EcuList } from "./EcuList";

const stubFetch = (status: number, body: unknown) => {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const renderList = () =>
  render(
    <MemoryRouter>
      <EcuList userId="5" />
    </MemoryRouter>,
  );

describe("自社 ECU 一覧", () => {
  it("ECU の名前・品番・車種・最新の版と状態が表に出て、入力画面へのリンクがある", async () => {
    stubFetch(200, [
      {
        id: 3,
        name: "ゲートウェイ ECU",
        part_no: "DMY-A001",
        vehicle_model: "架空セダン",
        latest_version: 2,
        latest_status: "pending",
      },
    ]);
    renderList();
    expect(await screen.findByText("ゲートウェイ ECU")).toBeTruthy();
    expect(screen.getByText("DMY-A001")).toBeTruthy();
    expect(screen.getByText("架空セダン")).toBeTruthy();
    expect(screen.getByText("版 2：承認待ち")).toBeTruthy();
    const link = screen.getByRole("link", { name: "ゲートウェイ ECU" });
    expect(link.getAttribute("href")).toBe("/ecus/3");
  });

  it("版がない ECU は「未入力」と出る", async () => {
    stubFetch(200, [
      {
        id: 4,
        name: "ボディ ECU",
        part_no: "DMY-A002",
        vehicle_model: "架空セダン",
        latest_version: null,
        latest_status: null,
      },
    ]);
    renderList();
    expect(await screen.findByText("未入力")).toBeTruthy();
  });

  it("401 では、仮のユーザー ID を確かめるよう出す", async () => {
    stubFetch(401, { detail: "認証が必要です" });
    renderList();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "仮のユーザー ID を確かめてください",
    );
  });

  it("403 では、権限がないと出す", async () => {
    stubFetch(403, { detail: "権限がありません" });
    renderList();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "この操作の権限がありません",
    );
  });
});
