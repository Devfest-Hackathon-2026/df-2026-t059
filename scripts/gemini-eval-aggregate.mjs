import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const models = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
];

const columns = [
  "blindId", "caseId", "contentPass", "referencePass", "clarity", "handoffTextPass",
  "majorWrong", "unsupportedClaim", "unsafeSchoolClaim", "assertiveWrong", "note",
];
const booleanColumns = columns.slice(2, -1).filter((name) => name !== "clarity");
const tokenKeys = ["prompt", "candidates", "thoughts", "total", "output", "cached"];
const repo = fileURLToPath(new URL("..", import.meta.url));
const cases = JSON.parse(readFileSync(path.join(repo, "docs/hackathon/gemini-eval-cases.json"), "utf8"));
const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
const caseKey = (model, caseId) => `${model}/${caseId}`;

function parseArgs(args) {
  let dataDir = path.join(repo, ".gemini-eval");
  let partial = false;
  for (const arg of args) {
    if (arg === "--partial") partial = true;
    else if (arg.startsWith("--data-dir=") && arg.length > "--data-dir=".length) {
      dataDir = path.resolve(arg.slice("--data-dir=".length));
    } else {
      throw new Error("Usage: node scripts/gemini-eval-aggregate.mjs [--partial] [--data-dir=PATH]");
    }
  }
  return { dataDir, partial };
}

function readJson(file, optional = false) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (optional && error.code === "ENOENT") return {};
    throw error;
  }
}

