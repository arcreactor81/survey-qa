#!/usr/bin/env node
/** Semantic counterproofs for extraction input-wire barriers, replay, and exact transport. */
import { runMutantSuite } from "./mutate-runner.mjs";

const PASS_B = "src/extract/pass-b.ts";
const CHAT = "src/llm/chat.ts";
const CHUNK = "Pass-B keeps a same-row unit indivisible and retained late refusal blocks earlier work";
const SWEEP = "all sweep slices preflight before sweep 1 and retained late sweep stays zero-call";
const ORDINARY_TRANSPORT = "ordinary chat transport sends the exact admitted serialized body";
const PRESERIALIZED_TRANSPORT = "preSerialized chat transport sends the exact admitted body";

await runMutantSuite({
  title: "Extraction input-wire barriers refuse before every Pass-B purchase",
  mutants: [
    {
      name: "fresh oversized chunk no longer becomes the wave-wide refusal",
      breaks: "a later indivisible oversized chunk can stop being persisted and counted before earlier work",
      file: PASS_B,
      find: "if (pendingChunkWireFailure !== null) {",
      replace: "if (false && pendingChunkWireFailure !== null) {",
      kills: [CHUNK],
    },
    {
      name: "retained terminal chunk no longer blocks credential resolution",
      breaks: "re-entry touches Secrets Store for earlier missing work despite durable terminal authority",
      // Re-anchored 16 Aug 2026: the failure ladder split the old blanket !terminalFailure
      // gate. Model-output terminality deliberately no longer blocks credentials (surviving
      // chunks still get bought); what must keep blocking is durable INFRASTRUCTURE
      // authority — rate exceeded, persistence conflict, wire ceiling. The mutation removes
      // exactly those three guards.
      file: PASS_B,
      find: "if (pendingChunkWireFailure === null && !failureRateExceeded && persistenceConflictFailures === 0 && terminalReasonCode !== EXTRACTION_MODEL_INPUT_WIRE_CEILING_EXCEEDED && todo.length > 0) {",
      replace: "if (pendingChunkWireFailure === null && todo.length > 0) {",
      kills: [CHUNK],
    },
    {
      name: "fresh oversized sweep slice no longer gates every earlier sweep",
      breaks: "the first sweep can proceed even though a later deterministic slice is already unsafe",
      file: PASS_B,
      find: "if (pendingSweepWireFailure !== null) {",
      replace: "if (false && pendingSweepWireFailure !== null) {",
      kills: [SWEEP],
    },
    {
      name: "retained terminal sweep no longer blocks credential resolution",
      breaks: "re-entry resolves a credential for an earlier missing sweep before retained terminal authority",
      file: PASS_B,
      find: "pendingSweepWireFailure === null && retainedSweepTerminal === null",
      replace: "pendingSweepWireFailure === null",
      kills: [SWEEP],
    },
    {
      name: "transport appends an unmeasured byte after exact wire admission",
      breaks: "fetch can receive more bytes than the body admitted by the shared wire gate",
      file: CHAT,
      find: "body: bodyText,",
      replace: `body: bodyText + " ",`,
      kills: [ORDINARY_TRANSPORT, PRESERIALIZED_TRANSPORT],
    },
  ],
});
