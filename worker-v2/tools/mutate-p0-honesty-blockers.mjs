/**
 * Semantic mutation proof for the P0 fail-closed browser/progress blockers.
 *
 *   node tools/mutate-p0-honesty-blockers.mjs
 */
import { runMutantSuite } from "./mutate-runner.mjs";

const DR = "src/browser/driver.ts";
const PS = "src/browser/page-script.ts";
const EB = "src/workflow/stages/execute-batch.ts";

await runMutantSuite({
  title: "P0 honesty blockers - can every fail-closed guard go red?",
  filter: "P0 honesty blockers",
  mutants: [
    {
      name: "multi-question screen is allowed to actuate",
      breaks: "two disjoint visible question owners can receive one binding/default and a forward click",
      file: DR,
      find: "      rootCount >= 2",
      replace: "      false",
      kills: ["two visible question roots stop before binding, defaults, forward click, or coverage"],
    },
    {
      name: "identical-template movement returns to signature-only",
      breaks: "real roster/progress movement on an unchanged template is recorded as blocked",
      file: DR,
      find: "      movementSignals = advanceSignals(advanceBaseline, after);",
      replace: "      movementSignals = after.screenSignature !== advanceBaseline.screenSignature ? [\"screen-signature-changed\"] : [];",
      kills: ["identical template with delayed numeric progress is advanced and names its proof"],
    },
    {
      name: "native choice groups ignore form owner",
      breaks: "same-name radios in two native forms collapse into one respondent question",
      file: PS,
      find: "    var formOwner = Number.isSafeInteger(c && c.formOwner) && c.formOwner >= 0 ? c.formOwner : null;",
      replace: "    var formOwner = null;",
      kills: ["type, exact name, form owner and unnamed singleton identity define groups without key collisions"],
    },
    {
      name: "unnamed choices collapse into one global group",
      breaks: "two unnamed native controls are treated as one respondent question",
      file: PS,
      find: "    var unnamedControlIdx = name === null ? c.idx : null;",
      replace: "    var unnamedControlIdx = null;",
      kills: ["type, exact name, form owner and unnamed singleton identity define groups without key collisions"],
    },
    {
      name: "choice readback accepts a foreign native form",
      breaks: "a same-name checked radio in another form can certify the target group",
      file: DR,
      find: "    got.formOwner !== identity.formOwner ||",
      replace: "    false ||",
      kills: ["a retained choice from a same-name foreign form cannot satisfy the owning group receipt"],
    },
    {
      name: "multiple explicit forward controls are truncated to DOM-first",
      breaks: "the first of two visible Next/Submit controls is chosen silently",
      file: DR,
      find: "  if (explicit.length > 1) return { kind: \"ambiguous\", candidates: explicit };",
      replace: "  if (explicit.length > 1) return { kind: \"unique\", control: explicit[0], candidates: explicit };",
      kills: [
        "two visible enabled forward controls are named and neither is clicked",
        "one explicit Next beats Back/unrelated/hidden duplicates, but two explicit Next never use DOM order",
      ],
    },
    {
      name: "post-answer forward ambiguity falls through as no control",
      breaks: "answers can reveal two forward controls and the stop loses its named ambiguity",
      file: DR,
      find: "    if (navigation.kind === \"ambiguous\") {",
      replace: "    if (false) {",
      kills: ["forward ambiguity revealed after answers prevents the forward click"],
    },
    {
      name: "stored progress is treated as absent",
      breaks: "malformed durable bytes silently become a fresh zero ledger",
      file: EB,
      find: "  if (!obj) return emptyProgress(runId, planRevisionId);",
      replace: "  if (!obj || true) return emptyProgress(runId, planRevisionId);",
      kills: ["only a missing object becomes empty; malformed bytes are named and never overwritten"],
    },
    {
      name: "progress kind is not authenticated",
      breaks: "an unrelated object at progress.json is accepted as execution authority",
      file: EB,
      find: "  if (root.kind !== \"v2-execution-progress/1.0.0\") progressCorrupt(\"$.kind differs\");",
      replace: "  /* mutant: kind ignored */",
      kills: ["wrong kind/run/plan and row-total contradictions all fail closed"],
    },
    {
      name: "walk-step aggregate contradiction is ignored",
      breaks: "the ledger total can disagree with its own walk rows",
      file: EB,
      find: "  if (totalSteps !== summedSteps)",
      replace: "  if (false)",
      kills: ["wrong kind/run/plan and row-total contradictions all fail closed"],
    },
  ],
});