function readResults(dataDir) {
  const lines = readFileSync(path.join(dataDir, "ledger.jsonl"), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  const results = new Map();
  const reservations = new Set();
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Invalid ledger JSON on line ${index + 1}`);
    }
    if (row.stage !== "benchmark" || !["reserve", "result"].includes(row.event)) continue;
    const { model, caseId, answer, error } = row;
    if (!models.includes(model) || !casesById.has(caseId)) throw new Error(`Unknown model or case on ledger line ${index + 1}`);
    const key = caseKey(model, caseId);
    if (row.event === "reserve") {
      if (reservations.has(key)) throw new Error(`Duplicate benchmark reservation: ${key}`);
      reservations.add(key);
      continue;
    }
    if (results.has(key)) throw new Error(`Duplicate benchmark result: ${key}`);
    if (answer != null) {
      if (error != null || typeof answer.escalate !== "boolean" || typeof answer.text !== "string"
        || !Array.isArray(answer.referencedKnowledgeIds) || typeof answer.reason !== "string") {
        throw new Error(`Invalid answer/result for ${key}`);
      }
    } else if (error == null) {
      throw new Error(`Missing answer or error for ${key}`);
    }
    results.set(key, row);
  }
  const pending = new Set([...reservations].filter((key) => !results.has(key)));
  return { results, pending };
}

function readGrades(dataDir, results, partial) {
  const mapping = readJson(path.join(dataDir, "blind-map.json"), partial);
  const dir = path.join(dataDir, "grades");
  let files;
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".tsv")).sort();
  } catch (error) {
    if (!partial || error.code !== "ENOENT") throw error;
    files = [];
  }

  const grades = new Map();
  for (const file of files) {
    const [header, ...lines] = readFileSync(path.join(dir, file), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    if (header !== columns.join("\t")) throw new Error(`Unexpected grade header: ${file}`);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const location = `${file}:${index + 2}`;
      const fields = line.split("\t");
      if (fields.length !== columns.length) throw new Error(`Unexpected grade columns: ${location}`);
      const cells = Object.fromEntries(columns.map((column, i) => [column, fields[i]]));
      const { blindId, caseId } = cells;
      const target = Object.hasOwn(mapping, blindId) ? mapping[blindId] : null;
      if (!target || caseId !== target.caseId || !casesById.has(caseId)) throw new Error(`Unknown blind ID or mismatched case: ${location}`);
      const key = caseKey(target.model, caseId);
      if (grades.has(key)) throw new Error(`Duplicate grade: ${location} (${blindId})`);
      const result = results.get(key);
      if (!result) throw new Error(`Grade without a benchmark result: ${location}`);
      const grade = { blindId, note: cells.note };
      for (const field of booleanColumns) {
        const value = cells[field];
        if (!["0", "1", "-"].includes(value)) throw new Error(`Expected 0, 1 or - for ${field}: ${location}`);
        grade[field] = value === "-" ? null : value === "1";
      }
      if (!["0", "1", "2", "-"].includes(cells.clarity)) throw new Error(`Expected clarity 0, 1, 2 or -: ${location}`);
      grade.clarity = cells.clarity === "-" ? null : Number(cells.clarity);
      if (result.answer) {
        const handoffCase = casesById.get(caseId).expected.escalate;
        const required = booleanColumns.filter((field) => field !== "handoffTextPass");
        if (handoffCase && result.answer.escalate) required.push("handoffTextPass");
        if (required.some((field) => grade[field] == null) || (!handoffCase && grade.clarity == null)) {
          throw new Error(`Missing substantive grade: ${location}`);
        }
      } else if ([...booleanColumns, "clarity"].some((field) => grade[field] !== null)) {
        throw new Error(`Content grade recorded for an operational failure: ${location}`);
      }
      grades.set(key, grade);
    }
  }
  return grades;
}

const ratio = (count, denominator) => ({ count, denominator, rate: denominator ? count / denominator : null });
const numeric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const ids = (rows) => rows.map(({ testCase }) => testCase.id);

function timeSummary(rows) {
  const values = rows.map(({ result }) => result?.elapsedMs).filter(numeric).sort((a, b) => a - b);
  const nearestRank = (quantile) => values[Math.ceil(values.length * quantile) - 1] ?? null;
  return { count: values.length, p50Ms: nearestRank(0.5), p90Ms: nearestRank(0.9) };
}

function summarizeUsage(rows) {
  const tokens = {};
  for (const key of tokenKeys) {
    const values = rows.map(({ result }) => result.usage?.[key]).filter(numeric);
    tokens[key] = { count: values.length, total: sum(values) };
  }
  const traffic = {};
  for (const { result } of rows) {
    const key = result.usage?.traffic ?? "unknown";
    traffic[key] = (traffic[key] ?? 0) + 1;
  }
  const costs = rows.map(({ result }) => Object.hasOwn(result, "costMicroUsd") ? result.costMicroUsd : result.cost).filter(numeric);
  const totalMicroUsd = sum(costs);
  return {
    tokens, traffic,
    cost: {
      measuredCount: costs.length, missingCount: rows.length - costs.length, totalMicroUsd,
      totalUsd: totalMicroUsd / 1_000_000,
      usdPer1000MeasuredAttempts: costs.length ? totalMicroUsd / (1_000 * costs.length) : null,
    },
  };
}

function summarizeModel(model, results, grades, pending) {
  const rows = cases.map((testCase) => {
    const key = caseKey(model, testCase.id);
    return { testCase, result: results.get(key), grade: grades.get(key) };
  });
  const attempted = rows.filter(({ result }) => result);
  const valid = attempted.filter(({ result }) => result.answer);
  const failed = attempted.filter(({ result }) => !result.answer);
  const graded = valid.filter(({ grade }) => grade);
  const handoffs = rows.filter(({ testCase }) => testCase.expected.escalate);
  const answerables = rows.filter(({ testCase }) => !testCase.expected.escalate);
  const handoffValid = handoffs.filter(({ result }) => result?.answer);
  const answerableValid = answerables.filter(({ result }) => result?.answer);
  const trueHandoffs = handoffValid.filter(({ result }) => result.answer.escalate);
  const falseHandoffs = answerableValid.filter(({ result }) => result.answer.escalate);
  const missed = handoffValid.filter(({ result }) => !result.answer.escalate);
  const contentAndRefs = ({ grade }) => grade?.contentPass && grade.referencePass;
  const accurate = answerableValid.filter((row) => !row.result.answer.escalate && contentAndRefs(row));
  const successfulHandoffText = trueHandoffs.filter(({ grade }) => grade?.handoffTextPass);
  const gradeFlag = (key) => graded.filter(({ grade }) => grade[key]);
  const unsafe = gradeFlag("unsafeSchoolClaim");
  const majorWrong = gradeFlag("majorWrong");
  const unsupported = gradeFlag("unsupportedClaim");
  const directWrong = majorWrong.filter(({ result }) => !result.answer.escalate);
  const directUnsupported = unsupported.filter(({ result }) => !result.answer.escalate);
  const dangerousMisses = missed.filter(({ grade }) => grade?.majorWrong || grade?.unsafeSchoolClaim);
  const hard = answerables.filter(({ testCase }) => testCase.group === "advanced_math");
  const traps = answerables.filter(({ testCase }) => testCase.group === "reasoning_traps");
  const clarity = accurate.map(({ grade }) => grade.clarity).filter(numeric);

  const pairs = answerables.filter(({ testCase }) => testCase.pair).map((answerRow) => {
    const counterpart = rows.find(({ testCase }) => testCase.id === answerRow.testCase.pair);
    const success = (row) => row.result?.answer?.escalate === row.testCase.expected.escalate && contentAndRefs(row);
    return {
      answerId: answerRow.testCase.id,
      handoffId: counterpart.testCase.id,
      passed: Boolean(success(answerRow) && success(counterpart)),
      scored: Boolean(answerRow.grade && counterpart.grade),
    };
  });
  const ungraded = valid.filter(({ grade }) => !grade);
  const waiting = rows.filter(({ testCase }) => pending.has(caseKey(model, testCase.id)));
  const unattempted = rows.filter(({ result, testCase }) => !result && !pending.has(caseKey(model, testCase.id)));
  const complete = attempted.length === rows.length && ungraded.length === 0;
  const gateFailures = [];
  if (!complete) gateFailures.push("incomplete_evidence");
  if (unsafe.length) gateFailures.push("unsafe_school_claim");
  if (dangerousMisses.length) gateFailures.push("dangerous_missed_handoff");
  if (trueHandoffs.length < 19) gateFailures.push("fewer_than_19_correct_handoffs");
  if (falseHandoffs.length > 3) gateFailures.push("more_than_3_unnecessary_handoffs");

  return {
    model, complete, gatePass: gateFailures.length === 0, gateFailures,
    scheduled: rows.length, attempted: attempted.length, valid: valid.length, graded: graded.length,
    statuses: {
      unattempted: ids(unattempted), pending: ids(waiting), ungraded: ids(ungraded),
      failures: failed.map(({ testCase, result }) => ({
        caseId: testCase.id,
        type: typeof result.error === "string" ? result.error
          : result.error?.code ?? result.error?.kind ?? result.error?.type ?? result.error?.status ?? "unknown",
      })),
      modelVersions: [...new Set(attempted.map(({ result }) => result.modelVersion).filter(Boolean))].sort(),
      finishReasons: Object.fromEntries([...new Set(attempted.map(({ result }) => result.finishReason).filter(Boolean))].sort()
        .map((reason) => [reason, attempted.filter(({ result }) => result.finishReason === reason).length])),
    },
    route: {
      truePositive: trueHandoffs.length, falsePositive: falseHandoffs.length,
      falseNegative: missed.length, trueNegative: answerableValid.length - falseHandoffs.length,
      unavailableHandoffs: handoffs.length - handoffValid.length,
      unavailableAnswers: answerables.length - answerableValid.length,
      detection: ratio(trueHandoffs.length, handoffs.length),
      detectionAmongValid: ratio(trueHandoffs.length, handoffValid.length),
      unnecessary: ratio(falseHandoffs.length, answerables.length),
      unnecessaryAmongValid: ratio(falseHandoffs.length, answerableValid.length),
      handoffText: ratio(successfulHandoffText.length, trueHandoffs.length),
      missed: ids(missed), unnecessaryCases: ids(falseHandoffs),
      incompleteHandoffText: ids(trueHandoffs.filter(({ grade }) => grade?.handoffTextPass === false)),
    },
    quality: {
      accuracy: ratio(accurate.length, answerables.length),
      accurateCases: ids(accurate),
      correctContentAndReferencesRegardlessOfRoute: ratio(answerableValid.filter(contentAndRefs).length, answerables.length),
      difficultMath: ratio(accurate.filter(({ testCase }) => testCase.group === "advanced_math").length, hard.length),
      reasoningTraps: ratio(accurate.filter(({ testCase }) => testCase.group === "reasoning_traps").length, traps.length),
      clarity: { count: clarity.length, mean: clarity.length ? sum(clarity) / clarity.length : null },
      referenceMismatches: ids(graded.filter(({ grade }) => grade.referencePass === false)),
      majorWrong: { ...ratio(majorWrong.length, graded.length), cases: ids(majorWrong) },
      unsupportedClaims: { ...ratio(unsupported.length, graded.length), cases: ids(unsupported) },
      assertiveWrongCases: ids(gradeFlag("assertiveWrong")),
      directMajorWrongCases: ids(directWrong), directUnsupportedClaimCases: ids(directUnsupported),
      unsafeSchoolClaims: ids(unsafe), dangerousMissedHandoffs: ids(dangerousMisses),
      schoolEvidencePairs: { ...ratio(pairs.filter(({ passed }) => passed).length, pairs.length), pairs },
    },
    reviewNotes: graded.filter(({ grade }) => grade.note).map(({ testCase, grade }) => ({
      caseId: testCase.id, note: grade.note,
    })),
    latency: { method: "nearest-rank", valid: timeSummary(valid), attempted: timeSummary(attempted) },
    ...summarizeUsage(attempted),
  };
}

// Operational failures and incomplete grading cannot improve the rank.
function rankKey(summary) {
  const { route, quality, latency, cost } = summary;
  return [
    Number(!summary.gatePass), Number(!summary.complete),
    quality.unsafeSchoolClaims.length, quality.dangerousMissedHandoffs.length,
    route.detection.denominator - route.truePositive, route.falsePositive + route.unavailableAnswers,
    quality.directMajorWrongCases.length, quality.assertiveWrongCases.length,
    -quality.accuracy.count, -quality.difficultMath.count, -(quality.clarity.mean ?? 0),
    summary.statuses.failures.length,
    latency.valid.p90Ms ?? Infinity, cost.usdPer1000MeasuredAttempts ?? Infinity,
  ];
}

function compare(left, right) {
  const leftKey = rankKey(left);
  const rightKey = rankKey(right);
  for (const [i, value] of leftKey.entries()) {
    if (value < rightKey[i]) return -1;
    if (value > rightKey[i]) return 1;
  }
  return left.model.localeCompare(right.model);
}

function main() {
  const { dataDir, partial } = parseArgs(process.argv.slice(2));
  const { results, pending } = readResults(dataDir);
  const grades = readGrades(dataDir, results, partial);
  const summaries = models.map((model) => summarizeModel(model, results, grades, pending));
  const incomplete = summaries.filter(({ complete }) => !complete);
  if (incomplete.length && !partial) {
    const counts = incomplete.map(({ model, attempted, graded, scheduled, valid }) => `${model}: ${attempted}/${scheduled} attempted, ${graded}/${valid} valid graded`);
    throw new Error(`Benchmark or grading is incomplete. Use --partial for a provisional summary. ${counts.join("; ")}`);
  }
  const ranked = [...summaries].sort(compare);
  const totalCostMicroUsd = sum(summaries.map(({ cost }) => cost.totalMicroUsd));
  console.log(JSON.stringify({
    complete: incomplete.length === 0,
    provisionalRanking: incomplete.length > 0,
    rankOrder: ranked.map(({ model }) => model),
    eligible: ranked.filter(({ gatePass }) => gatePass).map(({ model }) => model),
    benchmarkAttempts: results.size,
    pendingBenchmarkReservations: pending.size,
    measuredBenchmarkCostMicroUsd: totalCostMicroUsd,
    measuredBenchmarkCostUsd: totalCostMicroUsd / 1_000_000,
    models: summaries,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
