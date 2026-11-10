// 権限と状態遷移の単体テスト（Firebase 不要）。npm run check:rules
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { invitePath, loginPath, safeNextPath } from "../src/features/auth/next-path.ts";
import {
  type CourseActor,
  canActAsStudent,
  canActAsTeacher,
  canReadCourse,
  canReadThread,
  canSeeStudentIdentity,
  isTeacherEmail,
  isThreadOwner,
  studentView,
} from "../src/server/auth/access.ts";
import {
  type DraftMirror,
  decideAiRetry,
  decideDismiss,
  decideEscalate,
  decideGenerationRequest,
  decidePublish,
  decideResolve,
  decideRestore,
  decideStudentMessage,
  decideTeacherReply,
  decideUnpublish,
  aiTurnExpired,
  effectiveThreadState,
  generationExpired,
  lastGenerationFailed,
  makeTitle,
  normalizeCategoryIds,
  normalizeInviteCode,
  studentActions,
  summaryStatusOf,
  teacherActions,
  type ThreadState,
} from "../src/server/workflow/rules.ts";

const NOW = 1_000_000;

function actor(overrides: Partial<CourseActor> & { uid?: string } = {}): CourseActor {
  const { uid = "student-1", ...rest } = overrides;
  return {
    principal: { uid, email: `${uid}@example.com`, name: uid },
    courseId: "math-i",
    enrolled: false,
    teacher: false,
    ...rest,
  };
}

const thread = { courseId: "math-i", studentId: "student-1" };

describe("access: 原文と本人表示", () => {
  test("本人（参加済み）は自分の相談を読める", () => {
    assert.equal(canReadThread(actor({ enrolled: true }), thread), true);
    assert.equal(isThreadOwner(actor({ enrolled: true }), thread), true);
  });
  test("未参加の本人 uid でも読めない（参加が前提）", () => {
    assert.equal(canReadThread(actor({ enrolled: false }), thread), false);
  });
  test("他の生徒は読めない", () => {
    assert.equal(canReadThread(actor({ uid: "student-2", enrolled: true }), thread), false);
  });
  test("担当教員は読めて、本人表示も見られる", () => {
    const teacher = actor({ uid: "teacher-1", teacher: true });
    assert.equal(canReadThread(teacher, thread), true);
    assert.equal(canSeeStudentIdentity(teacher, thread), true);
  });
  test("本人には本人表示を返さない（教員用の情報）", () => {
    assert.equal(canSeeStudentIdentity(actor({ enrolled: true }), thread), false);
  });
  test("別講義の教員は読めない", () => {
    const other = actor({ uid: "teacher-2", teacher: true, courseId: "other-course" });
    assert.equal(canReadThread(other, thread), false);
    assert.equal(canActAsTeacher(other, "math-i"), false);
  });
  test("講義情報・公開Q&Aは参加済みか教員だけ", () => {
    assert.equal(canReadCourse(actor(), "math-i"), false);
    assert.equal(canReadCourse(actor({ enrolled: true }), "math-i"), true);
    assert.equal(canReadCourse(actor({ teacher: true }), "math-i"), true);
    assert.equal(canActAsStudent(actor({ teacher: true }), "math-i"), false);
  });
  test("教員判定はメールの大文字小文字を区別しない。未検証（null）は教員にならない", () => {
    assert.equal(isTeacherEmail("Teacher@Example.com", ["teacher@example.com"]), true);
    assert.equal(isTeacherEmail(null, ["teacher@example.com"]), false);
  });
});

function state(overrides: Partial<ThreadState> = {}): ThreadState {
  return { status: "ai_answered", resolved: false, aiAttempt: null, draft: null, ...overrides };
}

function draft(overrides: Partial<DraftMirror> = {}): DraftMirror {
  return {
    generationRunning: false,
    generationExpiresAtMs: null,
    lastGenerationFailed: false,
    publication: "none",
    versionCount: 1,
    ...overrides,
  };
}

const running = (expiresAtMs = NOW + 1000) => draft({ generationRunning: true, generationExpiresAtMs: expiresAtMs });

