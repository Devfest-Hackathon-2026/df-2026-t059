// AI 実行の共通入口（src/server/workflow/ai-steps.ts）の単体テスト。npm run check:rules に含まれる。
// ストアの関数を差し替えて、Firestore なしで「設定エラーの捕捉」「失敗記録ができないときは成功扱いにしない」
// 「AI を1操作で1回だけ呼ぶ」「チケットや候補本文を返さない」を確かめる。
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { AiWorkflow, MessageDTO } from "../src/domain/course-workflow.ts";
import { conflict, isAppError } from "../src/server/errors.ts";
import { workflowStore } from "../src/server/firestore/workflow.ts";
import { requestTeacherDraft } from "../src/features/teacher/server.ts";
import { handle, ok } from "../src/server/http.ts";
import {
  answerWithConfiguredAi,
  requestAndGenerateDraft,
  runDraftGeneration,
  summarizeWithConfiguredAi,
} from "../src/server/workflow/ai-steps.ts";

type Store = typeof workflowStore;
const originals = { ...workflowStore };
afterEach(() => {
  Object.assign(workflowStore, originals);
  delete process.env.AI_MODE;
});

function stub<K extends keyof Store>(name: K, impl: (...args: Parameters<Store[K]>) => ReturnType<Store[K]>) {
  const calls: Parameters<Store[K]>[] = [];
  (workflowStore as Record<string, unknown>)[name] = (...args: Parameters<Store[K]>) => {
    calls.push(args);
    return impl(...args);
  };
  return calls;
}

const messages: MessageDTO[] = [{ id: "000001", role: "student", text: "頂点は？", sequence: 1, createdAt: "2026-11-08T00:00:00.000Z" }];
const generation = { courseId: "math-i", questionId: "q1", generationId: "g1", messages };
const aiTurn = { courseId: "math-i", questionId: "q1", attemptId: "a1", firstTurn: true };

function ai(overrides: Partial<AiWorkflow> = {}): AiWorkflow & { summaryCalls: number } {
  const workflow = {
    summaryCalls: 0,
    classifyQuestion: async () => ({ categoryIds: ["vertex"] }),
    answerQuestion: async () => ({ text: "回答", referencedKnowledgeIds: [], escalate: false, reason: "" }),
    summarizeConversation: async () => {
      workflow.summaryCalls += 1;
      return { question: "頂点の求め方", answer: "平方完成する。" };
    },
    ...overrides,
  };
  return workflow;
}

describe("summarizeWithConfiguredAi：getAiWorkflow() の評価から捕捉する", () => {
  test("AI 設定の取得で例外 → summary_configuration_failed として記録し、AI は呼ばない", async () => {
    const failed = stub("failDraftGeneration", async () => ({ applied: true }));
    const finished = stub("finishDraftGeneration", async () => ({ applied: true }));
    const result = await summarizeWithConfiguredAi(generation, () => {
      throw new Error("Unsupported AI_MODE");
    });
    assert.deepEqual(result, { applied: true, ok: false });
    assert.equal(failed.length, 1);
    assert.equal(failed[0][1], "summary_configuration_failed");
    assert.equal(finished.length, 0);
  });
  test("既定の getAiWorkflow() が設定エラー（AI_MODE が不正）でも捕捉する", async () => {
    process.env.AI_MODE = "not-a-mode";
    const failed = stub("failDraftGeneration", async () => ({ applied: true }));
    const result = await summarizeWithConfiguredAi(generation);
    assert.equal(result.ok, false);
    assert.equal(failed[0][1], "summary_configuration_failed");
  });
  test("失敗の記録自体ができなければ、成功扱いにせず例外を返す", async () => {
    stub("failDraftGeneration", async () => {
      throw new Error("firestore unavailable");
    });
    await assert.rejects(summarizeWithConfiguredAi(generation, () => {
      throw new Error("config");
    }), /firestore unavailable/);
  });
  test("通常の成功：AI を1回だけ呼び、新しい版として保存する", async () => {
    const finished = stub("finishDraftGeneration", async () => ({ applied: true }));
    const workflow = ai();
    assert.deepEqual(await summarizeWithConfiguredAi(generation, () => workflow), { applied: true, ok: true });
    assert.equal(workflow.summaryCalls, 1);
    assert.equal(finished.length, 1);
  });
});

