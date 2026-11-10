import "server-only";
import type { AiWorkflow } from "../../domain/course-workflow.ts";
import { getAiWorkflow } from "../ai/workflow.ts";
import type { CourseActor } from "../auth/access.ts";
import { type AiTurnTicket, type DraftGenerationTicket, workflowStore } from "../firestore/workflow.ts";

// A/B のサーバー処理から使う、AI 呼び出しの手順をまとめた共通関数。
// AI（D担当の getAiWorkflow()）はトランザクションの外で1操作につき1回ずつ呼ぶ。自動の再試行ループ・ポーリング中の実行はしない。
// 失敗しても保存済みの発言・解決日時・既存の版は残り、生徒・教員の明示操作で再試行できる。
// 失敗の記録（Firestore への書き込み）自体ができなかったときは、成功扱いにせず例外をそのまま返す（Route Handler は 500）。

export type AiStepResult = { applied: boolean; ok: boolean };

/** AI 実装の取得。既定は D の getAiWorkflow()。検証では固定の実装を返す関数に差し替える。 */
export type AiWorkflowLoader = () => AiWorkflow;

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/**
 * 1回分の AI 回答：初回だけ分類 → カテゴリ確定（C が講義のカテゴリと照合）→ 公開Q&Aを取得 → 回答 → 保存。
 * 古い試行（連打・再試行で置き換え済み）や期限切れの結果は保存されない。
 */
export async function runAiTurn(ticket: AiTurnTicket, ai: AiWorkflow): Promise<AiStepResult> {
  try {
    const context = await workflowStore.getAiTurnContext(ticket);
    let categoryIds = context.categoryIds;
    const classify = ticket.firstTurn || categoryIds.length === 0;
    if (classify || context.needsTitle) {
      try {
        const classified = await ai.classifyQuestion({ text: context.firstMessageText, categories: context.categories });
        if (classify || classified.title) {
          categoryIds = await workflowStore.setAiCategories(ticket, classify ? classified.categoryIds : categoryIds, classified.title);
        }
      } catch (error) {
        if (classify) throw error;
        console.warn("[ai] title update failed", errorName(error));
      }
    }
    const knowledge = await workflowStore.listKnowledgeForAnswer(ticket.courseId, categoryIds);
    const answer = await ai.answerQuestion({ messages: context.messages, knowledge });
    const allowed = new Set(knowledge.map((item) => item.id));
    if (answer.referencedKnowledgeIds.some((id) => !allowed.has(id))) {
      return { ...(await workflowStore.failAiTurn(ticket, "invalid_reference")), ok: false };
    }
    return { ...(await workflowStore.finishAiTurn(ticket, answer)), ok: true };
  } catch (error) {
    console.error("[ai] answer failed", errorName(error));
    // 失敗の記録ができなければ例外のまま返す（成功扱いにしない）。
    return { ...(await workflowStore.failAiTurn(ticket, "ai_failed")), ok: false };
  }
}

/**
 * 要約1回分：確定済みの会話（自信のない AI 回答は除外済み）を D の要約関数に渡し、新しい版として保存する。
 * D が根拠不足などで失敗を返した場合も、通常の生成失敗として記録する。
 */
export async function runDraftGeneration(ticket: DraftGenerationTicket, ai: AiWorkflow): Promise<AiStepResult> {
  try {
    const summary = await ai.summarizeConversation({ messages: ticket.messages });
    return { ...(await workflowStore.finishDraftGeneration(ticket, summary)), ok: true };
  } catch (error) {
    console.error("[ai] summary failed", errorName(error));
    return { ...(await workflowStore.failDraftGeneration(ticket, "summary_failed")), ok: false };
  }
}

/**
 * AI 回答の共通入口。getAiWorkflow() の評価（AI_MODE などの設定）から失敗を捕捉し、
 * 設定エラーは ai_configuration_failed として記録する（保存済みの発言は残り、再試行できる）。
 */
export async function answerWithConfiguredAi(
  ticket: AiTurnTicket,
  loadAi: AiWorkflowLoader = getAiWorkflow,
): Promise<AiStepResult> {
  let ai: AiWorkflow;
  try {
    ai = loadAi();
  } catch (error) {
    console.error("[ai] configuration failed", errorName(error));
    return { ...(await workflowStore.failAiTurn(ticket, "ai_configuration_failed")), ok: false };
  }
  return runAiTurn(ticket, ai);
}

/**
 * 要約の共通入口。getAiWorkflow() の評価から失敗を捕捉し、設定エラーは summary_configuration_failed として記録する
 * （相談・解決日時・既存の候補・教員編集版は残る）。
 */
export async function summarizeWithConfiguredAi(
  ticket: DraftGenerationTicket,
  loadAi: AiWorkflowLoader = getAiWorkflow,
): Promise<AiStepResult> {
  let ai: AiWorkflow;
  try {
    ai = loadAi();
  } catch (error) {
    console.error("[ai] configuration failed", errorName(error));
    return { ...(await workflowStore.failDraftGeneration(ticket, "summary_configuration_failed")), ok: false };
  }
  return runDraftGeneration(ticket, ai);
}

/**
 * 候補の作成・再生成（生徒・教員の共通入口）：予約 → 要約 → 保存。
 * 生徒は既存候補の再生成だけ、教員は未解決の相談からも作成できる（判定はストア）。
 * 戻り値は AiStepResult（applied・ok）だけ。候補の本文・生成チケット・状態は含めない
 * （予約時点の状態は要約の完了後には古いため返さない）。
 * 画面へ返す状態は、呼び出し側が完了後に、生徒なら readThread（生徒用DTO）、教員なら readDraft を取り直して返す。
 */
export async function requestAndGenerateDraft(
  actor: CourseActor,
  courseId: string,
  questionId: string,
  input: { mode?: "regenerate" | "retry" } = {},
  loadAi: AiWorkflowLoader = getAiWorkflow,
): Promise<AiStepResult> {
  const { generation } = await workflowStore.requestDraftGeneration(actor, courseId, questionId, input);
  const { applied, ok } = await summarizeWithConfiguredAi(generation, loadAi);
  return { applied, ok };
}
