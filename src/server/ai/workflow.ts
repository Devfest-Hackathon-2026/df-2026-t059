import "server-only";
import type { AiAnswer } from "../../domain/ai-answer.ts";
import type {
  AiWorkflow,
  CourseCategory,
  MessageDTO,
  PublishedKnowledgeDTO,
} from "../../domain/course-workflow.ts";
import {
  AI_LIMITS,
  AiWorkflowError,
  type AiWorkflowErrorCode,
  answerQuestionWithVertex,
  classifyQuestionWithVertex,
  getVertexAiConfig,
  parseAndFilterClassification,
  parseAndValidateAiAnswer,
  parseAndValidateAiSummary,
  stripPersonalInfo,
  summarizeConversationWithVertex,
  validateKnowledgeInput,
  validateMessagesInput,
  validateQuestionTextInput,
} from "./gemini.ts";

export {
  AI_LIMITS,
  AiWorkflowError,
  type AiWorkflowErrorCode,
  parseAndFilterClassification,
  parseAndValidateAiAnswer,
  parseAndValidateAiSummary,
};

const ESCALATION_KEYWORDS = [
  "テスト範囲",
  "試験範囲",
  "成績",
  "配点",
  "採点",
  "単位",
  "欠席",
  "条件が足りない",
  "問題文が途中で切れて",
  "先生に確認",
];

const UNCERTAIN_ASSISTANT_PATTERNS = [
  "先生に引き継ぎます",
  "教員に引き継ぎます",
  "AIだけでは判断できないため",
  "根拠が不足しているため回答できません",
];

const CORRECTION_PATTERNS = ["訂正します", "先ほどの回答に誤りがありました", "間違いでした"];

function findMatchingKnowledgeIds(
  conversationText: string,
  knowledge: readonly PublishedKnowledgeDTO[],
): string[] {
  const keywords = ["判別式", "重解", "平方完成", "頂点", "軸", "放物線", "最大", "最小", "解の公式"];
  const matched: string[] = [];

  for (const item of knowledge) {
    const itemText = `${item.question} ${item.answer}`;
    const hasSharedKeyword = keywords.some(
      (kw) => conversationText.includes(kw) && itemText.includes(kw),
    );
    if (hasSharedKeyword && !matched.includes(item.id)) {
      matched.push(item.id);
    }
  }
  return matched.slice(0, 3);
}

