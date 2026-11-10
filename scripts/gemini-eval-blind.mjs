import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRows, workDir } from "./gemini-eval-budget.mjs";

const input = JSON.parse(readFileSync("docs/hackathon/gemini-eval-cases.json", "utf8"));
const saltPath = resolve(workDir, "blind-salt");
if (!existsSync(saltPath)) writeFileSync(saltPath, randomBytes(24).toString("hex"), { flag: "wx" });
const salt = readFileSync(saltPath, "utf8");
const hash = (id) => createHash("sha256").update(`${salt}:${id}`).digest("hex").slice(0, 12);
const ledger = readRows(resolve(workDir, "ledger.jsonl"));
const finished = ledger.filter(({ event, stage }) => event === "result" && stage === "benchmark");
const directory = resolve(workDir, "blind");
mkdirSync(directory, { recursive: true });
function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
const mapping = {};
for (const { id: caseId, expected, group, messages, knowledge } of input) {
  const rows = finished.filter((row) => row.caseId === caseId);
  const blind = rows.flatMap(({ answer, model, key }) => {
    if (!answer) return [];
    const blindId = hash(key);
    mapping[blindId] = { caseId, model };
    return [{ blindId, ...answer, text: answer.text.slice(0, 4_000) }];
  }).sort((a, b) => a.blindId.localeCompare(b.blindId));
  writeJson(resolve(directory, `${caseId}.json`), { caseId, group, messages, knowledge, expected, complete: rows.length === 4, answers: blind });
}
writeJson(resolve(workDir, "blind-map.json"), mapping);
console.log(JSON.stringify({ finished: finished.length, gradeable: Object.keys(mapping).length, completeCases: input.filter((q) => finished.filter((r) => r.caseId === q.id).length === 4).map((q) => q.id) }));