describe("rules: 生徒の発言・再試行・相談", () => {
  test("AI 処理中は送れない", () => assert.equal(decideStudentMessage(state({ status: "pending" })).ok, false));
  test("解決済みは送れない", () => assert.equal(decideStudentMessage(state({ resolved: true })).ok, false));
  test("対応待ちは補足として追記でき、状態は escalated のまま AI を呼ばない", () => {
    const decision = decideStudentMessage(state({ status: "escalated" }));
    assert.deepEqual(decision, { ok: true, value: { nextStatus: "escalated", startAiTurn: false } });
  });
  test("回答済み・先生回答済み・失敗からは追記して AI 待ちへ", () => {
    for (const status of ["ai_answered", "teacher_answered", "error"] as const) {
      assert.deepEqual(decideStudentMessage(state({ status })), {
        ok: true,
        value: { nextStatus: "pending", startAiTurn: true },
      });
    }
  });
  test("AI の再試行は error か期限切れの pending だけ", () => {
    assert.equal(decideAiRetry(state({ status: "error" }), NOW).ok, true);
    assert.equal(decideAiRetry(state({ status: "pending", aiAttempt: { id: "a", expiresAtMs: NOW + 1 } }), NOW).ok, false);
    assert.equal(decideAiRetry(state({ status: "pending", aiAttempt: { id: "a", expiresAtMs: NOW } }), NOW).ok, true);
    assert.equal(decideAiRetry(state({ status: "ai_answered" }), NOW).ok, false);
  });
  test("先生に相談：pending・対応待ち・解決済みは不可", () => {
    assert.equal(decideEscalate(state()).ok, true);
    assert.equal(decideEscalate(state({ status: "pending" })).ok, false);
    assert.equal(decideEscalate(state({ status: "escalated" })).ok, false);
    assert.equal(decideEscalate(state({ resolved: true })).ok, false);
  });
  test("教員の返信は対応待ちで未解決のときだけ（同時返信の2件目は拒否される）", () => {
    assert.equal(decideTeacherReply(state({ status: "escalated" })).ok, true);
    assert.equal(decideTeacherReply(state({ status: "teacher_answered" })).ok, false);
    assert.equal(decideTeacherReply(state({ status: "escalated", resolved: true })).ok, false);
  });
});

describe("rules: 解決と候補の生成", () => {
  test("解決：pending は不可", () => assert.equal(decideResolve(state({ status: "pending" }), NOW).ok, false));
  test("解決：候補・別案の生成中は不可", () => {
    assert.equal(decideResolve(state({ draft: running() }), NOW).ok, false);
  });
  test("解決：生成が期限切れなら可（置き換える）", () => {
    assert.equal(decideResolve(state({ draft: running(NOW) }), NOW).ok, true);
  });
  test("解決：既存の候補・編集版があっても可（別案を1つ追加する）", () => {
    assert.deepEqual(decideResolve(state({ draft: draft({ versionCount: 3 }) }), NOW), {
      ok: true,
      value: { alreadyResolved: false },
    });
  });
  test("解決：対応待ちでも可、解決済みへの再送は何もしない", () => {
    assert.equal(decideResolve(state({ status: "escalated" }), NOW).ok, true);
    assert.deepEqual(decideResolve(state({ resolved: true }), NOW), { ok: true, value: { alreadyResolved: true } });
  });
  test("生成要求：pending 以外の相談状態なら可（対応待ち・先生回答済み・解決済み）", () => {
    for (const s of [
      state({ status: "escalated" }),
      state({ status: "teacher_answered" }),
      state({ resolved: true }),
      state({ status: "error" }),
    ]) {
      assert.equal(decideGenerationRequest(s, "teacher", "regenerate", NOW).ok, true);
    }
    assert.equal(decideGenerationRequest(state({ status: "pending" }), "teacher", "regenerate", NOW).ok, false);
  });
  test("生成要求：教員は候補がなくても作成できる（未解決のまま）", () => {
    assert.deepEqual(decideGenerationRequest(state(), "teacher", "regenerate", NOW), {
      ok: true,
      value: { reason: "teacher_create" },
    });
  });
  test("生成要求：生徒は既存の候補の再生成だけ", () => {
    assert.equal(decideGenerationRequest(state(), "student", "regenerate", NOW).ok, false);
    assert.deepEqual(decideGenerationRequest(state({ draft: draft() }), "student", "regenerate", NOW), {
      ok: true,
      value: { reason: "regenerate" },
    });
  });
  test("生成要求：生成中は二重に予約しない（連打）", () => {
    assert.equal(decideGenerationRequest(state({ draft: running() }), "teacher", "regenerate", NOW).ok, false);
    assert.equal(decideGenerationRequest(state({ draft: running() }), "student", "regenerate", NOW).ok, false);
  });
  test("生成要求：retry は直前が失敗したときだけ", () => {
    assert.equal(decideGenerationRequest(state({ draft: draft() }), "student", "retry", NOW).ok, false);
    assert.deepEqual(
      decideGenerationRequest(state({ draft: draft({ lastGenerationFailed: true, versionCount: 0 }) }), "student", "retry", NOW),
      { ok: true, value: { reason: "retry" } },
    );
  });
  test("生徒の操作可否は同じ判定から作る（生成中は解決ボタンを無効化）", () => {
    const actions = studentActions(state({ draft: running() }), NOW);
    assert.equal(actions.canResolve, false);
    assert.equal(actions.canRequestRegeneration, false);
    assert.equal(studentActions(state({ draft: draft() }), NOW).canResolve, true);
    assert.equal(studentActions(state(), NOW).canRequestRegeneration, false);
  });
});

