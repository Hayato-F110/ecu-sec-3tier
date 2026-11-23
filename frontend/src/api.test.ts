import { describe, expect, it, vi } from "vitest";

import { ApiError, getAssessment, listEcus, saveDraft } from "./api";

/** fetch を差し替えて、決めた応答を返す。呼ばれ方はあとで mock.calls で見る */
const stubFetch = (status: number, body: unknown) => {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const headersOf = (fetchMock: ReturnType<typeof stubFetch>) => {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return new Headers(init.headers);
};

describe("API を呼ぶ関数", () => {
  it("仮のユーザー ID をヘッダー X-Dev-User-Id に付ける", async () => {
    const fetchMock = stubFetch(200, []);
    await listEcus("5");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ecus");
    expect(headersOf(fetchMock).get("X-Dev-User-Id")).toBe("5");
  });

  it("仮のユーザー ID が空なら、ヘッダーを付けない", async () => {
    const fetchMock = stubFetch(200, []);
    await listEcus("");
    expect(headersOf(fetchMock).has("X-Dev-User-Id")).toBe(false);
  });

  it("対策状況の取得は ECU の番号のパスを呼ぶ", async () => {
    const fetchMock = stubFetch(200, { assessment: null, entries: [] });
    await getAssessment("5", 12);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ecus/12/assessment");
  });

  it("下書きの保存は PUT で JSON を送る", async () => {
    const fetchMock = stubFetch(200, { assessment: null, entries: [] });
    const entries = [
      {
        item_id: 1,
        status: "done" as const,
        evidence: "根拠",
        planned_date: null,
      },
    ];
    await saveDraft("5", 12, entries);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/ecus/12/draft");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({ entries });
  });

  it("422 は、項目ごとの msg を持つ ApiError になる", async () => {
    stubFetch(422, {
      detail: [
        {
          type: "value_error",
          loc: ["body", "entries", 0],
          msg: "予定日が不正です",
        },
      ],
    });
    const error = await listEcus("5").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).details).toEqual(["予定日が不正です"]);
  });

  it("JSON でない失敗の応答でも ApiError になる", async () => {
    stubFetch(502, "Bad Gateway");
    const error = await listEcus("5").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).details).toEqual([]);
  });
});
