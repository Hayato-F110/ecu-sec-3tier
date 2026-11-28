import { useEffect, useRef, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";

import { homeOf, type Session, setUnauthorizedHandler } from "./api";
import { AssessmentForm, type KeptInput } from "./AssessmentForm";
import { EcuList } from "./EcuList";
import { Login } from "./Login";
import { Matrix } from "./Matrix";

/** 保存していない入力（変えた行と、そのときの版）と、誰の・どの ECU の入力か（SC3-38） */
type Draft = KeptInput & { email: string; ecuId: number };

const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** URL の ECU の番号（/ecus/3）を読む。数字でなければ API を呼ばずに「見つかりません」。
 * export はテスト（App.test.tsx の部品のテスト）のためだけ。画面からはログインの確かめを通る App の中でだけ使う */
export const AssessmentPage = ({
  token,
  email = "",
  role = "",
  kept = null,
  onRestored,
  onDraftChange,
}: {
  token: string;
  email?: string;
  /** ログインした人の役割（承認フローのボタンの出し分け。SC3-14） */
  role?: string;
  /** 預かっている入力。同じ人・同じ ECU のときだけ入力の部品に渡す */
  kept?: Draft | null;
  onRestored?: () => void;
  onDraftChange?: (draft: Draft | null) => void;
}) => {
  const { ecuId } = useParams();
  const id = /^\d{1,18}$/.test(ecuId ?? "") ? Number(ecuId) : NaN;
  const restore =
    kept !== null && kept.ecuId === id && sameEmail(kept.email, email)
      ? { base: kept.base, rows: kept.rows }
      : undefined;
  return (
    <>
      <p>
        <Link to="/">← 自社 ECU 一覧へ</Link>
      </p>
      <h2>対策状況の入力</h2>
      {Number.isSafeInteger(id) && id >= 1 ? (
        <AssessmentForm
          key={`${token}:${id}`}
          token={token}
          ecuId={id}
          role={role}
          restore={restore}
          onRestored={onRestored}
          onDraftChange={(input) =>
            onDraftChange?.(
              input === null ? null : { ...input, email, ecuId: id },
            )
          }
        />
      ) : (
        <p role="alert">見つかりません</p>
      )}
    </>
  );
};

export const App = () => {
  // トークンはこの部品の状態（メモリー）だけに置く。sessionStorage・localStorage・Cookie には
  // 書かない（画面に XSS があっても、保存場所から盗まれない。代わりに再読み込みでログインし直す）
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 401 でログイン画面に移ったときの元のページと、そのときの人。
  // 同じ人がログインし直したときだけ、そのページへ戻す（別の人に前の人のページを見せない）
  const [returnTo, setReturnTo] = useState<{
    email: string;
    path: string;
  } | null>(null);
  // SC3-38：入力の画面の、保存していない入力（入力の部品が知らせる）。
  // 401 のときにだけ kept へ写し、同じ人がログインし直したら入力の部品に返す。
  // どちらもメモリーだけに置く（トークンと同じ理由で、ブラウザの保存場所には書かない）
  const liveDraft = useRef<Draft | null>(null);
  const [kept, setKept] = useState<Draft | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const here = useRef(location.pathname);
  const current = useRef<Session | null>(null);
  useEffect(() => {
    here.current = location.pathname;
    current.current = session;
  }, [location.pathname, session]);

  useEffect(() => {
    // API が 401 を返したら（期限切れ・無効になった利用者など）、トークンを捨ててログインし直す。
    // ただし、ログインし直す前の古いトークンで送った要求の 401 なら何もしない
    // （遅れて届いた 401 で、新しくログインした人を追い出さない）
    setUnauthorizedHandler((sentToken) => {
      const now = current.current;
      if (now === null || now.token !== sentToken) return;
      setReturnTo(
        here.current === "/login"
          ? null
          : { email: now.email, path: here.current },
      );
      // 入力の画面が開いていなければ（liveDraft が null）、まだ戻していない同じ人の入力を残す
      // （ログインし直した直後にまた 401 になっても失わない。SC3-38 のレビュー2回目）
      const draft = liveDraft.current;
      setKept((k) =>
        draft !== null && sameEmail(draft.email, now.email)
          ? draft
          : k !== null && sameEmail(k.email, now.email)
            ? k
            : null,
      );
      current.current = null;
      setSession(null);
      setNotice("ログインしてください");
      navigate("/login", { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  // 画面の移動はしない：ログイン済みの画面で /login を開いている状態になり、下の
  // <Navigate> が移る先（元のページか、役割ごとの最初のページ）へ移す
  const onLogin = (next: Session) => {
    current.current = next;
    // 別の人がログインしたら、前の人の入力を捨てる（あとで前の人が戻っても返さない）
    setKept((k) => (k !== null && sameEmail(k.email, next.email) ? k : null));
    setSession(next);
    setNotice(null);
  };

  const logout = () => {
    current.current = null;
    setSession(null);
    setNotice(null);
    setReturnTo(null);
    setKept(null);
    navigate("/login", { replace: true });
  };

  if (session === null)
    return (
      <>
        <header>
          <h1>ECU セキュリティ対策状況</h1>
        </header>
        <main>
          <Routes>
            <Route
              path="/login"
              element={<Login onLogin={onLogin} notice={notice} />}
            />
            {/* 未ログインでは、どのページもログイン画面へ（API を呼ばない） */}
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </main>
      </>
    );

  const { token, email } = session;
  const sameUser = returnTo !== null && sameEmail(returnTo.email, email);
  const afterLogin = sameUser ? returnTo.path : homeOf(session.role);

  return (
    <>
      <header>
        <h1>ECU セキュリティ対策状況</h1>
        <p>ログイン中：{email}</p>
        <nav>
          <Link to="/">自社 ECU 一覧</Link>
          {" ｜ "}
          <Link to="/matrix">一括確認マトリクス</Link>
          {" ｜ "}
          <button type="button" onClick={logout}>
            ログアウト
          </button>
        </nav>
      </header>
      <main>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <h2>自社 ECU 一覧</h2>
                {/* ログインした人が変わったら部品を作り直す（前の人の表・絞り込みを残さない） */}
                <EcuList key={token} token={token} />
              </>
            }
          />
          <Route
            path="/ecus/:ecuId"
            element={
              <AssessmentPage
                token={token}
                email={email}
                role={session.role}
                kept={kept}
                onRestored={() => setKept(null)}
                onDraftChange={(draft) => {
                  liveDraft.current = draft;
                }}
              />
            }
          />
          <Route
            path="/matrix"
            element={
              <>
                <h2>一括確認マトリクス</h2>
                <Matrix key={token} token={token} />
              </>
            }
          />
          {/* ログイン済みで /login を開いたら、同じ人の 401 の前のページ、なければ役割ごとの最初のページへ */}
          <Route path="/login" element={<Navigate to={afterLogin} replace />} />
          <Route path="*" element={<p role="alert">見つかりません</p>} />
        </Routes>
      </main>
    </>
  );
};
