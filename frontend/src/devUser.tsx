import { useState } from "react";

// 仮の本人確認（Day 6 でログイン画面と JWT に置き換えて消す）。
// ここで選んだ ID は、ヘッダー X-Dev-User-Id で API に送るだけ。守りは API 側（DEV_AUTH_ENABLED）にある。
// ブラウザのタブを閉じると消える sessionStorage に置く（ほかのタブ・次の起動に残さない）。
const KEY = "dev-user-id";

const load = (): string => {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};

const store = (value: string) => {
  try {
    sessionStorage.setItem(KEY, value);
  } catch {
    // 保存できなくても、このタブの中では使える
  }
};

export const useDevUserId = () => {
  const [userId, setUserId] = useState(load);
  const change = (value: string) => {
    // 数字だけにする（API も数字だけを受け付ける）
    const digits = value.replace(/\D/g, "").slice(0, 18);
    store(digits);
    setUserId(digits);
  };
  return [userId, change] as const;
};

export const DevUserField = ({
  userId,
  onChange,
}: {
  userId: string;
  onChange: (value: string) => void;
}) => (
  <label className="dev-user">
    仮のユーザー ID（Day 6 でログインに置き換え）：
    <input
      inputMode="numeric"
      value={userId}
      onChange={(e) => onChange(e.target.value)}
    />
  </label>
);
