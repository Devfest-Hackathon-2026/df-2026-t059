import type { ApiErrorCode } from "../workflow-types.ts";

/** API のエラーコードに、通信できなかった場合を加えたもの。 */
export type TeacherErrorCode = ApiErrorCode | "NETWORK_ERROR";

export class TeacherApiError extends Error {
  readonly code: TeacherErrorCode;

  constructor(code: TeacherErrorCode, message: string) {
    super(message);
    this.name = "TeacherApiError";
    this.code = code;
  }
}

/** 画面に出す説明。想定外の例外の内容は見せない。 */
export function messageOf(error: unknown) {
  return error instanceof TeacherApiError ? error.message : "処理に失敗しました。もう一度お試しください。";
}

/** 別の先生の操作などで、手元の情報が古くなったことを示すエラーか。 */
export function isStale(error: unknown) {
  return error instanceof TeacherApiError && (error.code === "CONFLICT" || error.code === "NOT_FOUND");
}
