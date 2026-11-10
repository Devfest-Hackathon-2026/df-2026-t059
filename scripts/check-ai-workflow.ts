import assert from "node:assert/strict";
import type {
  CourseCategory,
  MessageDTO,
  PublishedKnowledgeDTO,
} from "../src/domain/course-workflow.ts";
import {
  AiWorkflowError,
  fixtureAiWorkflow,
  getAiWorkflow,
  parseAndFilterClassification,
  parseAndValidateAiAnswer,
  parseAndValidateAiSummary,
  vertexAiWorkflow,
} from "../src/server/ai/workflow.ts";

const sampleCategories: CourseCategory[] = [
  { id: "completing-square", name: "平方完成", order: 1 },
  { id: "vertex", name: "頂点と軸", order: 2 },
  { id: "discriminant", name: "判別式", order: 3 },
  { id: "other", name: "その他", order: 4 },
];

const sampleKnowledge: PublishedKnowledgeDTO[] = [
  {
    id: "know-discriminant-1",
    question: "二次関数のグラフとx軸の共有点の個数はどう調べる？",
    answer: "判別式 D = b^2 - 4ac の符号で調べます。D > 0 で2個、D = 0 で1個、D < 0 で0個です。",
    categoryId: "discriminant",
    publishedAt: "2026-11-06T09:00:00.000Z",
  },
  {
    id: "know-vertex-1",
    question: "平方完成の基本手順は？",
    answer: "y = ax^2 + bx + c を y = a(x - p)^2 + q に変形すると頂点は (p, q) です。",
    categoryId: "completing-square",
    publishedAt: "2026-11-06T09:10:00.000Z",
  },
];

function checkModeSelection() {
  const originalEnv = process.env;
  const isConfigError = (err: unknown) => err instanceof AiWorkflowError && err.code === "AI_CONFIG_ERROR";
  const demoProject = "demo-gdgoc-japan-hackathon-2026";
  try {
    process.env = { ...originalEnv, NODE_ENV: "test" };
    delete process.env.AI_MODE;
    assert.equal(getAiWorkflow(), fixtureAiWorkflow);
    process.env.AI_MODE = "fixture";
    assert.equal(getAiWorkflow(), fixtureAiWorkflow);
    process.env.AI_MODE = "invalid-mode";
    assert.throws(getAiWorkflow, isConfigError);

    process.env.AI_MODE = "vertex";
    process.env.GOOGLE_CLOUD_PROJECT = demoProject;
    assert.throws(getAiWorkflow, isConfigError);

    // 選択と設定検証だけを確認し、実モデルは呼び出さない。
    process.env = {
      ...process.env,
      NODE_ENV: "production",
      GCLOUD_PROJECT: "config-check-project",
      GOOGLE_CLOUD_PROJECT: "config-check-project",
      VERTEX_AI_LOCATION: "global",
      GEMINI_MODEL: "config-check-model",
    };
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    delete process.env.AI_MODE;
    assert.equal(getAiWorkflow(), vertexAiWorkflow, "公開環境は AI_MODE 未設定でも Vertex");
    process.env.AI_MODE = "fixture";
    assert.equal(getAiWorkflow(), vertexAiWorkflow, "公開環境は古い fixture 設定があっても Vertex");
    delete process.env.GEMINI_MODEL;
    assert.throws(getAiWorkflow, isConfigError, "公開環境の設定不足は設定エラー");

    process.env.GCLOUD_PROJECT = demoProject;
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
    assert.equal(getAiWorkflow(), fixtureAiWorkflow, "本番ビルドでも両 Emulator での検証は fixture");
  } finally {
    process.env = originalEnv;
  }
}