function summarizeTitleFromStudentText(text: string): string {
  const cleaned = stripPersonalInfo(text)
    .replace(/^(こんにちは|すみません|質問です|先生)[、。！!\s]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = cleaned.split(/(?<=[？?。])/)[0]?.trim() || cleaned;
  if (firstSentence.length <= 50) {
    return firstSentence.endsWith("？") || firstSentence.endsWith("?")
      ? firstSentence
      : `${firstSentence.replace(/[。.]$/, "")}とは？`;
  }
  return `${firstSentence.slice(0, 48)}…？`;
}

export const fixtureAiWorkflow: AiWorkflow = {
  async classifyQuestion(input: {
    text: string;
    categories: CourseCategory[];
  }): Promise<{ categoryIds: string[] }> {
    const text = validateQuestionTextInput(input.text);
    if (input.categories.length === 0) {
      return { categoryIds: [] };
    }

    const candidates: string[] = [];
    if (text.includes("平方完成") || text.includes("a(x-p)")) {
      candidates.push("completing-square");
    }
    if (
      text.includes("頂点") ||
      text.includes("軸") ||
      text.includes("最小") ||
      text.includes("最大")
    ) {
      candidates.push("vertex");
    }
    if (
      text.includes("判別式") ||
      text.includes("重解") ||
      text.includes("実数解") ||
      text.includes("x軸") ||
      text.includes("交点") ||
      text.includes("接する")
    ) {
      candidates.push("discriminant");
    }

    for (const category of input.categories) {
      if (
        category.id !== "other" &&
        (text.includes(category.name) || text.includes(category.id))
      ) {
        candidates.push(category.id);
      }
    }

    return parseAndFilterClassification(
      JSON.stringify({ categoryIds: candidates }),
      input.categories,
    );
  },

  async answerQuestion(input: {
    messages: MessageDTO[];
    knowledge: PublishedKnowledgeDTO[];
  }): Promise<AiAnswer> {
    const sortedMessages = validateMessagesInput(input.messages);
    const knowledge = validateKnowledgeInput(input.knowledge);
    const candidateKnowledgeIds = new Set(knowledge.map((k) => k.id));

    const studentMessages = sortedMessages.filter((m) => m.role === "student");
    const latestMessage =
      studentMessages[studentMessages.length - 1] ??
      sortedMessages[sortedMessages.length - 1];
    const previousMessages = sortedMessages.slice(0, -1);
    const fullConversationText = sortedMessages.map((m) => m.text).join("\n");

    const shouldEscalate = ESCALATION_KEYWORDS.some((kw) =>
      latestMessage.text.includes(kw),
    );
    if (shouldEscalate) {
      return parseAndValidateAiAnswer(
        JSON.stringify({
          text: "この質問は講義固有の条件や先生の判断が必要な内容を含むため、担当の先生に引き継ぎます。",
          referencedKnowledgeIds: [],
          escalate: true,
          reason:
            "講義固有の評価基準・出題範囲または未確定の条件を含み、公開済みQ&Aだけでは一意に判断できないため。",
        }),
        candidateKnowledgeIds,
      );
    }

    const referencedKnowledgeIds = findMatchingKnowledgeIds(
      fullConversationText,
      knowledge,
    );

    let answerText: string;
    const hasPreviousContext = previousMessages.length > 0;

    if (
      fullConversationText.includes("判別式") &&
      (latestMessage.text.includes("0") ||
        latestMessage.text.includes("グラフ") ||
        latestMessage.text.includes("接"))
    ) {
      answerText = hasPreviousContext
        ? "前のやり取りで確認した判別式 $D = b^2 - 4ac$ が $0$ のとき、二次方程式は重解を持ちます。そのため、二次関数のグラフ（放物線）はx軸と1点だけで接し、その接点が放物線の頂点になります。"
        : "判別式 $D = b^2 - 4ac$ が $0$ のとき、二次方程式は重解を持ち、放物線はx軸に1点で接します。その接点が頂点です。";
    } else if (fullConversationText.includes("判別式")) {
      answerText =
        "二次関数 $y = ax^2 + bx + c$ のグラフとx軸の共有点の個数は、判別式 $D = b^2 - 4ac$ の符号で調べられます。\n\n- $D > 0$：2個\n- $D = 0$：1個（接する）\n- $D < 0$：0個";
    } else if (
      fullConversationText.includes("平方完成") ||
      fullConversationText.includes("頂点")
    ) {
      answerText = hasPreviousContext
        ? "先ほどの式の続きとして、xの係数の半分を2乗した値を足して引くことで $(x - p)^2$ の形を作れます。整理した $y = a(x - p)^2 + q$ から、頂点の座標は $(p, q)$、軸は直線 $x = p$ と分かります。"
        : "二次関数 $y = ax^2 + bx + c$ を平方完成して $y = a(x - p)^2 + q$ の形に変形すると、頂点の座標は $(p, q)$、軸の方程式は $x = p$ と求められます。";
    } else {
      answerText = hasPreviousContext
        ? `これまでの会話内容を踏まえると、「${stripPersonalInfo(latestMessage.text)}」については定義と基本公式を順番に当てはめることで解決できます。`
        : `「${stripPersonalInfo(latestMessage.text)}」について回答します。二次関数の基本形とグラフの性質を確認して式を整理してみましょう。`;
    }

    return parseAndValidateAiAnswer(
      JSON.stringify({
        text: answerText,
        referencedKnowledgeIds,
        escalate: false,
        reason: "",
      }),
      candidateKnowledgeIds,
    );
  },

  async summarizeConversation(input: {
    messages: MessageDTO[];
  }): Promise<{ question: string; answer: string }> {
    const sortedMessages = validateMessagesInput(input.messages);
    const studentMessages = sortedMessages.filter((m) => m.role === "student");

    const validResponses = sortedMessages.filter((msg, idx) => {
      if (msg.role !== "assistant" && msg.role !== "teacher") {
        return false;
      }
      if (UNCERTAIN_ASSISTANT_PATTERNS.some((pat) => msg.text.includes(pat))) {
        return false;
      }
      const isCorrectedLater = sortedMessages
        .slice(idx + 1)
        .some(
          (later) =>
            (later.role === "assistant" || later.role === "teacher") &&
            CORRECTION_PATTERNS.some((pat) => later.text.includes(pat)),
        );
      return !isCorrectedLater;
    });

    if (studentMessages.length === 0 || validResponses.length === 0) {
      throw new AiWorkflowError(
        "AI_INSUFFICIENT_BASIS",
        "Conversation does not contain enough confirmed content to summarize.",
      );
    }

    const fullText = sortedMessages.map((m) => m.text).join("\n");

    if (
      fullText.includes("判別式") &&
      (fullText.includes("0") || fullText.includes("重解") || fullText.includes("接"))
    ) {
      return parseAndValidateAiSummary(
        JSON.stringify({
          canSummarize: true,
          question: "判別式が0のとき、グラフはどうなる？",
          answer:
            "二次方程式は重解を持ち、放物線はx軸に1点で接します。その接点が頂点です。",
        }),
      );
    }

    if (fullText.includes("平方完成") && fullText.includes("頂点")) {
      return parseAndValidateAiSummary(
        JSON.stringify({
          canSummarize: true,
          question: "平方完成で二次関数の頂点と軸はどう求める？",
          answer:
            "二次関数を $y = a(x - p)^2 + q$ の形に平方完成すると、頂点の座標は $(p, q)$、軸の方程式は直線 $x = p$ になります。",
        }),
      );
    }

    const teacherResponses = validResponses.filter((m) => m.role === "teacher");
    const chosenResponse =
      teacherResponses[teacherResponses.length - 1] ??
      validResponses[validResponses.length - 1];
    const cleanAnswer = stripPersonalInfo(
      chosenResponse.text.replace(/^(訂正します[。、\s]*)/, ""),
    );

    if (!cleanAnswer) {
      throw new AiWorkflowError(
        "AI_INSUFFICIENT_BASIS",
        "Conversation answer is empty after removing personal info.",
      );
    }

    return parseAndValidateAiSummary(
      JSON.stringify({
        canSummarize: true,
        question: summarizeTitleFromStudentText(studentMessages[0].text),
        answer: cleanAnswer,
      }),
    );
  },
};

export const vertexAiWorkflow: AiWorkflow = {
  classifyQuestion: classifyQuestionWithVertex,
  answerQuestion: answerQuestionWithVertex,
  summarizeConversation: summarizeConversationWithVertex,
};

export function getAiWorkflow(): AiWorkflow {
  // 本番ビルドを demo プロジェクトの両 Emulator につないで検証する場合も切り替えを使う。
  const emulatorRun = process.env.GCLOUD_PROJECT?.startsWith("demo-")
    && process.env.FIRESTORE_EMULATOR_HOST
    && process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (process.env.NODE_ENV !== "production" || emulatorRun) {
    const mode = process.env.AI_MODE?.trim() || "fixture";
    if (mode === "fixture") return fixtureAiWorkflow;
    if (mode !== "vertex") {
      throw new AiWorkflowError(
        "AI_CONFIG_ERROR",
        `Unsupported AI_MODE "${mode}". Expected "fixture" or "vertex".`,
      );
    }
  }

  getVertexAiConfig();
  return vertexAiWorkflow;
}
