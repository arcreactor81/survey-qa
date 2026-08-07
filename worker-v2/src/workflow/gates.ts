/**
 * NOT-EVALUATED IS A STATE, NOT A VALUE IN THE SUCCESSFUL DOMAIN.
 *
 * THE PATTERN THIS FILE EXISTS TO MAKE IMPOSSIBLE. The extraction stubs used to return
 * the value that MEANS "zero problems":
 *
 *     return { hash: "", unexplainedNormativeBlocks: 0 };   // source ledger: nothing ran
 *     return { hash: "", highRiskDisagreements: 0 };        // typed diff: nothing ran
 *     gates: { allConstructClassesDispositioned: true, ... } // literal true
 *
 * and the seal read `unexplainedNormativeBlocks === 0` as a passing gate. A stage that had
 * not executed therefore CERTIFIED that it had found nothing wrong, and the run proceeded
 * with four green approval gates over a contract nobody had extracted. This is the same
 * self-validating-green shape the scorer had and we deleted: work that did not happen must
 * never be indistinguishable from work that happened and found nothing.
 *
 * The fix is typed, not disciplinary. A gate result is a discriminated union whose
 * `not-evaluated` arm carries NO boolean and NO count, so there is nothing for a reader to
 * misread as success, and `passed()` — the only way to ask "may we proceed" — returns
 * false for it. A passing gate must additionally carry a PROOF: who evaluated it, at which
 * version, over which input digest. A gate with no proof cannot be `pass`, so a future
 * stub cannot re-acquire the old behaviour by returning `{ state: "pass" }`: it would have
 * to fabricate a proof, which is a visible lie rather than an accidental one.
 */

/** Thrown by a stage that has no implementation. Never caught to produce a default. */
import { REQUIRED_CONTRACT_GATES } from "../../shared/v2-record.mjs";

export class NotImplemented extends Error {
  readonly code = "NOT_IMPLEMENTED";
  constructor(stage: string, detail?: string) {
    super(`${stage} is not implemented${detail ? `: ${detail}` : ""}. It has no result, and no result is not a passing result.`);
    this.name = "NotImplemented";
  }
}

/** Who computed a gate outcome, at what version, over what input. */
export interface GateProof {
  evaluatorId: string;
  evaluatorVersion: string;
  /** Digest of the exact input the evaluator read. "" is not acceptable. */
  inputHash: string;
  observedAt: string;
}

export type GateOutcome =
  | { state: "pass"; proof: GateProof; detail?: string }
  | { state: "fail"; proof: GateProof; detail: string }
  | { state: "not-evaluated"; reason: string; detail: string };

/** The only sanctioned way to ask whether a gate permits progress. */
export const gatePassed = (g: GateOutcome | undefined | null): boolean =>
  !!g && g.state === "pass" && isProof(g.proof);

export const isProof = (p: GateProof | undefined | null): boolean =>
  !!p &&
  typeof p.evaluatorId === "string" &&
  p.evaluatorId.length > 0 &&
  typeof p.evaluatorVersion === "string" &&
  p.evaluatorVersion.length > 0 &&
  typeof p.inputHash === "string" &&
  p.inputHash.length > 0 &&
  typeof p.observedAt === "string" &&
  p.observedAt.length > 0;

export const notEvaluated = (reason: string, detail: string): GateOutcome => ({
  state: "not-evaluated",
  reason,
  detail,
});

export const gatePass = (proof: GateProof, detail?: string): GateOutcome => ({ state: "pass", proof, detail });
export const gateFail = (proof: GateProof, detail: string): GateOutcome => ({ state: "fail", proof, detail });

/**
 * A stage result that may be absent. The `not-evaluated` arm deliberately has no `value`
 * field at all, so `result.value.count` is a type error rather than a runtime zero.
 */
export type StageResult<T> =
  | { state: "evaluated"; value: T; proof: GateProof }
  | { state: "not-evaluated"; reason: string; detail: string };

export const stageNotEvaluated = <T>(reason: string, detail: string): StageResult<T> => ({
  state: "not-evaluated",
  reason,
  detail,
});

export const stageEvaluated = <T>(value: T, proof: GateProof): StageResult<T> => ({
  state: "evaluated",
  value,
  proof,
});

/**
 * Human-readable one-liner for the checkpoint's reasonCode trail and the logs.
 *
 * The DETAIL is included, not just the state, because "not-evaluated" alone sends the
 * reader back to the logs to find out why — and the why is usually one sentence the gate
 * already wrote ("XAI_API_KEY is not available to this Worker"). A refusal that cannot be
 * acted on is only half honest.
 */
export function describeGates(gates: Record<string, GateOutcome>): string {
  return Object.entries(gates)
    .map(([name, g]) => `${name}=${g.state}${g.detail ? ` (${g.detail})` : ""}`)
    .join(" ");
}

export function unmetGates(gates: Record<string, GateOutcome> | null | undefined): string[] {
  const source = gates ?? {};
  const names = [
    ...REQUIRED_CONTRACT_GATES,
    ...Object.keys(source).filter((name) => !REQUIRED_CONTRACT_GATES.includes(name)),
  ];

  return names.flatMap((name) => {
    if (!Object.prototype.hasOwnProperty.call(source, name)) return [`${name}:missing`];
    const gate = source[name];
    return gatePassed(gate) ? [] : [`${name}:${gate?.state ?? "malformed"}`];
  });
}