describe("rules: 公開・見送り・状態表示", () => {
  test("公開：未公開は可、同じ内容の再送は既存結果、別内容は競合、見送り済みは不可", () => {
    assert.deepEqual(decidePublish("none", false), { ok: true, value: { alreadyPublished: false } });
    assert.deepEqual(decidePublish("published", true), { ok: true, value: { alreadyPublished: true } });
    assert.equal(decidePublish("published", false).ok, false);
    assert.equal(decidePublish("dismissed", false).ok, false);
  });
  test("見送り：公開済みは不可、二重の見送りは何もしない", () => {
    assert.equal(decideDismiss("published").ok, false);
    assert.deepEqual(decideDismiss("dismissed"), { ok: true, value: { alreadyDismissed: true } });
  });
  test("要約状態の表示", () => {
    assert.equal(summaryStatusOf(null, NOW), "none");
    assert.equal(summaryStatusOf(running(), NOW), "generating");
    assert.equal(summaryStatusOf(draft({ versionCount: 0, lastGenerationFailed: true }), NOW), "failed");
    assert.equal(summaryStatusOf(running(NOW), NOW), "ready");
    assert.equal(summaryStatusOf(draft({ versionCount: 0, generationRunning: true, generationExpiresAtMs: NOW }), NOW), "failed");
    assert.equal(summaryStatusOf(draft({ publication: "published" }), NOW), "published");
  });
});

describe("rules: 入力の整形", () => {
  test("タイトルは空白を整理し、省略記号込みで上限以内", () => {
    assert.equal(makeTitle("  二次関数の\n頂点は？ ", 60), "二次関数の 頂点は？");
    const long = makeTitle("あ".repeat(100), 60);
    assert.equal(Array.from(long).length, 60);
    assert.ok(long.endsWith("…"));
  });
  test("カテゴリは許可IDだけ・重複なし・最大2件、なければ other", () => {
    const allowed = ["vertex", "discriminant", "other"];
    assert.deepEqual(normalizeCategoryIds(["vertex", "vertex", "x", "discriminant", "other"], allowed, 2), [
      "vertex",
      "discriminant",
    ]);
    assert.deepEqual(normalizeCategoryIds(["unknown"], allowed, 2), ["other"]);
    assert.deepEqual(normalizeCategoryIds([], allowed, 2), ["other"]);
  });
  test("招待コードは空白・ハイフン・大文字小文字を吸収し、形式外は null", () => {
    assert.equal(normalizeInviteCode(" abcd-efgh "), "ABCDEFGH");
    assert.equal(normalizeInviteCode("ABCD-EFG"), null);
    assert.equal(normalizeInviteCode("ABCD-EFG0"), null);
  });
});

