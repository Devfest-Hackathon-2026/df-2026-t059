// 相談・候補の状態遷移の判定。Firestore に依存しない純粋関数にして、単体テストで確かめる。
// ストア（src/server/firestore/workflow.ts）はトランザクションの中で現在の状態を読み、ここで可否を決める。

import type {
  DraftGenerationReason,
  QuestionStatus,
  StudentThreadActions,
  SummaryStatus,
} from "../../domain/course-workflow.ts";

export type AttemptState = { id: string; expiresAtMs: number };

/** 相談ドキュメントに複製して持つ候補の状態（生徒の画面と一覧で使う）。 */
export type DraftMirror = {
  generationRunning: boolean;
  generationExpiresAtMs: number | null;
  lastGenerationFailed: boolean;
  publication: "none" | "published" | "dismissed";
  versionCount: number;
};

export type ThreadState = {
  status: QuestionStatus;
  resolved: boolean;
  aiAttempt: AttemptState | null;
  draft: DraftMirror | null;
};

export type Decision<T = undefined> = { ok: true; value: T } | { ok: false; reason: string };

const allow = <T>(value: T): Decision<T> => ({ ok: true, value });
const deny = (reason: string): Decision<never> => ({ ok: false, reason });

export function isExpired(expiresAtMs: number | null | undefined, nowMs: number): boolean {
  return expiresAtMs != null && expiresAtMs <= nowMs;
}

/** AI 回答の試行が、pending のまま期限を過ぎたか。 */
export function aiTurnExpired(state: ThreadState, nowMs: number): boolean {
  return state.status === "pending" && !!state.aiAttempt && isExpired(state.aiAttempt.expiresAtMs, nowMs);
}

/**
 * 期限切れの AI 回答を失敗（error）として扱った状態（要約の期限切れと同じ考え方）。
 * 表示（status）・操作可否・ストアの判定はすべてこの状態を使う。期限後に届いた回答は保存しない。
 * 保存済みの発言は残り、生徒は再試行・追記・相談・解決ができる。
 */
export function effectiveThreadState(state: ThreadState, nowMs: number): ThreadState {
  return aiTurnExpired(state, nowMs) ? { ...state, status: "error", aiAttempt: null } : state;
}

/** 有効な（期限内の）要約生成が走っているか。期限切れは走っていない扱いにして置き換えられる。 */
export function generationRunning(draft: DraftMirror | null, nowMs: number): boolean {
  return !!draft?.generationRunning && !isExpired(draft.generationExpiresAtMs, nowMs);
}

/** 実行中のまま期限を過ぎた生成。結果を待たず失敗として扱う（次の要求で置き換え、遅れて届いた結果は保存しない）。 */
export function generationExpired(draft: DraftMirror | null, nowMs: number): boolean {
  return !!draft?.generationRunning && isExpired(draft.generationExpiresAtMs, nowMs);
}

/**
 * 直近の生成が失敗したか（失敗の記録済み、または期限切れ）。
 * 状態表示（summaryStatusOf）・操作可否（canRetrySummary）・再試行の受付（mode=retry）・ストアは、すべてこの判定を使う。
 */
export function lastGenerationFailed(draft: DraftMirror | null, nowMs: number): boolean {
  if (!draft) return false;
  if (draft.generationRunning) return generationExpired(draft, nowMs);
  return draft.lastGenerationFailed;
}

export function summaryStatusOf(draft: DraftMirror | null, nowMs: number): SummaryStatus {
  if (!draft) return "none";
  if (draft.publication === "published") return "published";
  if (draft.publication === "dismissed") return "dismissed";
  if (generationRunning(draft, nowMs)) return "generating";
  if (draft.versionCount > 0) return "ready";
  if (lastGenerationFailed(draft, nowMs)) return "failed";
  return "generating";
}

/**
 * 生徒の追加発言。
 * - 解決済みは不可（原則として新しい相談にする）。
 * - AI 処理中（pending）は不可。
 * - 先生の対応待ち（escalated）は補足として追記できる。状態は escalated のままで AI は呼ばない（11/7 決定）。
 * - それ以外は追記して AI の回答を待つ（pending）。
 */
