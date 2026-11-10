// 評価用ローカルアプリだけが使う、外部通信を持たない認証・応答スタブ。
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";

const mode = process.argv[2];
if (mode !== "--mock" && mode !== "--approved") throw new Error("Select an explicit local service mode.");

type Operation = "classify" | "answer" | "summary";
const frozen = JSON.parse(readFileSync(new URL("../docs/hackathon/gemini-eval-baseline.json", import.meta.url), "utf8")) as {
  requests: Record<Operation, { systemInstruction: string; config: unknown }>;
};

const mockTurns: { operation: Operation; output: unknown }[] = [
  { operation: "classify", output: { categoryIds: ["other"], title: "二次関数の頂点" } },
  { operation: "answer", output: {
    text: "公開Q&Aの記法に従うと $y=(x-3)^2-4$ なので、頂点は $(3,-4)$ です。",
    referencedKnowledgeIds: ["square-completion"], escalate: false, reason: "",
  } },
  { operation: "answer", output: {
    text: "$x=4$ を代入すると、$(4-3)^2-4=1-4=-3$ です。",
    referencedKnowledgeIds: [], escalate: false, reason: "",
  } },
  { operation: "classify", output: { categoryIds: ["other"], title: "追試の出題範囲" } },
  { operation: "answer", output: {
    text: "追試の出題範囲は公開Q&Aから確認できないので、担当の先生に引き継ぎます。",
    referencedKnowledgeIds: [], escalate: true, reason: "追試範囲の公表情報がないため。",
  } },
  { operation: "summary", output: {
    canSummarize: true, question: "平方完成で二次関数の頂点を求めるには？",
    answer: "$y=x^2-6x+5=(x-3)^2-4$ と変形できるので、頂点は $(3,-4)$ です。",
  } },
];

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

let generated = 0;
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") return json(response, 200, { generated });
  if (request.method === "POST" && request.url === "/token") {
    request.resume();
    return json(response, 200, { access_token: "synthetic-evaluation-token", expires_in: 3600, token_type: "Bearer" });
  }
  if (
    mode !== "--mock" || request.method !== "POST"
    || request.url?.split("?")[0] !== `/v1/projects/mock-gemini-eval/locations/global/publishers/google/models/${process.env.GEMINI_MODEL}:generateContent`
  ) return json(response, 404, {});

  const expected = mockTurns[generated];
  if (!expected) return json(response, 409, { error: "Unexpected extra model invocation." });
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      systemInstruction?: { parts?: { text: string }[] };
      generationConfig?: unknown;
    };
    const instruction = body.systemInstruction?.parts?.map(({ text }) => text).join("");
    const frozenRequest = frozen.requests[expected.operation];
    if (
      instruction !== frozenRequest.systemInstruction || !isDeepStrictEqual(body.generationConfig, frozenRequest.config)
      || !isDeepStrictEqual(Object.keys(body).sort(), ["contents", "generationConfig", "systemInstruction"])
    ) {
      return json(response, 409, { error: "The app request differs from the frozen deployment." });
    }
    generated += 1;
    return json(response, 200, {
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(expected.output) }] }, finishReason: "STOP" }],
    });
  } catch {
    return json(response, 400, { error: "Invalid synthetic request." });
  }
});

server.listen(3198, "127.0.0.1");
