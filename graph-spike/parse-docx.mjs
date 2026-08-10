// parse-docx.mjs — OPTIONAL experiment: compile Graph-D from the .docx prose
// instead of from the manifest, using a deterministic parser (no model).
//
// READ THE CAVEAT BEFORE QUOTING THE NUMBER. The corpus's .docx files are
// GENERATED from the manifests by lib/describe.mjs, so their programmer-English
// is perfectly regular ("TERMINATE IF S1=4 (LABEL).", "IF ..., SKIP TO Q8."). A
// regex parser therefore does extremely well here, and that result is an UPPER
// BOUND on a template-regular document, not an estimate for real client
// questionnaires — which mix prose, tables, inconsistent question numbering,
// logic in comments, and logic that is only implied.
import { docxLines } from "./docx-text.mjs";

const dec = (s) => String(s).replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function parseDocx(path) {
  const lines = docxLines(path).map(dec);
  const m = { schema: "branching-survey/v1", id: null, title: lines[0] || null, questions: [], loops: [], computed: [] };
  const warnings = [];
  let q = null;
  let section = null;
  const computedLabels = new Map();

  const push = () => { if (q) m.questions.push(q); q = null; };

  for (const raw of lines) {
    const line = raw.trim();
    let mm;

    if ((mm = /^--- SECTION: (.+?) ---$/.exec(line))) { section = mm[1]; continue; }

    if ((mm = /^([A-Za-z]+\d+)\.\s+(.*)$/.exec(line)) && !/^\d/.test(mm[1])) {
      push();
      q = {
        id: mm[1], section, type: "radio",
        text: mm[2].replace(/\[PIPE: current (\w+) item\]/g, "{LOOP}").replace(/\[PIPE: (\w+) selection\]/g, "{$1}"),
        options: [], rules: [],
      };
      continue;
    }
    if (!q) continue;

    if ((mm = /^(\d+)\)\s+(.*)$/.exec(line))) {
      const exclusive = /\[EXCLUSIVE\]/.test(mm[2]);
      q.options.push({ code: Number(mm[1]), label: mm[2].replace(/\s*\[EXCLUSIVE\]\s*$/, "").trim(), ...(exclusive ? { exclusive: true } : {}) });
      continue;
    }
    if ((mm = /^(r\d+)\)\s+(.*)$/.exec(line))) {
      q.rows ??= [];
      q.rows.push({ code: mm[1], label: mm[2].trim() });
      continue;
    }
    if ((mm = /^\[INSTRUCTION:\s*([\s\S]*?)\]$/.exec(line))) {
      q.instruction = mm[1].trim();
      if (/select all that apply/i.test(q.instruction)) q.type = "checkbox";
      continue;
    }
    if ((mm = /^\[NUMERIC ENTRY, range (-?\d+)[–-](-?\d+)\]$/.exec(line))) {
      q.type = "number"; q.min = Number(mm[1]); q.max = Number(mm[2]); q.options = []; continue;
    }
    if ((mm = /^\[RATING SCALE (-?\d+)[–-](-?\d+)\]$/.exec(line))) {
      q.type = "rating"; q.min = Number(mm[1]); q.max = Number(mm[2]); q.options = []; continue;
    }
    if (/^\[OPEN TEXT ENTRY\]$/.test(line)) { q.type = "text"; q.options = []; continue; }
    if (/^\[ALLOCATION TABLE/.test(line)) { q.type = "allocation"; q.options = []; q.rows ??= []; continue; }
    if (/^\[MULTI-SELECT/.test(line) || /Select all that apply/i.test(q.instruction || "")) q.type = "checkbox";
    if (/^\[PIPING:/.test(line)) continue;

    if ((mm = /^SUM OF ALL ROWS MUST EQUAL (\d+)\.$/.exec(line))) {
      q.type = "allocation";
      q.allocation = Object.assign({ enforceTotal: true }, q.allocation, { total: Number(mm[1]) });
      continue;
    }
    if ((mm = /^EACH ROW: MINIMUM (\d+), MAXIMUM (\d+)/.exec(line))) {
      q.allocation = Object.assign({ enforceTotal: true }, q.allocation, { rowMin: Number(mm[1]), rowMax: Number(mm[2]) });
      continue;
    }
    if ((mm = /^ROW (r\d+) \('.*?'\):\s*(.*)\.$/.exec(line))) {
      const row = (q.rows || []).find((r) => r.code === mm[1]);
      if (row) {
        const mn = /MINIMUM (\d+)/.exec(mm[2]);
        const mx = /MAXIMUM (\d+)/.exec(mm[2]);
        if (mn) row.min = Number(mn[1]);
        if (mx) row.max = Number(mx[1]);
      } else warnings.push(`row override for unknown row ${mm[1]}`);
      continue;
    }
    if ((mm = /^PROGRAMMER: (ROTATE OPTION ORDER ACROSS RESPONDENTS|RANDOMIZE OPTION ORDER)(.*)\.$/.exec(line))) {
      q.randomize = { mode: mm[1].startsWith("ROTATE") ? "rotate" : "shuffle" };
      const anchors = [...mm[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      if (anchors.length) {
        q.randomize.anchorLastCodes = anchors
          .map((lab) => (q.options.find((o) => o.label.toUpperCase() === lab.toUpperCase()) || {}).code)
          .filter((c) => c !== undefined);
        if (q.randomize.anchorLastCodes.length !== anchors.length) warnings.push(`${q.id}: anchor label not matched to a code`);
      }
      continue;
    }
    if ((mm = /^PROGRAMMER: SHOW ONLY THE OPTIONS SELECTED AT (\w+)(?: \(EXCLUDE (.+?)\))?\.$/.exec(line))) {
      q.optionsFrom = { q: mm[1] };
      if (mm[2]) q.optionsFrom.__excludeLabels = [...mm[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      q.options = [];
      continue;
    }
    if ((mm = /^PROGRAMMER: COMPUTE (.+?) = (.+?)\.$/.exec(line))) {
      const label = mm[1].trim();
      const refs = [...mm[2].matchAll(/(\w+)\s+(r\d+)/g)].map((x) => `${x[1]}.${x[2]}`);
      const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      computedLabels.set(label, id);
      m.computed.push({ id, label, expr: { op: "sum", refs } });
      continue;
    }
    if ((mm = /^LOOP (\w+): REPEAT (\w+)(?:-(\w+))? FOR EACH OPTION SELECTED AT (\w+)(?: \(EXCLUDING (.+?)\))?, IN THE ORDER LISTED AT \w+(?:, MAXIMUM (\d+) ITERATIONS)?\./.exec(line))) {
      m.loops.push({
        id: mm[1], source: mm[4], __blockFrom: mm[2], __blockTo: mm[3] || mm[2],
        __excludeLabels: mm[5] ? [...mm[5].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [],
        ...(mm[6] ? { max: Number(mm[6]) } : {}),
      });
      continue;
    }
    if ((mm = /^TERMINATE IF (.+?)\.$/.exec(line))) {
      const cond = parseCond(mm[1], m, computedLabels, warnings);
      q.rules.push({ if: cond, terminate: slug(mm[1]) });
      continue;
    }
    if (/^TERMINATE\.$/.test(line)) { q.rules.push({ terminate: "terminate" }); continue; }
    if ((mm = /^IF (.+?), SKIP TO (\w+)\.$/.exec(line))) {
      q.rules.push({ if: parseCond(mm[1], m, computedLabels, warnings), goto: mm[2] });
      continue;
    }
    if ((mm = /^AFTER THIS QUESTION, SKIP TO (\w+)\.$/.exec(line))) { q.rules.push({ goto: mm[1] }); continue; }
    if (/^(Intro text|Programming:|SCREENER AND MAIN)/.test(line)) continue;
  }
  push();

  // resolve label-based references now that every question is known
  const byId = new Map(m.questions.map((x) => [x.id, x]));
  for (const qq of m.questions) {
    if (qq.optionsFrom?.__excludeLabels) {
      const src = byId.get(qq.optionsFrom.q);
      qq.optionsFrom.exclude = qq.optionsFrom.__excludeLabels
        .map((lab) => (src?.options || []).find((o) => o.label.toUpperCase() === lab.toUpperCase())?.code)
        .filter((c) => c !== undefined);
      delete qq.optionsFrom.__excludeLabels;
    }
    if (!qq.rules.length) delete qq.rules;
    if (qq.type !== "allocation") delete qq.rows;
  }
  for (const l of m.loops) {
    const a = m.questions.findIndex((x) => x.id === l.__blockFrom);
    const b = m.questions.findIndex((x) => x.id === l.__blockTo);
    l.block = a >= 0 && b >= a ? m.questions.slice(a, b + 1).map((x) => x.id) : [l.__blockFrom];
    const src = byId.get(l.source);
    l.exclude = (l.__excludeLabels || [])
      .map((lab) => (src?.options || []).find((o) => o.label.toUpperCase() === lab.toUpperCase())?.code)
      .filter((c) => c !== undefined);
    delete l.__blockFrom; delete l.__blockTo; delete l.__excludeLabels;
    if (!l.exclude.length) delete l.exclude;
  }
  if (!m.loops.length) delete m.loops;
  if (!m.computed.length) delete m.computed;
  return { manifest: m, warnings };
}

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40); }

function parseCond(text, manifest, computedLabels, warnings) {
  const t = text.trim();
  if (/ OR /.test(t)) return { op: "or", terms: t.split(/ OR /).map((x) => parseCond(x, manifest, computedLabels, warnings)) };
  if (/ AND /.test(t)) return { op: "and", terms: t.split(/ AND /).map((x) => parseCond(x, manifest, computedLabels, warnings)) };
  let mm;
  if ((mm = /^FEWER THAN (\d+) OPTIONS SELECTED AT (\w+)$/.exec(t))) return { q: mm[2], op: "countLt", value: Number(mm[1]) };
  if ((mm = /^AT MOST (\d+) OPTIONS SELECTED AT (\w+)$/.exec(t))) return { q: mm[2], op: "countLte", value: Number(mm[1]) };
  if ((mm = /^MORE THAN (\d+) OPTIONS SELECTED AT (\w+)$/.exec(t))) return { q: mm[2], op: "countGt", value: Number(mm[1]) };
  if ((mm = /^(\d+) OR MORE OPTIONS SELECTED AT (\w+)$/.exec(t))) return { q: mm[2], op: "countGte", value: Number(mm[1]) };
  if ((mm = /^EXACTLY (\d+) OPTIONS SELECTED AT (\w+)$/.exec(t))) return { q: mm[2], op: "countEq", value: Number(mm[1]) };
  if ((mm = /^(\w+) INCLUDES (\d+)/.exec(t))) return { q: mm[1], op: "includes", value: Number(mm[2]) };
  if ((mm = /^(\w+) DOES NOT INCLUDE (\d+)/.exec(t))) return { q: mm[1], op: "notIncludes", value: Number(mm[2]) };
  if ((mm = /^(\w+)\s*=\s*(\d+)/.exec(t))) return { q: mm[1], op: "eq", value: Number(mm[2]) };
  if ((mm = /^(\w+) IS NOT (\d+)/.exec(t))) return { q: mm[1], op: "ne", value: Number(mm[2]) };
  if ((mm = /^(.+?)\s*(<=|>=|<|>)\s*(-?\d+)$/.exec(t))) {
    const op = { "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" }[mm[2]];
    const lhs = mm[1].trim();
    if (computedLabels.has(lhs)) return { var: computedLabels.get(lhs), op, value: Number(mm[3]) };
    return { q: lhs, op, value: Number(mm[3]) };
  }
  warnings.push("unparsed condition: " + t);
  return { op: "always", __unparsed: t };
}
