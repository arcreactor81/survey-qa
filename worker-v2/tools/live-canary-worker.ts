/**
 * Isolated deployed wrapper for real end-to-end canaries.
 *
 * Never use this entry point for the normal Access-protected deployment. The generated canary
 * config gives it distinct Worker, Workflow, and R2 identities and enables workers.dev only
 * because every request that reaches the application is gated here first.
 */

import productionWorker from "../src/index";
import type { Env } from "../src/types/env";
import {
  handleLiveCanarySubmission,
  isAuthorizedLiveCanaryRequest,
  liveCanaryRequestMode,
  liveCanaryNotFound,
  requestWithoutLiveCanaryCredential,
  requestWithoutLiveCanaryInternalHeaders,
  liveCanarySubmissionByteLimit,
} from "./live-canary-auth";

export { SurveyRunWorkflowV2 } from "../src/workflow/run-workflow";
export { SurveyVisualShadowWorkflowV1 } from "../src/workflow/visual-shadow-workflow";

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    // A public caller never controls the private wrapper-to-router run-id seam. Strip it
    // before auth/routing/fingerprinting; handleLiveCanarySubmission injects its own value.
    const ingress = requestWithoutLiveCanaryInternalHeaders(request);
    if (!(await isAuthorizedLiveCanaryRequest(ingress, env.CANARY_AUTH_SHA256))) {
      return liveCanaryNotFound();
    }
    const mode = liveCanaryRequestMode(ingress);
    if (mode === null) return liveCanaryNotFound();
    if (mode === "submission") {
      const maximumBytes = liveCanarySubmissionByteLimit(env.MAX_SUBMISSION_BYTES);
      if (maximumBytes === null) return liveCanaryNotFound();
      return handleLiveCanarySubmission(
        ingress,
        env.EVIDENCE,
        env.CANARY_AUTH_SHA256,
        (forwarded) => productionWorker.fetch(forwarded, env, context),
        { maximumBytes },
      );
    }
    return productionWorker.fetch(requestWithoutLiveCanaryCredential(ingress), env, context);
  },
};