describe("rules: 要約生成の期限切れ（GPT レビュー指摘3）", () => {
  // 初回の生成が中断し、記録上は実行中のまま期限を過ぎた状態。
  const expiredFirst = draft({ versionCount: 0, generationRunning: true, generationExpiresAtMs: NOW - 1 });
  const expiredWithVersions = draft({ versionCount: 2, generationRunning: true, generationExpiresAtMs: NOW - 1 });

  test("期限切れは失敗として扱う（実行中の期限内は失敗ではない）", () => {
    assert.equal(generationExpired(expiredFirst, NOW), true);
    assert.equal(lastGenerationFailed(expiredFirst, NOW), true);
    assert.equal(lastGenerationFailed(running(), NOW), false);
    assert.equal(lastGenerationFailed(draft({ lastGenerationFailed: true }), NOW), true);
    assert.equal(lastGenerationFailed(draft(), NOW), false);
  });
  test("初回が期限切れ：表示は failed、専用の再試行（mode=retry）を受け付け、生徒の canRetrySummary も true", () => {
    assert.equal(summaryStatusOf(expiredFirst, NOW), "failed");
    assert.deepEqual(decideGenerationRequest(state({ draft: expiredFirst }), "student", "retry", NOW), {
      ok: true,
      value: { reason: "retry" },
    });
    const actions = studentActions(state({ draft: expiredFirst }), NOW);
    assert.equal(actions.canRetrySummary, true);
    assert.equal(actions.canRequestRegeneration, true);
    assert.equal(actions.canResolve, true);
  });
  test("既存の版がある別案生成の期限切れ：表示は ready のまま、再試行は受け付ける", () => {
    assert.equal(summaryStatusOf(expiredWithVersions, NOW), "ready");
    assert.equal(studentActions(state({ draft: expiredWithVersions }), NOW).canRetrySummary, true);
  });
  test("期限内の生成中は再試行も再生成も受け付けない", () => {
    assert.equal(decideGenerationRequest(state({ draft: running() }), "teacher", "retry", NOW).ok, false);
    assert.equal(studentActions(state({ draft: running() }), NOW).canRetrySummary, false);
  });
});

describe("safeNextPath: ログイン後の転送先（GPT レビュー指摘2）", () => {
  const sameOrigin = (path: string) => new URL(path, "https://app.example").origin === "https://app.example";

  test("タブ文字を挟んだ外部 URL を拒否する（再現ケース）", () => {
    const attack = "/\t/outside.example"; // \t は実際のタブ文字
    assert.equal(attack.charCodeAt(1), 9);
    assert.equal(new URL(attack, "https://app.example").href, "https://outside.example/");
    assert.equal(safeNextPath(attack), "/");
  });
  test("制御文字・バックスラッシュ・プロトコル相対・絶対 URL を拒否する", () => {
    for (const value of [
      "/\n/outside.example",
      "/\r/outside.example",
      "/\u0000/x",
      "/\u007f/x",
      "//outside.example",
      "/\\outside.example",
      "/\\/outside.example",
      "https://outside.example/",
      "javascript:alert(1)",
      "outside.example",
      "",
    ]) {
      assert.equal(safeNextPath(value), "/", JSON.stringify(value));
    }
    assert.equal(safeNextPath(undefined), "/");
    assert.equal(safeNextPath(null, "/login"), "/login");
  });
  test("正規化後に // から始まる形になる入力を拒否する（再レビューの再現ケース）", () => {
    for (const value of ["/a/..//outside.example", "/.//outside.example", "/a/b/../..//outside.example", "/%2e//outside.example"]) {
      assert.equal(new URL(value, "https://app.example").pathname.startsWith("//"), true, value);
      assert.equal(safeNextPath(value), "/", value);
    }
  });
  test("返り値をもう一度 safeNextPath に通しても変わらない（冪等）", () => {
    for (const value of ["/c/math-i", "/join/math-i?code=ABCD-EFGH", "/./c/x", "/a/../c/x?y=1#z", "/%09/outside.example"]) {
      const once = safeNextPath(value);
      assert.equal(safeNextPath(once), once, value);
    }
  });
  test("通常の内部パス・クエリ・ハッシュはそのまま使える", () => {
    assert.equal(safeNextPath("/"), "/");
    assert.equal(safeNextPath("/c/math-i"), "/c/math-i");
    assert.equal(safeNextPath("/join/math-i?code=ABCD-EFGH"), "/join/math-i?code=ABCD-EFGH");
    assert.equal(safeNextPath("/t/math-i?tab=review#q1"), "/t/math-i?tab=review#q1");
  });
  test("どの入力でも結果は同じオリジンのパスになる", () => {
    const inputs = [
      "/%09/outside.example",
      "/%2F%2Foutside.example",
      "/./../c/x",
      "/c/%E6%95%B0%E5%AD%A6",
      "/a?next=//evil",
      "/a/..//outside.example",
      "/.//outside.example",
      "/..//..//outside.example",
    ];
    for (const value of inputs) {
      const result = safeNextPath(value);
      assert.ok(result.startsWith("/") && !result.startsWith("//"), value);
      assert.ok(sameOrigin(result), value);
    }
  });
});

