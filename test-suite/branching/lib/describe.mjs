// describe.mjs — renders the machine-readable manifest logic (conditions,
// rules, loops, allocation constraints, randomization, piping, computed
// variables) as the programmer-English instructions a real questionnaire
// would carry ("IF Q3=2 SKIP TO Q7", "TERMINATE IF ...", "SUM MUST EQUAL
// 100"). Shared by gen-branching-docx.mjs (writes the instructions into the
// .docx) and validate.mjs (asserts the same strings appear in the .docx), so
// document and ground truth cannot drift apart.

function questionById(manifest, qid) {
  return manifest.questions.find((q) => q.id === qid) || null;
}

function optionLabel(manifest, qid, code) {
  const q = questionById(manifest, qid);
  const opt = (q?.options || []).find((o) => o.code === code);
  return opt ? opt.label : null;
}

function rowLabel(manifest, ref) {
  const dot = ref.indexOf(".");
  if (dot === -1) return null;
  const q = questionById(manifest, ref.slice(0, dot));
  const row = (q?.rows || []).find((r) => r.code === ref.slice(dot + 1));
  return row ? row.label : null;
}

export function refToText(manifest, ref) {
  const dot = ref.indexOf(".");
  if (dot === -1) return ref;
  const label = rowLabel(manifest, ref);
  const base = `${ref.slice(0, dot)} ${ref.slice(dot + 1)}`;
  return label ? `${base} (${label.toUpperCase()})` : base;
}

export function computedToText(manifest, comp) {
  const parts = (comp.expr?.refs || []).map((r) => refToText(manifest, r));
  return `COMPUTE ${comp.label} = ${parts.join(" + ")}.`;
}

export function conditionToText(manifest, cond) {
  if (!cond || cond.op === "always") return "ALWAYS";
  if (cond.op === "and" || cond.op === "or") {
    return (cond.terms || [])
      .map((t) => conditionToText(manifest, t))
      .join(cond.op === "and" ? " AND " : " OR ");
  }
  if (cond.var !== undefined) {
    const comp = (manifest.computed || []).find((c) => c.id === cond.var);
    const name = comp ? comp.label : cond.var;
    const sym = { lt: "<", lte: "<=", gt: ">", gte: ">=", eq: "=", ne: "IS NOT" }[cond.op] || cond.op;
    return `${name} ${sym} ${cond.value}`;
  }
  const qid = cond.q;
  const withLabel = (code) => {
    const label = optionLabel(manifest, qid, code);
    return label ? `${code} (${label.toUpperCase()})` : String(code);
  };
  switch (cond.op) {
    case "eq": return `${qid}=${withLabel(cond.value)}`;
    case "ne": return `${qid} IS NOT ${withLabel(cond.value)}`;
    case "lt": return `${qid} < ${cond.value}`;
    case "lte": return `${qid} <= ${cond.value}`;
    case "gt": return `${qid} > ${cond.value}`;
    case "gte": return `${qid} >= ${cond.value}`;
    case "includes": return `${qid} INCLUDES ${withLabel(cond.value)}`;
    case "notIncludes": return `${qid} DOES NOT INCLUDE ${withLabel(cond.value)}`;
    case "countLt": return `FEWER THAN ${cond.value} OPTIONS SELECTED AT ${qid}`;
    case "countLte": return `AT MOST ${cond.value} OPTIONS SELECTED AT ${qid}`;
    case "countGt": return `MORE THAN ${cond.value} OPTIONS SELECTED AT ${qid}`;
    case "countGte": return `${cond.value} OR MORE OPTIONS SELECTED AT ${qid}`;
    case "countEq": return `EXACTLY ${cond.value} OPTIONS SELECTED AT ${qid}`;
    default: return JSON.stringify(cond);
  }
}

