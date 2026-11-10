/** 教員画面で使う日時の表示（例：11/7 14:05）。 */
export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
