# Frozen-contract sprint scorer

This directory contains a corpus-agnostic scorer. It imports no corpus, manifest, placement,
or answer-key module. The independent scoring holder supplies two things at execution time:

1. JSON containing production `RunRecordV2`-like records.
2. A private ESM oracle implementing the interface documented in `score.mjs`.

Run it with:

```powershell
node worker-v2/tools/sprint-score/cli.mjs --records <records.json> --oracle <private-oracle.mjs> --pretty
```

The CLI prints aggregate-only JSON. It never prints case ids, run ids, entity references, or
private oracle metadata. Its failure surface is redacted to a closed error code because an
oracle exception itself could contain a private placement. Any missing record, empty
denominator, malformed entity, unproven stage, invalid oracle, or inconsistent strict claim
exits nonzero. Detailed errors remain available from the module API to the independent holder.

The CLI runs record loading, the private oracle, and scoring in a child process whose stdout and
stderr are discarded. The parent accepts only a versioned IPC packet, reconstructs the public
summary from a closed vocabulary of fields and non-negative counts, and emits only whitelisted
error codes. This contains accidental oracle logging and exception detail; the private oracle
remains trusted scoring code, not an adversarial-code sandbox.

The scorer evaluates five independent evidence probes and computes the sixth stage itself:

1. eligible
2. exact screen reached
3. uniquely bound
4. typed case emitted
5. decided
6. strict claim matched

A strict match requires the right defect type, exact requirement lineage and version, and a
claim-referenced observation with the expected payload kind, closed predicate, and a
`contradicted` verifier decision. Claim prose has zero matching weight.

Before matching, the scorer validates the record linkage used as proof: each cited observation
must exist, belong to a unique facet, and that facet must belong to the claim's normative item.
Passed binding, typed-case, and decision probes must likewise cite an entity owned by the
expected normative item. Existing but unrelated evidence cannot prove those stages.

Strict claims are allocated one-to-one across oracle defects with deterministic maximum
matching. One production claim can never receive credit twice, while an augmenting-path
reassignment prevents a broad case from consuming the only claim available to a more specific
case. Exact duplicate oracle identities fail loudly instead of creating an inflated denominator.

`gaps` is an exclusive first-failure partition. `stages` is independent accounting, so an
early coverage failure cannot hide later evidence. The output reports separate end-to-end,
conditional-reached, and conditional-reached-and-bound denominators. A zero conditional
denominator is emitted as `status: "no-denominator"` with `rate: null`, never as success.

Run the isolated synthetic tests with:

```powershell
node --test worker-v2/tools/sprint-score/score.test.mjs
```