describe("runDraftGeneration：生成失敗・根拠不足・古い試行", () => {
  test("AI が失敗（根拠不足など）→ summary_failed として記録", async () => {
    const failed = stub("failDraftGeneration", async () => ({ applied: true }));
    const result = await runDraftGeneration(generation, ai({
      summarizeConversation: async () => {
        throw new Error("insufficient_evidence");
      },
    }));
    assert.deepEqual(result, { applied: true, ok: false });
    assert.equal(failed[0][1], "summary_failed");
  });
  test("古い試行・期限切れ（ストアが applied=false を返す）は、成功扱いにせず結果をそのまま返す", async () => {
    stub("finishDraftGeneration", async () => ({ applied: false }));
    assert.deepEqual(await runDraftGeneration(generation, ai()), { applied: false, ok: true });
  });
  test("生成結果の保存に失敗し、失敗の記録もできなければ例外", async () => {
    stub("finishDraftGeneration", async () => {
      throw new Error("write failed");
    });
    stub("failDraftGeneration", async () => {
      throw new Error("firestore unavailable");
    });
    await assert.rejects(runDraftGeneration(generation, ai()), /firestore unavailable/);
  });
});

describe("answerWithConfiguredAi", () => {
  test("AI 設定の取得で例外 → ai_configuration_failed として記録", async () => {
    const failed = stub("failAiTurn", async () => ({ applied: true }));
    const result = await answerWithConfiguredAi(aiTurn, () => {
      throw new Error("config");
    });
    assert.deepEqual(result, { applied: true, ok: false });
    assert.equal(failed[0][1], "ai_configuration_failed");
  });
  test("失敗の記録ができなければ例外", async () => {
    stub("failAiTurn", async () => {
      throw new Error("firestore unavailable");
    });
    await assert.rejects(answerWithConfiguredAi(aiTurn, () => {
      throw new Error("config");
    }), /firestore unavailable/);
  });
});

describe("requestAndGenerateDraft：戻り値は AiStepResult（applied・ok）だけ", () => {
  const actor = {
    principal: { uid: "teacher-1", email: "teacher@example.com", name: "先生" },
    courseId: "math-i",
    enrolled: false,
    teacher: true,
  };
  // 予約時点の状態（generating）は要約の完了後には古い。成功・失敗のどちらでも返さない。
  function assertOnlyStepResult(result: object) {
    assert.deepEqual(Object.keys(result).sort(), ["applied", "ok"]);
    assert.equal("summaryStatus" in result, false);
  }
  function reserve() {
    return stub("requestDraftGeneration", async () => ({ generation, summaryStatus: "generating" as const }));
  }

  test("成功：予約 → 要約を1回 → 保存。チケット・会話・候補本文・予約時の状態を返さない", async () => {
    const requested = reserve();
    const finished = stub("finishDraftGeneration", async () => ({ applied: true }));
    const failed = stub("failDraftGeneration", async () => ({ applied: true }));
    const workflow = ai();
    const result = await requestAndGenerateDraft(actor, "math-i", "q1", { mode: "regenerate" }, () => workflow);
    assert.deepEqual(result, { applied: true, ok: true });
    assertOnlyStepResult(result);
    assert.equal(workflow.summaryCalls, 1);
    assert.deepEqual(requested[0].slice(1), ["math-i", "q1", { mode: "regenerate" }]);
    assert.equal(finished.length, 1);
    assert.equal(failed.length, 0);
  });

  test("AI の失敗：summary_failed を記録し、{ applied, ok: false } だけを返す", async () => {
    reserve();
    const failed = stub("failDraftGeneration", async () => ({ applied: true }));
    const finished = stub("finishDraftGeneration", async () => ({ applied: true }));
    const result = await requestAndGenerateDraft(actor, "math-i", "q1", { mode: "retry" }, () => ai({
      summarizeConversation: async () => {
        throw new Error("model error");
      },
    }));
    assert.deepEqual(result, { applied: true, ok: false });
    assertOnlyStepResult(result);
    assert.equal(failed[0][1], "summary_failed");
    assert.equal(finished.length, 0);
  });

  test("AI 設定の取得で失敗：summary_configuration_failed を記録し、{ applied, ok: false } だけを返す。AI は呼ばない", async () => {
    reserve();
    const failed = stub("failDraftGeneration", async () => ({ applied: true }));
    const result = await requestAndGenerateDraft(actor, "math-i", "q1", {}, () => {
      throw new Error("Unsupported AI_MODE");
    });
    assert.deepEqual(result, { applied: true, ok: false });
    assertOnlyStepResult(result);
    assert.equal(failed[0][1], "summary_configuration_failed");
  });

  test("期限切れ・置き換え済みの試行：保存されなかったことだけを返す", async () => {
    reserve();
    stub("finishDraftGeneration", async () => ({ applied: false }));
    const result = await requestAndGenerateDraft(actor, "math-i", "q1", {}, () => ai());
    assert.deepEqual(result, { applied: false, ok: true });
    assertOnlyStepResult(result);
  });

  test("ストアの戻り値に項目が増えても applied・ok 以外は返さない", async () => {
    reserve();
    stub("finishDraftGeneration", async () => ({ applied: true, summaryStatus: "generating", answer: "候補本文" }) as { applied: boolean });
    const result = await requestAndGenerateDraft(actor, "math-i", "q1", {}, () => ai());
    assert.deepEqual(result, { applied: true, ok: true });
    assertOnlyStepResult(result);
  });

  test("予約の拒否（権限・状態）は例外のまま返し、AI は呼ばない", async () => {
    stub("requestDraftGeneration", async () => {
      throw conflict();
    });
    const workflow = ai();
    await assert.rejects(requestAndGenerateDraft(actor, "math-i", "q1", {}, () => workflow), (error: unknown) => {
      assert.ok(isAppError(error));
      assert.equal(error.code, "CONFLICT");
      return true;
    });
    assert.equal(workflow.summaryCalls, 0);
  });

  test("失敗の記録ができなければ成功扱いにせず例外", async () => {
    reserve();
    stub("failDraftGeneration", async () => {
      throw new Error("firestore unavailable");
    });
    await assert.rejects(requestAndGenerateDraft(actor, "math-i", "q1", {}, () => {
      throw new Error("config");
    }), /firestore unavailable/);
  });
});

