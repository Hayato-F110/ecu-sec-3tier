import { useEffect, useMemo, useState } from "react";

import {
  getMatrix,
  type MatrixView,
  REVIEW_LABELS,
  type ReviewStatus,
  STATUS_LABELS,
} from "./api";
import { ErrorMessage } from "./ErrorMessage";

/** 一括確認マトリクス（メーカー用）。どの版を見せるか・誰が見られるかは API が決める。
 *  画面は受け取った行を、サプライヤ・確認状況で絞って並べるだけ */
export const Matrix = ({ token }: { token: string }) => {
  const [view, setView] = useState<MatrixView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [supplier, setSupplier] = useState(""); // "" は「すべて」
  const [review, setReview] = useState<"" | ReviewStatus>("");

  useEffect(() => {
    let active = true; // ログインした人が変わったとき、前の応答で上書きしない
    getMatrix(token).then(
      (result) => {
        if (!active) return;
        setView(result);
        setError(null);
      },
      (e: unknown) => {
        if (!active) return;
        setView(null);
        setError(e);
      },
    );
    return () => {
      active = false;
    };
  }, [token]);

  // 選択肢のサプライヤは、応答の行から作る（重ねない）
  const suppliers = useMemo(() => {
    const byId = new Map<number, string>();
    for (const r of view?.rows ?? []) byId.set(r.supplier_id, r.supplier_name);
    return [...byId];
  }, [view]);

  if (error !== null) return <ErrorMessage error={error} />;
  if (view === null) return <p>読み込み中…</p>;

  // 確認状況で絞ると、承認済みの版がない行（確認状況が空）はどれにも当たらない
  const rows = view.rows.filter(
    (r) =>
      (supplier === "" || String(r.supplier_id) === supplier) &&
      (review === "" || r.review_status === review),
  );

  return (
    <>
      <div className="filters">
        <label>
          サプライヤ
          <select
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          >
            <option value="">すべて</option>
            {suppliers.map(([id, name]) => (
              <option key={id} value={String(id)}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          確認状況
          <select
            value={review}
            onChange={(e) => setReview(e.target.value as "" | ReviewStatus)}
          >
            <option value="">すべて</option>
            {Object.entries(REVIEW_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <p>該当なし</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>サプライヤ</th>
              <th>品番</th>
              <th>ECU</th>
              <th>車種</th>
              <th>承認済みの版</th>
              <th>確認状況</th>
              {view.items.map((item) => (
                <th key={item.id}>{item.title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ecu_id}>
                <td>{r.supplier_name}</td>
                <td>{r.part_no}</td>
                <td>{r.ecu_name}</td>
                <td>{r.vehicle_model}</td>
                {r.version === null ? (
                  <td colSpan={2 + r.cells.length}>承認済みの版なし</td>
                ) : (
                  <>
                    <td>{`版 ${r.version}`}</td>
                    <td>
                      {r.review_status === null
                        ? ""
                        : (REVIEW_LABELS[r.review_status] ?? r.review_status)}
                    </td>
                    {r.cells.map((c) => (
                      <td key={c.item_id}>
                        {c.status === null
                          ? "未入力"
                          : (STATUS_LABELS[c.status] ?? c.status)}
                      </td>
                    ))}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
};