export function decideStudentMessage(state: ThreadState): Decision<{ nextStatus: QuestionStatus; startAiTurn: boolean }> {
  if (state.resolved) return deny("解決済みの相談には追記できません。新しい質問として送ってください。");
  if (state.status === "pending") return deny("AIが回答を作成中です。");
  if (state.status === "escalated") return allow({ nextStatus: "escalated", startAiTurn: false });
  return allow({ nextStatus: "pending", startAiTurn: true });
}

/** 保存済みの発言で AI の回答をやり直す。error（期限切れを含む）だけ。 */
export function decideAiRetry(state: ThreadState, nowMs: number): Decision {
  const current = effectiveThreadState(state, nowMs);
  if (current.resolved) return deny("解決済みの相談です。");
  if (current.status === "error") return allow(undefined);
  if (current.status === "pending" && !current.aiAttempt) return allow(undefined);
  return deny("再試行できる状態ではありません。");
}

/** 生徒が先生に相談する。 */
export function decideEscalate(state: ThreadState): Decision {
  if (state.resolved) return deny("解決済みの相談です。");
  if (state.status === "pending") return deny("AIが回答を作成中です。");
  if (state.status === "escalated") return deny("すでに先生の回答を待っています。");
  return allow(undefined);
}

/** 担当教員の返信。対応待ちで未解決の相談だけ。2人が同時に返信しても片方だけ保存される。 */
export function decideTeacherReply(state: ThreadState): Decision {
  if (state.resolved) return deny("解決済みの相談です。");
  if (state.status !== "escalated") return deny("対応待ちの相談ではありません。");
  return allow(undefined);
}

/**
 * 生徒の解決操作。resolvedAt を設定し、同じトランザクションで要約生成を1つ予約する。
 * - AI 処理中（pending）と、候補・別案の生成中は不可（11/7 決定）。
 * - 既存の候補・教員編集版があっても残し、新しい別案を1つ作る。
 * - 解決済みへの再送は何もしない（重複した生成を作らない）。
 */
export function decideResolve(state: ThreadState, nowMs: number): Decision<{ alreadyResolved: boolean }> {
  if (state.resolved) return allow({ alreadyResolved: true });
  if (state.status === "pending") return deny("AIが回答を作成中です。");
  if (generationRunning(state.draft, nowMs)) return deny("共有候補を作成中です。完了してから解決してください。");
  return allow({ alreadyResolved: false });
}

export type GenerationRequester = "student" | "teacher";

/**
 * 候補の作成・再生成の要求。
 * - 相談が pending の間は不可。それ以外の状態（対応待ち・回答済み・解決済み）では可（11/7 決定）。
 * - 同じ候補で生成中のものがあれば不可（期限切れは置き換える）。
 * - 生徒は既にある候補の再生成だけを要求できる（新規の候補は解決操作で作る）。
 * - mode=retry は直前の生成が失敗したとき（期限切れを含む）だけ（失敗の再試行と、新しい別案の再生成を区別する）。
 */
export function decideGenerationRequest(
  state: ThreadState,
  requester: GenerationRequester,
  mode: "regenerate" | "retry",
  nowMs: number,
): Decision<{ reason: DraftGenerationReason }> {
  if (state.status === "pending") return deny("AIが回答を作成中です。");
  if (generationRunning(state.draft, nowMs)) return deny("共有候補を作成中です。");
  if (mode === "retry") {
    if (!lastGenerationFailed(state.draft, nowMs)) return deny("再試行できる失敗がありません。");
    return allow({ reason: "retry" });
  }
  if (!state.draft) {
    if (requester === "student") return deny("共有候補がまだありません。");
    return allow({ reason: "teacher_create" });
  }
  return allow({ reason: "regenerate" });
}

/** 生徒の画面に返す操作可否。サーバーの判定と同じ関数から作る。 */
export function studentActions(raw: ThreadState, nowMs: number): StudentThreadActions {
  const state = effectiveThreadState(raw, nowMs);
  const message = decideStudentMessage(state);
  const draft = state.draft;
  return {
    canSendMessage: message.ok,
    canEscalate: decideEscalate(state).ok,
    canResolve: !state.resolved && decideResolve(state, nowMs).ok,
    canRetryAi: decideAiRetry(state, nowMs).ok,
    canRequestRegeneration: !!draft && decideGenerationRequest(state, "student", "regenerate", nowMs).ok,
    canRetrySummary: !!draft && decideGenerationRequest(state, "student", "retry", nowMs).ok,
  };
}

