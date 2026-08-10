/**
 * Private transport seam between the isolated canary wrapper and the normal submission
 * handler. The public caller may send a header with this spelling, but the wrapper always
 * removes it before authentication/fingerprinting and writes its own value afterwards.
 * Normal deployments do not carry CANARY_AUTH_SHA256, so the submission handler rejects the
 * header if it ever reaches them directly.
 */

export const LIVE_CANARY_PLANNED_RUN_ID_HEADER =
  "x-survey-qa-internal-canary-planned-run-id" as const;

export const LIVE_CANARY_ACCEPTANCE_SCHEMA =
  "survey-qa-live-canary-acceptance/1.0.0" as const;
