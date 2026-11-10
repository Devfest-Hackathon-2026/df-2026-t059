// デモ用データの投入。npm run seed:demo（Emulator 起動中に実行）。既存データの移行はしない。
//
//   Emulator（既定）：講義・カテゴリ・公開Q&A・招待に加え、テスト用の生徒2人と状態ごとの相談を作る。
//     担当教員は teacher@example.com（Auth Emulator の Google ログイン画面でこのメールを入力する）。
//   クラウド：SEED_TARGET=cloud と DEMO_TEACHER_EMAILS（カンマ区切り）を明示したときだけ。
//     講義・カテゴリ・公開Q&A・招待だけを作る（生徒の相談は本人がログインして作る）。
//
//   --reset を付けると、同じ講義IDのデータを消してから作り直す。
import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import type { AiWorkflow } from "../src/domain/course-workflow.ts";
import type { CourseActor } from "../src/server/auth/access.ts";
import { getAuthAdmin, getFirestoreAdmin } from "../src/server/firestore/admin.ts";
import { workflowStore as store } from "../src/server/firestore/workflow.ts";
import { runAiTurn, runDraftGeneration } from "../src/server/workflow/ai-steps.ts";

const COURSE_ID = process.env.DEMO_COURSE_ID ?? "math-i";
const cloud = process.env.SEED_TARGET === "cloud";
const reset = process.argv.includes("--reset");

if (cloud) {
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error("SEED_TARGET=cloud では FIRESTORE_EMULATOR_HOST を外してください。");
  if (!process.env.DEMO_TEACHER_EMAILS) throw new Error("SEED_TARGET=cloud では DEMO_TEACHER_EMAILS を指定してください。");
} else if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("Emulator を起動し、FIRESTORE_EMULATOR_HOST と FIREBASE_AUTH_EMULATOR_HOST を設定してください。");
}

const teacherEmails = (process.env.DEMO_TEACHER_EMAILS ?? "teacher@example.com")
  .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);

const categories = [
  { id: "completing-square", name: "平方完成", order: 1 },
  { id: "vertex", name: "頂点と軸", order: 2 },
  { id: "discriminant", name: "判別式", order: 3 },
  { id: "other", name: "その他", order: 99 },
];

// 自作の文章のみ。
const knowledge = [
  { categoryId: "completing-square", question: "平方完成のやり方は？", answer: "x² の係数でくくり、x の係数の半分の2乗を足して引きます。例：x²-6x+5 = (x-3)²-4。" },
  { categoryId: "completing-square", question: "x² の係数が1でないときの平方完成は？", answer: "まず x² の係数で x² と x の項をくくってから平方完成します。例：2x²+8x+1 = 2(x+2)²-7。" },
  { categoryId: "vertex", question: "二次関数の頂点はどう求める？", answer: "y=a(x-p)²+q の形に平方完成すると頂点は (p, q)、軸は x=p です。" },
  { categoryId: "vertex", question: "グラフが上に開くか下に開くかはどこで決まる？", answer: "x² の係数 a が正なら下に凸（上に開く）、負なら上に凸（下に開く）です。" },
  { categoryId: "discriminant", question: "判別式が0のとき、グラフはどうなる？", answer: "二次方程式は重解を持ち、放物線は x 軸に1点で接します。その接点が頂点です。" },
  { categoryId: "discriminant", question: "判別式 D の符号と x 軸との共有点の数は？", answer: "D>0 なら2個、D=0 なら1個（接する）、D<0 なら0個です。" },
];

/** シード用の固定AI（D担当の固定実装が入ったら置き換えてよい）。 */
const fixtureAi: AiWorkflow = {
  classifyQuestion: async ({ text }) => ({
    categoryIds: text.includes("判別式") ? ["discriminant"] : text.includes("平方完成") ? ["completing-square"] : ["vertex"],
  }),
  answerQuestion: async ({ messages }) => {
    const last = messages.at(-1)?.text ?? "";
    const unsure = last.includes("軸が") || last.includes("決まる");
    return {
      text: unsure ? "この条件だけでは式が1つに決まりません。先生に確認しましょう。" : "平方完成して y=a(x-p)²+q の形にすると考えやすくなります。",
      referencedKnowledgeIds: [],
      escalate: unsure,
      reason: unsure ? "条件不足" : "",
    };
  },
  summarizeConversation: async ({ messages }) => ({
    question: messages[0]?.text.slice(0, 60) ?? "質問",
    answer: "会話で確認した内容：平方完成して頂点を読み取る。",
  }),
};