describe("rules: AI 回答の期限切れ（要約と同じ扱い）", () => {
  const expiredPending = state({ status: "pending", aiAttempt: { id: "a", expiresAtMs: NOW - 1 } });
  const runningPending = state({ status: "pending", aiAttempt: { id: "a", expiresAtMs: NOW + 1000 } });

  test("pending のまま期限を過ぎた試行は失敗（error）として扱う", () => {
    assert.equal(aiTurnExpired(expiredPending, NOW), true);
    assert.equal(aiTurnExpired(runningPending, NOW), false);
    assert.equal(effectiveThreadState(expiredPending, NOW).status, "error");
    assert.equal(effectiveThreadState(expiredPending, NOW).aiAttempt, null);
    assert.equal(effectiveThreadState(runningPending, NOW).status, "pending");
  });
  test("期限切れ後は再試行・追記・先生への相談・解決ができる（会話は保持）", () => {
    const actions = studentActions(expiredPending, NOW);
    assert.equal(actions.canRetryAi, true);
    assert.equal(actions.canSendMessage, true);
    assert.equal(actions.canEscalate, true);
    assert.equal(actions.canResolve, true);
    const effective = effectiveThreadState(expiredPending, NOW);
    assert.deepEqual(decideStudentMessage(effective), { ok: true, value: { nextStatus: "pending", startAiTurn: true } });
    assert.equal(decideGenerationRequest(effective, "teacher", "regenerate", NOW).ok, true);
  });
  test("教員の操作可否も同じ判定：期限切れ後は候補を作れる、期限内の処理中は作れない", () => {
    assert.deepEqual(teacherActions(expiredPending, NOW), { canReply: false, canRequestDraft: true });
    assert.equal(decideGenerationRequest(effectiveThreadState(expiredPending, NOW), "teacher", "regenerate", NOW).ok, true);
    assert.deepEqual(teacherActions(runningPending, NOW), { canReply: false, canRequestDraft: false });
    assert.deepEqual(teacherActions(state({ status: "escalated" }), NOW), { canReply: true, canRequestDraft: true });
    assert.deepEqual(teacherActions(state({ draft: running() }), NOW), { canReply: false, canRequestDraft: false });
  });
  test("期限内の AI 処理中は、再試行・追記・相談・解決のどれもできない", () => {
    const actions = studentActions(runningPending, NOW);
    assert.equal(actions.canRetryAi, false);
    assert.equal(actions.canSendMessage, false);
    assert.equal(actions.canEscalate, false);
    assert.equal(actions.canResolve, false);
  });
});

describe("access: 生徒用の主体（兼任者）", () => {
  const both = actor({ enrolled: true, teacher: true });
  test("studentView は teacher だけを外し、uid・courseId・enrolled は変えない。元の主体も変えない", () => {
    const view = studentView(both);
    assert.equal(view.teacher, false);
    assert.equal(view.enrolled, true);
    assert.equal(view.courseId, both.courseId);
    assert.equal(view.principal.uid, both.principal.uid);
    assert.equal(both.teacher, true);
    assert.notEqual(view.principal, both.principal);
  });
  test("生徒用の主体では本人の相談だけ読め、本人表示は見えない。教員の主体では担当教員として読める", () => {
    const view = studentView(both);
    assert.equal(canReadThread(view, { courseId: "math-i", studentId: both.principal.uid }), true);
    assert.equal(canReadThread(view, { courseId: "math-i", studentId: "someone-else" }), false);
    assert.equal(canSeeStudentIdentity(view, thread), false);
    assert.equal(canReadThread(both, { courseId: "math-i", studentId: "someone-else" }), true);
    assert.equal(canActAsTeacher(view, "math-i"), false);
    assert.equal(canActAsTeacher(both, "math-i"), true);
  });
  test("未参加の教員の生徒用の主体は、何も読めない", () => {
    const view = studentView(actor({ teacher: true }));
    assert.equal(canReadThread(view, { courseId: "math-i", studentId: "student-1" }), false);
    assert.equal(canReadCourse(view, "math-i"), false);
  });
});

