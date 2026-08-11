/** Non-secret identities shared by the isolated deploy generator and its client. */

export const LIVE_CANARY_WORKER_NAME = "survey-qa-v2-visual-canary";
export const LIVE_CANARY_BUCKET_NAME = "survey-qa-artifacts-visual-canary";
export const LIVE_CANARY_ACCOUNT_ID = "f0cbb2076e484454e6567789b9be85d8";
export const LIVE_CANARY_COMPLIANCE_REGION = "public";
export const LIVE_CANARY_ORIGIN =
  "https://survey-qa-v2-visual-canary.arcreactor81.workers.dev";
export const PRODUCTION_ACCESS_ORIGIN = "https://survey-qa-v2.wellshit.co.in";
export const LIVE_CANARY_IDENTITY_HEADER = "x-survey-qa-canary-identity-sha256";
export const LIVE_CANARY_VERSION_ID_HEADER = "x-survey-qa-canary-version-id";
export const LIVE_CANARY_PROVIDER_HEADER = "x-survey-qa-canary-provider";
export const LIVE_CANARY_POLICY_HEADER = "x-survey-qa-canary-policy-sha256";
export const LIVE_CANARY_PROVIDER_CONFIGURATION_HEADER =
  "x-survey-qa-canary-provider-configuration-sha256";
export const LIVE_CANARY_MAXIMUM_USD_HEADER = "x-survey-qa-canary-maximum-usd";