// A の src/features/student/server.ts と同じ組み立て（AI 実行の入口 → 処理後に readThread で取り直す）を、
// Route Handler の共通処理 handle で包んで HTTP の応答を確かめる（server.ts は next/headers を読むため Node から直接は読めない）。
describe("Route Handler（handle）経由：失敗の記録ができなければ 500、記録できれば処理後の状態を返す", () => {
  const student = {
    principal: { uid: "student-1", email: "student@example.com", name: "生徒" },
    courseId: "math-i",
    enrolled: true,
    teacher: false,
  };
  const post = (path: string) => new Request(`http://localhost/api/courses/math-i${path}`, { method: "POST" });
  async function summaryRoute() {
    await requestAndGenerateDraft(student, "math-i", "q1", { mode: "retry" });
    return ok(await workflowStore.readThread(student, "math-i", "q1"));
  }

  test("要約：AI 設定エラーの記録に失敗 → 500（INTERNAL_ERROR）。内部の例外文は返さない", async () => {
    process.env.AI_MODE = "not-a-mode";
    stub("requestDraftGeneration", async () => ({ generation, summaryStatus: "generating" as const }));
    stub("failDraftGeneration", async () => {
      throw new Error("firestore unavailable: internal detail");
    });
    const read = stub("readThread", async () => ({ id: "q1" }) as never);
    const response = await handle(post("/questions/q1/summary/retry"), summaryRoute);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.equal(JSON.stringify(body).includes("firestore unavailable"), false);
    assert.equal(read.length, 0);
  });

  test("要約：失敗を記録できれば 200 で、処理後に取り直した状態を返す（予約時の generating は返さない）", async () => {
    process.env.AI_MODE = "not-a-mode";
    stub("requestDraftGeneration", async () => ({ generation, summaryStatus: "generating" as const }));
    stub("failDraftGeneration", async () => ({ applied: true }));
    stub("readThread", async () => ({ id: "q1", summaryStatus: "ready" }) as never);
    const response = await handle(post("/questions/q1/summary/retry"), summaryRoute);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { id: "q1", summaryStatus: "ready" } });
  });

  test("AI 回答：設定エラーの記録に失敗 → 500。保存済みの発言は呼び出し前に確定している", async () => {
    process.env.AI_MODE = "not-a-mode";
    stub("failAiTurn", async () => {
      throw new Error("firestore unavailable");
    });
    const response = await handle(post("/questions"), async () => {
      await answerWithConfiguredAi(aiTurn);
      return ok({}, 201);
    });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "INTERNAL_ERROR");
  });
});


describe("requestTeacherDraft：統合後も失敗記録の障害を隠さない", () => {
  test("最初の失敗記録が拒否されたら、再度記録して200にせず例外を返す", async () => {
    process.env.AI_MODE = "not-a-mode";
    stub("requestDraftGeneration", async () => ({ generation, summaryStatus: "generating" as const }));
    let attempts = 0;
    const failed = stub("failDraftGeneration", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("first failure write rejected");
      return { applied: true };
    });
    const read = stub("readDraft", async () => ({ questionId: "q1" }) as Awaited<ReturnType<Store["readDraft"]>>);
    const actor = {
      principal: { uid: "teacher-1", email: "teacher@example.com", name: "先生" },
      courseId: "math-i", enrolled: false, teacher: true,
    };
    await assert.rejects(requestTeacherDraft(actor, "math-i", "q1", "regenerate"), /first failure write rejected/);
    assert.equal(failed.length, 1);
    assert.equal(read.length, 0);
  });
});
