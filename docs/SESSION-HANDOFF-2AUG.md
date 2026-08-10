# Session handoff — 2 Aug 2026 (usage-limit cutoff)

State capture written at cutoff. The authoritative copy of pending owner rulings and agent
pointers lives in the orchestrator's memory; this is the repo-side mirror for anyone opening
the tree cold.

## Critical path to the first real verdict (in order)

1. **Fix the arms baseline regression.** `src/arms/*` wired at `run-workflow.ts:440` throws
   `UNRESOLVED_COMPONENT: ingest="v2-two-pass"` when NO `ARM_MANIFEST` is set — 2 d13-recovery
   tests red. The no-manifest path must be byte-identical to pre-arms behaviour.
   Acceptance: `node tools/test.mjs` ≥ 138/145 (only the 5 stale d11 tests red), `tsc --noEmit` clean.
2. **One deploy** of survey-qa-v2. Picks up the typed-case expander fix and the production
   `JUDGEMENT_KEY_REGISTRY` pin (both uncommitted in the tree). All four signing secrets are
   already uploaded. `DEFAULT_TARGET_BUILD_ID`: derive from a content hash of the crawled
   site — do NOT set a static tag.
3. **First cloud verdicts.** Ceiling is 16/220 typed cases on t1-easy (7.3%); live count will
   be lower until step 4.
4. **Make `execute-batch.ts` read the typed case** — it currently never drives a documented
   answer or boundary value; walks satisfy cases only incidentally.
5. **Wire the model verifier** — 134 of 204 expectation gaps are NO_TYPED_PREDICATE_FOR_KIND;
   this is a ~9× ceiling lever vs ~1.5× for better extraction. Blocked on an owner ruling:
   may a model-attested TYPED OBSERVATION (never a verdict) earn `verified` through the
   deterministic derivation path? Recommended yes, provenance-marked.

## What landed today (all uncommitted unless noted)

- worker-v2 deployed behind Access; full submission runs end-to-end; extraction real
  (two-method passes, sealed 226-req contract, ~$0.13/doc)
- `project-observations.ts` (the missing producer) + rewritten `verify-observations.ts`
  (derived `verified`, 9 negative tests, mutation-checked)
- Typed-case expander fix: killed 50 fabricated cases (destination "CONTINUE" token-matching
  any Continue button = passes nothing checked); closed 8-code EXPECTATION_GAP registry;
  7/7 mutants killed (`tools/mutate-expander.mjs`)
- `evaluation/` pre-registered ablation harness (16/16 mutations killed) + `evaluation/arms/`
  isolation (5 slots, per-arm configs, tree-hash parity gate that caught a real
  two-trees-one-SHA failure)
- `graph-spike/FINDINGS.md`: graph = component not architecture; self-consistency 0/18;
  coverage arithmetic is the prize; 11% edges / 89% attributes
- `docs/document-processing-playbook.md`; toMarkdown benchmarked and rejected (keep ours)
- pa-policy-extractor: container deleted (self-rearming alarm loop billing wall-clock),
  repo+site updated and PUSHED (693dd48), `workers_dev:false` declared after a deploy
  silently re-enabled it
- `CLAUDE.md` north star: generalizable architecture — any survey + link combo; corpus is an
  instrument, never a specification

## Open experiment threads

- **Prereg §1.1 Arm A is a fiction** — v2 already navigates/judges deterministically. Owner
  to rule: build strawman / redefine / drop (recommended: drop → component ablations).
- Corpus100: 40/60 salted split exists in `test-suite/blind/corpus100/design/registry.json`;
  survey directories EMPTY; first-10 gate in force (probe surveys attacking known anchoring
  assumptions; ≥2 non-template document production paths; ≥2 clean controls).
- Blind defect plans authored by GPT (codex job `task-msbo6u3i-kzclqf`) — the orchestrator
  must never read them; builder agents consume the job log directly.
- Extraction trust: only 3/226 rows found by both passes (diagnose: disjoint-by-design vs
  dead matcher vs hallucination) and 155-vs-226 run variance unmeasured — both cheap, both
  before trusting the contract.
