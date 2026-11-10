// DTO 変換の回帰テスト（Firebase のサーバー接続は不要）。npm run check:rules に含まれる。
// 画面へ返す状態・操作可否が、ストアの判定と同じ規則で作られることを確かめる。
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { generatedQuestionTitle } from "../src/domain/question-title.ts";
import { toStudentThreadDetail, toTeacherThreadDetail, toThreadSummary } from "../src/server/firestore/dto.ts";
import type { Question } from "../src/server/firestore/models.ts";

const NOW = Date.UTC(2026, 10, 7, 9, 0, 0);
const at = (offsetMs: number) => Timestamp.fromMillis(NOW + offsetMs);

function question(overrides: Partial<Question> = {}): Question {
  return {
    studentId: "student-1",
    studentDisplayName: "生徒 太郎",
    title: "放物線の向きの見分け方は？",
    categoryIds: ["vertex"],
    status: "pending",
    escalatedBy: null,
    resolvedAt: null,
    messageCount: 1,
    aiAttempt: { id: "attempt-1", startedAt: at(-120_000), expiresAt: at(-1_000) },
    lastErrorCode: null,
    draft: null,
    createdAt: at(-120_000),
    updatedAt: at(-120_000),
    ...overrides,
  };
}

test("旧データの長い問題文は生徒・教員の一覧と会話で同じ題名になる", () => {
  const legacy = question({ title: "鉄と不純物からなる試料300mgを希硫酸に溶かし、鉄を全て2価の陽イオンとした。この溶液に、硫酸で酸性にした0.020…" });
  assert.equal(toThreadSummary("q1", legacy, NOW).title, "試料中の鉄の定量");
  assert.equal(toStudentThreadDetail("q1", legacy, [], NOW).title, "試料中の鉄の定量");
  assert.equal(toTeacherThreadDetail("q1", legacy, [], NOW).title, "試料中の鉄の定量");
  assert.equal(toThreadSummary("q2", question({ title: "$y=x^2$ の頂点" }), NOW).title, "$y=x^2$ の頂点");
  const echoed = "鉄と不純物からなる試料300mgを希硫酸に溶かし、鉄を全て2価の陽イオンとしたとは？";
  assert.equal(generatedQuestionTitle(echoed, legacy.title), undefined);
  assert.equal(toThreadSummary("q3", question({ title: echoed }), NOW).title, "試料中の鉄の定量");
  assert.equal(generatedQuestionTitle("酸化還元滴定による鉄の定量", legacy.title), "酸化還元滴定による鉄の定量");
});

describe("DTO：AI 回答の期限切れ（保存上は pending）", () => {
  test("教員向け：状態は error、候補作成は可能（GPT 再レビューの再現ケース）、返信は不可", () => {
    const dto = toTeacherThreadDetail("q1", question(), [], NOW);
    assert.equal(dto.status, "error");
    assert.deepEqual(dto.actions, { canReply: false, canRequestDraft: true });
  });
  test("生徒向け：状態は error、再試行・追記・相談・解決が可能", () => {
    const dto = toStudentThreadDetail("q1", question(), [], NOW);
    assert.equal(dto.status, "error");
    assert.equal(dto.actions.canRetryAi, true);
    assert.equal(dto.actions.canSendMessage, true);
    assert.equal(dto.actions.canEscalate, true);
    assert.equal(dto.actions.canResolve, true);
  });
  test("一覧：状態は error", () => {
    assert.equal(toThreadSummary("q1", question(), NOW).status, "error");
  });
});

describe("DTO：期限内の AI 処理中", () => {
  const inProgress = question({ aiAttempt: { id: "attempt-1", startedAt: at(-1_000), expiresAt: at(60_000) } });
  test("教員向け：pending のまま、候補作成も返信も不可", () => {
    const dto = toTeacherThreadDetail("q1", inProgress, [], NOW);
    assert.equal(dto.status, "pending");
    assert.deepEqual(dto.actions, { canReply: false, canRequestDraft: false });
  });
  test("生徒向け：pending のまま、操作はすべて不可", () => {
    const dto = toStudentThreadDetail("q1", inProgress, [], NOW);
    assert.equal(dto.status, "pending");
    assert.equal(Object.values(dto.actions).some(Boolean), false);
  });
});

describe("DTO：その他の状態", () => {
  test("対応待ち：教員は返信・候補作成ができる。生徒向けには本人表示を含めない", () => {
    const escalated = question({ status: "escalated", escalatedBy: "student", aiAttempt: null });
    assert.deepEqual(toTeacherThreadDetail("q1", escalated, [], NOW).actions, { canReply: true, canRequestDraft: true });
    assert.equal(toTeacherThreadDetail("q1", escalated, [], NOW).student.displayName, "生徒 太郎");
    assert.ok(!JSON.stringify(toStudentThreadDetail("q1", escalated, [], NOW)).includes("生徒 太郎"));
  });
  test("要約の生成中：教員は候補作成できない。期限切れの生成なら作れる", () => {
    const generating = (expiresAt: Timestamp) => question({
      status: "teacher_answered",
      aiAttempt: null,
      draft: { generationRunning: true, generationExpiresAt: expiresAt, lastGenerationFailed: false, publication: "none", versionCount: 0 },
    });
    assert.equal(toTeacherThreadDetail("q1", generating(at(60_000)), [], NOW).actions.canRequestDraft, false);
    assert.equal(toTeacherThreadDetail("q1", generating(at(-1_000)), [], NOW).actions.canRequestDraft, true);
    assert.equal(toThreadSummary("q1", generating(at(-1_000)), NOW).summaryStatus, "failed");
  });
});
