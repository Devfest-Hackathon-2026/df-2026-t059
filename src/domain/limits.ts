// 初期値（docs/decisions.md「11/7 実装開始と権限の簡略化」）。チームで決まったらここだけ変える。

/** セッション Cookie の有効期間。Firebase の上限は 14 日。 */
export const SESSION_DURATION_MS = 5 * 24 * 60 * 60 * 1000;

/** 質問・追加発言・教員の返信の最大文字数。 */
export const MESSAGE_MAX_LENGTH = 2000;

/** 保存・再利用する AI 回答の最大文字数。 */
export const AI_ANSWER_MAX_LENGTH = 4000;

/** AIに渡す合計発言数と、関連する元会話から保存する最大発言数。 */
export const AI_CONTEXT_MAX_MESSAGES = 20;
export const RELATED_CONTEXT_MAX_MESSAGES = 10;

/** AI 回答の試行期限。過ぎると生徒が再試行できる。 */
export const AI_TURN_TIMEOUT_MS = 90 * 1000;

/** 要約生成の試行期限。過ぎると次の要求で失敗扱いにして置き換える。 */
export const DRAFT_GENERATION_TIMEOUT_MS = 120 * 1000;

/** スレッド一覧のタイトル（省略記号込み）。 */
export const THREAD_TITLE_MAX_LENGTH = 60;

/** AI に渡す公開Q&Aの最大件数・初回分類の最大カテゴリ数。 */
export const KNOWLEDGE_FOR_ANSWER_LIMIT = 30;
export const MAX_QUESTION_CATEGORIES = 2;

/** 候補・公開Q&Aの長さ。 */
export const DRAFT_QUESTION_MAX_LENGTH = 200;
export const DRAFT_ANSWER_MAX_LENGTH = 4000;

export const COURSE_NAME_MAX_LENGTH = 80;
export const CATEGORY_NAME_MAX_LENGTH = 40;

/** ID トークンを Cookie に交換できる、ログインからの経過時間。 */
export const RECENT_SIGN_IN_MS = 5 * 60 * 1000;

/** 参加コードの有効期間と、アカウントごとの照合失敗の制限。 */
export const INVITE_DURATION_MS = 30 * 60 * 1000;
export const INVITE_MAX_FAILURES = 5;
export const INVITE_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
