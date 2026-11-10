import { parseStudentLocation, studentLocationSearch } from "../student/student-location.ts";
import { parseTeacherLocation, teacherLocationSearch } from "../teacher/teacher-location.ts";

// ログイン後の移動先を、同じサイト内のパスだけに絞る（外部サイトへの転送を防ぐ）。
// 先頭の文字だけを見ると、ブラウザの URL 解析で無視されるタブ・改行などを挟んだ
// "/\t/outside.example" が "//outside.example"（別サイト）として解釈されてしまう。
// また "/a/..//outside.example" のように、正規化（.. の解決）の後で "//" から始まる形になる入力もある。
// そのため、入力と正規化後の返り値の両方に同じ検証をかける。

const PLACEHOLDER_ORIGIN = "https://same-origin.invalid";

// C0 制御文字（タブ・改行を含む）と DEL。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒否するための正規表現
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** 同じオリジンの絶対パス（"/" 始まり、"//" 始まりでない、制御文字・バックスラッシュなし）として解釈できるなら正規化した形を返す。 */
function normalizeSameOriginPath(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || CONTROL_CHARACTERS.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function safeNextPath(next: string | undefined | null, fallback = "/"): string {
  if (typeof next !== "string") return fallback;
  const normalized = normalizeSameOriginPath(next);
  if (normalized === null) return fallback;
  // 正規化後の返り値も、単独で使われたときに同じオリジンへ解決されることを確かめる（"//outside.example" などを拒否）。
  // 正規化は冪等なので、安全な値は同じ文字列のまま返る。
  return normalizeSameOriginPath(normalized) === normalized ? normalized : fallback;
}

export function isCourseId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && value !== "." && value !== ".."
    && !value.includes("/") && !value.includes("\\") && !CONTROL_CHARACTERS.test(value)
    && !/^__.*__$/.test(value);
}

function decodeCourseId(segment: string): string | null {
  try {
    const id = decodeURIComponent(segment);
    return isCourseId(id) ? id : null;
  } catch {
    return null;
  }
}

/** ログイン後に戻るページを許可リストで絞る。認可は移動先で確認する。 */
export function courseReturnPath(next: string | undefined | null): string {
  const url = new URL(safeNextPath(next), PLACEHOLDER_ORIGIN);
  if (url.pathname === "/courses/new") return "/courses/new";
  const match = /^\/([ct])\/([^/]+)$/.exec(url.pathname);
  if (!match) return "/";
  const courseId = decodeCourseId(match[2]);
  if (!courseId) return "/";
  const search = match[1] === "c"
    ? studentLocationSearch(parseStudentLocation(url.searchParams))
    : teacherLocationSearch(parseTeacherLocation(url.searchParams));
  return `/${match[1]}/${encodeURIComponent(courseId)}${search}`;
}

export function loginPath(currentPath: string | undefined | null): string {
  return `/login?next=${encodeURIComponent(courseReturnPath(currentPath))}`;
}

export function courseJoinPath(courseId: string): string {
  return `/join/${encodeURIComponent(courseId)}`;
}

/** 貼り付けた招待URLから、このサイトの招待ページだけを開く。 */
export function invitePath(input: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim(), origin);
  } catch {
    return null;
  }
  const match = /^\/join\/([^/]+)$/.exec(url.pathname);
  if (url.origin !== origin || !match) return null;
  const courseId = decodeCourseId(match[1]);
  return courseId ? courseJoinPath(courseId) : null;
}

