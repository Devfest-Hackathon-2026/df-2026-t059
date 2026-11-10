import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { GoogleAuth } from "google-auth-library";
import { createLedger, errorCode, models, project, readRows, usageOf, workDir } from "./gemini-eval-budget.mjs";

const current = "gemini-3.1-flash-lite";
const candidate = process.env.GEMINI_EVAL_CANDIDATE;
assert.ok(candidate && Object.hasOwn(models, candidate) && candidate !== current, "Select a candidate for the app smoke");
assert.ok(process.argv.includes("--live"), "The app smoke requires --live");
const baseline = JSON.parse(readFileSync("docs/hackathon/gemini-eval-baseline.json", "utf8"));
const ledger = createLedger();
const existing = readRows(resolve(workDir, "ledger.jsonl")).filter((r) => r.event === "reserve" && r.stage === "app");
const counts = Object.fromEntries([current, candidate].map((model) => [model, existing.filter((r) => r.model === model).length]));
const auth = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
const send = (res, status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
let busy = false;

async function vertex(url, body, timeoutMs) {
  const headers = new Headers(await auth.getRequestHeaders(url));
  headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw Object.assign(new Error("Vertex request failed"), { status: response.status });
  return response.json();
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/ready") return send(res, 200, { ready: true });
  const match = req.url?.match(/^\/v1\/projects\/hackathon-513708\/locations\/global\/publishers\/google\/models\/(gemini-[0-9.a-z-]+):generateContent$/);
  if (req.method !== "POST" || !match || ![current, candidate].includes(match[1])) return send(res, 404, { error: { code: 404, message: "Invalid test request" } });
  if (busy) return send(res, 429, { error: { code: 429, message: "App smoke allows one in-flight request" } });
  busy = true;
  const model = match[1];
  let request;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32_768) throw new Error("Unexpected app request size");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const instruction = body.systemInstruction?.parts?.map(({ text }) => text).join("\n");
    const kind = Object.keys(baseline.requests).find((key) => baseline.requests[key].systemInstruction === instruction);
    assert.ok(kind, "Unexpected app system instruction");
    assert.deepEqual(body.generationConfig, baseline.requests[kind].config, "App generation config differs from frozen configuration");
    assert.deepEqual(Object.keys(body).sort(), ["contents", "generationConfig", "systemInstruction"], "Unexpected app request fields");
    const endpoint = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}`;
    const tokens = await vertex(`${endpoint}:countTokens`, body, 10_000);
    const index = counts[model] + 1;
    request = ledger.reserve({ key: `app:${model}:${index}`, stage: "app", model, caseId: `${index}:${kind}`, inputTokens: tokens.totalTokens });
    counts[model] = index;
    const start = performance.now();
    const result = await vertex(`${endpoint}:generateContent`, body, 30_000);
    const state = ledger.settle(request, {
      elapsedMs: Math.round(performance.now() - start), modelVersion: result.modelVersion,
      finishReason: result.candidates?.[0]?.finishReason, usage: usageOf(result.usageMetadata),
    });
    console.log(JSON.stringify({ model, kind, ...state }));
    send(res, 200, result);
  } catch (error) {
    const code = errorCode(error);
    if (request && !request.completed) ledger.settle(request, { error: code, usage: null });
    const validation = error?.code === "ERR_ASSERTION";
    const blocked = error?.message === "USD stop threshold reached" || error?.message === "Request limit reached";
    console.log(JSON.stringify({ model, error: validation ? "REQUEST_MISMATCH" : blocked ? "BUDGET_STOP" : code, ...ledger.snapshot() }));
    send(res, validation ? 400 : blocked ? 429 : 502, { error: { message: "App smoke request did not complete" } });
  } finally {
    busy = false;
  }
});

server.listen(3199, "127.0.0.1", () => console.log(JSON.stringify({ proxyReady: true, port: 3199 })));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
