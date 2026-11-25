import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  type AssessmentView,
  type EntryIn,
  type EntryStatus,
  getAssessment,
  saveDraft,
  STATUS_LABELS,
  versionLabel,
} from "./api";
import { ErrorMessage } from "./ErrorMessage";

/** API と同じ上限（backend/app/schemas.py の EVIDENCE_MAX）。画面の制限は使いやすさのためで、最後の判断は API */
const EVIDENCE_MAX = 2000;

/** 対応予定日を入れられる状態（API の決まりと同じ） */
const needsPlannedDate = (status: EntryStatus | "") =>
  status === "in_progress" || status === "not_done";

type Row = {
  item_id: number;
  title: string;
  status: EntryStatus | "";
  /** 保存済みの状態がある。API は送らなかった項目を前の値のまま残すので、（未選択）に戻しても消えない */
  saved: boolean;
  evidence: string;
  planned_date: string;
};

const rowsOf = (view: AssessmentView): Row[] =>
  view.entries.map((e) => ({
    item_id: e.item_id,
    title: e.title,
    status: e.status ?? "",
    saved: e.status !== null,
    evidence: e.evidence ?? "",
    planned_date: e.planned_date ?? "",
  }));

/** 状態を選んだ項目だけを、API の形にする。予定日は、入れられない状態なら空（null）にする */
const entriesOf = (rows: Row[]): EntryIn[] =>
  rows.flatMap((r) =>
    r.status === ""
      ? []
      : [
          {
            item_id: r.item_id,
            status: r.status,
            evidence: r.evidence,
            planned_date:
              needsPlannedDate(r.status) && r.planned_date !== ""
                ? r.planned_date
                : null,
          },
        ],
  );

/** 版の状態ごとの説明。保存してよいかは API が決める（画面は知らせるだけ） */
const Notice = ({ view }: { view: AssessmentView }) => {
  const a = view.assessment;
  if (a === null) return <p>まだ入力がありません</p>;
  if (a.status === "pending")
    return (
      <p>承認待ちの版は保存できません（承認か差し戻しのあとに入力できます）</p>
    );
  if (a.status === "approved")
    return <p>保存すると新しい版（版 {a.version + 1}）の下書きになります</p>;
  if (a.status === "rejected")
    return <p>差し戻された版です。保存すると下書きに戻ります</p>;
  return null;
};

/** 対策状況の入力。項目ごとに状態・根拠・対応予定日を入れ、下書きとして保存する */
export const AssessmentForm = ({
  token,
  ecuId,
}: {
  token: string;
  ecuId: number;
}) => {
  const [view, setView] = useState<AssessmentView | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  // 保存の結果は「どのユーザー・ECU の保存か」と組で持ち、今の組と同じときだけ出す
  const target = `${token}:${ecuId}`;
  const [savedFor, setSavedFor] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{
    target: string;
    error: unknown;
  } | null>(null);
  // 保存の応答が届いたときの組。送ったときと違えば（途中でユーザー ID を変えた）、応答を捨てる
  const currentTarget = useRef(target);
  useEffect(() => {
    currentTarget.current = target;
  }, [target]);

  useEffect(() => {
    let active = true; // ECU・ログインした人が変わったとき、前の応答で上書きしない
    getAssessment(token, ecuId).then(
      (result) => {
        if (!active) return;
        setView(result);
        setRows(rowsOf(result));
        setLoadError(null);
      },
      (e: unknown) => {
        if (!active) return;
        setView(null);
        setLoadError(e);
      },
    );
    return () => {
      active = false;
    };
  }, [token, ecuId]);

  if (loadError !== null) return <ErrorMessage error={loadError} />;
  if (view === null) return <p>読み込み中…</p>;

  const update = (itemId: number, change: Partial<Row>) => {
    setSavedFor(null);
    setRows((current) =>
      current.map((r) => (r.item_id === itemId ? { ...r, ...change } : r)),
    );
  };

  const entries = entriesOf(rows);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const sentFor = target;
    setSaving(true);
    setSaveError(null);
    setSavedFor(null);
    try {
      const result = await saveDraft(token, ecuId, entries);
      if (currentTarget.current !== sentFor) return;
      setView(result);
      setRows(rowsOf(result));
      setSavedFor(sentFor);
    } catch (e: unknown) {
      if (currentTarget.current !== sentFor) return;
      setSaveError({ target: sentFor, error: e });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit}>
      {view.assessment !== null && (
        <p>{versionLabel(view.assessment.version, view.assessment.status)}</p>
      )}
      <Notice view={view} />
      <table>
        <thead>
          <tr>
            <th>対策項目</th>
            <th>状態</th>
            <th>根拠</th>
            <th>対応予定日</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.item_id}>
              <th scope="row">{r.title}</th>
              <td>
                <select
                  aria-label={`${r.title} の状態`}
                  value={r.status}
                  onChange={(e) =>
                    update(r.item_id, {
                      status: e.target.value as Row["status"],
                    })
                  }
                >
                  <option value="" disabled={r.saved}>
                    （未選択）
                  </option>
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <textarea
                  aria-label={`${r.title} の根拠`}
                  value={r.evidence}
                  maxLength={EVIDENCE_MAX}
                  rows={2}
                  onChange={(e) =>
                    update(r.item_id, { evidence: e.target.value })
                  }
                />
              </td>
              <td>
                <input
                  type="date"
                  aria-label={`${r.title} の対応予定日`}
                  value={needsPlannedDate(r.status) ? r.planned_date : ""}
                  disabled={!needsPlannedDate(r.status)}
                  onChange={(e) =>
                    update(r.item_id, { planned_date: e.target.value })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="submit" disabled={entries.length === 0 || saving}>
        下書きを保存
      </button>
      {savedFor === target && <p role="status">保存しました</p>}
      {saveError !== null && saveError.target === target && (
        <ErrorMessage error={saveError.error} />
      )}
    </form>
  );
};
