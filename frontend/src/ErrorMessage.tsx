import { ApiError, messageOf } from "./api";

/** 失敗の文言。422 なら、API が返した項目ごとの msg も並べる */
export const ErrorMessage = ({ error }: { error: unknown }) => {
  const details = error instanceof ApiError ? error.details : [];
  if (details.length === 0) {
    return (
      <p role="alert" className="error">
        {messageOf(error)}
      </p>
    );
  }
  return (
    <div role="alert" className="error">
      <p>{messageOf(error)}</p>
      <ul>
        {details.map((msg, i) => (
          <li key={i}>{msg}</li>
        ))}
      </ul>
    </div>
  );
};
