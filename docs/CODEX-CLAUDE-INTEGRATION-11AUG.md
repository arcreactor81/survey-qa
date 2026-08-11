# Codex / Claude integration checkpoint — 11 August 2026

> **12 Aug:** the living cross-agent brief is now `docs/COORDINATION.md` — read that first for
> current state, owner rulings, and in-flight work. This file remains authoritative for the
> deployment no-go conditions and the navigator-contract design half.

This note coordinates concurrent review-driven work. It is not evidence that the canary is ready
to deploy.

## Shared baseline

- Commit `733c33389fef75523f8986521ead4823a7279d5f` is the restore point containing the full
  8–10 August working tree before Claude's review-driven fixes.
- Attribute Claude's implementation changes only against that commit.
- Do not read `test-suite/blind/**`, any `truth/**`, or `sprint/04-CORPUS.md`.

## Work ownership

- Claude is implementing the defects recorded in `survey-qa-review-findings-10aug`, including the
  option-inventory false-accusation paths and the enabled-visual zero-success canary defect.
- Codex owns the local ACL/deployment-control fixes in:
  - `worker-v2/tools/private-local-output.mjs`
  - `worker-v2/tools/tests/live-canary-deploy.test.mjs`
- Codex will independently cross-validate Claude's final diff and tests before any deployment.

## Live evidence from this session

1. The first Workflow interlock attempt stopped before Wrangler because the `20260810-c` profile
   was created under the sandbox identity but verified under the repository-owner identity.
2. The ACL verifier is now identity-stable: it binds the exact private-directory owner plus the
   individual repository recovery owner, requires the verifier/file owner to be one of them, and
   rejects every extra ACE.
3. Independent results after that fix:
   - focused deployment tests: 15/15;
   - Workflow-gate tests: 18/18;
   - real read-only ACL verification under both creator and repository-owner identities: pass.
4. The second Workflow interlock attempt passed the ACL seam and stopped at Wrangler version
   launch. Exact reproduction showed Node 24 returns `EINVAL` for
   `spawnSync("npx.cmd", ...)`. Direct Wrangler execution succeeds and reports `4.106.0`.
5. A standalone replacement now exists in `tools/pinned-wrangler-command.mjs`: it uses the running
   Node executable plus the exact local Wrangler JavaScript entrypoint and pins package/bin bytes.
   It is wired into the Workflow interlock, which no longer invokes `npx`, `.cmd`, or a PATH-selected
   Wrangler. The combined pin/interlock focused suite passes 25/25.
6. Neither attempt reached Cloudflare. No Workflow query, deployment, login, model call, or new
   model spend occurred.
7. `tools/canary-source-snapshot.mjs` now creates and verifies a new-only, link-refusing,
   secret-refusing deploy-source snapshot with a sorted byte-length/SHA-256 manifest. Its focused
   snapshot/runner suite passes 16/16. No deploy snapshot has been frozen yet because writers are
   still active.
8. The live-canary client requires an operator-supplied lowercase questionnaire SHA-256 and checks
   it before credentials, output creation, fetch, or spend. Its focused suite now passes 39/39,
   including poll-time schema and HTTP failures that must retain all seven endpoint responses and
   the final failure summary.
9. Durable visual inference now refuses provider model-identity drift after a paid call, retains
   its accounting telemetry, discards the untrusted content, and performs no second call on replay.
10. The semantic visual test runner recursively discovers nested test modules by their actual test
    imports rather than filename convention, so unconventional test names cannot silently fall out
    of the gate.
11. A blocked test axis is terminalized before the superseding signed record and report are built.
    The focused workflow suites pass 18/18 and 6/6; a deliberate regression mutant is killed by the
    signed cross-surface test even though the later finalize backstop still repairs the checkpoint.
12. Work still in progress before freeze: entailed-only option authority and partial quote gaps,
    table-cell provenance for combo/ruby content, and server/deploy-gate questionnaire binding.

## Current no-go decision

Never deploy the `20260810-c` profiles. Their bytes still match the old checkpoint, but Claude's
Worker changes make the retained bundle hash stale, and their original operational ACL proof has
been superseded.

Deployment remains blocked until all of the following are true:

- Claude has stopped writing and its exact diff from `733c333` is reviewed.
- The full Worker, visual, TypeScript, and mutation gates pass on one frozen source snapshot.
- The Windows Wrangler launcher no longer depends on direct `.cmd` spawning and is tested.
- A manifest binds source/imports/assets/config/client/package lock/Wrangler version to the exact
  snapshot used for dry-run and deployment; post-test recomputation must match.
- Deployment scrubs the same ambient Cloudflare/Wrangler overrides as the strongest read-only
  audit and records the deployed version id.
- The client checks the expected questionnaire SHA-256 before the paid POST.
- Post-deploy checks prove the version/build/provider/policy identity, exact remote secret names,
  authenticated health, and a separate anonymous denial before spend.
- Fresh host-owned signer/profile/token material is generated from the frozen snapshot.
- Each provider arm is fully terminal before the next arm is deployed.

The concrete freeze/build/attestation design is recorded in
`docs/CANARY-DEPLOYMENT-INTEGRITY-11AUG.md`.

## Intended serial outcome

After the combined tree passes those gates: run one bounded Gemma smoke, close and collect it,
then do the same for Gemini and Mistral. Compare quality, coverage, latency, reliability, and
settled cost. OCR 4 remains a separately metered durable workflow rather than an implicit second
vision call.

## Navigator integration direction

If Claude and Codex produce different walkers, retain both behind one platform-neutral navigator
contract instead of selecting one by inspection. Each engine emits read-only, provenance-bearing
observations and candidate actions. The browser runtime alone emits the executed-transition
receipt; both engine traces reference that same receipt rather than independently claiming what
happened.

- DOM/accessibility/graph and vision-semantic engines may observe or propose concurrently.
- Engines never receive executable page handles. Exactly one lease-fenced actuator owns mutation
  in a browser session and rejects stale epochs, ambiguous targets, second owners, and unsafe
  retries after an unknown effect.
- Observations merge into one survey graph by semantic/state identity, retaining engine and source
  provenance rather than overwriting disagreements.
- Agreement can raise confidence. Disagreement requires another bounded probe, an independent
  session replay, or a surfaced limitation; it cannot be resolved by an unreported guess.
- Platform-shaped selectors and behaviors remain declared adapters.
- Store occurrence transitions first, keyed by session/page/sequence/epoch plus history digest.
  Semantic aliases are later hypotheses; identical presentations reached through different
  histories are not silently collapsed.
- Coverage remains a deterministic ledger minted from the sealed document obligations and linked
  to actuator receipts/resulting epochs. Engines attach evidence but cannot mint coverage or a
  pass/defect verdict.
- Evaluate DOM/graph alone, vision-semantic alone, and the integrated navigator as separate arms on
  unfamiliar surveys. Integration is accepted only if it improves coverage without violating the
  false-positive and fail-loud gates.