/**
 * 担当教員の画面に返す操作可否。サーバーの判定（decideTeacherReply・decideGenerationRequest）と同じ関数から作り、
 * 期限切れの AI 回答は失敗（error）として扱う（保存上は pending でも候補を作れる）。
 */
export function teacherActions(raw: ThreadState, nowMs: number): { canReply: boolean; canRequestDraft: boolean } {
  const state = effectiveThreadState(raw, nowMs);
  return {
    canReply: decideTeacherReply(state).ok,
    canRequestDraft: decideGenerationRequest(state, "teacher", "regenerate", nowMs).ok,
  };
}

/** 公開。同じ版・同じ内容の再送は既存結果を返し、異なる内容は競合。見送り済みは再開操作が未決のため不可。 */
export function decidePublish(
  publication: DraftMirror["publication"],
  sameAsPublished: boolean,
): Decision<{ alreadyPublished: boolean }> {
  if (publication === "dismissed") return deny("見送った候補です。");
  if (publication === "published") {
    return sameAsPublished ? allow({ alreadyPublished: true }) : deny("すでに別の内容で公開されています。");
  }
  return allow({ alreadyPublished: false });
}

export function decideDismiss(publication: DraftMirror["publication"]): Decision<{ alreadyDismissed: boolean }> {
  if (publication === "published") return deny("公開済みの候補は見送れません。");
  return allow({ alreadyDismissed: publication === "dismissed" });
}

/**
 * 見送った候補を確認待ちに戻す（11/8）。版・本文・カテゴリは残し、AI は呼ばない。
 * - 公開中は不可（取り下げは unpublish）。
 * - 生成中（期限内）は不可。期限切れの生成は失敗として閉じてから戻す。
 * - 確認できる版がなければ不可（戻しても確認待ち＝ready にならないため）。
 * - すでに確認待ち（publication=none）で確認できる版があれば、何もせずそのまま返す（二重の要求）。
 */
export function decideRestore(draft: DraftMirror, nowMs: number): Decision<{ alreadyPending: boolean }> {
  if (draft.publication === "published") return deny("公開中の候補です。");
  if (generationRunning(draft, nowMs)) return deny("共有候補を作成中です。完了してから戻してください。");
  if (draft.versionCount === 0) return deny("確認できる案がないため戻せません。");
  return allow({ alreadyPending: draft.publication === "none" });
}

/**
 * 公開Q&Aの取り下げ（11/8）。
 * - 元候補がない（シードで直接入れた初期データなど）：Q&A の削除だけを行う。
 * - 元候補が「このQ&Aで公開中」のときだけ、候補を確認待ちに戻す。生成中でも取り下げられる（11/8 決定）。
 * - 元候補の現在の公開と一致しない（取り下げ後に再公開された別のQ&Aなど）：何も変えない。
 */
export function decideUnpublish(
  source: { publication: DraftMirror["publication"]; publishedKnowledgeId: string | null } | null,
  knowledgeId: string,
): Decision<{ restoreDraft: boolean }> {
  if (!source) return allow({ restoreDraft: false });
  if (source.publication === "published" && source.publishedKnowledgeId === knowledgeId) {
    return allow({ restoreDraft: true });
  }
  return deny("このQ&Aは元の候補の現在の公開と一致しません。最新の状態を読み込んでください。");
}

export { makeTitle } from "../../domain/question-title.ts";

/** AI の分類結果を講義の現行カテゴリと照合する。重複を除き最大件数まで。有効なものがなければ other。 */
export function normalizeCategoryIds(
  candidates: readonly string[],
  allowed: readonly string[],
  max: number,
  fallback = "other",
): string[] {
  const allowedSet = new Set(allowed);
  const picked: string[] = [];
  for (const id of candidates) {
    if (allowedSet.has(id) && !picked.includes(id)) picked.push(id);
    if (picked.length >= max) break;
  }
  if (picked.length === 0 && allowedSet.has(fallback)) picked.push(fallback);
  return picked;
}

/** 招待コード。紛らわしい文字（0/O/1/I/L）を除いた 8 文字。表示は XXXX-XXXX。 */
export const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function formatInviteCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

/** 入力の空白・ハイフン・大文字小文字の違いを吸収する。形式外なら null。 */
export function normalizeInviteCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== 8) return null;
  for (const ch of compact) if (!INVITE_ALPHABET.includes(ch)) return null;
  return compact;
}
