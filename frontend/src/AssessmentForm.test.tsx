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
    // 申請・承認の 409 にも同じ文言が出るので、「保存」に限らない言い方（SC3-14）
    expect(within(alert).getByText("操作できませんでした")).toBeTruthy();
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

describe("承認フロー（docs/test-plans/SC3-14.md #12）", () => {
  const pending = (canReview: boolean): AssessmentView =>
    view({
      assessment: { id: 7, version: 2, status: "pending" },
      can_review: canReview,
    });
  const renderAs = (role: string) =>
    render(<AssessmentForm token="5" ecuId={12} role={role} />);
  const call = (fetchMock: ReturnType<typeof stubFetch>, i: number) => ({
    url: String(fetchMock.mock.calls[i][0]),
    method: (fetchMock.mock.calls[i][1] as RequestInit | undefined)?.method,
  });

  it("入力者が申請すると POST /api/ecus/12/submit を呼び、状態が「承認待ち」になる", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(
      { status: 200, body: view() },
      { status: 200, body: pending(false) },
    );
    renderAs("editor");
    await user.click(await screen.findByRole("button", { name: "承認申請" }));
    expect(await screen.findByText("版 2：承認待ち")).toBeTruthy();
    expect(call(fetchMock, 1)).toEqual({
      url: "/api/ecus/12/submit",
      method: "POST",
    });
  });

  it("保存していない入力があるまま申請しようとしたら、申請せずに知らせる", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ status: 200, body: view() });
    renderAs("editor");
    await user.type(
      await screen.findByLabelText("セキュアブート の根拠"),
      "追記",
    );
    await user.click(screen.getByRole("button", { name: "承認申請" }));
    expect(
      await screen.findByText(
        "保存していない入力があります。先に下書きを保存してください",
      ),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("申請が 409 なら、API の理由を出す", async () => {
    const user = userEvent.setup();
    stubFetch(
      { status: 200, body: view() },
      { status: 409, body: { detail: "未入力の項目があります" } },
    );
    renderAs("editor");
    await user.click(await screen.findByRole("button", { name: "承認申請" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("操作できませんでした")).toBeTruthy();
    expect(within(alert).getByText("未入力の項目があります")).toBeTruthy();
  });

  it("承認者は承認できる（POST /api/ecus/12/approve）", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(
      { status: 200, body: pending(true) },
      {
        status: 200,
        body: view({ assessment: { id: 7, version: 2, status: "approved" } }),
      },
    );
    renderAs("approver");
    await user.click(await screen.findByRole("button", { name: "承認" }));
    expect(await screen.findByText("版 2：承認済み")).toBeTruthy();
    expect(call(fetchMock, 1)).toEqual({
      url: "/api/ecus/12/approve",
      method: "POST",
    });
  });

  it("承認が 403 なら、権限がないことを出す", async () => {
    const user = userEvent.setup();
    stubFetch({ status: 200, body: pending(true) }, { status: 403, body: {} });
    renderAs("approver");
    await user.click(await screen.findByRole("button", { name: "承認" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "この操作の権限がありません",
    );
  });

  it("差し戻しは、理由が空・空白だけなら押せず、理由を入れると送れる。理由が表示される", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(
      { status: 200, body: pending(true) },
      {
        status: 200,
        body: view({
          assessment: {
            id: 7,
            version: 2,
            status: "rejected",
            reject_reason: "根拠が足りません",
          },
        }),
      },
    );
    renderAs("approver");
    const button = await screen.findByRole("button", { name: "差し戻し" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByLabelText("差し戻しの理由");
    await user.type(reason, "　 ");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.clear(reason);
    await user.type(reason, "根拠が足りません");
    await user.click(button);
    expect(await screen.findByText("版 2：差し戻し")).toBeTruthy();
    expect(screen.getByText("差し戻しの理由：根拠が足りません")).toBeTruthy();
    expect(call(fetchMock, 1)).toEqual({
      url: "/api/ecus/12/reject",
      method: "POST",
    });
    expect(sentBody(fetchMock, 1)).toEqual({ reason: "根拠が足りません" });
  });

  it("差し戻された版を開くと、入力者にも理由が出る", async () => {
    stubFetch({
      status: 200,
      body: view({
        assessment: {
          id: 7,
          version: 2,
          status: "rejected",
          reject_reason: "予定日を入れてください",
        },
      }),
    });
    renderAs("editor");
    expect(
      await screen.findByText("差し戻しの理由：予定日を入れてください"),
    ).toBeTruthy();
  });

  it("承認者でも、API が承認できないと言う版（自分の申請など）には、ボタンの代わりに知らせを出す", async () => {
    stubFetch({ status: 200, body: pending(false) });
    renderAs("approver");
    expect(
      await screen.findByText(
        "自分の申請は承認できません（未入力の項目がある版も承認できません）",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
    expect(screen.queryByRole("button", { name: "差し戻し" })).toBeNull();
  });

  it("入力者に承認・差し戻しのボタン、承認者に申請のボタンは出ない", async () => {
    stubFetch({ status: 200, body: pending(true) });
    const { unmount } = renderAs("editor");
    await screen.findByText("版 2：承認待ち");
    expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
    expect(screen.queryByRole("button", { name: "差し戻し" })).toBeNull();
    unmount();
    stubFetch({ status: 200, body: view() });
    renderAs("approver");
    await screen.findByText("版 2：下書き");
    expect(screen.queryByRole("button", { name: "承認申請" })).toBeNull();
  });

  it.each(["supplier_admin", "reviewer", "sys_admin"])(
    "%s には申請・承認・差し戻しのボタンが出ない",
    async (role) => {
      stubFetch({ status: 200, body: pending(true) });
      const { unmount } = renderAs(role);
      await screen.findByText("版 2：承認待ち");
      for (const name of ["承認申請", "承認", "差し戻し"])
        expect(screen.queryByRole("button", { name })).toBeNull();
      unmount();
      stubFetch({ status: 200, body: view() });
      renderAs(role);
      await screen.findByText("版 2：下書き");
      expect(screen.queryByRole("button", { name: "承認申請" })).toBeNull();
    },
  );
});
