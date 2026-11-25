import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  getAssessment,
  listEcus,
  login,
  messageOf,
  saveDraft,
  setUnauthorizedHandler,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

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
  it("トークンを Authorization: Bearer に付ける（SC3-12 #15）", async () => {
    const fetchMock = stubFetch(200, []);
    await listEcus("tok-5");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ecus");
    expect(headersOf(fetchMock).get("Authorization")).toBe("Bearer tok-5");
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

  it.each([409, 422])(
    "%i で理由が文章（detail が文字列）なら、その理由を details に入れる",
    async (status) => {
      stubFetch(status, { detail: "存在しない対策項目：[999]" });
      const error = await listEcus("5").catch((e: unknown) => e);
      expect((error as ApiError).details).toEqual([
        "存在しない対策項目：[999]",
      ]);
    },
  );

  it.each([401, 403, 404])(
    "%i では API の文章を details に入れない（画面の決まった文言だけを出す）",
    async (status) => {
      stubFetch(status, { detail: "見つかりません" });
      const error = await listEcus("5").catch((e: unknown) => e);
      expect((error as ApiError).details).toEqual([]);
    },
  );

  it("JSON でない失敗の応答でも ApiError になる", async () => {
    stubFetch(502, "Bad Gateway");
    const error = await listEcus("5").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).details).toEqual([]);
  });

  it("ログインの API 以外の 401 では、登録した処理（トークンを捨てて /login へ）を呼ぶ（#17）", async () => {
    stubFetch(401, { detail: "ログインが必要です" });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const error = await listEcus("tok-5").catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
    // どのトークンの要求が 401 になったかを渡す（古いトークンの 401 を見分けるため）
    expect(handler).toHaveBeenCalledWith("tok-5");
  });

  it.each([403, 404, 422])("%i では 401 の処理を呼ばない", async (status) => {
    stubFetch(status, { detail: "x" });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await listEcus("tok-5").catch(() => null);
    expect(handler).not.toHaveBeenCalled();
  });

  it("401 の文言は「ログインしてください」（#17）", () => {
    expect(messageOf(new ApiError(401, []))).toBe("ログインしてください");
  });
});

describe("ログインの API", () => {
  it("POST /api/auth/login に JSON を送り、トークンを返す。Authorization は付けない", async () => {
    const fetchMock = stubFetch(200, {
      access_token: "tok-new",
      token_type: "bearer",
      expires_in: 1800,
      role: "editor",
    });
    const session = await login("a-editor@example.com", "pw");
    expect(session).toEqual({
      token: "tok-new",
      email: "a-editor@example.com",
      role: "editor",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "a-editor@example.com",
      password: "pw",
    });
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("失敗（401）は ApiError にするが、全体の 401 の処理は呼ばない（#15）", async () => {
    stubFetch(401, { detail: "メールアドレスかパスワードが違います" });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const error = await login("a@example.com", "x").catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
