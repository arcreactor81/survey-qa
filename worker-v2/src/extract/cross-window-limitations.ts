/** Bind the sealed coverage ceiling to the exact Pass-A bytes the extraction stage evaluated. */

import type { Env } from "../types/env";
import { extractionPassKey } from "../keys";
import { sha256Hex } from "../store/hash";
import {
  crossWindowLimitationSupplement,
  limitationsFromPassAPayload,
} from "../../shared/cross-window-limitations.mjs";

export const PASS_A_CROSS_WINDOW_LIMITATION_REFUSAL =
  "extraction-pass-a-cross-window-limitation-invalid";

export class PassACrossWindowLimitationRefusal extends Error {
  readonly reasonCode = PASS_A_CROSS_WINDOW_LIMITATION_REFUSAL;

  constructor(detail: string) {
    super(
      `PASS_A_CROSS_WINDOW_LIMITATION_INVALID: ${detail}. Refusing to seal because candidate-only ` +
        `reconciliation cannot silently receive whole-document discovery credit.`,
    );
    this.name = "PassACrossWindowLimitationRefusal";
  }
}

/** One keyed R2 read, no listing, alternate artifact, or trust in caller-supplied rows. */
export async function passACrossWindowSupplementsForSeal(
  env: Env,
  runId: string,
  expectedPassAHash: string,
): Promise<string[]> {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedPassAHash)) {
    throw new PassACrossWindowLimitationRefusal(`evaluated Pass-A hash is malformed (${expectedPassAHash})`);
  }
  const key = extractionPassKey(runId, "a");
  const object = await env.EVIDENCE.get(key);
  if (!object) throw new PassACrossWindowLimitationRefusal(`evaluated Pass-A artifact is missing at ${key}`);

  const bytes = new Uint8Array(await object.arrayBuffer());
  const actualHash = `sha256:${await sha256Hex(bytes)}`;
  if (actualHash !== expectedPassAHash) {
    throw new PassACrossWindowLimitationRefusal(
      `Pass-A artifact hash mismatch (expected ${expectedPassAHash}, got ${actualHash})`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new PassACrossWindowLimitationRefusal(`Pass-A artifact is not JSON (${String(error)})`);
  }
  try {
    return limitationsFromPassAPayload(payload).map((row) =>
      crossWindowLimitationSupplement(row, expectedPassAHash),
    );
  } catch (error) {
    throw new PassACrossWindowLimitationRefusal(error instanceof Error ? error.message : String(error));
  }
}
