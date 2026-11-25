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

import { setUnauthorizedHandler } from "./api";
import { AssessmentForm } from "./AssessmentForm";
import { EcuList } from "./EcuList";
import { Login } from "./Login";
import { Matrix } from "./Matrix";

/** URL の ECU の番号（/ecus/3）を読む。数字でなければ API を呼ばずに「見つかりません」 */
const AssessmentPage = ({ token }: { token: string }) => {
  const { ecuId } = useParams();
  const id = /^\d{1,18}$/.test(ecuId ?? "") ? Number(ecuId) : NaN;
  return (
    <>
      <p>
        <Link to="/">← 自社 ECU 一覧へ</Link>
      </p>
      <h2>対策状況の入力</h2>
      {Number.isSafeInteger(id) && id >= 1 ? (
        <AssessmentForm key={`${token}:${id}`} token={token} ecuId={id} />
      ) : (
        <p role="alert">見つかりません</p>
      )}
    </>
  );
};

export const App = () => {
  // トークンはこの部品の状態（メモリー）だけに置く。sessionStorage・localStorage・Cookie には
  // 書かない（画面に XSS があっても、保存場所から盗まれない。代わりに再読み込みでログインし直す）
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 401 でログイン画面に移ったときの元のページ。ログインし直したらそこへ戻す
  const [returnTo, setReturnTo] = useState("/");
  const navigate = useNavigate();
  const location = useLocation();
  const here = useRef(location.pathname);
  useEffect(() => {
    here.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    // API が 401 を返したら（期限切れ・無効になった利用者など）、トークンを捨ててログインし直す
    setUnauthorizedHandler(() => {
      setReturnTo(here.current === "/login" ? "/" : here.current);
      setToken(null);
      setNotice("ログインしてください");
      navigate("/login", { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  // 画面の移動はしない：ログイン済みの画面で /login を開いている状態になり、下の
  // <Navigate to={returnTo}> が元のページ（ふつうは一覧）へ移す
  const onLogin = (newToken: string) => {
    setToken(newToken);
    setNotice(null);
  };

  const logout = () => {
    setToken(null);
    setNotice(null);
    setReturnTo("/");
    navigate("/login", { replace: true });
  };

  if (token === null)
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

  return (
    <>
      <header>
        <h1>ECU セキュリティ対策状況</h1>
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
            element={<AssessmentPage token={token} />}
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
          {/* ログイン済みで /login を開いたら、元のページ（401 の前のページ。ふだんは一覧）へ */}
          <Route path="/login" element={<Navigate to={returnTo} replace />} />
          <Route path="*" element={<p role="alert">見つかりません</p>} />
        </Routes>
      </main>
    </>
  );
};
