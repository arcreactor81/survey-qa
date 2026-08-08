# The facet-instance id collision — first real end-to-end run

Run `v2r_01kzf7ehb2sayx2y2xz4ecm1ed`, real questionnaire, real models. Extraction succeeded
(pass A grok-4.5, 23 requirements; pass B deepseek-v4-pro, 181 requirements over 24 chunks;
zero failed units). The contract sealed as
`cr_2a98b085b5652fe39f23c8145e7d785f597958da` — 189 requirements. Planning then died three
times on the same line:

```
Error: planning refused duplicate sealed facetInstanceId fi_b74430a941910fc9a6f9
```

## The mechanism, exactly

`facetInstanceId` is minted in `src/extract/expand.ts`:

```ts
const certificate = `xc_${sha256({ expander, requirementVersionId, case, expectationGap, index }).slice(0, 16)}`;
facetInstanceId:   `fi_${sha256(`${requirementVersionId}|${index}|${certificate}`).slice(0, 20)}`
```

Every input to that id is either the **requirement's version id**, the **case**, or the
**index of the case within its row**. So the id is unique across rows **if and only if
`requirementVersionId` is**. It was not.

`requirementVersionId` is minted in `src/extract/merge.ts#toRequirement`. Before this fix it
hashed exactly five fields:

```ts
sha256(JSON.stringify({ s: statement, q: docQuote, scope, quant: quantifier, f: construct }))
```

and `requirementLineageId` hashed only two of them (`construct | normalizeText(statement)`).

**A rating grid states the same mandate once per row.** In the real document, "The response
options for this statement must be: Strongly agree (code 1), …" is stated for grid row D and
again for grid row E. Across those two requirements the statement is identical, the doc quote
is identical (same `atomTextHash`), the scope is the bare string `question` with no id, the
quantifier is `specific` and the construct is `option-list`. All five hashed fields agree, so
both rows minted **one** `requirementLineageId` (`req_f4vtks533hcp`) and **one**
`requirementVersionId` (`reqv_636312bac370b797cdd31883`) — and therefore one certificate and
one `facetInstanceId`.

Reproduced bit-for-bit from the sealed artifact by re-running the pre-fix formula over both
rows: certificate `xc_26c96dd0b2b3c3eb`, id `fi_b74430a941910fc9a6f9` — the exact id planning
refused, from both.

## Collision, not duplication — and how we know

The two sealed facet instances are **byte-identical**. The two requirement rows behind them
are **not**. Pulled from the sealed revision, they differ in exactly two fields:

| field | row A | row B |
|---|---|---|
| `selector` | `"I enjoy trying coffee from parts of the world I have not tried before." statement` | `"Making coffee at home is better value than buying it from a coffee shop." statement` |
| `sourceAtoms` | `b0224…b0229` — table row 5, rowHeader **D** | `b0231…b0236` — table row 6, rowHeader **E** |

They are **two genuinely distinct requirements** — two rows of one grid, each stating its own
answer scale — that collided on a **too-weak id**. Deduplicating them would have deleted a
mandate the document states and shrunk the denominator D10 exists to protect.

The merge also **structurally cannot** duplicate a raw, which excludes the other diagnosis by
construction rather than by this one instance: each pass-A item lands in exactly one group,
`usedB` prevents a pass-B item from matching twice, and every unmatched pass-B item gets its
own group.

## Why it mattered beyond planning

`plan.ts:166`, `structure/compile.ts:185` and `stages/assemble-record.mjs:80` all key **maps**
on `requirementLineageId`. A shared lineage id means one of the two rows is silently shadowed
in every one of them — 189 requirements reaching 188 map entries. Planning's refusal was the
first thing loud enough to notice. **It is left exactly as it was.**

## The fix: collision-scoped widening

`merge.ts` mints identity at escalating levels. **Level 0 is the historical derivation, byte
for byte**, and is never changed — a requirement id is inside `semanticContractBody`'s digest,
and the revision id *is* that digest, so widening unconditionally would move the identity of
every revision of every unchanged document and silently re-point every cross-run comparison.

