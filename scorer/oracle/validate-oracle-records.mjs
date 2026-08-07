// validate-oracle-records.mjs — OracleRecord conformance gate.
//
//   node scorer/oracle/validate-oracle-records.mjs   (run build-oracle.mjs first)
//
// Validates every generated survey×variant record against the converged
// private interface scorer/schemas/oracle-record.schema.json (v1.0.0) with
// ajv (draft 2020-12) + ajv-formats, then applies the cross-reference rules
// JSON Schema cannot express (threat-model §3 / schema $comment):
//   - duplicate oracleId / witnessPathId / defectId rejection;
//   - every reachability.witnessPathIds entry resolves to a witness path;
//   - every seededDefects[*].affectedObligationIds entry resolves to an
//     obligation in the same record;
//   - clean records carry exactly zero seeded defects, flawed at least one;
//   - index.json agrees with the records it points at (files, record ids,
//     counts, defect ids and affected-obligation sets).
// Exit code 1 on any failure.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { GENERATED_DIR, ORACLE_ROOT, loadCorpusIndex } from "./lib/corpus.mjs";
import { ORACLE_SCHEMA, INDEX_SCHEMA } from "./lib/serialize.mjs";

const Ajv2020 = AjvModule.default ?? AjvModule;
const addFormats = addFormatsModule.default ?? addFormatsModule;

const SCHEMA_PATH = join(ORACLE_ROOT, "..", "schemas", "oracle-record.schema.json");

let checks = 0;
let failures = 0;
function check(cond, label, detail) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL ${label}${detail ? " — " + detail : ""}`);
  }
  return !!cond;
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const corpus = loadCorpusIndex();
const expectedFiles = corpus.surveys.flatMap((s) => [`${s.id}.clean.json`, `${s.id}.flawed.json`]);

// Directory hygiene: exactly the 12 records + index.json, no strays.
const onDisk = readdirSync(GENERATED_DIR).filter((f) => f.endsWith(".json")).sort();
check(
  JSON.stringify(onDisk) === JSON.stringify([...expectedFiles, "index.json"].sort()),
  "generated/ contains exactly the 12 records + index.json",
  onDisk.join(", ")
);

const records = new Map(); // fileName -> record
let schemaValid = 0;
for (const file of expectedFiles) {
  const path = join(GENERATED_DIR, file);
  console.log(`=== ${file} ===`);
  if (!check(existsSync(path), `${file} exists`)) continue;
  const record = JSON.parse(readFileSync(path, "utf8"));
  records.set(file, record);

  // 1. Schema conformance.
  const ok = validate(record);
  if (check(ok, `${file}: validates against oracle-record.schema.json v${ORACLE_SCHEMA}`)) schemaValid++;
  if (!ok) {
    for (const err of (validate.errors || []).slice(0, 10)) {
      console.error(`    ${err.instancePath || "/"} ${err.message}`);
    }
    continue; // cross-refs on a shape-invalid record would just cascade
  }

  // 2. Uniqueness.
  const obligationIds = record.obligations.map((o) => o.oracleId);
  check(new Set(obligationIds).size === obligationIds.length, `${file}: oracleId values unique`);
  const pathIds = record.witnessPaths.map((p) => p.witnessPathId);
  check(new Set(pathIds).size === pathIds.length, `${file}: witnessPathId values unique`);
  const defectIds = record.seededDefects.map((d) => d.defectId);
  check(new Set(defectIds).size === defectIds.length, `${file}: defectId values unique`);

  // 3. Cross-references.
  const pathIdSet = new Set(pathIds);
  const obligationIdSet = new Set(obligationIds);
  let witnessOk = true;
  for (const ob of record.obligations) {
    for (const pid of ob.reachability.witnessPathIds) if (!pathIdSet.has(pid)) witnessOk = false;
    if (ob.reachability.status === "reachable" && ob.reachability.witnessPathIds.length === 0) witnessOk = false;
    if (ob.reachability.status === "unreachable" && ob.reachability.witnessPathIds.length > 0) witnessOk = false;
  }
  check(witnessOk, `${file}: witnessPathIds resolve and match reachability status`);
  let affectedOk = true;
  for (const d of record.seededDefects) {
    for (const id of d.affectedObligationIds) if (!obligationIdSet.has(id)) affectedOk = false;
  }
  check(affectedOk, `${file}: seededDefects.affectedObligationIds resolve to record obligations`);

  // 4. Variant/defect consistency (also schema-enforced; assert directly).
  const kind = record.survey.variant.kind;
  check(kind === (file.endsWith(".clean.json") ? "clean" : "flawed"), `${file}: variant.kind matches filename`);
  if (kind === "clean") check(record.seededDefects.length === 0, `${file}: clean record has zero seeded defects`);
  else check(record.seededDefects.length >= 1, `${file}: flawed record has at least one seeded defect`);
  check(record.oracleRecordId === `${record.survey.surveyId}.${kind}`, `${file}: oracleRecordId is surveyId.kind`);
}

// 5. Index cross-refs.
console.log("=== index.json ===");
const index = JSON.parse(readFileSync(join(GENERATED_DIR, "index.json"), "utf8"));
check(index.schema === INDEX_SCHEMA, `index.json schema is ${INDEX_SCHEMA}`, index.schema);
check(index.recordSchemaVersion === ORACLE_SCHEMA, `index.json recordSchemaVersion is ${ORACLE_SCHEMA}`);
check(index.surveys.length === corpus.surveys.length, "index.json covers every corpus survey");
for (const s of index.surveys) {
  for (const [variant, entry] of Object.entries(s.variants)) {
    const record = records.get(entry.file);
    if (!check(!!record, `index ${s.id} ${variant}: file ${entry.file} is a validated record`)) continue;
    check(entry.oracleRecordId === record.oracleRecordId, `index ${s.id} ${variant}: oracleRecordId matches record`);
    check(entry.counts.total === record.obligations.length, `index ${s.id} ${variant}: obligation count matches record`);
    check(entry.witnessPaths === record.witnessPaths.length, `index ${s.id} ${variant}: witness path count matches record`);
    check(
      entry.unreachableObligations ===
        record.obligations.filter((o) => o.reachability.status === "unreachable").length,
      `index ${s.id} ${variant}: unreachable count matches record`
    );
    check(
      JSON.stringify(entry.seededDefectIds) === JSON.stringify(record.seededDefects.map((d) => d.defectId)),
      `index ${s.id} ${variant}: seededDefectIds match record`
    );
  }
  const flawedRecord = records.get(s.variants.flawed.file);
  if (flawedRecord) {
    check(
      JSON.stringify(s.seededDefects) ===
        JSON.stringify(
          flawedRecord.seededDefects.map((d) => ({
            defectId: d.defectId,
            category: d.category,
            locator: d.sourceAnchor.locator,
            affectedObligationIds: d.affectedObligationIds,
          }))
        ),
      `index ${s.id}: seeded defect summary matches flawed record`
    );
  }
}

console.log(`\n${records.size} records, ${schemaValid} schema-valid; ${checks} checks, ${failures} failures`);
if (failures > 0) process.exit(1);
console.log("ORACLE RECORDS VALID");
