import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  ApiError,
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

/** 保存していない入力（SC3-38）。ログインの期限が切れたときに上の部品が預かり、同じ人が戻ったら返す */
export type DraftRow = Pick<
  Row,
  "item_id" | "status" | "evidence" | "planned_date"
>;

/** 上の部品に預ける入力：自分が変えた行だけと、そのときの版（SC3-38 のレビュー1回目。
 * 触っていない行まで戻すと、ほかの人が先に保存した値を古い値で上書きするため） */
export type KeptInput = {
  base: AssessmentView["assessment"];
  rows: DraftRow[];
};

/** 預かったときと今で、同じ版か（番号・版の番号・状態がすべて同じ） */
const sameBase = (a: KeptInput["base"], b: KeptInput["base"]) =>
  a === null || b === null
    ? a === b
    : a.id === b.id && a.version === b.version && a.status === b.status;

const toDraftRow = (r: Row): DraftRow => ({
  item_id: r.item_id,
  status: r.status,
  evidence: r.evidence,
  planned_date: r.planned_date,
});

/** サーバーの行に、預かった入力を重ねる。サーバーにない項目の入力は捨てる。
 * 預かった状態が（未選択）で、サーバーに保存済みの状態があるときは、サーバーの状態を使う
 * （保存済みの行は（未選択）に戻せない画面の決まりのため） */
const restoreInto = (rows: Row[], kept: DraftRow[]): Row[] =>
  rows.map((r) => {
    const k = kept.find((d) => d.item_id === r.item_id);
    if (k === undefined) return r;
    return {
      ...r,
      status: k.status === "" && r.saved ? r.status : k.status,
      evidence: k.evidence,
      planned_date: k.planned_date,
    };
  });

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
  restore,
  onRestored,
  onDraftChange,
}: {
  token: string;
  ecuId: number;
  /** 戻す入力（ログインし直す前の同じ人・同じ ECU の入力）。最初の読み込みのときだけ使う */
  restore?: KeptInput;
  /** 戻す入力を使い終えたら呼ぶ（戻した・版が変わって戻さなかった・読み込みに失敗した。
   * 上の部品は預かった入力を捨てる。戻すのは1回だけ） */
  onRestored?: () => void;
  /** 保存していない入力が変わるたびに呼ぶ。入力がない・保存したら null */
  onDraftChange?: (input: KeptInput | null) => void;
}) => {
  const [view, setView] = useState<AssessmentView | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  // 自分が変えた行の項目の番号（入力した行と、戻した行）。保存していない入力があるかもこれで決める
  const [changed, setChanged] = useState<ReadonlySet<number>>(new Set());
  const [restored, setRestored] = useState(false);
  // ログインし直す間に版が変わったので、預かった入力を戻さなかった
  const [skipped, setSkipped] = useState(false);
  // 最初の読み込みのときの値だけを使う（読み込みの途中で props が変わっても読み直さない）
  const restoreAtMount = useRef(restore);
  const onRestoredRef = useRef(onRestored);
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => {
    onRestoredRef.current = onRestored;
    onDraftChangeRef.current = onDraftChange;
  }, [onRestored, onDraftChange]);
  useEffect(() => {
    onDraftChangeRef.current?.(
      view === null || changed.size === 0
        ? null
        : {
            base: view.assessment,
            rows: rows.filter((r) => changed.has(r.item_id)).map(toDraftRow),
          },
    );
  }, [view, changed, rows]);
  // 部品が消えたら（ほかのページへ移った・人が替わった）、預かる入力もなくす
  useEffect(() => () => onDraftChangeRef.current?.(null), []);
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
    /** 戻す入力を1回だけ取り出し、上の部品に捨ててもらう。入力がなければ undefined */
    const takeKept = () => {
      const kept = restoreAtMount.current;
      restoreAtMount.current = undefined;
      if (kept === undefined) return undefined;
      // 行が0件でも、使い終えたことは知らせる（上の部品に残らないように。レビュー2回目）
      onRestoredRef.current?.();
      return kept.rows.length === 0 ? undefined : kept;
    };
    getAssessment(token, ecuId).then(
      (result) => {
        if (!active) return;
        setView(result);
        const kept = takeKept();
        if (kept !== undefined && sameBase(kept.base, result.assessment)) {
          setRows(restoreInto(rowsOf(result), kept.rows));
          setChanged(new Set(kept.rows.map((k) => k.item_id)));
          setRestored(true);
        } else {
          // 版が変わっていたら戻さない（古い版の入力を新しい版に書かないため）
          if (kept !== undefined) setSkipped(true);
          setRows(rowsOf(result));
        }
        setLoadError(null);
      },
      (e: unknown) => {
        if (!active) return;
        // 読み込みに失敗しても、預かった入力は捨てる（あとで開いたときに古い入力を戻さない）。
        // ただし 401 は読み込みの失敗ではなくログインの終わりなので、捨てない（レビュー2回目）
        if (!(e instanceof ApiError && e.status === 401)) takeKept();
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
    setChanged((current) => new Set(current).add(itemId));
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
      setChanged(new Set());
      setRestored(false);
      setSkipped(false);
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
      {restored && (
        <p>ログインし直す前の入力を戻しました（まだ保存していません）</p>
      )}
      {skipped && (
        <p>ログインし直す間に版が変わったため、前の入力は戻していません</p>
      )}
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