async function runChecks() {
  checkModeSelection();

  // 2. 分類（正常系、候補0件、許可外ID・重複除外、最大2件制限）
  const classified = await fixtureAiWorkflow.classifyQuestion({
    text: "二次関数を平方完成して頂点と判別式を求める方法は？",
    categories: sampleCategories,
  });
  assert.deepEqual(classified.categoryIds, ["completing-square", "vertex"]);

  const emptyCategoryResult = await fixtureAiWorkflow.classifyQuestion({
    text: "平方完成のやり方を教えて",
    categories: [],
  });
  assert.deepEqual(emptyCategoryResult.categoryIds, []);

  const filteredClassification = parseAndFilterClassification(
    JSON.stringify({
      title: "$D=0$ のときのグラフ",
      categoryIds: [
        "unknown-id",
        "discriminant",
        "discriminant",
        "vertex",
        "completing-square",
      ],
    }),
    sampleCategories,
  );
  assert.deepEqual(filteredClassification.categoryIds, ["discriminant", "vertex"]);
  assert.equal(filteredClassification.title, "$D=0$ のときのグラフ");

  const allInvalidClassification = parseAndFilterClassification(
    JSON.stringify({ categoryIds: ["not-allowed-1", "not-allowed-2"] }),
    sampleCategories,
  );
  assert.deepEqual(allInvalidClassification.categoryIds, []);

  // 3. 初回質問と追加質問の回答（文脈引き継ぎ・参照ID・0件候補・先生への引き継ぎ）
  const firstTurnMessages: MessageDTO[] = [
    {
      id: "msg-1",
      role: "student",
      text: "二次関数の判別式で何が分かりますか？",
      sequence: 1,
      createdAt: "2026-11-07T01:00:00.000Z",
    },
  ];
  const firstAnswer = await fixtureAiWorkflow.answerQuestion({
    messages: firstTurnMessages,
    knowledge: sampleKnowledge,
  });
  assert.equal(firstAnswer.escalate, false);
  assert.deepEqual(firstAnswer.referencedKnowledgeIds, ["know-discriminant-1"]);
  assert.ok(firstAnswer.text.includes("判別式"));

  const followUpMessages: MessageDTO[] = [
    ...firstTurnMessages,
    {
      id: "msg-2",
      role: "assistant",
      text: firstAnswer.text,
      sequence: 2,
      createdAt: "2026-11-07T01:00:05.000Z",
      referencedKnowledgeIds: firstAnswer.referencedKnowledgeIds,
    },
    {
      id: "msg-3",
      role: "student",
      text: "それが0のとき、グラフはどうなる？",
      sequence: 3,
      createdAt: "2026-11-07T01:01:00.000Z",
    },
  ];
  const followUpAnswer = await fixtureAiWorkflow.answerQuestion({
    messages: followUpMessages,
    knowledge: sampleKnowledge,
  });
  assert.equal(followUpAnswer.escalate, false);
  assert.ok(followUpAnswer.text.includes("前のやり取りで確認した判別式"));
  assert.ok(followUpAnswer.text.includes("重解"));

  const zeroKnowledgeAnswer = await fixtureAiWorkflow.answerQuestion({
    messages: firstTurnMessages,
    knowledge: [],
  });
  assert.deepEqual(zeroKnowledgeAnswer.referencedKnowledgeIds, []);

  const escalatedAnswer = await fixtureAiWorkflow.answerQuestion({
    messages: [
      {
        id: "msg-esc-1",
        role: "student",
        text: "来週の中間試験のテスト範囲と配点を教えてください",
        sequence: 1,
        createdAt: "2026-11-07T02:00:00.000Z",
      },
    ],
    knowledge: sampleKnowledge,
  });
  assert.equal(escalatedAnswer.escalate, true);
  assert.ok(escalatedAnswer.reason.length > 0);
  assert.deepEqual(escalatedAnswer.referencedKnowledgeIds, []);

  // 4. 要約（question/answerの2項目、個人情報・誤答の除外、根拠不足時のエラー）
  const conversationForSummary: MessageDTO[] = [
    ...followUpMessages,
    {
      id: "msg-4",
      role: "assistant",
      text: followUpAnswer.text,
      sequence: 4,
      createdAt: "2026-11-07T01:01:05.000Z",
      referencedKnowledgeIds: followUpAnswer.referencedKnowledgeIds,
    },
  ];
  const summary = await fixtureAiWorkflow.summarizeConversation({
    messages: conversationForSummary,
  });
  assert.deepEqual(summary, {
    question: "判別式が0のとき、グラフはどうなる？",
    answer: "二次方程式は重解を持ち、放物線はx軸に1点で接します。その接点が頂点です。",
  });

  // 保存できる長さの AI 回答を履歴に含めても、追加質問と要約の入力として使える。
  const longAnswer = { ...conversationForSummary[1], text: "解".repeat(4000) };
  const withLongAnswer = [firstTurnMessages[0], longAnswer, followUpMessages[2]];
  const afterLongAnswer = await fixtureAiWorkflow.answerQuestion({ messages: withLongAnswer, knowledge: [] });
  assert.equal(afterLongAnswer.escalate, false);
  assert.match(afterLongAnswer.text, /重解/);
  const summaryAfterLongAnswer = await fixtureAiWorkflow.summarizeConversation({ messages: withLongAnswer });
  assert.match(summaryAfterLongAnswer.answer, /重解/);

  for (const message of [
    { ...longAnswer, role: "student" as const, text: "問".repeat(2001) },
    { ...longAnswer, role: "teacher" as const, text: "解".repeat(2001) },
    { ...longAnswer, text: "解".repeat(4001) },
  ]) {
    await assert.rejects(
      fixtureAiWorkflow.answerQuestion({ messages: [firstTurnMessages[0], message], knowledge: [] }),
      (err: unknown) => err instanceof AiWorkflowError && err.code === "AI_INVALID_INPUT",
    );
  }

  // 個人情報・訂正前の誤答を含む会話の要約確認
  const correctedConversation: MessageDTO[] = [
    {
      id: "msg-c1",
      role: "student",
      text: "氏名: 山田太郎 student@example.com 二次関数の最大値はどう求めますか？",
      sequence: 1,
      createdAt: "2026-11-07T03:00:00.000Z",
    },
    {
      id: "msg-c2",
      role: "assistant",
      text: "誤った途中回答です。",
      sequence: 2,
      createdAt: "2026-11-07T03:00:05.000Z",
    },
    {
      id: "msg-c3",
      role: "teacher",
      text: "訂正します。定義域の両端と頂点の位置を比べて最大値を求めます。連絡先: teacher@example.com",
      sequence: 3,
      createdAt: "2026-11-07T03:05:00.000Z",
    },
  ];
  const cleanedSummary = await fixtureAiWorkflow.summarizeConversation({
    messages: correctedConversation,
  });
  assert.ok(!cleanedSummary.question.includes("山田太郎"));
  assert.ok(!cleanedSummary.question.includes("student@example.com"));
  assert.ok(!cleanedSummary.answer.includes("誤った途中回答"));
  assert.ok(!cleanedSummary.answer.includes("teacher@example.com"));
  assert.ok(cleanedSummary.answer.includes("定義域の両端"));

  // 根拠不足（未回答または引き継ぎのみ）で要約失敗になることの確認
  await assert.rejects(
    fixtureAiWorkflow.summarizeConversation({
      messages: [
        {
          id: "msg-u1",
          role: "student",
          text: "この問題の解き方が分かりません",
          sequence: 1,
          createdAt: "2026-11-07T04:00:00.000Z",
        },
        {
          id: "msg-u2",
          role: "assistant",
          text: "この質問は担当の先生に引き継ぎます。",
          sequence: 2,
          createdAt: "2026-11-07T04:00:05.000Z",
        },
      ],
    }),
    (err: unknown) =>
      err instanceof AiWorkflowError && err.code === "AI_INSUFFICIENT_BASIS",
  );

  // 5. 異常系（存在しない参照ID、不正JSON、空応答）
  assert.throws(
    () =>
      parseAndValidateAiAnswer(
        JSON.stringify({
          text: "回答です",
          referencedKnowledgeIds: ["non-existent-id"],
          escalate: false,
          reason: "",
        }),
        new Set(["know-discriminant-1"]),
      ),
    (err: unknown) =>
      err instanceof AiWorkflowError && err.code === "AI_INVALID_REFERENCE",
  );

  assert.throws(
    () => parseAndValidateAiAnswer("{ invalid json", new Set()),
    (err: unknown) => err instanceof AiWorkflowError && err.code === "AI_INVALID_OUTPUT",
  );

  assert.throws(
    () => parseAndValidateAiAnswer("   ", new Set()),
    (err: unknown) => err instanceof AiWorkflowError && err.code === "AI_EMPTY_RESPONSE",
  );

  assert.throws(
    () =>
      parseAndValidateAiSummary(
        JSON.stringify({ canSummarize: false, question: "", answer: "" }),
      ),
    (err: unknown) =>
      err instanceof AiWorkflowError && err.code === "AI_INSUFFICIENT_BASIS",
  );

  console.log("PASS: D担当のAIワークフロー（分類・回答・要約・検証・異常系）がすべて想定通り動作した。");
}

runChecks().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
