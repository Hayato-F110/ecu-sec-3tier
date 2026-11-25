import { useEffect, useState } from "react";
import { Link } from "react-router";

import { type EcuSummary, listEcus, versionLabel } from "./api";
import { ErrorMessage } from "./ErrorMessage";

/** 自社 ECU 一覧。どの ECU が見えるかは API が会社で絞り込む（画面では絞らない） */
export const EcuList = ({ token }: { token: string }) => {
  const [ecus, setEcus] = useState<EcuSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true; // ログインした人が変わったとき、前の応答で上書きしない
    listEcus(token).then(
      (result) => {
        if (!active) return;
        setEcus(result);
        setError(null);
      },
      (e: unknown) => {
        if (!active) return;
        setEcus(null);
        setError(e);
      },
    );
    return () => {
      active = false;
    };
  }, [token]);

  if (error !== null) return <ErrorMessage error={error} />;
  if (ecus === null) return <p>読み込み中…</p>;
  if (ecus.length === 0) return <p>ECU がありません</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>ECU</th>
          <th>品番</th>
          <th>車種</th>
          <th>最新の版</th>
        </tr>
      </thead>
      <tbody>
        {ecus.map((ecu) => (
          <tr key={ecu.id}>
            <td>
              <Link to={`/ecus/${ecu.id}`}>{ecu.name}</Link>
            </td>
            <td>{ecu.part_no}</td>
            <td>{ecu.vehicle_model}</td>
            <td>
              {ecu.latest_version === null || ecu.latest_status === null
                ? "未入力"
                : versionLabel(ecu.latest_version, ecu.latest_status)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
