# Canary deployment integrity contract — 11 August 2026

Status: local deployment-integrity implementation is negative-tested; live deployment is not yet
approved.

Implemented locally as of 11 August:

- exact local Wrangler package/bin/version pinning, integrated into the Workflow interlock;
- ACL-private local-output verification;
- new-only source snapshot selection/copy/manifest/reverification with link and secret refusal;
- client-side expected-questionnaire SHA-256 rejection before credentials, output, fetch, or spend;
- exact one-call canary accounting and retention-first handling of core/visual poll contract gaps;
- recursive semantic discovery of required visual test modules;
- a discovery build, separately audited build, immutable reviewed-bundle freeze, and mandatory
  final replay of the exact reviewed no-bundle deploy config through pinned Wrangler 4.106.0's
  production `versions upload` handler in dry-run mode;
- a retained canonical final-replay manifest that binds the reviewed manifest, deploy-config
  digest, Wrangler toolchain identity, sanitized log identity, and the exact recursive output
  census.

Still required before a live deployment: finish concurrent correctness repairs, run the complete
local/type/mutation gates over the settled tree, generate fresh profiles from one newly frozen
source/config/document tuple, run the live Workflow and remote-secret preflight gates, and obtain
an explicit final deployment decision. The superseded `20260810-c` profiles must not be deployed.

The live model comparison must test one exact source/build/config/document tuple. A config hash
alone is insufficient: the hardened path separately binds the sealed source/assets snapshot, the
audited reviewed bundle, the final no-bundle config, and the exact replay output.

Current Cloudflare primitives used by this design:

- Wrangler supports `--dry-run --outdir` and a build metafile for reviewing its bundled output.
- Wrangler supports `no_bundle` for deploying already-preprocessed JavaScript plus declared
  additional modules.
- A Worker version-metadata binding exposes the active version id, tag, and creation timestamp.

Official references:

- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/wrangler/bundling/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/

## Identity tuple

Every arm must bind and retain this non-secret identity before any paid request:

1. source snapshot manifest SHA-256;
2. bundled Worker/module manifest SHA-256;
3. static-assets manifest SHA-256;
4. generated deploy-config SHA-256;
5. visual provider-policy SHA-256;
6. pinned Node/Wrangler/TypeScript versions, package manifests, direct entrypoints, lockfile, and
   complete installed-toolchain inventory SHA-256;
7. questionnaire bytes SHA-256;
8. provider/model/configuration identity;
9. record and judgement public key ids;
10. deployed Cloudflare version id.

Changing any member creates a different arm. Results from different tuples cannot be silently
combined.

## Freeze and build

1. Require all writers and mutation harnesses to be terminal.
2. Copy the deployable Worker source, shared modules, public assets, canary tooling/config source,
   and root package lock into a new ACL-private snapshot directory. Refuse links, reparse points,
   unexpected files, secret-like files, and an existing destination.
3. Produce a sorted manifest of relative path, byte length, and SHA-256. Hash the canonical
   manifest bytes.
4. Run every required local gate against this snapshot or prove that the tested live-tree manifest
   still exactly equals the snapshot manifest before and after the gates.
5. Run pinned Wrangler `deploy --dry-run --strict --outdir ... --metafile ...` against the snapshot.
6. Require all provider arms to produce the same Worker/module/assets hashes. Provider selection
   must remain config, not a source fork.
7. Generate a second deploy config whose `main` is the reviewed JavaScript artifact, whose module
   rules include exactly the reviewed additional modules, and whose deployment uses `no_bundle`.
   This prevents a second source-bundling pass from observing a different working tree.
8. Mark the snapshot/build files read-only after creation. Recompute every manifest immediately
   before and after deployment. Any mismatch stops before paid execution; a post-deploy mismatch
   also invalidates and quarantines that version.

### Final reviewed replay and census gate

Preparation now has three distinct pinned-Wrangler dry-runs. The first discovers the graph; the
second is independently audited and becomes the reviewed bundle; the third runs only after the
final deploy config has been projected onto that reviewed bundle. The third command is exactly
`versions upload`, dry-run, strict, outdir, and config under the already-validated local
Node/Wrangler descriptor. It has no metafile argument, secrets file, control-plane side effect, or
model call. This is the same pinned subcommand used by the later production version upload, rather
than an inferred equivalence with `deploy`.

The final replay accepts only the reviewed entry, every reviewed additional module with the same
path/type/byte length/SHA-256, and Wrangler 4.106.0's timestamped README by-product. It recursively
counts files and directories and refuses maps, TypeScript source, reviewed manifests, unknown
files, empty extra directories, links, junctions, substituted paths, wrong README shape, or a
total/file count above the closed ceiling. It persists one canonical manifest binding that census
to the final deploy-config SHA-256, reviewed-bundle-manifest SHA-256, Wrangler toolchain identity,
and sanitized log identity.

The retained output, log, config, reviewed bundle, and canonical manifest are recomputed by every
prepared-state verification before a later control-plane side effect. The replay manifest is
local mandatory evidence; it is not a substitute for the independent remote version and runtime
attestation.

Failure-capable evidence recorded on 11 August:

- before production implementation, the focused suite was deliberately red at 15/16 because the
  replay entrypoint did not exist;
- after implementation, the focused suite is 30/30 green, including
  wrong-rule, nonzero-command, extra-map, missing-module, substituted-byte, and retained-drift
  negatives;
