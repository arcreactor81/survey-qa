/**
 * CUMULATIVE CROSS-RUN PROVIDER SPEND LEDGER — the durable authority for how much has been
 * spent on each LLM provider across ALL runs, ever.
 *
 * The owner's hard requirement: USD 10 cumulative cap on Gemini, enforced before every
 * purchase. The xAI USD 5 cap existed only as doctrine and real spend reached USD 6.14
 * unnoticed — this module exists so that never happens again.
 *
 * DESIGN:
 *   - Stored in the EVIDENCE R2 bucket under a fixed key outside any run prefix
 *     (`v2/ledger/provider-cumulative-spend.json`), so it survives run cleanup.
 *   - Schema-versioned JSON with per-provider cumulative USD and call counts, plus a
 *     bounded append-only tail of the last N purchase receipts for audit trail.
 *   - Enforcement: before each Gemini purchase, read the ledger and compute
 *     (cumulative spend + conservative reservation) against geminiMaxTotalUsd().
 *   - Recording: after every provider purchase settles, record the receipt into this
 *     ledger. Recording failures are named limitations, never fatal to the run.
 *
 * ASSUMPTION (stated, per CLAUDE.md): runs are serial. The deployment quiescence
 * interlock guarantees one run at a time, so read-modify-write without conditional
 * writes is acceptable. If that assumption ever breaks, the ledger needs conditional
 * writes (R2 etag-based CAS or equivalent) — the current write path does NOT guard
 * against concurrent writers.
 */

import { providerCumulativeSpendKey } from "../keys";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "provider-cumulative-spend/1.0.0" as const;
const KIND = "provider-cumulative-spend" as const;
const MAX_RECEIPT_TAIL = 200;
const MAX_LEDGER_BYTES = 512 * 1024;

export type ProviderName = "grok" | "deepseek" | "gemini";
const KNOWN_PROVIDERS = new Set<ProviderName>(["grok", "deepseek", "gemini"]);

export interface ProviderCumulativeEntry {
  cumulativeUsd: number;
  callCount: number;
}

export interface ReceiptEntry {
  provider: ProviderName;
  costUsd: number;
  model: string;
  runId: string;
  eventId: string;
  at: string;
}

export interface ProviderCumulativeSpendLedger {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: typeof KIND;
  providers: Record<ProviderName, ProviderCumulativeEntry>;
  receipts: ReceiptEntry[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Typed refusal — flows into the substitution chain as any other Gemini failure
// ---------------------------------------------------------------------------

export class ProviderCapExceededRefusal extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly cumulativeUsd: number,
    readonly reservationUsd: number,
    readonly capUsd: number,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "ProviderCapExceededRefusal";
  }
}

