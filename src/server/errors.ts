import type { ApiErrorCode } from "../domain/course-workflow.ts";

const statusByCode: Record<ApiErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
};

/** 利用者に返してよい理由だけを message に入れる。原文・秘密値・内部例外は入れない。 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: ApiErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = statusByCode[code];
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const invalidInput = (message = "入力内容を確認してください。") => new AppError("INVALID_INPUT", message);
export const unauthenticated = () => new AppError("UNAUTHENTICATED", "ログインしてください。");
export const forbidden = (message = "この操作は許可されていません。") => new AppError("FORBIDDEN", message);
/** 非公開データは「存在しない」と「権限がない」を区別しない。 */
export const notFound = () => new AppError("NOT_FOUND", "見つかりません。");
export const conflict = (message = "状態が変わりました。最新の状態を読み込んでください。") =>
  new AppError("CONFLICT", message);
export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new AppError("TOO_MANY_REQUESTS", message, retryAfterSeconds);

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
