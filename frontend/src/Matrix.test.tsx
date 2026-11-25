import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MatrixView } from "./api";
import { Matrix } from "./Matrix";

// docs/test-plans/SC3-11.md の #12〜#16。応答の形は backend/app/schemas.py の MatrixView
const ITEMS = [
  { id: 11, code: "SB", title: "セキュアブート" },
  { id: 12, code: "SECOC", title: "メッセージ認証" },
];

const row = (
  over: Partial<MatrixView["rows"][number]>,
): MatrixView["rows"][number] => ({
  ecu_id: 1,
  supplier_id: 100,
  supplier_name: "架空電装 A 社",
  ecu_name: "ゲートウェイ ECU",
  part_no: "DMY-A001",
  vehicle_model: "架空セダン",
  version: 1,
  review_status: "unreviewed",
  cells: [
    { item_id: 11, status: "done" },
    { item_id: 12, status: "in_progress" },
  ],
  ...over,
});

const SAMPLE: MatrixView = {
  items: ITEMS,
  rows: [
    row({}),
    row({
      ecu_id: 2,
      part_no: "DMY-A002",
      ecu_name: "ボディ ECU",
      version: 2,
      review_status: "confirmed",
      cells: [
        { item_id: 11, status: "not_done" },
        { item_id: 12, status: "not_applicable" },
      ],
    }),
    row({
      ecu_id: 3,
      supplier_id: 200,
      supplier_name: "架空電装 B 社",
      part_no: "DMY-B001",
      ecu_name: "ブレーキ ECU",
      review_status: "change_requested",
    }),
    row({
      ecu_id: 4,
      supplier_id: 200,
      supplier_name: "架空電装 B 社",
      part_no: "DMY-B004",
      ecu_name: "メーター ECU",
      version: null,
      review_status: null,
      cells: [
        { item_id: 11, status: null },
        { item_id: 12, status: null },
      ],
    }),
  ],
};

const stubFetch = (status: number, body: unknown) => {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const renderMatrix = () =>
  render(
    <MemoryRouter>
      <Matrix userId="2" />
    </MemoryRouter>,
  );

/** 表の本文の行（見出しの行を除く）の品番 */
const partNos = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((tr) => within(tr).queryByText(/^DMY-/)?.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { __hacked?: unknown }).__hacked;
});

describe("一括確認マトリクス", () => {
  it("#12 見出しに対策項目、行に ECU、セルに状態と確認状況の文字が出る", async () => {
    const fetchMock = stubFetch(200, SAMPLE);
    renderMatrix();
    const table = await screen.findByRole("table");
    expect(fetchMock).toHaveBeenCalledWith("/api/matrix", expect.anything());
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(ITEMS.map((i) => i.title)));
    const first = screen.getByText("DMY-A001").closest("tr")!;
    expect(within(first).getByText("架空電装 A 社")).toBeTruthy();
    expect(within(first).getByText("ゲートウェイ ECU")).toBeTruthy();
    expect(within(first).getByText("版 1")).toBeTruthy();
    expect(within(first).getByText("未確認")).toBeTruthy();
    expect(within(first).getByText("対応済み")).toBeTruthy();
    expect(within(first).getByText("対応中")).toBeTruthy();
    const second = screen.getByText("DMY-A002").closest("tr")!;
    expect(within(second).getByText("確認完了")).toBeTruthy();
    expect(within(second).getByText("未対応")).toBeTruthy();
    expect(within(second).getByText("対象外")).toBeTruthy();
    const third = screen.getByText("DMY-B001").closest("tr")!;
    expect(within(third).getByText("修正依頼中")).toBeTruthy();
  });

  it("#13 承認済みの版がない ECU の行に「承認済みの版なし」と出る", async () => {
    stubFetch(200, SAMPLE);
    renderMatrix();
    await screen.findByRole("table");
    const tr = screen.getByText("DMY-B004").closest("tr")!;
    expect(within(tr).getByText("承認済みの版なし")).toBeTruthy();
  });

  it("#14 サプライヤ・確認状況で絞り込み、組み合わせ、「すべて」に戻し、当たらなければ「該当なし」", async () => {
    stubFetch(200, SAMPLE);
    renderMatrix();
    await screen.findByRole("table");
    expect(partNos()).toEqual(["DMY-A001", "DMY-A002", "DMY-B001", "DMY-B004"]);

    const supplier = screen.getByLabelText("サプライヤ");
    const review = screen.getByLabelText("確認状況");
    // 選択肢のサプライヤは、応答の行から作る（重ならない）
    expect(
      within(supplier)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["すべて", "架空電装 A 社", "架空電装 B 社"]);

    fireEvent.change(supplier, { target: { value: "200" } });
    expect(partNos()).toEqual(["DMY-B001", "DMY-B004"]);

    // 確認状況で絞ると、承認済みの版なしの行は出ない
    fireEvent.change(supplier, { target: { value: "" } });
    fireEvent.change(review, { target: { value: "unreviewed" } });
    expect(partNos()).toEqual(["DMY-A001"]);

    // 組み合わせ
    fireEvent.change(supplier, { target: { value: "200" } });
    fireEvent.change(review, { target: { value: "change_requested" } });
    expect(partNos()).toEqual(["DMY-B001"]);

    // 当たらない
    fireEvent.change(review, { target: { value: "confirmed" } });
    expect(screen.getByText("該当なし")).toBeTruthy();

    // 「すべて」に戻す
    fireEvent.change(supplier, { target: { value: "" } });
    fireEvent.change(review, { target: { value: "" } });
    expect(partNos()).toEqual(["DMY-A001", "DMY-A002", "DMY-B001", "DMY-B004"]);
  });

  it.each([
    [403, "この操作の権限がありません"],
    [401, "仮のユーザー ID を確かめてください"],
    [500, "API の呼び出しに失敗しました（500）"],
  ])(
    "#15 API が %i なら決まった文言を出し、表を出さない",
    async (status, text) => {
      stubFetch(status, { detail: "x" });
      renderMatrix();
      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        text,
      );
      expect(screen.queryByRole("table")).toBeNull();
    },
  );

  it("#15 通信に失敗したら決まった文言を出し、表を出さない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    renderMatrix();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "通信に失敗しました。API が動いているか確かめてください",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("#16 すべての文字の欄で、差し込まれた HTML は文字のまま出て動かない", async () => {
    const attack = (label: string) =>
      `<script>window.__hacked="${label}"</script><img src=x onerror="window.__hacked='${label}'">`;
    stubFetch(200, {
      items: [{ id: 11, code: "SB", title: attack("item") }],
      rows: [
        row({
          supplier_name: attack("supplier"),
          ecu_name: attack("ecu"),
          part_no: `DMY-${attack("part")}`,
          vehicle_model: attack("model"),
          cells: [{ item_id: 11, status: "done" }],
        }),
      ],
    });
    const { container } = renderMatrix();
    await screen.findByRole("table");
    for (const label of ["item", "supplier", "ecu", "part", "model"]) {
      expect(
        screen.getAllByText(attack(label), { exact: false }).length,
      ).toBeGreaterThan(0);
    }
    expect((window as { __hacked?: unknown }).__hacked).toBeUndefined();
    expect(container.querySelector("script, img")).toBeNull();
  });
});
