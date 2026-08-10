# Codex milestone checkpoints — 5 August 2026

## Milestone 1 — inherited baseline verified

Status: complete locally; Cloudflare inventory and stored artifacts audited read-only. No candidate was deployed.

### Files changed

- `worker-v2/src/workflow/stages/planner/plan-core.d.ts`
  - Declares the runtime-exported `pathSignature` used by `plan.ts`.
  - Corrects emitted planner shapes for skipped questions, termination, exploration rationale/probing, and text-entry length.
- `worker-v2/tools/tests/d11-gates.test.mjs`
  - Adds persisted-reader and independent-judge coverage for invalid gate maps.
- This checkpoint file.

No unfamiliar work was cleaned, reset, reverted, overwritten, or deleted. No commit, push, PR, or merge was performed.

### Defect and invariant

The inherited tree initially failed typecheck because `plan.ts` imported a real runtime export that its declaration file omitted. The declaration now matches that export and the nearby runtime payload shapes inspected during independent review.

The contract denominator may be sealed, re-read, or independently bound only when all four required extraction gates are present, each is `pass`, and each carries a valid proof. An empty map, a three-of-four map, a null map, or a present-but-proofless `pass` fails closed with gate-specific diagnostics after revision identity and record signature checks succeed.

The production cost-bucket expression remains:

```ts
.map((b) => [b, cp.counts[b]] as const)
```

### Tests added and strengthened

- Stored, correctly re-hashed invalid revisions are rejected by `getContractRevision`.
- Correctly hashed revisions referenced by a genuinely signed fixture RunRecord are rejected by the independent authority binder for gate failure—not misreported as identity, hash, or signature failure.
- Both caller tests cover empty, three-of-four, null, and proofless-pass gate maps.
- In-memory mutation testing removed stored-reader gate enforcement; the new D11 test failed, killing the mutant. Earlier required-gate enumeration mutation testing also failed as intended. No source file was mutated on disk.

### Local results

- `npm run typecheck`: pass.
- Focused D11: 17/17 pass.
- Focused D17: 10/10 pass.
- Complete deterministic worker-v2 suite: 176/176 pass, 0 failed.
  - This exceeds the latest inherited 174-case suite by the two caller-boundary tests and the older owner-supplied 165-case reference by eleven. No test was skipped, lost, or weakened.
- Wrangler 4.106.0 deploy dry-run: pass; 1,848.75 KiB upload / 436.09 KiB gzip; all declared bindings resolved; no deployment occurred.

### Cloudflare and GitHub observations

- Active Worker version: `3b6bdf57-8d1f-48e8-898b-b817500c9f67`, serving 100%.
- Prior version `724203ef-7202-45c3-9dab-4904b954ce13` remains available. Before a later candidate deployment, the currently active version must be retained as the explicit rollback point.
- No Workflow instance was running during inspection. Inventory was 12 completed, 1 errored, and 2 terminated.
- The latest engine-completed recovery remained application-level `partial-blocked`: 191/191 cases blocked and none exercised. It is not evidence of successful survey validation.
- The separate failed recovery durably records three 480-second extraction timeouts.
- The inspected published report HTML and data bytes matched their pointer SHA-256 values and lengths.
- Remote `master` remains `4e6e8ba443f8762dc150652f4548676ac0ffd2d3`; no PR was opened.

Fresh authenticated HTTP/Workflow validation could not be run: Cloudflare Access returns 302 to anonymous requests, no Access service-token variables or usable signed-in browser session are available in this environment, and no authorized real survey/document pair was available. Deployment alone would not satisfy remote validation, so no candidate was deployed and no remote-behavior success is claimed.

### Remaining risks and next milestone

Milestone 2 is the next correctness boundary. Current planning assigns sibling facet cases to a shared requirement path; typed enrichment collapses or overwrites incompatible route and boundary actions; execution may close every attached case from generic path completion. Case assignment, observed exercise, deterministic verdict, and expected-edge coverage must be separated and bound to exact evidence before downstream completion can be trusted.
