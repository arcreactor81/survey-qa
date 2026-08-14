/**
 * Evidence endpoints. ui-report-redesign §7.5 specifies six behaviours for the content
 * endpoint; all six are implemented here, and step 6 (fail closed on hash mismatch) is
 * the one that must never be relaxed for convenience.
 *
 * No public raw R2 links are ever emitted (§8.6): bytes are proxied through the Worker so
 * that Access authorization applies to every single fetch.
 *
 * WHY THE MEDIA TYPE IS AN ALLOWLIST AND NOT A PASSTHROUGH
 *
 * Evidence is CAPTURED FROM THE TARGET SITE — DOM excerpts, HAR files, screenshots, and
 * whatever a vendor's page contained. It was served with `content-disposition: inline` and
 * the media type the catalogue declared, on the SAME ORIGIN as the authenticated app. A
 * captured `text/html` or `image/svg+xml` artifact therefore executed in the operator's
 * session, with same-origin read access to every other run's report and evidence. The
 * `nosniff` header prevented type confusion; it did nothing about a type that is
 * *declared* active.
 *
 * The attacker does not need to compromise anything: they need only get their markup onto
 * a page this tool tests, and then wait for an operator to click a citation. That is the
 * ordinary case for a QA tool pointed at a third-party survey.
 *
 * So: a short allowlist of INERT types is served inline, and everything else — including
 * every type that can execute — is served as an octet-stream attachment under a
 * `sandbox`ed, `default-src 'none'` CSP. The bytes are always delivered in full and
 * always re-hashed; what changes is that the browser is never asked to interpret them in
 * a document context on this origin.
 */

import type { Env } from "../types/env";
import { fail, json } from "./http";
import { isV2RunId } from "../ids";
import {
  EvidenceCatalogTampered,
  EvidenceIntegrityFailure,
  getBoundCatalogEntry,
  getVerifiedEvidence,
  listCatalog,
} from "../store/evidence";

/**
 * Types a browser cannot be made to execute in a document context. Deliberately short:
 * anything not here is a download, and adding to it is a security decision.
 *
 * NOT here, on purpose: text/html, application/xhtml+xml, image/svg+xml (script + foreign
 * objects), application/xml and text/xml (XSLT), application/pdf (the built-in viewer is
 * a scriptable document context), and every JavaScript media type.
 */
const INLINE_SAFE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "text/plain",
  "text/csv",
  "application/json",
]);

/** `text/plain; charset=utf-8` -> `text/plain`; unparseable -> "". */
const essence = (mediaType: string): string => (mediaType ?? "").split(";")[0]!.trim().toLowerCase();

export interface ServedMediaDecision {
  contentType: string;
  disposition: string;
  inline: boolean;
  declared: string;
}

/** Pure, and exported so the regression suite can assert the policy directly. */
export function decideMedia(declaredMediaType: string, evidenceId: string): ServedMediaDecision {
  const declared = declaredMediaType ?? "";
  const base = essence(declared);
  if (INLINE_SAFE.has(base)) {
    const charset = base.startsWith("text/") || base === "application/json" ? "; charset=utf-8" : "";
    return { contentType: `${base}${charset}`, disposition: "inline", inline: true, declared };
  }
  // Filename is derived from the evidence id, never from anything the target site chose.
  // PDF stays a forced download, but receives a truthful extension so the operator can
  // open the captured print rendition without renaming it. No other active type earns
  // an extension here: expanding this map is a security decision, not presentation sugar.
  const extension = base === "application/pdf" ? "pdf" : "bin";
  return {
    contentType: "application/octet-stream",
    disposition: `attachment; filename="${evidenceId}.${extension}"`,
    inline: false,
    declared,
  };
}

/** GET /api/v2/runs/:id/evidence — the catalog (metadata + hashes, never bytes). */
export async function listEvidence(_req: Request, env: Env, runId: string): Promise<Response> {
  if (!isV2RunId(runId)) return fail(404, "NOT_A_V2_RUN", `${runId} is not a survey-qa-v2 run id`);
  try {
    const entries = await listCatalog(env, runId);
    return json({ runId, count: entries.length, evidence: entries });
  } catch (err) {
    if (err instanceof EvidenceCatalogTampered) return fail(409, "EVIDENCE_CATALOG_TAMPERED", err.message);
    throw err;
  }
}

/** GET /api/v2/runs/:id/evidence/:evidenceId/content */
export async function getEvidenceContent(
  _req: Request,
  env: Env,
  runId: string,
  evidenceId: string,
): Promise<Response> {
  if (!isV2RunId(runId)) return fail(404, "NOT_A_V2_RUN", `${runId} is not a survey-qa-v2 run id`);

  try {
    // 1. Resolve evidenceId against the catalog (not against a caller-supplied path —
    //    the caller never names an R2 key, so a path cannot be traversed) AND verify the
    //    entry still binds to its own citation: id === H(runId, sourceEvidenceId, hash).
    const entry = await getBoundCatalogEntry(env, runId, evidenceId);
    if (!entry) return fail(404, "EVIDENCE_NOT_FOUND", `no evidence ${evidenceId} in run ${runId}`);

    // 2. Verify stored bytes against contentHash.
    const { bytes } = await getVerifiedEvidence(env, entry);
    // 3. Decide how this type may be delivered. Active content never renders here.
    const media = decideMedia(entry.mediaType, entry.evidenceId);
    return new Response(bytes, {
      headers: {
        // 4/5. Declared media type + size, and a strong digest header.
        "content-type": media.contentType,
        "content-length": String(entry.size),
        "cache-control": "private, no-store",
        // RFC 9530 style digest; the client can re-verify independently.
        "repr-digest": `sha-256=:${hexToBase64(entry.contentHash)}:`,
        "x-content-sha256": entry.contentHash,
        // What the catalogue SAID, so a client can tell it was down-typed rather than
        // guess. This header is informational and is never used to select a renderer.
        "x-declared-media-type": media.declared.replace(/[^\x20-\x7e]/g, "").slice(0, 120),
        "content-disposition": media.disposition,
        "x-content-type-options": "nosniff",
        // Belt and braces around captured third-party bytes: no scripts, no subresources,
        // no same-origin document context, not framable, not readable cross-origin.
        "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  } catch (err) {
    // 6. Fail closed rather than render corrupted or repointed content.
    if (err instanceof EvidenceIntegrityFailure) return fail(409, "EVIDENCE_INTEGRITY_FAILED", err.message);
    if (err instanceof EvidenceCatalogTampered) return fail(409, "EVIDENCE_CATALOG_TAMPERED", err.message);
    throw err;
  }
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