Only the members of a colliding group escalate, and they escalate **together, on content**,
never on position in the array:

| level | identity derives from |
|---|---|
| 0 | statement, docQuote, scope, quantifier, construct *(unchanged, historical)* |
| 1 | + `selector` — the field naming **which** instance of a repeated mandate this is |
| 2 | + the cited source blocks, and the full version tuple |

Level 2 folds the whole version tuple into the fingerprint deliberately: two rows still
sharing a lineage id there agree on **every** field identity derives from, which is what makes
the collapse below a total rule rather than a guess.

On the real pair, level 1 separates them: `req_g6by217vf45x` / `req_6fn96tmwttcf`.

### The one case that *is* duplication

Rows still sharing a lineage id at level 2 are identical in statement, quote, scope,
quantifier, construct, selector **and** source blocks — **up to normalization**. The level-2
fingerprint normalizes the prose fields (case, punctuation, whitespace), so two rows whose
model-written restatements differ only in spelling also collapse, even though their raw-field
version ids differ. That is the intended reading: a trivially re-spelled duplicate of the same
mandate over the same cells is one mandate, not two. They collapse into one row carrying both
readings' provenance (`foundBy` unioned, `raw` concatenated) rather than being counted twice,
which would inflate the denominator.

Both the widening and the collapse are reported in `diff.summary` — a repeated mandate is a
fact about the document, and an auditor should not have to infer it from the shape of an id.

### The precondition, now stated

`expandFloor` refuses a duplicate `requirementVersionId` across rows before minting anything,
naming `extract/merge.ts` as the place to act. It does **not** deduplicate: two rows sharing a
version id is exactly the condition under which we cannot tell whether they are one
requirement or two.

## Decisions and accepted caveats

- **`MERGE_VERSION` was NOT bumped, deliberately.** `shared/v2-record.mjs#semanticContractBody`
  keeps each gate proof's `evaluatorVersion` **inside** the hashed body (line 97), so bumping
  it would move every future revision id for unchanged documents — the exact outcome this fix
  is designed to avoid. The derivation change is invisible to every document that never had a
  collision, which is what makes leaving the version alone honest rather than convenient.
- **Identity becomes set-dependent for a colliding pair.** A future run over a document that
  states only grid row D mints the unsuffixed level-0 id for it, where this run mints a level-1
  id. That is the price of keeping every already-unique id byte-stable, and it is the side the
  owner chose.
- **The alternative — always hashing the selector — is a derivation-version bump, not a bug
  fix.** It is the cleaner long-term design and it moves every existing id. Left for the owner
  as an explicit decision, not taken here.

## Tests

`tools/tests/d27-identity-collision.test.mjs` (8 cases), registered in `tools/test.mjs`.
`merge` was added to the testkit bundle registry so the tests drive the **real** identity mint
rather than a fixture requirement row.

Evidence they can fail, via the bundle-rewriting mutation hook (never touches `src/**`):

```
MUTANT_FILE=src/extract/merge.ts \
MUTANT_FIND="const MAX_IDENTITY_LEVEL = 2;" \
MUTANT_REPLACE="const MAX_IDENTITY_LEVEL = 0;" node tools/test.mjs D27      # 3 of 7 red

MUTANT_FILE=src/extract/merge.ts \
MUTANT_FIND="const MAX_IDENTITY_LEVEL = 2;" \
MUTANT_REPLACE="const MAX_IDENTITY_LEVEL = 1;" node tools/test.mjs D27      # partial-separation red

MUTANT_FILE=src/extract/merge.ts \
MUTANT_FIND="const prior = collapsedInto.get(lineage);" \
MUTANT_REPLACE="const prior = undefined;" node tools/test.mjs D27           # collapse test red
```

The "already-unique ids do not move" case recomputes the **literal pre-fix formula** inline, so
it goes red the moment the base derivation is touched — which is the change that would move the
identity of every revision ever sealed.
