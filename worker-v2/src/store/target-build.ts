/**
 * THE TARGET IDENTITY OF A RUN — what a judgement binds to when nobody configured a tag.
 *
 * WHY THIS EXISTS. A JudgementRecord binds to *the thing that was tested*. Until this
 * module, that identity came from exactly one place — `DEFAULT_TARGET_BUILD_ID` — and that
 * variable is unset, so `store/judgement.ts`'s `target-build` check resolved `null`, every
 * judgement was `unusable`, and EVERY report this deployment produces is marked
 * diagnostic-only. Not one of them could be recorded as a settled result, and no rerun
 * could ever differ, because the missing thing was configuration and not luck.
 *
 * WHY A STATIC TAG IS NOT THE ANSWER (worker-v2/DEPLOY.md §2c). No correct value can be
 * invented in code: a survey URL is not a build id, and two different builds can be served
 * at one URL. And `CLAUDE.md` forbids per-survey configuration outright — the system must
 * work for ANY survey + link with nothing hand-set.
 *
 * WHAT THIS DERIVES INSTEAD. An identity for the site AS THIS RUN ACTUALLY OBSERVED IT:
 * a sha-256 over the sorted, distinct content hashes of the run's own captured screens,
 * rendered as `site-sha256:<hex>`. Those hashes are already in the evidence catalogue —
 * the store is content-addressed — so this is a pure function of artifacts the run already
 * has. No model call, no new capture, no clock, no randomness. Same observed content ⇒
 * same id. A different build served at the same URL ⇒ different screens ⇒ different id.
 *
 * ================== BE HONEST ABOUT WHAT THIS ID MEANS ==================
 *
 * IT IS NOT A VENDOR BUILD IDENTITY. It says "this is the content this run saw", not "this
 * is release 4.2.1". Nothing here can know the latter, and pretending otherwise would be
 * the exact class of confident-but-unfounded claim this service exists to delete.
 *
 * IT IS SENSITIVE TO ANYTHING THAT CHANGED ON SCREEN. A rendered timestamp, a rotating
 * banner, a randomised question order, an A/B bucket — each changes a capture's bytes and
 * therefore changes the id. Two runs against an unchanged site can legitimately produce two
 * different ids. In this codebase that is not hypothetical: `RenderedScreen.at` is a
 * wall-clock capture timestamp inside every `dom-excerpt` blob, so today two runs over an
 * identical site DO derive different ids. Cross-run stability would require the capture
 * side to store a normalised screen projection; that is a change to the capture surface,
 * not something this module may fake by reaching inside blobs it did not write.
 *
 * WHAT IT IS GOOD FOR, EXACTLY. Binding a judgement to the observation it was derived from,
 * so a result can be final for THAT observation. It is a within-run identity that is stable
 * under re-derivation, not a cross-run fingerprint of a release.
 *
 * NOTHING IS SILENTLY FILTERED. Two selection rules are applied and both are stated here
 * and enforced below; there is no third:
 *
 *   RULE 1 — ONLY CAPTURED SCREENS PARTICIPATE (`screenshot`, `dom-excerpt`). Those are the
 *            two evidence types that are a direct reading of the site under test (see
 *            browser/capture.ts). `trace`, `state`, `har` and `other` are the run's OWN
 *            bookkeeping — failure payloads, path observations — and they carry run ids,
 *            attempt ids and durations. Hashing them would mint a fresh id on every run by
 *            construction and the value would be indistinguishable from a random string.
 *   RULE 2 — DISTINCT CONTENT, COUNTED ONCE. The same screen captured on four walks is one
 *            observed screen. Multiplicity is a fact about the plan, not about the site.
 *
 * Anything else in the selected set is included exactly as captured. This module never
 * looks inside a blob and never normalises one.
 */

import type { EvidenceCatalogEntry } from "../types/record";
import { sha256Hex } from "./hash";

/** The scheme prefix. `site-` names what it is derived from; nothing here claims a release. */
export const OBSERVED_SITE_BUILD_ID_PREFIX = "site-sha256:";

/**
 * Mixed into the digest so that if the selection rules above are ever changed, ids minted
 * under the old rules cannot silently collide with ids minted under the new ones. Bump it
 * with any change to what participates or how it is ordered.
 */
export const OBSERVED_SITE_BUILD_ID_VERSION = "survey-qa/observed-site-build-id/1";

