/**
 * Closed codec for the Pass-A cross-window discovery ceiling.
 *
 * Pure ESM lets the Worker, Node record assembler, and report projection interpret the
 * same sealed supplement. Its JSON suffix keeps every count typed and round-trippable.
 */

export const PASS_A_CROSS_WINDOW_LIMITATION_KIND = "pass-a-cross-window-candidate-dependence";
export const CROSS_WINDOW_DISCOVERY_BLOCKER_KIND = "DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE";
export const CROSS_WINDOW_LIMITATION_SUPPLEMENT_PREFIX =
  "PASS_A_CROSS_WINDOW_CANDIDATE_DEPENDENCE: ";
const PASS_A_HASH = /^sha256:[0-9a-f]{64}$/;

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const EXPECTED_KEYS = [
  "candidatesSynthesized",
  "candidatesUngrounded",
  "detail",
  "kind",
  "sourceEvidenceBlocks",
  "sourceEvidenceSpans",
  "synthesisAdditions",
  "windowsTotal",
].sort();

function sameKeys(value) {
  const actual = Object.keys(value).sort();
  return actual.length === EXPECTED_KEYS.length &&
    actual.every((key, index) => key === EXPECTED_KEYS[index]);
}

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`PASS_A_CROSS_WINDOW_LIMITATION_INVALID: ${field} must be a non-negative safe integer`);
  }
  return value;
}

/** Validate and normalize one row. Unknown fields refuse rather than gaining silent meaning. */
export function validatePassACrossWindowLimitation(value) {
  if (!isObj(value) || !sameKeys(value)) {
    throw new TypeError(
      `PASS_A_CROSS_WINDOW_LIMITATION_INVALID: expected exactly [${EXPECTED_KEYS.join(", ")}]`,
    );
  }
  if (value.kind !== PASS_A_CROSS_WINDOW_LIMITATION_KIND) {
    throw new TypeError(`PASS_A_CROSS_WINDOW_LIMITATION_INVALID: unsupported kind ${String(value.kind)}`);
  }
  if (typeof value.detail !== "string" || value.detail.trim().length === 0) {
    throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: detail must be a non-empty string");
  }
  const row = {
    kind: PASS_A_CROSS_WINDOW_LIMITATION_KIND,
    windowsTotal: count(value.windowsTotal, "windowsTotal"),
    candidatesSynthesized: count(value.candidatesSynthesized, "candidatesSynthesized"),
    candidatesUngrounded: count(value.candidatesUngrounded, "candidatesUngrounded"),
    sourceEvidenceBlocks: count(value.sourceEvidenceBlocks, "sourceEvidenceBlocks"),
    sourceEvidenceSpans: count(value.sourceEvidenceSpans, "sourceEvidenceSpans"),
    synthesisAdditions: count(value.synthesisAdditions, "synthesisAdditions"),
    detail: value.detail,
  };
  if (row.windowsTotal <= 1) {
    throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: candidate dependence requires at least two windows");
  }
  return row;
}

/** Multi-window completion must carry exactly one limitation; missing is not zero. */
export function limitationsFromPassAPayload(payload) {
  if (!isObj(payload) || !isObj(payload.slice)) {
    throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: Pass-A payload or slice is missing");
  }
  const windowsTotal = count(payload.slice.windowsTotal, "slice.windowsTotal");
  const windowsLanded = count(payload.slice.windowsLanded, "slice.windowsLanded");
  const windowsRemaining = count(payload.slice.windowsRemaining, "slice.windowsRemaining");
  if (
    payload.slice.done !== true ||
    payload.slice.terminalFailure !== false ||
    windowsRemaining !== 0 ||
    windowsLanded !== windowsTotal
  ) {
    throw new TypeError(
      "PASS_A_CROSS_WINDOW_LIMITATION_INVALID: retained Pass-A payload is not an exact successful completion " +
        `(done=${String(payload.slice.done)}, terminalFailure=${String(payload.slice.terminalFailure)}, ` +
        `windowsLanded=${windowsLanded}, windowsTotal=${windowsTotal}, windowsRemaining=${windowsRemaining})`,
    );
  }
  if (!Array.isArray(payload.crossWindowLimitations)) {
    throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: crossWindowLimitations was not evaluated");
  }
  const rows = payload.crossWindowLimitations.map(validatePassACrossWindowLimitation);
  if (windowsTotal <= 1) {
    if (payload.slice.synthesisState !== "not-required") {
      throw new TypeError(
        `PASS_A_CROSS_WINDOW_LIMITATION_INVALID: ${windowsTotal} window requires synthesisState=not-required, got ${String(
          payload.slice.synthesisState,
        )}`,
      );
    }
    if (rows.length !== 0) {
      throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: a single-window pass cannot claim cross-window synthesis");
    }
    return [];
  }
  if (payload.slice.synthesisState !== "ok") {
    throw new TypeError(
      `PASS_A_CROSS_WINDOW_LIMITATION_INVALID: ${windowsTotal} windows require synthesisState=ok, got ${String(
        payload.slice.synthesisState,
      )}`,
    );
  }
  if (rows.length !== 1 || rows[0].windowsTotal !== windowsTotal) {
    throw new TypeError(
      `PASS_A_CROSS_WINDOW_LIMITATION_INVALID: ${windowsTotal} windows require one matching counted limitation`,
    );
  }
  return rows;
}

