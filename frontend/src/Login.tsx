import { type FormEvent, useState } from "react";

import { ApiError, login } from "./api";

const FAILED = "メールアドレスかパスワードが違います";

/** ログイン画面。成功したらトークンを onLogin に渡す（保存は App のメモリーだけ）。
 *  notice は、401 でここに戻ってきたときの知らせ（「ログインしてください」） */
export const Login = ({
  onLogin,
  notice,
}: {
  onLogin: (token: string) => void;
  notice: string | null;
}) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(email, password));
    } catch (err) {
      // 失敗の理由（メールアドレスがない・パスワードが違うなど）は API も画面も区別しない
      setError(
        err instanceof ApiError
          ? FAILED
          : "通信に失敗しました。API が動いているか確かめてください",
      );
      // 打ち間違えたパスワードを画面に残さない
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const message = error ?? notice;
  return (
    <>
      <h2>ログイン</h2>
      {message !== null && <p role="alert">{message}</p>}
      <form onSubmit={submit}>
        <p>
          <label>
            メールアドレス
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        </p>
        <p>
          <label>
            パスワード
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </p>
        <button type="submit" disabled={busy}>
          ログイン
        </button>
      </form>
    </>
  );
};
