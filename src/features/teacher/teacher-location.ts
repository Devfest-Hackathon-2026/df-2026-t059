/**
 * 教員画面の URL クエリと表示の対応。ページ（サーバー）と画面（ブラウザ）の両方から使う。
 * URL に載せるのはタブと、開いている質問・候補だけ。入力中の内容や確認用のダイアログは載せない。
 */
const teacherViews = ["board", "review", "published", "settings"] as const;

export type TeacherView = (typeof teacherViews)[number];

export type TeacherLocation = {
  view: TeacherView;
  /** 質問対応なら会話、Q&A確認なら共有候補を開いている質問の ID */
  question?: string;
  /** Q&A確認で開いている、見送った候補の質問の ID */
  dismissed?: string;
};

type QueryReader = { get(name: string): string | null };

function isTeacherView(value: string | null): value is TeacherView {
  return teacherViews.some((view) => view === value);
}

/** 知らない値は既定の画面（質問対応）として扱う。開けるかどうかはサーバーで確認する。 */
export function parseTeacherLocation(query: QueryReader): TeacherLocation {
  const raw = query.get("view");
  const view = isTeacherView(raw) ? raw : "board";
  if (view === "published" || view === "settings") return { view };
  const question = query.get("question");
  if (question) return { view, question };
  const dismissed = view === "review" ? query.get("dismissed") : null;
  return dismissed ? { view, dismissed } : { view };
}

/** `?view=review&question=ID` の形（既定の画面は空文字）。 */
export function teacherLocationSearch({ view, question, dismissed }: TeacherLocation): string {
  const query = new URLSearchParams();
  if (view !== "board") query.set("view", view);
  if (question) query.set("question", question);
  if (dismissed) query.set("dismissed", dismissed);
  const search = query.toString();
  return search ? `?${search}` : "";
}

/** ページの searchParams から、ログイン後に戻る先のクエリを作る（知らないパラメータは引き継がない）。 */
export function teacherSearchFromPage(query: Record<string, string | string[] | undefined>): string {
  return teacherLocationSearch(parseTeacherLocation({
    get: (name) => {
      const value = query[name];
      return typeof value === "string" ? value : null;
    },
  }));
}
