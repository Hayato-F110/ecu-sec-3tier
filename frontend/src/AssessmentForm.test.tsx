import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AssessmentForm } from "./AssessmentForm";
import type { AssessmentView } from "./api";

const view = (overrides: Partial<AssessmentView> = {}): AssessmentView => ({
  assessment: { id: 7, version: 2, status: "draft" },
  entries: [
    {
      item_id: 1,
      code: "SB",
      title: "セキュアブート",
      status: "done",
      evidence: "ROM の公開鍵で署名を検証",
      planned_date: null,
    },
    {
      item_id: 2,
      code: "SECOC",
      title: "メッセージ認証",
      status: null,
      evidence: null,
      planned_date: null,
    },
    {
      item_id: 3,
      code: "DBG",
      title: "デバッグポートの無効化",
      status: "in_progress",
      evidence: "量産で無効化",
      planned_date: "2027-01-10",
    },
  ],
  ...overrides,
});

type Reply = { status: number; body: unknown };
/** 呼ばれた順に応答を返す fetch（1回目は取得、2回目は保存） */
const stubFetch = (...replies: Reply[]) => {
  const queue = [...replies];
  const fetchMock = vi.fn<typeof fetch>(async () => {
    const reply = queue.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const sentBody = (fetchMock: ReturnType<typeof stubFetch>, call: number) => {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string) as unknown;
};

const renderForm = () => render(<AssessmentForm token="5" ecuId={12} />);

describe("対策状況の入力", () => {
  it("項目ごとに状態・根拠・予定日の欄が出て、保存済みの値が入っている", async () => {
    stubFetch({ status: 200, body: view() });
    renderForm();
    const status = (await screen.findByLabelText(
      "セキュアブート の状態",
    )) as HTMLSelectElement;
    expect(status.value).toBe("done");
    expect(
      (screen.getByLabelText("セキュアブート の根拠") as HTMLTextAreaElement)
        .value,
    ).toBe("ROM の公開鍵で署名を検証");
    expect(
      (screen.getByLabelText("メッセージ認証 の状態") as HTMLSelectElement)
        .value,
    ).toBe("");
    expect(
      (
        screen.getByLabelText(
          "デバッグポートの無効化 の対応予定日",
        ) as HTMLInputElement
      ).value,
    ).toBe("2027-01-10");
    expect(screen.getByText("版 2：下書き")).toBeTruthy();
  });

  it("根拠の欄は 2000 文字まで", async () => {
    stubFetch({ status: 200, body: view() });
    renderForm();
    const evidence = await screen.findByLabelText("セキュアブート の根拠");
    expect(evidence.getAttribute("maxlength")).toBe("2000");
  });

  it("対応済み・対象外のとき予定日の欄は使えず、送る値も空", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(
      { status: 200, body: view() },
      { status: 200, body: view() },
    );
    renderForm();
    expect(
      (
        (await screen.findByLabelText(
          "セキュアブート の対応予定日",
        )) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    await user.selectOptions(
      screen.getByLabelText("デバッグポートの無効化 の状態"),
      "not_applicable",
    );
    const planned = screen.getByLabelText(
      "デバッグポートの無効化 の対応予定日",
    ) as HTMLInputElement;
    expect(planned.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "下書きを保存" }));
    await screen.findByText("保存しました");
    const body = sentBody(fetchMock, 1) as {
      entries: { item_id: number; planned_date: unknown }[];
    };
    expect(body.entries.find((e) => e.item_id === 3)?.planned_date).toBeNull();
  });

  it("保存で PUT /api/ecus/12/draft に、状態を選んだ項目だけを API の形で送る", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(
      { status: 200, body: view() },
      { status: 200, body: view() },
    );
    renderForm();
    const evidence = await screen.findByLabelText("セキュアブート の根拠");
    await user.clear(evidence);
    await user.type(evidence, "公開鍵は OTP に保存");
    await user.click(screen.getByRole("button", { name: "下書きを保存" }));
    await screen.findByText("保存しました");
    const [url, init] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/ecus/12/draft");
    expect(init.method).toBe("PUT");
    expect(sentBody(fetchMock, 1)).toEqual({
      entries: [
        {
          item_id: 1,
          status: "done",
          evidence: "公開鍵は OTP に保存",
          planned_date: null,
        },
        {
          item_id: 3,
          status: "in_progress",
          evidence: "量産で無効化",
          planned_date: "2027-01-10",
        },
      ],
    });
  });

  it("状態を1つも選んでいないと保存ボタンが押せない", async () => {
    const empty = view({
      assessment: null,
      entries: view().entries.map((e) => ({
        ...e,
        status: null,
        evidence: null,
        planned_date: null,
      })),
    });
    stubFetch({ status: 200, body: empty });
    renderForm();
    const button = (await screen.findByRole("button", {
      name: "下書きを保存",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("まだ入力がありません")).toBeTruthy();
  });

  it("取得が 404 なら「見つかりません」と出し、入力欄を出さない", async () => {
    stubFetch({ status: 404, body: { detail: "見つかりません" } });
    renderForm();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "見つかりません",
    );
    expect(screen.queryByRole("button", { name: "下書きを保存" })).toBeNull();
  });

  it("承認待ちの版では、保存できないことを示し、保存が 409 なら API の理由を出す", async () => {
    const user = userEvent.setup();
    stubFetch(
      {
        status: 200,
        body: view({ assessment: { id: 7, version: 2, status: "pending" } }),
      },
      { status: 409, body: { detail: "承認待ちの版は編集できません" } },
    );
    renderForm();
    expect(
      await screen.findByText(
        "承認待ちの版は保存できません（承認か差し戻しのあとに入力できます）",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "下書きを保存" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("保存できませんでした")).toBeTruthy();
    expect(
      within(alert).getByText("承認待ちの版は編集できません"),
    ).toBeTruthy();
  });

  it("保存が重なった 409 では、承認待ちとは言わず、やり直しを促す API の理由を出す", async () => {
    const user = userEvent.setup();
    stubFetch(
      { status: 200, body: view() },
      {
        status: 409,
        body: { detail: "ほかの保存と重なりました。やり直してください" },
      },
    );
    renderForm();
    await user.click(
      await screen.findByRole("button", { name: "下書きを保存" }),
    );
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("ほかの保存と重なりました。やり直してください"),
    ).toBeTruthy();
    expect(alert.textContent).not.toContain("承認待ち");
  });

  it("保存済みの項目は（未選択）に戻せない（送らない項目は API が前の値のまま残すため）", async () => {
    stubFetch({ status: 200, body: view() });
    renderForm();
    const saved = (await screen.findByLabelText(
      "セキュアブート の状態",
    )) as HTMLSelectElement;
    const unsaved = screen.getByLabelText(
      "メッセージ認証 の状態",
    ) as HTMLSelectElement;
    const blank = (select: HTMLSelectElement) =>
      [...select.options].find((o) => o.value === "")!;
    expect(blank(saved).disabled).toBe(true);
    expect(blank(unsaved).disabled).toBe(false);
  });

  it("保存の途中でログインした人が変わったら、前の保存の結果で上書きしない", async () => {
    const user = userEvent.setup();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    let releaseSave: (r: Response) => void = () => {};
    const replies: (() => Promise<Response>)[] = [
      async () => json(view()), // ユーザー 5 の取得
      () =>
        new Promise<Response>((resolve) => {
          releaseSave = resolve; // ユーザー 5 の保存（応答を止めておく）
        }),
      async () =>
        json(view({ assessment: { id: 9, version: 4, status: "draft" } })), // ユーザー 7 の取得
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => replies.shift()!()),
    );
    const { rerender } = render(<AssessmentForm token="5" ecuId={12} />);
    await user.click(
      await screen.findByRole("button", { name: "下書きを保存" }),
    );
    rerender(<AssessmentForm token="7" ecuId={12} />);
    expect(await screen.findByText("版 4：下書き")).toBeTruthy();

    await act(async () => {
      releaseSave(
        json(view({ assessment: { id: 8, version: 3, status: "draft" } })),
      );
    });

    expect(screen.getByText("版 4：下書き")).toBeTruthy();
    expect(screen.queryByText("版 3：下書き")).toBeNull();
    expect(screen.queryByText("保存しました")).toBeNull();
  });

  it("承認済みの版を見ているときは、保存すると新しい版になると示す", async () => {
    stubFetch({
      status: 200,
      body: view({ assessment: { id: 7, version: 2, status: "approved" } }),
    });
    renderForm();
    expect(
      await screen.findByText("保存すると新しい版（版 3）の下書きになります"),
    ).toBeTruthy();
  });

  it("保存が 422 なら、項目ごとの msg を出す", async () => {
    const user = userEvent.setup();
    stubFetch(
      { status: 200, body: view() },
      {
        status: 422,
        body: {
          detail: [
            {
              type: "value_error",
              loc: ["body", "entries", 0],
              msg: "使えない文字が含まれています",
            },
          ],
        },
      },
    );
    renderForm();
    await user.click(
      await screen.findByRole("button", { name: "下書きを保存" }),
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("入力を確かめてください")).toBeTruthy();
    expect(
      within(alert).getByText("使えない文字が含まれています"),
    ).toBeTruthy();
  });

  it("根拠の <script> は文字のまま出て、HTML として動かない", async () => {
    const attack =
      '<script>window.__hacked = true</script><img src=x onerror="window.__hacked=true">';
    const withAttack = view();
    withAttack.entries[0] = { ...withAttack.entries[0], evidence: attack };
    stubFetch({ status: 200, body: withAttack });
    const { container } = renderForm();
    const evidence = (await screen.findByLabelText(
      "セキュアブート の根拠",
    )) as HTMLTextAreaElement;
    expect(evidence.value).toBe(attack);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(
      (window as unknown as { __hacked?: boolean }).__hacked,
    ).toBeUndefined();
  });

  it("保存したあとは、応答の内容（版と状態）を出す", async () => {
    const user = userEvent.setup();
    stubFetch(
      {
        status: 200,
        body: view({ assessment: { id: 7, version: 2, status: "approved" } }),
      },
      {
        status: 200,
        body: view({ assessment: { id: 8, version: 3, status: "draft" } }),
      },
    );
    renderForm();
    await user.click(
      await screen.findByRole("button", { name: "下書きを保存" }),
    );
    expect(await screen.findByText("版 3：下書き")).toBeTruthy();
  });
});