/** RULE 1, as data. */
const OBSERVED_SCREEN_TYPES: ReadonlySet<EvidenceCatalogEntry["type"]> = new Set([
  "screenshot",
  "dom-excerpt",
] as const);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Derive `site-sha256:<hex>` from a run's evidence catalogue, or `null` when the run
 * observed nothing that could be bound to.
 *
 * `null` IS THE POINT OF THE EMPTY CASE, NOT AN OVERSIGHT. A run that captured no screen —
 * the site was unreachable, the browser never started — has nothing to bind a judgement to.
 * It must stay unbindable and keep the named reason `store/judgement.ts` already gives it.
 * Hashing the empty set would mint a perfectly well-formed identity for "we saw nothing",
 * every such run would share it, and a run that observed the site zero times could be
 * certified. That is the failure mode this function refuses by returning `null`.
 *
 * It is also fail-closed on a catalogue that cannot be read as content hashes: if any
 * SELECTED entry carries something that is not a bare sha-256 hex digest, no id is derived
 * at all rather than one derived from the entries that happened to look right — a silent
 * partial derivation is a different id wearing the same name.
 */
export async function deriveObservedSiteBuildId(
  catalog: readonly EvidenceCatalogEntry[],
): Promise<string | null> {
  const selected = catalog.filter((e) => OBSERVED_SCREEN_TYPES.has(e.type));
  if (selected.length === 0) return null;
  if (selected.some((e) => typeof e.contentHash !== "string" || !SHA256_HEX.test(e.contentHash))) return null;

  // RULE 2 + a total order, so the id does not depend on R2 listing order or capture order.
  const distinct = [...new Set(selected.map((e) => e.contentHash))].sort();
  const digest = await sha256Hex(`${OBSERVED_SITE_BUILD_ID_VERSION}\n${distinct.join("\n")}\n`);
  return `${OBSERVED_SITE_BUILD_ID_PREFIX}${digest}`;
}

export type TargetIdentitySource = "recorded" | "override" | "derived" | "none";

export interface TargetIdentity {
  /** What every consumer binds against. `null` means UNBINDABLE — say so, never guess. */
  targetBuildId: string | null;
  source: TargetIdentitySource;
  /** One sentence, for the operational diagnostics beside the report. */
  note: string;
}

/**
 * THE PRECEDENCE, WRITTEN DOWN ONCE (this comment is the specification):
 *
 *   1. RECORDED — the identity this run already carries on its envelope / RunRecord. It is
 *      where `DEFAULT_TARGET_BUILD_ID` lands when it is set at run creation, so an
 *      owner-controlled tag reaches this branch first in the normal case. It wins because a
 *      run's identity must not change under it: a judgement already bound to the recorded
 *      value must still bind after the variable is edited or after a report is rebuilt.
 *   2. OVERRIDE — `DEFAULT_TARGET_BUILD_ID` read live. This is the branch for a tag
 *      configured AFTER this run started, and it is why the variable remains a real
 *      override rather than dead configuration: an owner-controlled tag beats a derived one.
 *   3. DERIVED — `site-sha256:<hex>` over this run's captured screens. The fallback that
 *      makes the service self-sufficient with nothing hand-set, per CLAUDE.md.
 *   4. NONE — nothing was recorded, nothing was configured, and nothing was captured. The
 *      run stays UNBINDABLE and keeps the named reason. This is not a degraded case to be
 *      papered over; it is the honest answer for a run that saw nothing.
 *
 * Deterministic in every branch: no clock, no randomness, no network, no model.
 */
export async function resolveTargetIdentity(input: {
  /** `envelope.input.targetBuildId ?? record.run.targetBuildId`, already collapsed. */
  recorded: string | null | undefined;
  /** `env.DEFAULT_TARGET_BUILD_ID`. */
  override: string | null | undefined;
  /** This run's evidence catalogue. Empty when it is unreadable — fail closed either way. */
  catalog: readonly EvidenceCatalogEntry[];
}): Promise<TargetIdentity> {
  const recorded = nonEmpty(input.recorded);
  if (recorded) {
    return {
      targetBuildId: recorded,
      source: "recorded",
      note: "The target identity was recorded on this run when it was created, and is used exactly as recorded.",
    };
  }

  const override = nonEmpty(input.override);
  if (override) {
    return {
      targetBuildId: override,
      source: "override",
      note: "The target identity comes from the configured DEFAULT_TARGET_BUILD_ID, which overrides the derived one.",
    };
  }

  const derived = await deriveObservedSiteBuildId(input.catalog);
  if (derived) {
    return {
      targetBuildId: derived,
      source: "derived",
      note:
        "No target identity was configured, so one was derived from the content of the screens this run actually " +
        "captured. It identifies the observed content, not a vendor's release: anything that differs on screen — " +
        "including a rendered timestamp — makes it a different id.",
    };
  }

  return {
    targetBuildId: null,
    source: "none",
    note:
      "This run captured no screens, so there is nothing to identify the thing under test. No identity is derived " +
      "from an empty capture, and results stay unbindable.",
  };
}

const nonEmpty = (v: string | null | undefined): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v : null;
