// API を呼ぶ関数。応答の形は backend/app/schemas.py に合わせて手で書く（API が3つだけのため。
// API が増える Day 7 以降に、OpenAPI からの自動生成を見直す）。
// パスは「/api/…」で、画面と同じオリジンに送る（nginx・開発用のサーバーが API へ中継する）。

export type EntryStatus =
  "done" | "in_progress" | "not_done" | "not_applicable";
export type AssessmentStatus = "draft" | "pending" | "rejected" | "approved";

export type EcuSummary = {
  id: number;
  name: string;
  part_no: string;
  vehicle_model: string;
  latest_version: number | null;
  latest_status: AssessmentStatus | null;
};

/** 保存で送る1項目（schemas.py の EntryIn） */
export type EntryIn = {
  item_id: number;
  status: EntryStatus;
  evidence: string;
  planned_date: string | null;
};

/** 取得で受け取る1項目。まだ入力のない項目は status・evidence が null（schemas.py の EntryOut） */
export type EntryOut = {
  item_id: number;
  code: string;
  title: string;
  status: EntryStatus | null;
  evidence: string | null;
  planned_date: string | null;
};

export type AssessmentView = {
  assessment: { id: number; version: number; status: AssessmentStatus } | null;
  entries: EntryOut[];
};

export type ReviewStatus = "unreviewed" | "confirmed" | "change_requested";

/** 一括確認マトリクス（schemas.py の MatrixView）。cells は items と同じ並び順。
 *  承認済みの版がない ECU は version・review_status・各セルの status が null */
export type MatrixView = {
  items: { id: number; code: string; title: string }[];
  rows: {
    ecu_id: number;
    supplier_id: number;
    supplier_name: string;
    ecu_name: string;
    part_no: string;
    vehicle_model: string;
    version: number | null;
    review_status: ReviewStatus | null;
    cells: { item_id: number; status: EntryStatus | null }[];
  }[];
};

/** API の失敗。status は HTTP の状態コード、details は 422 の項目ごとの msg */
export class ApiError extends Error {
  readonly status: number;
  readonly details: string[];

  constructor(status: number, details: string[]) {
    super(`API の呼び出しに失敗しました（${status}）`);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

/** API の理由（detail）を画面に並べる状態コード。保存が重なった 409 と承認待ちの 409 のように、
 *  同じ状態コードでも理由が違うため。401・403・404 は画面の決まった文言だけにする */
const SHOW_DETAILS = new Set([409, 422]);

/** 応答の理由を取り出す。{"detail": "文章"} はその文章、{"detail": [{"msg": …}, …]} は msg だけ。形が違えば空 */
const detailsOf = (body: unknown): string[] => {
  if (typeof body !== "object" || body === null || !("detail" in body))
    return [];
  const { detail } = body;
  if (typeof detail === "string") return [detail];
  if (!Array.isArray(detail)) return [];
  return detail.flatMap((d: unknown) =>
    typeof d === "object" &&
    d !== null &&
    "msg" in d &&
    typeof d.msg === "string"
      ? [d.msg]
      : [],
  );
};

/** ログインの API 以外が 401 を返したときの処理（App がトークンを捨てて /login に移す） */
let onUnauthorized: ((sentToken: string) => void) | null = null;

/** 401 の処理を登録する。処理には、401 になった要求で送ったトークンを渡す
 *  （ログインし直したあとに届いた、古いトークンの要求の 401 を見分けるため） */
export const setUnauthorizedHandler = (
  handler: ((sentToken: string) => void) | null,
) => {
  onUnauthorized = handler;
};

/** 応答を読む。失敗なら ApiError。JSON でない本文でも落ちない */
const readResponse = async <T>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      SHOW_DETAILS.has(response.status) ? detailsOf(body) : [],
    );
  return body as T;
};

/** ログインした人として API を呼ぶ。トークンは Authorization: Bearer で送る */
const request = async <T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  // 期限切れ・無効になった利用者など。トークンを捨てて、ログインし直してもらう
  if (response.status === 401) onUnauthorized?.(token);
  return readResponse<T>(response);
};

/** ログイン。成功ならトークンを返す。失敗の 401 は「ログインし直し」の処理を呼ばない
 *  （ログイン画面のまま、違うことだけを伝える） */
/** ログインした人。メモリーだけに置く（App） */
export type Session = { token: string; email: string; role: string };

/** メーカーの役割。ログインのあとはマトリクスへ（自社 ECU 一覧はサプライヤ用で、メーカーには 403） */
export const OEM_ROLES = new Set(["sys_admin", "reviewer"]);

export const homeOf = (role: string) => (OEM_ROLES.has(role) ? "/matrix" : "/");

export const login = async (
  email: string,
  password: string,
): Promise<Session> => {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await readResponse<{ access_token: string; role: string }>(
    response,
  );
  return { token: body.access_token, email, role: body.role };
};

export const listEcus = (token: string) =>
  request<EcuSummary[]>(token, "/api/ecus");

export const getMatrix = (token: string) =>
  request<MatrixView>(token, "/api/matrix");

export const getAssessment = (token: string, ecuId: number) =>
  request<AssessmentView>(token, `/api/ecus/${ecuId}/assessment`);

export const saveDraft = (token: string, ecuId: number, entries: EntryIn[]) =>
  request<AssessmentView>(token, `/api/ecus/${ecuId}/draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });

/** 失敗をオーナーに見せる文言。画面で隠すのではなく、API の判断をそのまま伝える */
export const messageOf = (error: unknown): string => {
  if (!(error instanceof ApiError))
    return "通信に失敗しました。API が動いているか確かめてください";
  switch (error.status) {
    case 401:
      return "ログインしてください";
    case 403:
      return "この操作の権限がありません";
    case 404:
      return "見つかりません";
    case 409:
      // 理由（承認待ち・保存の重なりなど）は、API の detail を ErrorMessage が下に並べる
      return "保存できませんでした";
    case 422:
      return "入力を確かめてください";
    default:
      return `API の呼び出しに失敗しました（${error.status}）`;
  }
};

export const STATUS_LABELS: Record<EntryStatus, string> = {
  done: "対応済み",
  in_progress: "対応中",
  not_done: "未対応",
  not_applicable: "対象外",
};

export const ASSESSMENT_LABELS: Record<AssessmentStatus, string> = {
  draft: "下書き",
  pending: "承認待ち",
  rejected: "差し戻し",
  approved: "承認済み",
};

export const REVIEW_LABELS: Record<ReviewStatus, string> = {
  unreviewed: "未確認",
  confirmed: "確認完了",
  change_requested: "修正依頼中",
};

/** 「版 2：承認待ち」の形 */
export const versionLabel = (version: number, status: AssessmentStatus) =>
  `版 ${version}：${ASSESSMENT_LABELS[status] ?? status}`;