async function main() {
  const db = getFirestoreAdmin();
  const courseRef = db.collection("courses").doc(COURSE_ID);
  if ((await courseRef.get()).exists) {
    if (!reset) throw new Error(`講義 ${COURSE_ID} はすでにあります。作り直すときは --reset を付けてください。`);
    await db.recursiveDelete(courseRef);
  }
  const now = Timestamp.now();
  await courseRef.create({ name: "数学I 二次関数", teacherEmails, categories, materials: [], createdAt: now, updatedAt: now });

  const knowledgeCol = courseRef.collection("knowledge");
  for (const [index, item] of knowledge.entries()) {
    const at = Timestamp.fromMillis(now.toMillis() - (knowledge.length - index) * 60_000);
    await knowledgeCol.add({
      ...item, publishedAt: at, publishedByUid: "seed", sourceQuestionId: "seed", sourceVersionId: "seed", createdAt: at, updatedAt: at,
    });
  }

  const teacherActor: CourseActor = {
    principal: { uid: "seed-teacher", email: teacherEmails[0], name: "デモ先生" },
    courseId: COURSE_ID, enrolled: false, teacher: true,
  };
  const invite = await store.issueInvite(teacherActor, COURSE_ID);

  if (!cloud) await seedThreads(teacherActor, invite.code);

  console.log(`講義: ${COURSE_ID}（数学I 二次関数）`);
  console.log(`担当教員: ${teacherEmails.join(", ")}`);
  console.log(`参加URL: ${invite.joinPath}`);
  console.log(`参加コード: ${invite.code}（発行から30分有効）`);
  console.log("（コードを再表示したいときは、教員画面で再発行してください）");
}

async function seedThreads(teacher: CourseActor, code: string) {
  const auth = getAuthAdmin();
  const students = [
    { uid: "demo-student-1", email: "student1@example.com", name: "デモ 生徒A" },
    { uid: "demo-student-2", email: "student2@example.com", name: "デモ 生徒B" },
  ];
  const actors: CourseActor[] = [];
  for (const s of students) {
    await auth.deleteUser(s.uid).catch(() => undefined);
    await auth.createUser({ uid: s.uid, email: s.email, emailVerified: true, displayName: s.name });
    await store.redeemInvite({ uid: s.uid, email: s.email, name: s.name }, COURSE_ID, { code });
    actors.push({ principal: { uid: s.uid, email: s.email, name: s.name }, courseId: COURSE_ID, enrolled: true, teacher: false });
  }
  const [a, b] = actors;

  const ask = async (actor: CourseActor, text: string) => {
    const created = await store.createQuestion(actor, COURSE_ID, { text });
    await runAiTurn(created.aiTurn, fixtureAi);
    return created.thread.id;
  };

  // 1. AI回答済み
  await ask(a, "y=x²-6x+5 の頂点を求めたい");
  // 2. 先生の対応待ち（AIが引き継ぎ）
  await ask(b, "放物線の軸が x=2 なら、式はどう決まる？");
  // 3. 先生回答済み（未解決）
  const answered = await ask(a, "y=-x²+2x の軸が決まる理由は？");
  await store.replyToQuestion(teacher, COURSE_ID, answered, { text: "平方完成すると y=-(x-1)²+1 なので軸は x=1 です。" });
  // 4. 解決済み＋候補（確認待ち）
  const ready = await ask(b, "平方完成で x の係数の半分を使うのはなぜ？");
  const r4 = await store.resolveQuestion(b, COURSE_ID, ready);
  if (r4.generation) await runDraftGeneration(r4.generation, fixtureAi);
  // 5. 解決済み＋教員編集版＋別案
  const edited = await ask(a, "判別式が負のときグラフはどうなる？");
  const t5 = await store.requestDraftGeneration(teacher, COURSE_ID, edited);
  await runDraftGeneration(t5.generation, fixtureAi);
  const d5 = await store.readDraft(teacher, COURSE_ID, edited);
  const base = d5.versions[0];
  await store.saveDraftEdit(teacher, COURSE_ID, edited, {
    baseVersionId: base.id, expectedSelectedVersionId: d5.selectedVersionId,
    question: "判別式が負のとき、グラフはどうなる？", answer: "D<0 なら x 軸と共有点を持ちません。a>0 ならグラフ全体が x 軸より上にあります。", categoryId: "discriminant",
  });
  const r5 = await store.resolveQuestion(a, COURSE_ID, edited);
  if (r5.generation) await runDraftGeneration(r5.generation, fixtureAi);
  // 6. 公開済み
  const published = await ask(b, "頂点が (1, 2) で点 (0, 3) を通る二次関数は？");
  const r6 = await store.resolveQuestion(b, COURSE_ID, published);
  if (r6.generation) await runDraftGeneration(r6.generation, fixtureAi);
  const d6 = await store.readDraft(teacher, COURSE_ID, published);
  const v6 = d6.versions[0];
  await store.publishDraft(teacher, COURSE_ID, published, {
    versionId: v6.id, question: "頂点と通る1点から二次関数を決めるには？",
    answer: "y=a(x-p)²+q に頂点を代入し、通る点から a を求めます。例：y=(x-1)²+2。", categoryId: "vertex",
  });
  console.log(`テスト生徒: ${students.map((s) => s.email).join(", ")}（状態ごとの相談を6件作成）`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => Promise.all(getApps().map(deleteApp)));
