import {
  VisionProviderUnavailableError,
  type VisualProviderFailureReference,
} from "./types";

const NOT_ATTEMPTED_PREFLIGHT_TUPLES = new Set([
  "workers-ai-binding/request-contract-invalid",
  "workers-ai-binding/request-screenshot-too-large",
  "workers-ai-binding/request-payload-invalid",
]);

/**
 * Normalize one of the adapter's closed preflight tuples.
 *
 * This is deliberately the single allowlist used by the live exception classifier, durable
 * receipt validation, and replay. A syntactically well-formed but unknown tuple is not proof
 * that the paid boundary was avoided.
 */
export function allowedNotAttemptedPreflightReference(
  category: unknown,
  code: unknown,
): VisualProviderFailureReference | null {
  if (
    typeof category !== "string" ||
    typeof code !== "string" ||
    !NOT_ATTEMPTED_PREFLIGHT_TUPLES.has(`${category}/${code}`)
  ) {
    return null;
  }
  return { category, code };
}

/**
 * The only adapter failures permitted to prove that no paid provider boundary was crossed.
 *
 * A boolean field is not enough: it is easy for a contradictory or hostile exception to claim
 * `providerCallAttempted: false`. The complete typed tuple, phase, and null telemetry must agree
 * with one of the adapter's closed preflight failures. Everything else remains conservatively
 * chargeable.
 */
export function coherentNotAttemptedPreflightReference(
  error: unknown,
): VisualProviderFailureReference | null {
  if (!(error instanceof VisionProviderUnavailableError)) return null;
  try {
    const reference = error as VisionProviderUnavailableError & {
      providerFailureCategory?: unknown;
      providerFailureCode?: unknown;
      providerFailurePhase?: unknown;
      providerCallAttempted?: unknown;
    };
    const allowed = allowedNotAttemptedPreflightReference(
      reference.providerFailureCategory,
      reference.providerFailureCode,
    );
    if (
      reference.telemetry !== null ||
      reference.providerFailurePhase !== "preflight" ||
      reference.providerCallAttempted !== false ||
      allowed === null
    ) {
      return null;
    }
    return allowed;
  } catch {
    return null;
  }
}
