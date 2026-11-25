import { useEffect, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
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
  const navigate = useNavigate();

  useEffect(() => {
    // API が 401 を返したら（期限切れ・無効になった利用者など）、トークンを捨ててログインし直す
    setUnauthorizedHandler(() => {
      setToken(null);
      setNotice("ログインしてください");
      navigate("/login", { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  const onLogin = (newToken: string) => {
    setToken(newToken);
    setNotice(null);
    navigate("/", { replace: true });
  };

  const logout = () => {
    setToken(null);
    setNotice(null);
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
          {/* ログイン済みで /login を開いたら一覧へ */}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<p role="alert">見つかりません</p>} />
        </Routes>
      </main>
    </>
  );
};