export function crossWindowLimitationSupplement(value, passAHash) {
  const row = validatePassACrossWindowLimitation(value);
  if (!PASS_A_HASH.test(passAHash)) {
    throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: supplement passAHash is malformed");
  }
  return `${CROSS_WINDOW_LIMITATION_SUPPLEMENT_PREFIX}${JSON.stringify({ ...row, passAHash })}`;
}

/** Null means unrelated. A named-but-malformed supplement throws. */
export function parseCrossWindowLimitationSupplement(value) {
  if (typeof value !== "string" || !value.startsWith(CROSS_WINDOW_LIMITATION_SUPPLEMENT_PREFIX)) return null;
  const encoded = value.slice(CROSS_WINDOW_LIMITATION_SUPPLEMENT_PREFIX.length);
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new TypeError(
      `PASS_A_CROSS_WINDOW_LIMITATION_INVALID: sealed supplement JSON is malformed (${String(error)})`,
    );
  }
  if (!isObj(parsed)) {
    throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: sealed supplement must be an object");
  }
  const { passAHash, ...rowInput } = parsed;
  if (typeof passAHash !== "string" || !PASS_A_HASH.test(passAHash)) {
    throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: sealed supplement passAHash is malformed");
  }
  return { ...validatePassACrossWindowLimitation(rowInput), passAHash };
}

export function contractCrossWindowLimitations(supplements, expectedPassAHash) {
  if (!Array.isArray(supplements)) {
    throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: contractSupplements must be an array");
  }
  const rows = [];
  for (const supplement of supplements) {
    const row = parseCrossWindowLimitationSupplement(supplement);
    if (row !== null) rows.push(row);
  }
  if (rows.length > 1) {
    throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: duplicate sealed candidate-dependence supplements");
  }
  if (rows.length > 0 && (!PASS_A_HASH.test(expectedPassAHash ?? "") || rows[0].passAHash !== expectedPassAHash)) {
    throw new TypeError(
      "PASS_A_CROSS_WINDOW_LIMITATION_INVALID: sealed supplement does not bind the revision's exact Pass-A hash",
    );
  }
  return rows;
}

/**
 * THE SAME LIMITATION, IN THE READER'S WORDS — emitted BESIDE the machine string, never
 * instead of it.
 *
 * WHAT THIS FIXES (docs/REPORT-PRESENTATION-REVIEW.md B1). The customer summary printed the
 * machine string raw, because a document-level blocker has no requirement rows to translate
 * and the renderer's last resort was to plainify the audit sentence. What a researcher met,
 * on every run of this contract, was:
 *
 *   "Whole survey — DOCUMENT_CROSS_WINDOW_DISCOVERY_INCOMPLETE: Cross-window reconciliation
 *    compared all 110 candidate row(s) emitted by 12 primary window reader(s)..."
 *
 * It passes the jargon gate — every word in it is allowed — and it is still unreadable. The
 * fix belongs HERE rather than in the renderer: this module knows what the numbers mean, and
 * a renderer inventing prose from a counted structure it does not own is how the two drift.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. The machine sentence quotes "139 of 1131 block(s)", and
 * the second number is not a field: `EXPECTED_KEYS` is a closed, sealed set and the document's
 * total block count is not in it. So this sentence states the numerator it HAS and does not
 * imply a fraction it cannot source. Parsing the denominator back out of `detail` prose would
 * be reading a convention rather than a value, and inventing it is worse.
 */
export function crossWindowLimitationPlainDetail(row) {
  if (!isObj(row)) throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: limitation detail row missing");
  const { passAHash, ...rowInput } = row;
  const value = validatePassACrossWindowLimitation(rowInput);
  const quoted = value.sourceEvidenceBlocks;
  return (
    `We cannot promise we read every part of the questionnaire. Our readers worked through it in ` +
    `${value.windowsTotal} passes and quoted ${quoted.toLocaleString("en")} section${quoted === 1 ? "" : "s"} of it ` +
    `exactly; anything outside those quotes was never looked at, so a requirement written there would not appear ` +
    `in this report at all.`
  );
}

export function crossWindowLimitationDetail(row) {
  if (!isObj(row)) throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: limitation detail row missing");
  const { passAHash, ...rowInput } = row;
  const value = validatePassACrossWindowLimitation(rowInput);
  if (typeof passAHash !== "string" || !PASS_A_HASH.test(passAHash)) {
    throw new TypeError("PASS_A_CROSS_WINDOW_LIMITATION_INVALID: limitation detail Pass-A hash missing");
  }
  return (
    `${CROSS_WINDOW_DISCOVERY_BLOCKER_KIND}: ${value.detail} Provenance bridge: exact retained Pass-A payload ${passAHash}. Counted boundary: ` +
    `${value.windowsTotal} primary windows; ` +
    `${value.candidatesSynthesized} candidate row(s) reconciled; ${value.candidatesUngrounded} ungrounded; ` +
    `${value.sourceEvidenceSpans} nominated exact quote span(s) from ${value.sourceEvidenceBlocks} source ` +
    `block(s) supplied; text outside those nominated spans was not inspected by synthesis, even when every ` +
    `source block supplied at least one span; ${value.synthesisAdditions} synthesis addition(s).`
  );
}
