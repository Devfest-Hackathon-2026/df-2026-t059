import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { parseAndValidateAiAnswer } from "../src/server/ai/gemini.ts";
import { createLedger, errorCode, models, project, usageOf, workDir } from "./gemini-eval-budget.mjs";

const dataset = readFileSync("docs/hackathon/gemini-eval-cases.json");
const baseline = JSON.parse(readFileSync("docs/hackathon/gemini-eval-baseline.json", "utf8"));
const frozen = baseline.requests.answer;
const sha = (input) => createHash("sha256").update(input).digest("hex");
assert.equal(sha(dataset), "aa04629953b8ba8d8ce24a5aa0030ba22b09607c206ec833e7efd102ee325da7");
assert.equal(sha(frozen.systemInstruction), "15defbf6b60f40842c2a3b2e1650a7f7f38a0909d1b77c3887277a94cb1ca501");
assert.equal(frozen.apiVersion, "v1");
assert.equal(frozen.location, "global");
assert.equal(frozen.timeoutMs, 30_000);

const cases = JSON.parse(dataset);
assert.equal(cases.length, 50);
assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
assert.equal(cases.filter(({ expected }) => expected.escalate).length, 20);
const order = cases.toSorted((a, b) => sha(`gemini-eval-v1:${a.id}`).localeCompare(sha(`gemini-eval-v1:${b.id}`)));
const modelIds = Object.keys(models);
const requestQueue = order.flatMap(({ id, messages, knowledge }, index) => {
  assert.ok(messages.length >= 1 && messages.length <= 20 && knowledge.length <= 30);
  const contents = JSON.stringify({
    messages: messages.map(({ role, text }, i) => ({ role, sequence: i + 1, text: text.trim() })),
    publishedKnowledge: knowledge.map(({ id, question, answer, categoryId }) => ({ id, question: question.trim(), answer: answer.trim(), categoryId })),
  });
  return modelIds.map((_, offset) => {
    const model = modelIds[(index + offset) % modelIds.length];
    return { key: `answer:${id}:${model}`, caseId: id, model, contents, references: new Set(knowledge.map(({ id }) => id)) };
  });
});

if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({ dryRun: true, cases: cases.length, requests: requestQueue.length, source: baseline.sourceCommit, models: modelIds }));
  process.exit(0);
}
assert.ok(!process.env.GOOGLE_VERTEX_BASE_URL, "Unexpected Vertex URL override");
// Test TLS before reserving any paid request. The root endpoints need no ADC.
for (const origin of ["https://aiplatform.googleapis.com", "https://oauth2.googleapis.com"]) {
  try {
    await fetch(origin, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    throw new Error(`Connectivity check failed: ${new URL(origin).hostname}, ${errorCode(error.cause ?? error)}`);
  }
}
const ledger = createLedger();
const manifest = JSON.stringify({ datasetSha: sha(dataset), requestSha: sha(JSON.stringify(frozen)), models, project, order: requestQueue.map(({ key }) => key) });
const manifestPath = resolve(workDir, "manifest.json");
if (existsSync(manifestPath)) assert.equal(readFileSync(manifestPath, "utf8"), manifest, "Run manifest differs");
else writeFileSync(manifestPath, manifest, { flag: "wx" });

// An interrupted process may have submitted the request. Record the missing
// response as a failure, keep the budget reservation, and never re-send it.
for (const request of ledger.unsettled()) {
  assert.equal(request.stage, "benchmark", "App smoke interrupted; stop for inspection");
  const state = ledger.settle(request, { error: "INTERRUPTED", usage: null });
  console.log(JSON.stringify({ caseId: request.caseId, model: request.model, error: "INTERRUPTED", ...state }));
}

const client = () => new GoogleGenAI({ vertexai: true, project, location: frozen.location, apiVersion: frozen.apiVersion });
const countClient = client();
const countPath = resolve(workDir, "counts.json");
let counts;
if (existsSync(countPath)) {
  counts = JSON.parse(readFileSync(countPath, "utf8"));
} else {
  counts = {};
  for (let i = 0; i < requestQueue.length; i += 4) {
    await Promise.all(requestQueue.slice(i, i + 4).map(async ({ key, model, contents }) => {
      try {
        const result = await countClient.models.countTokens({ model, contents, config: {
          systemInstruction: frozen.systemInstruction, generationConfig: frozen.config, abortSignal: AbortSignal.timeout(15_000),
        } });
        assert.ok(Number.isSafeInteger(result.totalTokens) && result.totalTokens > 0);
        counts[key] = result.totalTokens;
      } catch (error) {
        throw new Error(`CountTokens failed: ${model}, ${errorCode(error)}`);
      }
    }));
  }
  mkdirSync(workDir, { recursive: true });
  writeFileSync(countPath, JSON.stringify(counts), { flag: "wx" });
}
assert.equal(Object.keys(counts).length, 200);
const totalByModel = Object.fromEntries(modelIds.map((model) => [model, requestQueue.filter((q) => q.model === model).reduce((sum, q) => sum + counts[q.key], 0)]));
const avg2kCost = modelIds.reduce((sum, model) => sum + totalByModel[model] * models[model].input + 50 * 2_000 * models[model].output, 0) / 1e6;
console.log(JSON.stringify({ preflight: true, totalByModel, maxInput: Math.max(...Object.values(counts)), estimatedUSDAt2000Output: avg2kCost }));

let completed = 0;
for (const { key, caseId, model, contents, references } of requestQueue) {
  if (ledger.has(key)) continue; // A recorded request may already have incurred charges.
  let request;
  try {
    request = ledger.reserve({ key, stage: "benchmark", model, caseId, inputTokens: counts[key] });
  } catch (error) {
    console.log(JSON.stringify({ stopped: error.message, ...ledger.snapshot() }));
    break;
  }
  const abortSignal = AbortSignal.timeout(frozen.timeoutMs);
  const start = performance.now();
  let response;
  try {
    response = await client().models.generateContent({ model, contents, config: {
      systemInstruction: frozen.systemInstruction, ...frozen.config, abortSignal,
    } });
  } catch (error) {
    const code = abortSignal.aborted ? "TIMEOUT" : errorCode(error);
    const state = ledger.settle(request, { elapsedMs: Math.round(performance.now() - start), error: code, usage: null });
    console.log(JSON.stringify({ caseId, model, error: code, ...state }));
    if (code.includes("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN") break;
    continue;
  }
  const elapsedMs = Math.round(performance.now() - start);
  const usage = usageOf(response.usageMetadata);
  const common = { elapsedMs, modelVersion: response.modelVersion, finishReason: response.candidates?.[0]?.finishReason, usage };
  let answer;
  let error;
  try {
    answer = parseAndValidateAiAnswer(response.text, references);
  } catch (cause) {
    error = errorCode(cause);
  }
  const state = ledger.settle(request, { ...common, answer, error, ...(error ? { rejectedText: response.text?.slice(0, 4_000) } : {}) });
  if (++completed % 8 === 0 || error) console.log(JSON.stringify({ progress: true, model, caseId, error, ...state }));
  if (usage?.traffic && !["ON_DEMAND", "TRAFFIC_TYPE_UNSPECIFIED"].includes(usage.traffic)) {
    console.log(JSON.stringify({ stopped: "Unexpected traffic pricing tier", ...state }));
    break;
  }
}
console.log(JSON.stringify({ done: true, ...ledger.snapshot() }));