export class ProviderLedgerCorrupt extends Error {
  constructor(readonly detail: string) {
    super(`provider cumulative spend ledger is corrupt: ${detail}`);
    this.name = "ProviderLedgerCorrupt";
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function emptyLedger(): ProviderCumulativeSpendLedger {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    providers: {
      grok: { cumulativeUsd: 0, callCount: 0 },
      deepseek: { cumulativeUsd: 0, callCount: 0 },
      gemini: { cumulativeUsd: 0, callCount: 0 },
    },
    receipts: [],
    updatedAt: new Date().toISOString(),
  };
}

function validateLedger(value: unknown): ProviderCumulativeSpendLedger {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderLedgerCorrupt("top level is not an object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    throw new ProviderLedgerCorrupt(
      `schema version ${JSON.stringify(obj.schemaVersion)} !== ${SCHEMA_VERSION}`,
    );
  }
  if (obj.kind !== KIND) {
    throw new ProviderLedgerCorrupt(`kind ${JSON.stringify(obj.kind)} !== ${KIND}`);
  }
  if (typeof obj.providers !== "object" || obj.providers === null || Array.isArray(obj.providers)) {
    throw new ProviderLedgerCorrupt("providers is not an object");
  }
  const providers = obj.providers as Record<string, unknown>;
  const result: Record<string, ProviderCumulativeEntry> = {};
  for (const p of KNOWN_PROVIDERS) {
    const entry = providers[p];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ProviderLedgerCorrupt(`providers.${p} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.cumulativeUsd !== "number" || !Number.isFinite(e.cumulativeUsd) || e.cumulativeUsd < 0) {
      throw new ProviderLedgerCorrupt(`providers.${p}.cumulativeUsd is not a finite non-negative number`);
    }
    if (typeof e.callCount !== "number" || !Number.isSafeInteger(e.callCount) || e.callCount < 0) {
      throw new ProviderLedgerCorrupt(`providers.${p}.callCount is not a non-negative safe integer`);
    }
    result[p] = { cumulativeUsd: e.cumulativeUsd, callCount: e.callCount };
  }
  if (!Array.isArray(obj.receipts)) {
    throw new ProviderLedgerCorrupt("receipts is not an array");
  }
  // Validate receipts exist and are objects — do not deep-validate every field in
  // the tail since they are informational audit trail only.
  const receipts: ReceiptEntry[] = [];
  for (let i = 0; i < obj.receipts.length; i++) {
    const r = obj.receipts[i];
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      throw new ProviderLedgerCorrupt(`receipts[${i}] is not an object`);
    }
    const re = r as Record<string, unknown>;
    if (typeof re.provider !== "string" || !KNOWN_PROVIDERS.has(re.provider as ProviderName)) {
      throw new ProviderLedgerCorrupt(`receipts[${i}].provider is not a known provider`);
    }
    if (typeof re.costUsd !== "number" || !Number.isFinite(re.costUsd) || re.costUsd < 0) {
      throw new ProviderLedgerCorrupt(`receipts[${i}].costUsd is not a finite non-negative number`);
    }
    receipts.push({
      provider: re.provider as ProviderName,
      costUsd: re.costUsd,
      model: typeof re.model === "string" ? re.model : "unknown",
      runId: typeof re.runId === "string" ? re.runId : "unknown",
      eventId: typeof re.eventId === "string" ? re.eventId : "unknown",
      at: typeof re.at === "string" ? re.at : new Date().toISOString(),
    });
  }
  if (typeof obj.updatedAt !== "string") {
    throw new ProviderLedgerCorrupt("updatedAt is not a string");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    providers: result as Record<ProviderName, ProviderCumulativeEntry>,
    receipts,
    updatedAt: obj.updatedAt,
  };
}

/**
 * Read the cumulative provider spend ledger from R2.
 *
 * FAIL-CLOSED RULES:
 *   - Missing ledger object: legitimate first-ever state, returns a zero-init ledger.
 *   - Corrupt/unparseable: throws ProviderLedgerCorrupt. Callers MUST NOT treat this as zero.
 *   - Schema-version mismatch: same as corrupt.
 */
export async function readProviderSpendLedger(
  bucket: R2Bucket,
): Promise<ProviderCumulativeSpendLedger> {
  const key = providerCumulativeSpendKey();
  const obj = await bucket.get(key);
  if (obj === null) return emptyLedger();
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (bytes.byteLength > MAX_LEDGER_BYTES) {
    throw new ProviderLedgerCorrupt("stored bytes exceed the ledger size envelope");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ProviderLedgerCorrupt("stored bytes are not valid UTF-8 JSON");
  }
  return validateLedger(parsed);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface ProviderSpendReceipt {
  provider: ProviderName;
  costUsd: number;
  model: string;
  runId: string;
  eventId: string;
}

/**
 * Record a provider purchase into the cumulative ledger. Called AFTER per-run usage
 * settlement. A write failure becomes a named limitation, never fatal to the run.
 *
 * Returns the updated ledger on success, or null if the write failed (the caller
 * must record the failure as a named limitation).
 */
export async function recordProviderSpend(
  bucket: R2Bucket,
  receipt: ProviderSpendReceipt,
): Promise<ProviderCumulativeSpendLedger | null> {
  try {
    const ledger = await readProviderSpendLedger(bucket);
    const entry = ledger.providers[receipt.provider];
    entry.cumulativeUsd += receipt.costUsd;
    // Guard against floating-point accumulation producing non-finite values
    if (!Number.isFinite(entry.cumulativeUsd)) {
      throw new Error("cumulative USD is no longer finite after recording");
    }
    entry.callCount += 1;
    ledger.receipts.push({
      provider: receipt.provider,
      costUsd: receipt.costUsd,
      model: receipt.model,
      runId: receipt.runId,
      eventId: receipt.eventId,
      at: new Date().toISOString(),
    });
    // Bound the receipt tail: keep only the last N
    if (ledger.receipts.length > MAX_RECEIPT_TAIL) {
      ledger.receipts = ledger.receipts.slice(ledger.receipts.length - MAX_RECEIPT_TAIL);
    }
    ledger.updatedAt = new Date().toISOString();
    const key = providerCumulativeSpendKey();
    const serialized = JSON.stringify(ledger, null, 2);
    const encoded = new TextEncoder().encode(serialized);
    if (encoded.byteLength > MAX_LEDGER_BYTES) {
      throw new Error("serialized ledger exceeds the size envelope");
    }
    await bucket.put(key, encoded, {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });
    return ledger;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enforcement — Gemini cap
// ---------------------------------------------------------------------------

/**
 * Conservative reservation for one Gemini call. Mirrors the Grok approach: use the
 * maximum known rates applied to request-byte and max-output-token ceilings. Since
 * Gemini's output rate (3.5 USD/Mtok) is much higher than its input rate (0.15 USD/Mtok),
 * the output dominates the reservation.
 *
 * @param inputCeilingTokens Upper bound on input tokens (e.g. request body bytes)
 * @param outputCeilingTokens Upper bound on output tokens (e.g. max_tokens)
 * @param inputUsdPerMTok Rate for input tokens
 * @param outputUsdPerMTok Rate for output tokens (includes thinking)
 */
export function conservativeGeminiReservation(
  inputCeilingTokens: number,
  outputCeilingTokens: number,
  inputUsdPerMTok: number,
  outputUsdPerMTok: number,
): number {
  const reservation =
    (inputCeilingTokens / 1e6) * inputUsdPerMTok +
    (outputCeilingTokens / 1e6) * outputUsdPerMTok;
  if (!Number.isFinite(reservation) || reservation < 0) return Infinity;
  return reservation;
}

/**
 * ENFORCE the Gemini cumulative cap BEFORE a purchase.
 *
 * Reads the cross-run ledger and checks whether (cumulative Gemini spend + a conservative
 * reservation for this call) exceeds geminiMaxTotalUsd. At/over: throws a
 * ProviderCapExceededRefusal, which the substitution chain treats like any other typed
 * Gemini failure and falls through to DeepSeek Flash.
 *
 * Corrupt ledger: throws ProviderLedgerCorrupt -> treated as a typed refusal -> fall through.
 */
export async function enforceGeminiCap(
  bucket: R2Bucket,
  capUsd: number,
  reservationUsd: number,
): Promise<ProviderCumulativeSpendLedger> {
  // readProviderSpendLedger handles missing (zero-init) vs corrupt (throws)
  const ledger = await readProviderSpendLedger(bucket);
  const gemini = ledger.providers.gemini;
  const projected = gemini.cumulativeUsd + reservationUsd;
  if (gemini.cumulativeUsd >= capUsd || projected > capUsd) {
    throw new ProviderCapExceededRefusal(
      "gemini",
      gemini.cumulativeUsd,
      reservationUsd,
      capUsd,
      `Gemini cumulative cap reached: spent $${gemini.cumulativeUsd.toFixed(6)}, ` +
        `reservation $${reservationUsd.toFixed(6)}, projected $${projected.toFixed(6)}, ` +
        `cap $${capUsd}. No further Gemini purchases permitted.`,
    );
  }
  return ledger;
}
