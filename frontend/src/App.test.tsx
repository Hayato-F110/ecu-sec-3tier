import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, AssessmentPage } from "./App";
import { AssessmentForm } from "./AssessmentForm";

// docs/test-plans/SC3-11.md の #17、SC3-12.md の #14・#16・#17・#18

const MATRIX = {
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** ログインは毎回ちがうトークン（tok-1、tok-2 …）を返す。ほかの API は route で決める */
const stubApi = (
  route: (url: string, init?: RequestInit) => Response | Promise<Response>,
) => {
  let issued = 0;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/api/auth/login") {
      issued += 1;
      const { email } = JSON.parse(String(init?.body)) as { email: string };
      return json({
        access_token: `tok-${issued}`,
        token_type: "bearer",
        expires_in: 1800,
        role: email.startsWith("oem-") ? "reviewer" : "editor",
      });
    }
    return route(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const okApi = () =>
  stubApi((url) => json(url.startsWith("/api/matrix") ? MATRIX : []));

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

const logIn = async (email = "a-editor@example.com") => {
  fireEvent.change(await screen.findByLabelText("メールアドレス"), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText("パスワード"), {
    target: { value: "pw" },
  });
  fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
};

const authOf = (call: Parameters<typeof fetch>) =>
  new Headers(call[1]?.headers).get("Authorization");

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("未ログイン（#14）", () => {
  it.each(["/", "/matrix", "/ecus/3"])(
    "%s を開くとログイン画面に移り、API を呼ばない",
    async (path) => {
      const fetchMock = okApi();
      renderAt(path);
      expect(
        await screen.findByRole("heading", { name: "ログイン" }),
      ).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("link", { name: "一括確認マトリクス" }),
      ).toBeNull();
    },
  );

  it("前の版の sessionStorage の仮のユーザー ID を読まない（#16）", async () => {
    // 前の版のキー。文字をそのまま書くと、消し残しの検査（backend/tests/test_auth.py）に掛かる
    sessionStorage.setItem(["dev", "user", "id"].join("-"), "2");
    const fetchMock = okApi();
    renderAt("/matrix");
    expect(
      await screen.findByRole("heading", { name: "ログイン" }),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ログインしたあと", () => {
  it("一覧に移り、以後の API に Authorization: Bearer が付く（#15）", async () => {
    const fetchMock = okApi();
    renderAt("/login");
    await logIn();
    expect(
      await screen.findByRole("heading", { name: "自社 ECU 一覧" }),
    ).toBeTruthy();
    // 見出しが出た時点では、一覧の API をまだ呼んでいないことがある（5回に1回落ちた。SC3-38 のレビュー1回目）
    const ecusCall = await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => u === "/api/ecus");
      expect(call).toBeTruthy();
      return call!;
    });
    expect(authOf(ecusCall)).toBe("Bearer tok-1");
  });

  it("トークンをブラウザの保存場所・Cookie・URL・履歴に書かない（#16）", async () => {
    okApi();
    renderAt("/login");
    await logIn();
    await screen.findByRole("heading", { name: "自社 ECU 一覧" });
    const stored = [
      ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)),
      ...Object.keys(localStorage).map((k) => localStorage.getItem(k)),
      document.cookie,
      window.location.href,
      JSON.stringify(window.history.state),
    ].join(" ");
    expect(stored).not.toContain("tok-1");
  });

  it("自社 ECU 一覧と一括確認マトリクスを、リンクで行き来できる（SC3-11 #17）", async () => {
    const fetchMock = okApi();
    renderAt("/login");
    await logIn();
    await screen.findByRole("heading", { name: "自社 ECU 一覧" });

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

  it("API が 401 を返すと、トークンを捨ててログイン画面に移る（#17）", async () => {
    const fetchMock = stubApi(() =>
      json({ detail: "ログインが必要です" }, 401),
    );
    renderAt("/login");
    await logIn();
    // ボタンを押した直後はまだログイン画面なので、401 の知らせが出るまで待つ
    expect((await screen.findByRole("alert")).textContent).toContain(
      "ログインしてください",
    );
    expect(screen.getByRole("heading", { name: "ログイン" })).toBeTruthy();
    // 一覧の API を、1回目のトークンで呼んでいた
    expect(
      fetchMock.mock.calls.some(
        ([u, init]) =>
          u === "/api/ecus" && authOf([u, init]) === "Bearer tok-1",
      ),
    ).toBe(true);
    // 捨てたトークンで、ほかの画面を開けない
    expect(
      screen.queryByRole("link", { name: "一括確認マトリクス" }),
    ).toBeNull();
    const calls = fetchMock.mock.calls.length;
    await logIn();
    // 2回目のログインでは新しいトークンを使う（呼ばれるまで待ってから、全部を確かめる）
    const after = () =>
      fetchMock.mock.calls
        .slice(calls)
        .filter(([u]) => u !== "/api/auth/login");
    await vi.waitFor(() => expect(after().length).toBeGreaterThan(0));
    expect(after().every((c) => authOf(c) === "Bearer tok-2")).toBe(true);
  });

  it("401 でログインし直したら、元のページ（マトリクス）に戻る", async () => {
    let matrixCalls = 0;
    // 1回目のマトリクスは 401（期限切れ）、2回目は表を返す
    stubApi((url) => {
      if (!url.startsWith("/api/matrix")) return json([]);
      matrixCalls += 1;
      return matrixCalls === 1
        ? json({ detail: "ログインが必要です" }, 401)
        : json(MATRIX);
    });
    renderAt("/login");
    await logIn();
    await screen.findByRole("heading", { name: "自社 ECU 一覧" });
    fireEvent.click(screen.getByRole("link", { name: "一括確認マトリクス" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "ログインしてください",
    );
    await logIn();
    expect(await screen.findByText("DMY-A001")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "一括確認マトリクス" }),
    ).toBeTruthy();
  });

  it("ログアウトでログイン画面に移り、マトリクスを開けなくなる（#17）", async () => {
    okApi();
    renderAt("/login");
    await logIn();
    await screen.findByRole("heading", { name: "自社 ECU 一覧" });
    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    expect(
      await screen.findByRole("heading", { name: "ログイン" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "一括確認マトリクス" }),
    ).toBeNull();
  });
});

describe("ログインした人が変わったとき（#18）", () => {
  it("新しい応答が来るまで、前の人のマトリクスを出さない", async () => {
    let matrixCalls = 0;
    // 1回目（tok-1）は表を返し、2回目（tok-2）は返事が来ないままにする
    stubApi((url) => {
      if (!url.startsWith("/api/matrix")) return json([]);
      matrixCalls += 1;
      return matrixCalls === 1 ? json(MATRIX) : new Promise<Response>(() => {});
    });
    renderAt("/login");
    await logIn();
    await screen.findByRole("heading", { name: "自社 ECU 一覧" });
    fireEvent.click(screen.getByRole("link", { name: "一括確認マトリクス" }));
    expect(await screen.findByText("DMY-A001")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    await logIn();
    await screen.findByRole("heading", { name: "自社 ECU 一覧" });
    fireEvent.click(screen.getByRole("link", { name: "一括確認マトリクス" }));
    expect(await screen.findByText("読み込み中…")).toBeTruthy();
    expect(screen.queryByText("DMY-A001")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("2回目のレビューの直し", () => {
  it("メーカーの人はログインのあとマトリクスに移る（自社 ECU 一覧は 403 のため）", async () => {
    const fetchMock = okApi();
    renderAt("/login");
    await logIn("oem-reviewer@example.com");
    expect(
      await screen.findByRole("heading", { name: "一括確認マトリクス" }),
    ).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/ecus")).toBe(false);
  });

  it("ログインした人のメールアドレスを上に出す", async () => {
    okApi();
    renderAt("/login");
    await logIn();
    expect(
      await screen.findByText("ログイン中：a-editor@example.com"),
    ).toBeTruthy();
  });

  it("ログインし直したあとに届いた、古いトークンの要求の 401 では追い出さない", async () => {
    // 1回目のトークンの一覧の要求は、あとで 401 を返す（それまで返事を止めておく）
    let releaseOld: (r: Response) => void = () => {};
    stubApi((url, init) => {
      const auth = new Headers(init?.headers).get("Authorization");
      if (url === "/api/ecus" && auth === "Bearer tok-1")
        return new Promise<Response>((resolve) => {
          releaseOld = resolve;
        });
      if (url === "/api/matrix" && auth === "Bearer tok-1")
        return json({ detail: "ログインが必要です" }, 401);
      return json(url.startsWith("/api/matrix") ? MATRIX : []);
    });
    renderAt("/login");
    await logIn();
    await screen.findByRole("heading", { name: "自社 ECU 一覧" });
    // マトリクスの 401 でログイン画面へ → 同じ人でログインし直す（tok-2）
    fireEvent.click(screen.getByRole("link", { name: "一括確認マトリクス" }));
    await screen.findByRole("alert");
    await logIn();
    expect(await screen.findByText("DMY-A001")).toBeTruthy();
    // 止めていた古い要求（tok-1）の 401 がいま届く
    releaseOld(json({ detail: "ログインが必要です" }, 401));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("heading", { name: "ログイン" })).toBeNull();
    expect(screen.getByText("DMY-A001")).toBeTruthy();
  });

  it("401 のあと別の人がログインしたら、前の人のページではなく、その人の最初のページへ", async () => {
    let matrixCalls = 0;
    stubApi((url) => {
      if (!url.startsWith("/api/matrix")) return json([]);
      matrixCalls += 1;
      return matrixCalls === 1
        ? json({ detail: "ログインが必要です" }, 401)
        : json(MATRIX);
    });
    renderAt("/login");
    await logIn("oem-reviewer@example.com");
    // マトリクスで 401 → 別の人（サプライヤの入力者）がログイン
    await screen.findByRole("alert");
    await logIn("a-editor@example.com");
    expect(
      await screen.findByRole("heading", { name: "自社 ECU 一覧" }),
    ).toBeTruthy();
  });
});

describe("入力画面でログインした人が変わったとき（SC3-12.md #18・SC3-35）", () => {
  // 期限切れ（401）で画面全体がログイン画面に替わる流れの見張り。
  // 入力の部品の作り直し（key）は、下の「入力のページの部品」で確かめる
  it("別の人でログインし直すと自分の一覧に移り、前の人の入力画面と入力を出さない", async () => {
    const ECU = {
      id: 1,
      name: "ゲートウェイ ECU",
      part_no: "DMY-A001",
      vehicle_model: "架空セダン",
      latest_version: 1,
      latest_status: "draft",
    };
    const VIEW = {
      assessment: { id: 7, version: 1, status: "draft" },
      entries: [
        {
          item_id: 1,
          code: "SB",
          title: "セキュアブート",
          status: "done",
          evidence: "ROM の公開鍵で署名を検証",
          planned_date: null,
        },
      ],
    };
    // 会社ごとの分離のとおり：A 社の ECU は A 社の人（tok-1）にだけ返す。
    // B 社の人（tok-2）の一覧は空、A 社の ECU は 404。保存は 401（期限切れ）
    const fetchMock = stubApi((url, init) => {
      const isA =
        new Headers(init?.headers).get("Authorization") === "Bearer tok-1";
      if (url === "/api/ecus") return json(isA ? [ECU] : []);
      if (url === "/api/ecus/1/assessment")
        return isA ? json(VIEW) : json({ detail: "見つかりません" }, 404);
      if (url === "/api/ecus/1/draft")
        return json({ detail: "ログインが必要です" }, 401);
      return json([]);
    });
    renderAt("/login");
    await logIn("a-editor@example.com");
    fireEvent.click(
      await screen.findByRole("link", { name: "ゲートウェイ ECU" }),
    );
    const evidence = await screen.findByLabelText("セキュアブート の根拠");
    fireEvent.change(evidence, { target: { value: "A 社だけが知る根拠" } });
    fireEvent.click(screen.getByRole("button", { name: "下書きを保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "ログインしてください",
    );

    await logIn("b-editor@example.com");
    // 別の人は元のページ（A 社の入力画面）に戻さず、自分の最初のページへ
    expect(
      await screen.findByRole("heading", { name: "自社 ECU 一覧" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "対策状況の入力" }),
    ).toBeNull();
    expect(screen.queryByDisplayValue("A 社だけが知る根拠")).toBeNull();
    // 根拠は入力欄の値なので、文字（queryByText）では見つからない。値で探す
    expect(screen.queryByDisplayValue("ROM の公開鍵で署名を検証")).toBeNull();
    // B 社の人のトークンで、A 社の ECU の入力を取りに行っていない
    const bAsked = fetchMock.mock.calls.filter(
      (c) =>
        authOf(c) === "Bearer tok-2" && String(c[0]).startsWith("/api/ecus/1"),
    );
    expect(bAsked).toEqual([]);
  });
});

describe("入力中にログインの期限が切れたとき（SC3-38）", () => {
  const ECU = {
    id: 1,
    name: "ゲートウェイ ECU",
    part_no: "DMY-A001",
    vehicle_model: "架空セダン",
    latest_version: 1,
    latest_status: "draft",
  };
  const VIEW = {
    assessment: { id: 7, version: 1, status: "draft" },
    entries: [
      {
        item_id: 1,
        code: "SB",
        title: "セキュアブート",
        status: "done",
        evidence: "ROM の公開鍵で署名を検証",
        planned_date: null,
      },
    ],
  };
  /** 1回目の保存だけ 401（期限切れ）。2回目からは保存した中身を返す */
  const expiringApi = () => {
    let drafts = 0;
    return stubApi((url, init) => {
      if (url === "/api/ecus") return json([ECU]);
      if (url === "/api/ecus/1/assessment") return json(VIEW);
      if (url === "/api/ecus/1/draft") {
        drafts += 1;
        if (drafts === 1) return json({ detail: "ログインが必要です" }, 401);
        const { entries } = JSON.parse(String(init?.body)) as {
          entries: { evidence: string }[];
        };
        return json({
          ...VIEW,
          entries: [{ ...VIEW.entries[0], evidence: entries[0].evidence }],
        });
      }
      return json([]);
    });
  };
  const draftBodies = (fetchMock: ReturnType<typeof stubApi>) =>
    fetchMock.mock.calls
      .filter(([u]) => u === "/api/ecus/1/draft")
      .map((c) => ({ auth: authOf(c), body: String(c[1]?.body) }));

  /** 入力者 A がログイン → 入力 → 保存で 401 → ログイン画面 */
  const typeThenExpire = async () => {
    renderAt("/login");
    await logIn("a-editor@example.com");
    fireEvent.click(
      await screen.findByRole("link", { name: "ゲートウェイ ECU" }),
    );
    fireEvent.change(await screen.findByLabelText("セキュアブート の根拠"), {
      target: { value: "保存前の根拠" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下書きを保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "ログインしてください",
    );
  };

  it("同じ人でログインし直すと入力が残り、保存の要求に残った入力が入る", async () => {
    const fetchMock = expiringApi();
    await typeThenExpire();
    await logIn("a-editor@example.com");
    // 元の入力画面に戻り、サーバーの値ではなく、保存する前の入力が出る
    expect(await screen.findByDisplayValue("保存前の根拠")).toBeTruthy();
    expect(screen.queryByDisplayValue("ROM の公開鍵で署名を検証")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下書きを保存" }));
    expect(await screen.findByText("保存しました")).toBeTruthy();
    const last = draftBodies(fetchMock).at(-1)!;
    expect(last.auth).toBe("Bearer tok-2");
    expect(last.body).toContain("保存前の根拠");
  });

  it("別の人でログインすると、前の人の入力は画面にも保存の要求にも出ない（その後に前の人が戻っても）", async () => {
    const fetchMock = expiringApi();
    await typeThenExpire();
    // 別の人（B 社）がログイン → ログアウト → 元の人（A 社）がログインして同じ ECU を開く
    await logIn("b-editor@example.com");
    await screen.findByRole("heading", { name: "自社 ECU 一覧" });
    expect(screen.queryByDisplayValue("保存前の根拠")).toBeNull();
    // 同じ ECU の画面を開いても出さない（本物の API なら B 社には 404。ここでは画面の守りだけを
    // 確かめるため、見本はわざと中身を返す）
    fireEvent.click(
      await screen.findByRole("link", { name: "ゲートウェイ ECU" }),
    );
    expect(
      await screen.findByDisplayValue("ROM の公開鍵で署名を検証"),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue("保存前の根拠")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    await logIn("a-editor@example.com");
    fireEvent.click(
      await screen.findByRole("link", { name: "ゲートウェイ ECU" }),
    );
    // 別の人がログインした時点で捨てたので、サーバーの値が出る
    expect(
      await screen.findByDisplayValue("ROM の公開鍵で署名を検証"),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue("保存前の根拠")).toBeNull();
    // 401 になった1回目のほかに、保存前の根拠を送った要求がない
    const sent = draftBodies(fetchMock).filter((d) =>
      d.body.includes("保存前の根拠"),
    );
    expect(sent.map((d) => d.auth)).toEqual(["Bearer tok-1"]);
  });

  it("残した入力は1回だけ戻す。ほかのページへ移って戻ると、サーバーの値を出す", async () => {
    expiringApi();
    await typeThenExpire();
    await logIn("a-editor@example.com");
    expect(await screen.findByDisplayValue("保存前の根拠")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "← 自社 ECU 一覧へ" }));
    fireEvent.click(
      await screen.findByRole("link", { name: "ゲートウェイ ECU" }),
    );
    expect(
      await screen.findByDisplayValue("ROM の公開鍵で署名を検証"),
    ).toBeTruthy();
  });
});

describe("預かった入力の戻し方（SC3-38 のレビュー1回目）", () => {
  const ECU = {
    id: 1,
    name: "ゲートウェイ ECU",
    part_no: "DMY-A001",
    vehicle_model: "架空セダン",
    latest_version: 1,
    latest_status: "draft",
  };
  const entry = (item_id: number, title: string, evidence: string) => ({
    item_id,
    code: `C${item_id}`,
    title,
    status: "done",
    evidence,
    planned_date: null,
  });
  const BEFORE = {
    assessment: { id: 7, version: 1, status: "draft" },
    entries: [entry(1, "セキュアブート", "根拠1"), entry(2, "鍵管理", "根拠2")],
  };
  /** 1回目の保存は 401。そのあとの読み込みは after を返す（ログインし直す間に、ほかの人が変えた）。
   * "fail-once" なら、そのあとの最初の読み込みだけ 500 で、次からは BEFORE */
  const changingApi = (after: unknown) => {
    let expired = false;
    let failed = false;
    return stubApi((url) => {
      if (url === "/api/ecus") return json([ECU]);
      if (url === "/api/ecus/1/assessment") {
        if (!expired) return json(BEFORE);
        if (after === "fail-once" || after === "401-once") {
          if (failed) return json(BEFORE);
          failed = true;
          return after === "401-once"
            ? json({ detail: "ログインが必要です" }, 401)
            : json({ detail: "一時的なエラー" }, 500);
        }
        return json(after);
      }
      if (url === "/api/ecus/1/draft") {
        if (!expired) {
          expired = true;
          return json({ detail: "ログインが必要です" }, 401);
        }
        return json(BEFORE);
      }
      return json([]);
    });
  };
  const typeThenExpire = async () => {
    renderAt("/login");
    await logIn("a-editor@example.com");
    fireEvent.click(
      await screen.findByRole("link", { name: "ゲートウェイ ECU" }),
    );
    fireEvent.change(await screen.findByLabelText("セキュアブート の根拠"), {
      target: { value: "保存前の根拠" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下書きを保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "ログインしてください",
    );
  };

  it("戻すのは自分が変えた行だけ。触っていない行は、ほかの人が保存した値のまま送る", async () => {
    const fetchMock = changingApi({
      ...BEFORE,
      entries: [
        entry(1, "セキュアブート", "根拠1"),
        entry(2, "鍵管理", "ほかの人が保存した根拠2"),
      ],
    });
    await typeThenExpire();
    await logIn("a-editor@example.com");
    expect(await screen.findByDisplayValue("保存前の根拠")).toBeTruthy();
    expect(screen.getByDisplayValue("ほかの人が保存した根拠2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下書きを保存" }));
    expect(await screen.findByText("保存しました")).toBeTruthy();
    const last = fetchMock.mock.calls
      .filter(([u]) => u === "/api/ecus/1/draft")
      .at(-1)!;
    expect(String(last[1]?.body)).toContain("ほかの人が保存した根拠2");
    expect(String(last[1]?.body)).not.toContain('"根拠2"');
  });

  it.each([
    ["版の番号が変わった", { id: 8, version: 2, status: "draft" }],
    [
      "版の状態が変わった（申請された）",
      { id: 7, version: 1, status: "pending" },
    ],
  ])(
    "ログインし直す間に%sら、入力を戻さずに知らせる",
    async (_name, assessment) => {
      changingApi({
        assessment,
        entries: [entry(1, "セキュアブート", "今の根拠1"), BEFORE.entries[1]],
      });
      await typeThenExpire();
      await logIn("a-editor@example.com");
      expect(await screen.findByDisplayValue("今の根拠1")).toBeTruthy();
      expect(screen.queryByDisplayValue("保存前の根拠")).toBeNull();
      expect(
        screen.getByText(
          "ログインし直す間に版が変わったため、前の入力は戻していません",
        ),
      ).toBeTruthy();
    },
  );

  it("ログインし直したあとの読み込みに失敗したら、預かった入力を捨てる（あとで開いても戻さない）", async () => {
    changingApi("fail-once");
    await typeThenExpire();
    await logIn("a-editor@example.com");
    // ログイン画面の「ログインしてください」の知らせと取り違えないよう、エラーの文で探す
    // （画面はサーバーの詳しい文を出さず、状態の番号だけを出す）
    expect(
      await screen.findByText("API の呼び出しに失敗しました（500）"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "← 自社 ECU 一覧へ" }));
    fireEvent.click(
      await screen.findByRole("link", { name: "ゲートウェイ ECU" }),
    );
    expect(await screen.findByDisplayValue("根拠1")).toBeTruthy();
    expect(screen.queryByDisplayValue("保存前の根拠")).toBeNull();
  });

  it("ログインし直した直後の読み込みがまた 401 でも、預かった入力を失わない（レビュー2回目）", async () => {
    changingApi("401-once");
    await typeThenExpire();
    await logIn("a-editor@example.com");
    // 読み込みが 401 になり、もう一度ログイン画面へ
    expect(
      await screen.findByRole("heading", { name: "ログイン" }),
    ).toBeTruthy();
    await logIn("a-editor@example.com");
    expect(await screen.findByDisplayValue("保存前の根拠")).toBeTruthy();
  });

  it("預かった行が0件でも、使い終えたことを上の部品に知らせる（レビュー2回目）", async () => {
    stubApi(() => json(BEFORE));
    const onRestored = vi.fn();
    render(
      <AssessmentForm
        token="tok"
        ecuId={1}
        restore={{ base: BEFORE.assessment as never, rows: [] }}
        onRestored={onRestored}
      />,
    );
    expect(await screen.findByDisplayValue("根拠1")).toBeTruthy();
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("上の部品に預ける入力は、自分が変えた行の4つの欄と、そのときの版だけ", async () => {
    stubApi(() => json(BEFORE));
    const onDraftChange = vi.fn();
    render(
      <AssessmentForm token="tok" ecuId={1} onDraftChange={onDraftChange} />,
    );
    fireEvent.change(await screen.findByLabelText("鍵管理 の根拠"), {
      target: { value: "変えた根拠2" },
    });
    expect(onDraftChange).toHaveBeenLastCalledWith({
      base: { id: 7, version: 1, status: "draft" },
      rows: [
        {
          item_id: 2,
          status: "done",
          evidence: "変えた根拠2",
          planned_date: "",
        },
      ],
    });
  });
});

describe("入力のページの部品（SC3-12.md #18・SC3-35）", () => {
  it("トークンが替わったら部品を作り直し、新しい応答が来るまで前の人の入力を出さない", async () => {
    const VIEW = {
      assessment: { id: 7, version: 1, status: "draft" },
      entries: [
        {
          item_id: 1,
          code: "SB",
          title: "セキュアブート",
          status: "done",
          evidence: "ROM の公開鍵で署名を検証",
          planned_date: null,
        },
      ],
    };
    // tok-A には入力の内容を返し、tok-B の取得は返事が来ないままにする
    const fetchMock = stubApi((_url, init) =>
      new Headers(init?.headers).get("Authorization") === "Bearer tok-A"
        ? json(VIEW)
        : new Promise<Response>(() => {}),
    );
    const page = (token: string) => (
      <MemoryRouter initialEntries={["/ecus/1"]}>
        <Routes>
          <Route
            path="/ecus/:ecuId"
            element={<AssessmentPage token={token} />}
          />
        </Routes>
      </MemoryRouter>
    );
    const { rerender } = render(page("tok-A"));
    const evidence = await screen.findByLabelText("セキュアブート の根拠");
    fireEvent.change(evidence, { target: { value: "A 社だけが知る根拠" } });

    rerender(page("tok-B"));
    expect(await screen.findByText("読み込み中…")).toBeTruthy();
    expect(screen.queryByDisplayValue("A 社だけが知る根拠")).toBeNull();
    expect(screen.queryByDisplayValue("ROM の公開鍵で署名を検証")).toBeNull();
    // 作り直した部品が、新しい人のトークンで取りに行っている（「読み込み中…」のまま止まっていない）
    const bAsked = fetchMock.mock.calls.filter(
      (c) =>
        authOf(c) === "Bearer tok-B" &&
        String(c[0]) === "/api/ecus/1/assessment",
    );
    expect(bAsked).toHaveLength(1);
  });
});

describe("承認フローのボタン（SC3-14 #12）", () => {
  it("入力者でログインして入力の画面を開くと、ログインした人の役割で「承認申請」が出る", async () => {
    const ecu = {
      id: 1,
      name: "ゲートウェイ ECU",
      part_no: "DMY-A001",
      vehicle_model: "架空セダン",
      latest_version: 1,
      latest_status: "draft",
    };
    stubApi((url) => {
      if (url === "/api/ecus") return json([ecu]);
      if (url === "/api/ecus/1/assessment")
        return json({
          assessment: { id: 7, version: 1, status: "draft" },
          entries: [],
          can_review: false,
        });
      return json([]);
    });
    renderAt("/login");
    await logIn("a-editor@example.com");
    fireEvent.click(
      await screen.findByRole("link", { name: "ゲートウェイ ECU" }),
    );
    expect(
      await screen.findByRole("button", { name: "承認申請" }),
    ).toBeTruthy();
  });
});
