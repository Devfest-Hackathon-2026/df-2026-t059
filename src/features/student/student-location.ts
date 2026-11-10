/**
 * 生徒画面の URL クエリと表示の対応。ページ（サーバー）と画面（ブラウザ）の両方から使う。
 * URL に載せるのは「どの画面を見ているか」だけ。入力途中の文章や検索条件は載せない。
 */
export type StudentLocation =
  | { tab: "chat"; sourceQuestionId?: string }
  | { tab: "history" }
  | { tab: "shared" }
  | { tab: "thread"; id: string };

type QueryReader = { get(name: string): string | null };

/** 知らない値は既定の画面（新しい質問）として扱う。URL は誰でも書き換えられるため、質問を読めるかはサーバーで確認する。 */
export function parseStudentLocation(query: QueryReader): StudentLocation {
  const question = query.get("question");
  if (question) return { tab: "thread", id: question };
  const view = query.get("view");
  if (view === "history" || view === "shared") return { tab: view };
  const relatedTo = query.get("relatedTo");
  return relatedTo ? { tab: "chat", sourceQuestionId: relatedTo } : { tab: "chat" };
}

/** `?view=history` の形（既定の画面は空文字）。 */
export function studentLocationSearch(location: StudentLocation): string {
  const query = new URLSearchParams();
  if (location.tab === "thread") query.set("question", location.id);
  else if (location.tab !== "chat") query.set("view", location.tab);
  else if (location.sourceQuestionId) query.set("relatedTo", location.sourceQuestionId);
  const search = query.toString();
  return search ? `?${search}` : "";
}

/** ページの searchParams から、ログイン後に戻る先のクエリを作る（知らないパラメータは引き継がない）。 */
export function studentSearchFromPage(query: Record<string, string | string[] | undefined>): string {
  return studentLocationSearch(parseStudentLocation({
    get: (name) => {
      const value = query[name];
      return typeof value === "string" ? value : null;
    },
  }));
}
