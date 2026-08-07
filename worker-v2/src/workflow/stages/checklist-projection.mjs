/**
 * THE CHECKLIST THE JUDGE COMPILES, PROJECTED FROM THE SEALED CONTRACT REVISION.
 *
 * The judging engine compiles typed expectations out of a CHECKLIST — obligations carrying
 * a statement, the document's own quote, a category and a browser-observability marker —
 * and binds every one of them to a row of the sealed revision. In v2 the sealed revision is
 * the denominator, so the checklist is a PROJECTION of it, not a second source. Two
 * documents that both claim to say what the survey must do is the failure the seal exists
 * to prevent.
 *
 * WHY THIS IS A LOSSY PROJECTION, AND WHAT IS LOST
 *
 * A sealed revision carries ambiguities as TOKENS — digests of the canonical form — because
 * a token is all that is needed to prove an ambiguity was sealed. It does not carry the two
 * competing READINGS, and no projection can recover them from a digest. The judge's
 * dependency-aware ambiguity precedence needs the readings, so a checklist projected from
 * the revision alone declares ZERO ambiguities and nothing withholds.
 *
 * That is why `checklistFromExtraction` exists and is preferred: the extraction stage keeps
 * its checklist (readings and all) at `v2/runs/<id>/checklist.json`, and this projection is
 * the FALLBACK for a run whose extraction did not leave one. The fallback is marked
 * `ambiguitiesAvailable: false` so the caller can say out loud that the ambiguity policy
 * had nothing to act on, rather than reporting an unambiguous document.
 */

import { liveRequirements } from "../../../shared/v2-record.mjs";

export const CHECKLIST_PROJECTION_VERSION = "v2-checklist-projection/1.0.0";

const arr = (v) => (Array.isArray(v) ? v : []);

/** v2 testability → the checklist's `browser_observable` vocabulary. */
const OBSERVABLE = { "browser-observable": "full", "not-browser-observable": "none" };

/**
 * Project a sealed revision onto the checklist shape the judge compiles.
 *
 * `doc_quote` is the requirement's `displayQuote` — the DOCUMENT'S OWN COPY — and never its
 * normative statement. The judge digests this field and requires the digest to be one of
 * the row's sealed source atoms, so substituting the statement would both break the binding
 * and make the compiler search every capture for prose the survey never renders. That
 * substitution has been made before in this repo and cost nine fabricated verdicts.
 */
export function checklistFromRevision(revision, { target = null, sourceDocument = null } = {}) {
  const rows = liveRequirements(revision);
  const observable = rows.filter((r) => r.testability === "browser-observable");
  const unobservable = rows.filter((r) => r.testability !== "browser-observable");

  return {
    schema_version: CHECKLIST_PROJECTION_VERSION,
    target,
    source_document: sourceDocument,
    generated_at: revision.sealedAt ?? null,
    provenance: {
      projectedFrom: revision.contractRevisionId,
      documentSha256: revision.documentSha256 ?? null,
      note:
        "projected from the sealed contract revision; ambiguity readings are not recoverable from sealed tokens",
    },
    counts: { obligations: observable.length, unverifiable: unobservable.length, ambiguities: 0 },
    obligations: observable.map((r) => ({
      id: r.requirementLineageId,
      category: r.facet,
      doc_quote: r.displayQuote ?? "",
      statement: r.normativeStatement ?? "",
      stimulus: r.selector === null || r.selector === undefined ? [] : [r.selector],
      // The checklist's `expected_observable` is extraction PROSE about what a tester should
      // see. A revision does not carry it, and inventing one would put a sentence nobody
      // wrote in front of the compiler.
      expected_observable: "",
      browser_observable: OBSERVABLE[r.testability] ?? "partial",
      confidence: null,
      source_chunk: String(r.scope ?? "survey").replace(/^section:/, ""),
      quote_verified: "exact",
    })),
    // EMPTY BECAUSE IT CANNOT BE RECONSTRUCTED, NOT BECAUSE THE DOCUMENT IS UNAMBIGUOUS.
    ambiguities: [],
    unverifiable_from_browser: unobservable.map((r) => ({
      id: r.requirementLineageId,
      doc_quote: r.displayQuote ?? "",
      mandate: r.normativeStatement ?? "",
      why_not_observable:
        r.notBrowserObservableReason ?? "the sealed revision records this requirement as not browser-observable",
      browser_proxy_evidence: "none",
      source_chunk: String(r.scope ?? "survey").replace(/^section:/, ""),
      quote_verified: "exact",
    })),
    ambiguitiesAvailable: false,
  };
}

/**
 * Adopt the checklist the extraction stage left for the run, if it is one.
 *
 * The shape check is deliberately shallow — an obligation list with ids and quotes. Deeper
 * validation belongs to the judge's own binder, which refuses an obligation that does not
 * bind to a sealed requirement and says which field failed. Duplicating that here would
 * produce a second, weaker opinion about the same document.
 */
export function checklistFromExtraction(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const obligations = arr(candidate.obligations);
  if (obligations.length === 0) return null;
  const usable = obligations.every((o) => typeof o?.id === "string" && typeof o?.doc_quote === "string");
  if (!usable) return null;
  return { ...candidate, ambiguitiesAvailable: arr(candidate.ambiguities).length > 0 };
}
