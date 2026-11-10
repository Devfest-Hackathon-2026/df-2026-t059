import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const project = "hackathon-513708";
export const models = {
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.5-flash-lite": { input: 0.30, output: 2.5 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.8-flash": { input: 1.5, output: 7.5 },
};
export const workDir = resolve(".gemini-eval");
const ceiling = 6_000_000; // micro-USD, without credits or cached input discounts
const outputReservation = 2 * 65_536; // public output limit plus the same allowance for reasoning
const maxCalls = 212;

export function readRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function createLedger() {
  mkdirSync(workDir, { recursive: true });
  const lock = resolve(workDir, "live.lock");
  const fd = openSync(lock, "wx");
  writeFileSync(fd, `${process.pid}\n`);
  closeSync(fd);
  process.once("exit", () => unlinkSync(lock));

  const path = resolve(workDir, "ledger.jsonl");
  const rows = readRows(path);
  const attempts = new Map();
  let charged = 0;
  let held = 0;
  const append = (row) => appendFileSync(path, `${JSON.stringify(row)}\n`, { flush: true });

  for (const row of rows) {
    if (row.event === "reserve") {
      if (attempts.has(row.key)) throw new Error("Duplicate key in ledger");
      attempts.set(row.key, row);
      held += row.reserved;
    } else if (row.event === "result") {
      const request = attempts.get(row.key);
      if (!request || request.completed) throw new Error("Unexpected result in ledger");
      request.completed = true;
      if (row.cost !== null) {
        charged += row.cost;
        held -= request.reserved;
      }
    } else {
      throw new Error("Unrecognized ledger event");
    }
  }

  const snapshot = () => ({ attempts: attempts.size, measuredUSD: charged / 1e6, reservedUSD: held / 1e6 });
  const reserve = ({ key, stage, model, inputTokens, caseId }) => {
    if (!Object.hasOwn(models, model) || !Number.isSafeInteger(inputTokens) || inputTokens < 1) throw new Error("Unknown model or input size");
    if (attempts.has(key)) throw new Error("Request already recorded");
    const { input, output } = models[model];
    // CountTokens can differ from billed usage; reserve additional input room.
    const reserved = Math.ceil(input * Math.max(2_000, inputTokens + 1_024) + output * outputReservation);
    const stageRequests = [...attempts.values()].filter((row) => row.stage === stage);
    const maximum = stage === "benchmark" ? 200 : 12;
    const perModel = stage === "benchmark" ? 50 : 6;
    if (attempts.size >= maxCalls || stageRequests.length >= maximum || stageRequests.filter((row) => row.model === model).length >= perModel) {
      throw new Error("Request limit reached");
    }
    if (stage === "app" && new Set([...stageRequests.map((row) => row.model), model]).size > 2) {
      throw new Error("App smoke may use only two models");
    }
    if (charged + held + reserved >= ceiling) throw new Error("USD stop threshold reached");
    const row = { event: "reserve", key, stage, model, caseId, inputTokens, reserved };
    append(row);
    attempts.set(key, row);
    held += reserved;
    return row;
  };

  const settle = (request, result) => {
    if (request.completed) throw new Error("Duplicate settlement");
    const usage = result.usage;
    let cost = null;
    if (usage?.prompt >= 0 && usage?.output >= 0 && (!usage.traffic || usage.traffic === "ON_DEMAND" || usage.traffic === "TRAFFIC_TYPE_UNSPECIFIED")) {
      const rates = models[request.model];
      cost = Math.ceil(usage.prompt * rates.input + usage.output * rates.output);
    }
    append({ event: "result", key: request.key, stage: request.stage, model: request.model, caseId: request.caseId, ...result, cost });
    request.completed = true;
    if (cost !== null) {
      charged += cost;
      held -= request.reserved;
    }
    return snapshot();
  };

  return {
    has: (key) => attempts.has(key),
    unsettled: () => [...attempts.values()].filter((request) => !request.completed),
    reserve, settle, snapshot,
  };
}

export function usageOf(metadata) {
  if (!metadata || !Number.isSafeInteger(metadata.promptTokenCount) || metadata.promptTokenCount < 0) return null;
  const prompt = metadata.promptTokenCount;
  const candidates = metadata.candidatesTokenCount ?? 0;
  const thoughts = metadata.thoughtsTokenCount ?? 0;
  const total = metadata.totalTokenCount;
  if (!Number.isSafeInteger(candidates) || !Number.isSafeInteger(thoughts) || !Number.isSafeInteger(total) || total < prompt) return null;
  return {
    prompt, candidates, thoughts, total,
    cached: metadata.cachedContentTokenCount ?? 0,
    output: Math.max(candidates + thoughts, total - prompt),
    traffic: metadata.trafficType,
  };
}

export function errorCode(error) {
  const status = error?.status ?? error?.response?.status ?? error?.code;
  if (typeof status === "number") return `HTTP_${status}`;
  if (typeof status === "string" && /^[A-Z0-9_]{1,40}$/.test(status)) return status;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "TIMEOUT";
  return "REQUEST_FAILED";
}
