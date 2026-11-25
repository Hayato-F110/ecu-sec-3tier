import { Link, Route, Routes, useParams } from "react-router";

import { AssessmentForm } from "./AssessmentForm";
import { DevUserField, useDevUserId } from "./devUser";
import { EcuList } from "./EcuList";
import { Matrix } from "./Matrix";

/** URL の ECU の番号（/ecus/3）を読む。数字でなければ API を呼ばずに「見つかりません」 */
const AssessmentPage = ({ userId }: { userId: string }) => {
  const { ecuId } = useParams();
  const id = /^\d{1,18}$/.test(ecuId ?? "") ? Number(ecuId) : NaN;
  return (
    <>
      <p>
        <Link to="/">← 自社 ECU 一覧へ</Link>
      </p>
      <h2>対策状況の入力</h2>
      {Number.isSafeInteger(id) && id >= 1 ? (
        <AssessmentForm key={id} userId={userId} ecuId={id} />
      ) : (
        <p role="alert">見つかりません</p>
      )}
    </>
  );
};

export const App = () => {
  const [userId, setUserId] = useDevUserId();
  return (
    <>
      <header>
        <h1>ECU セキュリティ対策状況</h1>
        <DevUserField userId={userId} onChange={setUserId} />
        <nav>
          <Link to="/">自社 ECU 一覧</Link>
          {" ｜ "}
          <Link to="/matrix">一括確認マトリクス</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <h2>自社 ECU 一覧</h2>
                {/* ID を変えたら部品を作り直す（前の人の表・絞り込みを残さない） */}
                <EcuList key={userId} userId={userId} />
              </>
            }
          />
          <Route
            path="/ecus/:ecuId"
            element={<AssessmentPage userId={userId} />}
          />
          <Route
            path="/matrix"
            element={
              <>
                <h2>一括確認マトリクス</h2>
                <Matrix key={userId} userId={userId} />
              </>
            }
          />
          <Route path="*" element={<p role="alert">見つかりません</p>} />
        </Routes>
      </main>
    </>
  );
};
