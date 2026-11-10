// Vertex AI を最大5回呼ぶ。実データ・Firestoreは使わない。内容の採点は docs/hackathon/test-report.md を参照。
import type { MessageDTO, PublishedKnowledgeDTO } from "../src/domain/course-workflow.ts";
import { AiWorkflowError, getVertexAiConfig } from "../src/server/ai/gemini.ts";
import { vertexAiWorkflow } from "../src/server/ai/workflow.ts";

if (!process.argv.includes("--live")) throw new Error("Vertex AI へ実際に送信する場合は --live を明示してください。");

const { location, model } = getVertexAiConfig();

const createdAt = "2026-11-10T00:00:00.000Z";
const message = (sequence: number, role: MessageDTO["role"], text: string): MessageDTO => ({
  id: `qa-${sequence}`, sequence, role, text, createdAt,
});
const question = "平方完成で $y=x^2-6x+5$ の頂点を求めるには？";
const knowledge: PublishedKnowledgeDTO[] = [
  { id: "qa-square", categoryId: "square", question: "平方完成から頂点を読むには？", answer: "$y=a(x-p)^2+q$ なら頂点は $(p,q)$ で、軸は $x=p$ です。", publishedAt: createdAt },
  { id: "qa-discriminant", categoryId: "discriminant", question: "判別式を求めるには？", answer: "$D=b^2-4ac$ です。", publishedAt: createdAt },
];

const cases = [
  ["V1 分類", () => vertexAiWorkflow.classifyQuestion({ text: question, categories: [
    { id: "square", name: "平方完成", order: 0 },
    { id: "discriminant", name: "判別式", order: 1 },
  ] })],
  ["V2 文脈と出典", () => vertexAiWorkflow.answerQuestion({ messages: [
    message(1, "student", question),
    message(2, "assistant", "$y=(x-3)^2-4$ に変形できます。"),
    message(3, "student", "その式から頂点と軸をどう読むのですか？提供された平方完成のQ&Aを使って説明してください。"),
  ], knowledge })],
  ["V3 根拠不足・教員引き継ぎ", () => vertexAiWorkflow.answerQuestion({ messages: [
    message(1, "student", "この講義の次の試験では平方完成が出題されますか？配点も教えてください。"),
  ], knowledge: [] })],
  ["V4 長文の数学問題", () => vertexAiWorkflow.answerQuestion({ messages: [
    message(1, "student", `${"数学Iの復習で、式の変形とグラフの関係を確かめたいです。途中の考え方も知りたいです。".repeat(35)}\n$y=2x^2+8x+3$ の平方完成、頂点、最小値を簡潔に教えてください。`),
  ], knowledge: [] })],
  ["V5 匿名化・訂正の反映", () => vertexAiWorkflow.summarizeConversation({ messages: [
    message(1, "student", "私は架空 太郎（synthetic@example.test）です。$y=(x-3)^2-4$ の頂点は？"),
    message(2, "assistant", "頂点は $(3,4)$ です。"),
    message(3, "teacher", "先ほどの回答は誤りです。平方の項が0になる $x=3$ で $y=-4$ なので、頂点は $(3,-4)$ です。"),
  ] })],
] as const;

const requestedCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
const selected = requestedCase === undefined ? cases : cases.filter(([label]) => label.startsWith(`${requestedCase} `));
if (!selected.length) throw new Error("--case=V1 から --case=V5 のいずれかを指定してください。");
console.log(JSON.stringify({ model, location, maxRequests: selected.length }));

for (const [label, run] of selected) {
  try {
    console.log(JSON.stringify({ label, output: await run() }));
  } catch (error) {
    // SDKの例外にはアカウントやプロジェクトの情報が入り得る。エラーコードだけを出力する。
    console.error(JSON.stringify({ label, error: error instanceof AiWorkflowError ? error.code : "UNKNOWN" }));
    process.exitCode = 1;
    break;
  }
}