- a real preparation-orchestrator test executes exactly three dry-runs, proves the third uses and
  retains the final reviewed config/output manifest, mutates the retained entry, and observes
  `FINAL_REPLAY_FILE_IDENTITY_MISMATCH` before any Workflow gate or control-plane subprocess;
- three exact-anchor in-memory source mutants remove, respectively, the automatic replay call,
  `prepared.finalReplay` retention, and the default prepared-state verification. Each is killed,
  so deleting any mandatory wiring seam can no longer leave the suite green;
- a fourth exact-anchor source mutant replaces `versions upload` with `deploy`; the independent
  command oracle rejects it with `FINAL_REPLAY_COMMAND_MISMATCH` before any subprocess;
- the real pinned Wrangler 4.106.0 graph/replay integration is 2/2 green on the settled command
  guard, and its production-freeze case invokes the production replay/census implementation
  itself;
- the serial one-call runner remains 17/17 green;
- no Cloudflare authentication, network request, deployment, secret read, or model call occurred.

The control manifest also contains a TypeScript-AST-derived import graph. Every static import,
re-export, import type, and literal dynamic import must resolve to an explicit repository-relative
source filename already present in the control denominator; only `node:*` built-ins are external.
Bare packages, URLs, extensionless or missing paths, and non-literal dynamic imports fail closed.
The sole named exception is `verified-typescript.mjs`, whose one dynamic import must have the exact
pinned-entrypoint AST shape and whose compiler bytes are independently included in the toolchain
identity. Direct CommonJS `require(...)` is forbidden. The one `createRequire` declaration in the
pinned toolchain adapter may only perform the three exact reviewed resolution-only lookups for
Wrangler and TypeScript; it cannot execute the returned loader or resolve another package.

Named residual: this closure is evaluated by already-loaded local control code. It cannot prove
that a privileged actor did not execute substituted code during module evaluation and restore the
reviewed bytes before the graph/hash checks. The pinned compiler-before-import sequence, exact
entrypoint hashes, immutable manifests, and repeated checks narrow that race; they do not claim to
eliminate a privileged local swap-and-restore attacker.

Command-parity status: the retained replay now invokes pinned Wrangler 4.106.0's exact
`versions upload --dry-run --strict --outdir --config` handler, and its canonical evidence records
that argv shape. The production transition uses the same `versions upload` subcommand and reviewed
config. Remaining named differences are intentional and bounded: the dry-run omits the production
`--name`, `--secrets-file`, `--tag`, and `--message` arguments and performs no account lookup or
upload.
Therefore it proves the pinned handler's config parsing, no-bundle materialization, module census,
and dry-run upload-form construction; it does not claim to prove remote secret inheritance,
version annotation persistence, or Cloudflare's control-plane acceptance. Those stay covered by
the separate pre/post-upload attestation gates.

## One hardened deploy process

The deploy wrapper—not a copied shell command—must:

- use the validated local Node executable plus validated Wrangler JavaScript entrypoint;
- pin account, public control plane, Worker, Workflow, R2, assets, provider, budgets, and routes;
- remove the complete closed set of Cloudflare/Wrangler credential, endpoint, config, environment,
  proxy, and output overrides case-insensitively;
- recheck ACLs, manifests, config, secret-file hash, and questionnaire hash immediately before
  spawn;
- use a new ACL-private sanitized log;
- capture the deployed version id from structured or independently verified control-plane output;
- never fall back or roll back automatically to a superseded version.

## Remote pre-spend attestation

Add a canary-only authenticated GET endpoint and version-metadata binding. It returns only
non-secret evidence:

- active Cloudflare version id/tag/timestamp;
- source/build/assets/config/provider-policy hashes;
- provider/model and one-call caps;
- expected questionnaire hash;
- expected public signer key ids;
- presence of the required Workflow/R2/AI/Browser/Secrets Store bindings;
- result of signing and verifying one fixed, build-bound challenge with each configured signer.

The challenge has no caller-controlled bytes. No private key, signature oracle, secret value, or
raw provider response is returned.

Before POST, the client requires exact agreement between local expected identity, control-plane
version id, and remote attestation. It also runs a distinct credential-free request and requires
the wrapper's closed anonymous denial response.

## Questionnaire binding

The client requires `--expected-document-sha256` and verifies the local file before creating a
submission plan. The canary wrapper independently hashes the decoded submitted bytes and compares
them with its configured expected hash before claiming the arm or creating a Workflow.

This is a canary-adapter constraint, not a document-specific rule in the core system.

## Required negative evidence

- mutate any source, asset, config, module, package-lock, Wrangler, provider-policy, or document
  byte and prove pre-spend rejection;
- add/remove/rename an additional build module and prove rejection;
- substitute a valid config that points at a mutable source entrypoint and prove rejection;
- inject every forbidden environment override in mixed case and prove it cannot reach Wrangler;
- return a wrong remote version/build/provider/signer identity and prove no POST occurs;
- omit the version-metadata binding or any required binding and prove no POST occurs;
- make authenticated health pass while anonymous denial or attestation fails and prove no POST;
- edit the snapshot during a simulated deploy and prove the arm is invalidated;
- prove the gate itself fails on a deliberately red fixture or mutation.

## Serial execution rule

After one arm deploys, no source/build/config mutation is permitted until both Workflows are
terminal and all artifacts, denominators, usage, costs, and limitations are collected. Only then
may the next provider deploy from the same frozen build. Any tuple drift restarts the comparison.
