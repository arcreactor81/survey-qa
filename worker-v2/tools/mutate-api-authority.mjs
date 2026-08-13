/**
 * API AUTHORITY MUTANTS -- body-size authority and durable denominator authority.
 *
 * Each mutation reintroduces a shortcut that can look harmless on normal browser input:
 * trusting Content-Length, skipping the actual stream ceiling, accepting an incomplete
 * human artifact binding, or trusting Workflow transport over the run envelope.
 *
 *   node tools/mutate-api-authority.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const API = "src/api/runs.ts";
const WORKFLOW = "src/workflow/run-workflow.ts";

await runMutantSuite({
  title: "API AUTHORITY MUTANTS -- bounded ingestion and envelope-bound contract source",
  filter: "API AUTHORITY",
  mutants: [
    {
      name: "declared Content-Length becomes the only body-size authority",
      breaks: "an over-limit declared body is parsed before it is refused",
      file: API,
      find: "    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxSubmissionBytes) {",
      replace: "    if (false) {",
      kills: ["API AUTHORITY: an oversized declared body is refused before parsing"],
    },
    {
      name: "actual request stream is no longer byte-counted",
      breaks: "missing or forged-low Content-Length can feed an over-cap body to a parser",
      file: API,
      find: "        if (chunk.byteLength > maxBytes - total) {",
      replace: "        if (false) {",
      kills: [
        "API AUTHORITY: a missing Content-Length is byte-counted and an over-cap stream writes and starts nothing",
        "API AUTHORITY: a forged-low Content-Length cannot bypass the streamed byte ceiling",
      ],
    },
    {
      name: "every present contract source is silently normalized to legacy extract",
      breaks: "unknown fields and incomplete human authority stop being refusals",
      file: WORKFLOW,
      find: "  if (value === undefined) return { mode: \"extract\" };",
      replace: "  if (true) return { mode: \"extract\" };",
      kills: ["API AUTHORITY: contract-source decoding refuses unknown fields and incomplete human authority"],
    },
    {
      name: "human source hash syntax is not validated",
      breaks: "a missing or non-canonical artifact digest can cross the Workflow boundary",
      file: WORKFLOW,
      find: "    !CONTRACT_SOURCE_SHA256.test(source.humanRequirementsSha256)",
      replace: "    false",
      kills: ["API AUTHORITY: contract-source decoding refuses unknown fields and incomplete human authority"],
    },
    {
      name: "Workflow transport may disagree with the durable run envelope",
      breaks: "a payload can switch extraction and human-authored denominator authority",
      file: WORKFLOW,
      find: "        if (!sameContractSource(requested, durable)) {",
      replace: "        if (false) {",
      kills: ["API AUTHORITY: workflow payload cannot change the envelope's contract source before resume or reuse"],
    },
  ],
});
