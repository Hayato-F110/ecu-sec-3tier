import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setUnauthorizedHandler } from "./api";
import { Login } from "./Login";

// docs/test-plans/SC3-12.md の #15

const stubLogin = (status: number, body: unknown) => {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const fill = (email: string, password: string) => {
  fireEvent.change(screen.getByLabelText("メールアドレス"), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText("パスワード"), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
};

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe("ログイン画面", () => {
  it("成功すると、受け取ったトークンを渡す", async () => {
    stubLogin(200, {
      access_token: "tok-9",
      token_type: "bearer",
      expires_in: 1800,
    });
    const onLogin = vi.fn();
    render(<Login onLogin={onLogin} notice={null} />);
    fill("a-editor@example.com", "pw");
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledWith("tok-9"));
  });

  it("失敗すると決まった文言を出し、パスワードの欄を空にする。401 の全体の処理は呼ばない", async () => {
    stubLogin(401, { detail: "メールアドレスかパスワードが違います" });
    const onLogin = vi.fn();
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    render(<Login onLogin={onLogin} notice={null} />);
    fill("a-editor@example.com", "wrong");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "メールアドレスかパスワードが違います",
    );
    expect(
      (screen.getByLabelText("パスワード") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByLabelText("メールアドレス") as HTMLInputElement).value,
    ).toBe("a-editor@example.com");
    expect(onLogin).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("パスワードの欄は伏せ字（type=password）", () => {
    render(<Login onLogin={vi.fn()} notice={null} />);
    expect(screen.getByLabelText("パスワード").getAttribute("type")).toBe(
      "password",
    );
  });

  it("API に届かないときは、通信の失敗を伝える", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("network");
      }),
    );
    render(<Login onLogin={vi.fn()} notice={null} />);
    fill("a-editor@example.com", "pw");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "通信に失敗しました",
    );
  });
});
