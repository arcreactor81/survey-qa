import type { Env } from "../types/env";
import type { RunCheckpoint } from "../types/contracts";
import { getEnvelope } from "../store/envelope";
import { k } from "../keys";
import { normalizeDocumentSemanticsProfile } from "../extract/document-semantics";
import { reconstructPassACompletedAuthority } from "../extract/pass-a";
import { reconstructPassBCompletedAuthority } from "../extract/pass-b";
import { loadDocument } from "../workflow/stages/extract";
import {
  projectDocumentReadingProgress,
  readingFromPrimary,
  readingFromSecondary,
  sourceContextForUnit,
  stopDocumentReading,
  withCheckpointUsage,
  type DocumentReadingProgress,
} from "./document-reading";

export interface ResolvedDocumentReading {
  progress: DocumentReadingProgress | null;
  /** True only when legacy terminal artifacts were inspected without writing them. */
  reconstructed: boolean;
}

function reason(cp: RunCheckpoint, fallback: string): string {
  return cp.failure?.reasonCode || cp.completion.reasonCode || fallback;
}

function unavailable(cp: RunCheckpoint, code: string, detail: string): DocumentReadingProgress {
  return withCheckpointUsage(readingFromPrimary({
    done: false,
    windowsTotal: 0,
    windowsLanded: 0,
    windowsRemaining: 0,
    terminalFailure: true,
    synthesisState: "unknown",
  }, {
    state: "unavailable",
    failedUnit: { unit: "", detail },
    reasonCode: code,
    updatedAt: cp.lastProgressAt,
  }), cp.usage);
}

/**
 * Read-only compatibility path for terminal checkpoints created before structured
 * reading progress existed. It reuses the strict paid-unit reconstruction routines and
 * the envelope-bound document hash; a GET never writes or repairs durable state.
 */
export async function resolveDocumentReading(
  env: Env,
  runId: string,
  cp: RunCheckpoint,
): Promise<ResolvedDocumentReading> {
  const stored = projectDocumentReadingProgress(cp.documentReading);
  if (stored) return { progress: withCheckpointUsage(stored, cp.usage), reconstructed: false };

  const extracting = cp.phases.find((phase) => phase.name === "extracting");
  const terminal = extracting?.state === "stopped" || cp.completion.test === "failed";
  if (!terminal || cp.phase !== "extracting") return { progress: null, reconstructed: false };

  try {
    const envelope = await getEnvelope(env, runId);
    if (!envelope) {
      return { progress: unavailable(cp, "document-reading-envelope-missing", "The run envelope is missing."), reconstructed: true };
    }
    if ((envelope.input.contractSource?.mode ?? "extract") !== "extract") {
      return { progress: null, reconstructed: false };
    }
    const profile = normalizeDocumentSemanticsProfile(envelope.input.documentSemanticsProfile);
    const { doc } = await loadDocument(
      env, envelope.input.documentKey, envelope.input.documentSha256, profile,
    );
    const passA = await reconstructPassACompletedAuthority(
      env, runId, doc, envelope.input.documentName,
    );
    if (passA.kind === "invalid") {
      return {
        reconstructed: true,
        progress: withCheckpointUsage(readingFromPrimary(passA.slice, {
          state: "stopped",
          failedUnit: passA.failedUnit,
          sourceContext: sourceContextForUnit(doc.blocks, passA.failedUnit?.blockIds ?? []),
          reasonCode: reason(cp, "pass-a-authority-invalid"),
          updatedAt: cp.lastProgressAt,
        }), cp.usage),
      };
    }

    let base = withCheckpointUsage(readingFromPrimary(passA.value.slice, {
      state: "reading",
      updatedAt: cp.lastProgressAt,
    }), cp.usage);
    const passBPrefix = `${k("runs", runId, "extraction", "pass-b")}`;
    const listed = await env.EVIDENCE.list({ prefix: passBPrefix, limit: 1 });
    if (listed.objects.length === 0) {
      base = stopDocumentReading(
        base, reason(cp, "extraction-stopped-after-primary-read"),
        cp.error ?? "The run stopped after the primary read and before a secondary unit was retained.",
        cp.lastProgressAt,
      ) ?? base;
      return { progress: withCheckpointUsage(base, cp.usage), reconstructed: true };
    }

    const passB = await reconstructPassBCompletedAuthority(
      env, runId, doc, envelope.input.documentName,
    );
    if (passB.kind === "invalid") {
      return {
        reconstructed: true,
        progress: withCheckpointUsage(readingFromSecondary(base, passB.slice, {
          state: "stopped",
          failedUnit: passB.failedUnit,
          sourceContext: sourceContextForUnit(doc.blocks, passB.failedUnit?.blockIds ?? []),
          reasonCode: reason(cp, "pass-b-authority-invalid"),
          updatedAt: cp.lastProgressAt,
        }), cp.usage),
      };
    }
    return {
      reconstructed: true,
      progress: withCheckpointUsage(readingFromSecondary(base, passB.value.slice, {
        state: "complete",
        updatedAt: cp.lastProgressAt,
      }), cp.usage),
    };
  } catch (error) {
    return {
      reconstructed: true,
      progress: unavailable(
        cp, "document-reading-reconstruction-unavailable",
        error instanceof Error ? error.message : "Stored document-reading evidence could not be reconstructed.",
      ),
    };
  }
}