describe("rules: 見送った候補の復帰（11/8）", () => {
  test("見送り済みで確認できる版があり生成中でなければ戻せる", () => {
    assert.deepEqual(decideRestore(draft({ publication: "dismissed" }), NOW), { ok: true, value: { alreadyPending: false } });
  });
  test("すでに確認待ちなら何もせずそのまま返す（二重の要求）", () => {
    assert.deepEqual(decideRestore(draft(), NOW), { ok: true, value: { alreadyPending: true } });
  });
  test("公開中・生成中・確認できる版がないときは戻せない", () => {
    assert.equal(decideRestore(draft({ publication: "published" }), NOW).ok, false);
    assert.equal(decideRestore({ ...running(), publication: "dismissed" }, NOW).ok, false);
    assert.equal(decideRestore(draft({ publication: "dismissed", versionCount: 0, lastGenerationFailed: true }), NOW).ok, false);
    assert.equal(decideRestore(draft({ versionCount: 0 }), NOW).ok, false);
  });
  test("期限切れの生成が残っていても戻せる（戻した後の表示は ready）", () => {
    const expired = { ...running(NOW - 1), publication: "dismissed" as const };
    assert.equal(decideRestore(expired, NOW).ok, true);
    assert.equal(summaryStatusOf({ ...expired, publication: "none" }, NOW), "ready");
  });
});

describe("rules: 公開Q&Aの取り下げ（11/8）", () => {
  test("元候補がこのQ&Aで公開中なら、候補を確認待ちに戻す", () => {
    assert.deepEqual(decideUnpublish({ publication: "published", publishedKnowledgeId: "k1" }, "k1"), {
      ok: true,
      value: { restoreDraft: true },
    });
  });
  test("元候補がない Q&A は削除だけ", () => {
    assert.deepEqual(decideUnpublish(null, "k1"), { ok: true, value: { restoreDraft: false } });
  });
  test("元候補の現在の公開と一致しない（再公開された別の Q&A・未公開・見送り）なら何も変えない", () => {
    assert.equal(decideUnpublish({ publication: "published", publishedKnowledgeId: "k2" }, "k1").ok, false);
    assert.equal(decideUnpublish({ publication: "none", publishedKnowledgeId: null }, "k1").ok, false);
    assert.equal(decideUnpublish({ publication: "dismissed", publishedKnowledgeId: null }, "k1").ok, false);
  });
});

describe("loginPath: 401 からの再ログイン導線", () => {
  test("講義ページと認識するクエリだけを戻り先として渡す", () => {
    assert.equal(loginPath("/c/math-i?view=shared&code=SECRET"), "/login?next=%2Fc%2Fmath-i%3Fview%3Dshared");
    assert.equal(loginPath("/t/math-i?view=review&question=q1"), "/login?next=%2Ft%2Fmath-i%3Fview%3Dreview%26question%3Dq1");
  });
  test("外部サイトへの戻り先は / に絞る", () => {
    assert.equal(loginPath("//outside.example"), "/login?next=%2F");
    assert.equal(loginPath("/a/..//outside.example"), "/login?next=%2F");
    assert.equal(loginPath(undefined), "/login?next=%2F");
  });
  test("ログイン自身や招待の秘密値を戻り先に含めない", () => {
    for (const path of ["/login", "/api/auth/logout", "/join/math-i?code=SECRET", "/t/%2Fmath-i", "/c/%E0"]) {
      assert.equal(loginPath(path), "/login?next=%2F");
    }
  });
});

test("参加URLの貼り付けでは、このサイトの参加ページをクエリなしで開く", () => {
  const origin = "https://school.example";
  assert.equal(invitePath(`${origin}/join/math-i`, origin), "/join/math-i");
  assert.equal(invitePath(`${origin}/join/math-i?code=ABCD-EFGH&next=/login`, origin), "/join/math-i");
  assert.equal(invitePath("https://other.example/join/math-i?code=ABCD-EFGH", origin), null);
  assert.equal(invitePath(`${origin}/login?code=ABCD-EFGH`, origin), null);
});

