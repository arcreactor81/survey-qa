#!/usr/bin/env node
import { runMutantSuite } from "./mutate-runner.mjs";
const FILE = "tools/grok-rate-attestation-core.ts";
const WORKER_FILE = "tools/grok-rate-attestation-worker.ts";
await runMutantSuite({ title: "GROK RATE ATTESTATION MUTANTS", filter: "GROK RATE ATTESTATION", mutants: [
  { name: "accepts another model identity", breaks: "a different model can lend its price to grok-4.5", file: FILE, find: "if (id !== EXACT_GROK_MODEL || object !== \"model\" || ownedBy !== EXACT_XAI_OWNER)", replace: "if (false)", kills: ["aliases, redirects, unknown keys, duplicate keys, and wrong identity fail closed"] },
  { name: "follows a model redirect", breaks: "an alias can resolve to a different priced model", file: FILE, find: 'redirect: "error"', replace: 'redirect: "follow"', kills: ["fixed request has one exact GET, redirect error, and never lets a caller select a model"] },
  { name: "permits an unreviewed price field", breaks: "unknown provider pricing can silently enter a receipt", file: FILE, find: "if (!keys.has(key))", replace: "if (false)", kills: ["aliases, redirects, unknown keys, duplicate keys, and wrong identity fail closed"] },
  { name: "permits recursively duplicated catalogue keys", breaks: "a nested last-wins duplicate can replace a reviewed catalogue fact", file: FILE, find: "if (keys.has(key)) bad();", replace: "if (false) bad();", kills: ["aliases, redirects, unknown keys, duplicate keys, and wrong identity fail closed"] },
  { name: "permits a fractional price", breaks: "rate conversion no longer has integer tick authority", file: FILE, find: "!Number.isSafeInteger(value)", replace: "false", kills: ["malformed, noninteger, contradictory, non-JSON, and oversized catalogue responses cannot make a receipt"] },
  { name: "removes the long-tier activation limitation", breaks: "base-only accounting can buy long-context Grok", file: FILE, find: 'threshold === 0 ? null : "LONG_CONTEXT_COSTING_REQUIRED"', replace: 'null', kills: ["malformed, noninteger, contradictory, non-JSON, and oversized catalogue responses cannot make a receipt"] },
  { name: "accepts a framed or streamed operator request", breaks: "a raw peer can smuggle an operator request body into the authenticated catalogue trigger", file: WORKER_FILE, find: "if (!bodyless(request))", replace: "if (false)", kills: ["operator protocol refuses POST, query aliases, wrong auth, body streams, and framing headers before provider access"] },
] });
