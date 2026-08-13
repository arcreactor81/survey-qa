# CUA quarantine lane

Status: local/mock GO for the adapter contract; production NO-GO.

The adapter in worker-v2/src/browser/openai-computer-use.ts is intentionally not wired into walkPath, provider selection, public/API routes, or deployment configuration. It has no default credential, fetch, origin, budget, or endpoint. No paid or live survey call is part of this validation.

Contract evidence closed in this lane:

- GA computer tool shape, batched actions[], screenshot continuation, modifier-key names, drag point variants, and human-in-the-loop guidance were checked against the [official Computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use).
- The only accepted model identities are gpt-5.6-luna and gpt-5.6-terra, both checked against their [official Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and [official Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) pages.
- Credentials are sent only to the exact https://api.openai.com/v1/responses endpoint.
- Optional GA mouse fields normalize conservatively; unknown modifiers, malformed buttons, unsupported actions, and invalid drag paths fail closed.
- store:false replay retains the original user/task item and every response output item, including encrypted reasoning items; no previous_response_id is sent.
- Each action is approved against a fresh screenshot receipt and exact current URL. A later action in the same model batch cannot reuse the earlier action's approval state.
- Returned model identity, usage telemetry, response bytes, output-item count, action count, screenshot bytes/dimensions, text, coordinates, turns, wall clock, and application cost are bounded or fail closed.

Local evidence (2026-08-13):

- node --test tools/tests/openai-computer-use.test.mjs: 21/21 passing.
- node tools/mutate-openai-computer-use.mjs: baseline PASS, no-op PASS, model-identity mutant KILLED.
- npm run typecheck: PASS.
- This is synthetic/mock evidence only; it is not live performance evidence and does not authorize production wiring.