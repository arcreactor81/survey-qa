// schema-guard.mjs — strict coverage check of manifest constructs.
//
// The oracle taxonomy must account for EVERY construct a manifest can carry.
// This walker knows the complete branching-survey/v1 vocabulary (keys and
// enums); anything it does not recognize is reported as an unmapped
// construct, and the build/selfcheck fail loudly. This is the "zero unmapped
// manifest features" guarantee: a future manifest with a new construct
// cannot silently produce an incomplete obligation set.

const ENUMS = {
  questionType: ["radio", "checkbox", "number", "text", "rating", "allocation"],
  condOp: [
    "and", "or", "always",
    "eq", "ne", "lt", "lte", "gt", "gte",
    "includes", "notIncludes",
    "countLt", "countLte", "countGt", "countGte", "countEq",
  ],
  exprOp: ["sum"],
  randomizeMode: ["shuffle", "rotate"],
  patchOp: ["replace", "remove", "add"],
};

const KEYS = {
  top: [
    "schema", "id", "variant", "title", "intro", "seed",
    "questions", "loops", "computed",
    "basedOn", "seededErrors", "notes",
    "terminateHtml", "completedHtml",
  ],
  question: [
    "id", "section", "type", "text", "instruction",
    "options", "optionsFrom", "min", "max",
    "rows", "allocation", "randomize", "rules", "piping",
  ],
  option: ["code", "label", "exclusive"],
  row: ["code", "label", "min", "max"],
  rule: ["if", "goto", "terminate", "reason"],
  cond: ["q", "var", "op", "value", "terms"],
  loop: ["id", "source", "exclude", "block", "max", "note"],
  computed: ["id", "label", "expr", "note"],
  expr: ["op", "refs"],
  randomize: ["mode", "anchorLastCodes"],
  allocation: ["total", "rowMin", "rowMax", "enforceTotal"],
  optionsFrom: ["q", "exclude"],
  piping: ["source", "note"],
  seededError: ["id", "category", "location", "description", "patch"],
  patchOp: ["op", "path", "value"],
};

function checkKeys(obj, spec, path, out) {
  for (const k of Object.keys(obj || {})) {
    if (!KEYS[spec].includes(k)) out.push(`${path}/${k}: unknown ${spec} key`);
  }
}

function checkEnum(value, name, path, out) {
  if (value !== undefined && !ENUMS[name].includes(value)) {
    out.push(`${path}: unknown ${name} value ${JSON.stringify(value)}`);
  }
}

function checkCond(cond, path, out) {
  if (!cond) return;
  checkKeys(cond, "cond", path, out);
  checkEnum(cond.op, "condOp", `${path}/op`, out);
  for (const [i, t] of (cond.terms || []).entries()) checkCond(t, `${path}/terms/${i}`, out);
}

/**
 * Returns a list of unmapped-construct strings (empty = fully covered).
 * Runs on the RAW manifest (answer key included, when present).
 */
export function checkManifestCoverage(manifest, label) {
  const out = [];
  const at = (p) => `${label}${p}`;
  checkKeys(manifest, "top", at(""), out);

  for (const [qi, q] of (manifest.questions || []).entries()) {
    const qp = at(`/questions/${qi}(${q.id ?? "?"})`);
    checkKeys(q, "question", qp, out);
    checkEnum(q.type, "questionType", `${qp}/type`, out);
    for (const [oi, o] of (q.options || []).entries()) checkKeys(o, "option", `${qp}/options/${oi}`, out);
    for (const [ri, r] of (q.rows || []).entries()) checkKeys(r, "row", `${qp}/rows/${ri}`, out);
    if (q.allocation) checkKeys(q.allocation, "allocation", `${qp}/allocation`, out);
    if (q.randomize) {
      checkKeys(q.randomize, "randomize", `${qp}/randomize`, out);
      checkEnum(q.randomize.mode, "randomizeMode", `${qp}/randomize/mode`, out);
    }
    if (q.optionsFrom) checkKeys(q.optionsFrom, "optionsFrom", `${qp}/optionsFrom`, out);
    if (q.piping) checkKeys(q.piping, "piping", `${qp}/piping`, out);
    for (const [ri, rule] of (q.rules || []).entries()) {
      const rp = `${qp}/rules/${ri}`;
      checkKeys(rule, "rule", rp, out);
      checkCond(rule.if, `${rp}/if`, out);
    }
  }
  for (const [li, loop] of (manifest.loops || []).entries()) {
    checkKeys(loop, "loop", at(`/loops/${li}`), out);
  }
  for (const [ci, comp] of (manifest.computed || []).entries()) {
    const cp = at(`/computed/${ci}`);
    checkKeys(comp, "computed", cp, out);
    if (comp.expr) {
      checkKeys(comp.expr, "expr", `${cp}/expr`, out);
      checkEnum(comp.expr.op, "exprOp", `${cp}/expr/op`, out);
    }
  }
  for (const [ei, e] of (manifest.seededErrors || []).entries()) {
    const ep = at(`/seededErrors/${ei}`);
    checkKeys(e, "seededError", ep, out);
    for (const [pi, op] of (e.patch || []).entries()) {
      checkKeys(op, "patchOp", `${ep}/patch/${pi}`, out);
      checkEnum(op.op, "patchOp", `${ep}/patch/${pi}/op`, out);
    }
  }
  return out;
}