export function ruleToText(manifest, rule) {
  if (rule.terminate) {
    return rule.if
      ? `TERMINATE IF ${conditionToText(manifest, rule.if)}.`
      : "TERMINATE.";
  }
  if (rule.goto) {
    return rule.if
      ? `IF ${conditionToText(manifest, rule.if)}, SKIP TO ${rule.goto}.`
      : `AFTER THIS QUESTION, SKIP TO ${rule.goto}.`;
  }
  return "";
}

export function loopToText(manifest, loop) {
  const src = questionById(manifest, loop.source);
  const excluded = (loop.exclude || [])
    .map((c) => optionLabel(manifest, loop.source, c))
    .filter(Boolean)
    .map((l) => `'${l.toUpperCase()}'`);
  const span = loop.block.length > 1
    ? `${loop.block[0]}-${loop.block[loop.block.length - 1]}`
    : loop.block[0];
  let text = `LOOP ${loop.id}: REPEAT ${span} FOR EACH OPTION SELECTED AT ${loop.source}`;
  if (excluded.length) text += ` (EXCLUDING ${excluded.join(", ")})`;
  text += `, IN THE ORDER LISTED AT ${loop.source}`;
  if (loop.max !== undefined) text += `, MAXIMUM ${loop.max} ITERATIONS`;
  text += ". PIPE THE CURRENT ITEM INTO EACH QUESTION IN THE LOOP.";
  return text;
}

export function randomizeToText(manifest, q) {
  const rnd = q.randomize;
  if (!rnd) return null;
  const anchors = (rnd.anchorLastCodes || [])
    .map((c) => optionLabel(manifest, q.id, c))
    .filter(Boolean)
    .map((l) => `'${l.toUpperCase()}'`);
  let text = rnd.mode === "rotate" ? "ROTATE OPTION ORDER ACROSS RESPONDENTS" : "RANDOMIZE OPTION ORDER";
  if (anchors.length) text += `; ALWAYS KEEP ${anchors.join(", ")} LAST`;
  return `PROGRAMMER: ${text}.`;
}

export function optionsFromToText(manifest, q) {
  if (!q.optionsFrom) return null;
  const excluded = (q.optionsFrom.exclude || [])
    .map((c) => optionLabel(manifest, q.optionsFrom.q, c))
    .filter(Boolean)
    .map((l) => `'${l.toUpperCase()}'`);
  let text = `PROGRAMMER: SHOW ONLY THE OPTIONS SELECTED AT ${q.optionsFrom.q}`;
  if (excluded.length) text += ` (EXCLUDE ${excluded.join(", ")})`;
  return text + ".";
}

export function allocationLines(q) {
  const alloc = q.allocation || {};
  const lines = [`SUM OF ALL ROWS MUST EQUAL ${alloc.total}.`];
  const rowMin = alloc.rowMin !== undefined ? alloc.rowMin : 0;
  const rowMax = alloc.rowMax !== undefined ? alloc.rowMax : alloc.total;
  lines.push(`EACH ROW: MINIMUM ${rowMin}, MAXIMUM ${rowMax}, WHOLE NUMBERS ONLY.`);
  for (const row of q.rows || []) {
    const overrides = [];
    if (row.min !== undefined) overrides.push(`MINIMUM ${row.min}`);
    if (row.max !== undefined) overrides.push(`MAXIMUM ${row.max}`);
    if (overrides.length) {
      lines.push(`ROW ${row.code} ('${row.label.toUpperCase()}'): ${overrides.join(", ")}.`);
    }
  }
  return lines;
}

/**
 * Question text as the DOCX prints it: piping tokens become human-readable
 * placeholders ({Q2} -> [PIPE: Q2 selection], {LOOP} -> [PIPE: current LX item]).
 */
export function docText(manifest, q) {
  const loop = (manifest.loops || []).find((l) => l.block.includes(q.id));
  return String(q.text).replace(/\{([A-Za-z0-9_]+)\}/g, (whole, token) => {
    if (token === "LOOP") return loop ? `[PIPE: current ${loop.id} item]` : whole;
    return `[PIPE: ${token} selection]`;
  });
}
