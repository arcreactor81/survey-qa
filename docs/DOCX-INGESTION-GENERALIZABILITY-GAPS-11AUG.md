# DOCX ingestion generalizability gaps — private real-document review

**Scope:** privacy-safe handoff from a structural audit of a real questionnaire supplied by the
owner. The source document, run identifiers, document text, reviewer identities, client metadata,
and exact private census remain under `.local-private/` and must never be copied here.

**Method limit:** LibreOffice/Poppler was unavailable, so this is OOXML/relationship inspection and
aggregate parser reconciliation, not rendered-page QA. No layout, clipping, or pixel-readability
claim follows from it.

## Result

V2 is materially safer than v1: it creates addressable body/table/auxiliary blocks and reports
many constructs v1 silently drops. The real document nevertheless confirmed that text-block
completeness is not the same thing as authoritative document coverage. The following are generic
production blockers, not survey-specific heuristics.

## Required parser/contract repairs

1. **Revision authority must be explicit.** The parser currently chooses the accepted tracked-
   change view. When pending revisions exist, require an explicit declared view or surface an
   authority question; do not silently treat one view as final.
2. **Comments need typed state and privacy-safe provenance.** Read and bind per-comment
   `commentsExtended` resolution state plus anchor identity. Keep author/initials out of
   `SourceBlock.origin`, extraction prompts, normal tool output, reports, and authority artifacts.
   If identity is retained at all, it belongs only in ACL-protected audit metadata.
3. **Auxiliary section scope cannot be inherited by document order.** A comment, header, footer,
   or image appended after body scanning must not inherit the last body heading. Preserve
   `section: null` until an exact anchor/section relation is proved.
4. **Image coverage needs semantic classes.** Separate descriptive alt text, generic object name,
   decorative image, no alt, and vision/OCR-needed. A generated object name is not proof that
   image content was read. Unreadable content gets a visible placeholder and counted limitation.
5. **Structural census must gate sealing.** Reconcile physical cells as text-bearing + empty =
   total, with spans and vertical merges explicitly represented or dispositioned. Aggregate prose
   warnings are not a source-ledger denominator, and an empty merge cell must not disappear.
6. **Every package part needs a disposition.** Reconcile archive entries into read, deliberately
   ignored, failed, or skipped. `read + skipped` over only a small subset must not be presented as
   full package coverage.
7. **Preserve auxiliary table structure.** Header/footer table cells must retain table/cell
   provenance instead of becoming ordinary paragraphs.
8. **Resolve or block generated numbering.** Use `numbering.xml`; otherwise retain `[#]`, count it,
   and withhold route/question identity that depends on the missing generated label.
9. **Preserve hyperlink semantics.** Keep displayed text and relationship target as distinct,
   provenance-bound atoms. A visible label alone may omit an operative destination.
10. **Coverage problems need a seal disposition.** A run may seal only after every material parser
    problem is resolved, explicitly accepted as a named limitation with bounded effect, or causes
    affected obligations to remain pending/unknown. Merely rendering problem prose later is not a
    gate.
11. **Private model transport must suppress payload retention.** Today `scanComments -> annotate ->
    pass A/B` sends reviewer-bearing origins through the shared chat transport. AI Gateway stores
    request/response payloads by default; `cf-aig-collect-log-payload: false` preserves metadata
    while suppressing those bodies ([Cloudflare logging documentation](https://developers.cloudflare.com/ai-gateway/observability/logging/)).
    Before any private-document model run, remove reviewer identity from the prompt projection,
    set and test that header on every Gateway request, stop persisting raw provider/model snippets
    in errors, and resolve the currently documented-but-unimplemented `ChatOutcome.logId` contract.
    Model-output validation also needs a sentinel negative because a model echo can otherwise
    persist into pass artifacts, sealed statements/quotes, records, and reports.

## Fail-capable fixtures required

- resolved and unresolved comments with invented sentinel reviewer metadata; changing the done
  state must change typed disposition, while the sentinel identity must never enter default model,
  report, tool, log, API, or authority surfaces;
- pass-A whole-document, pass-B chunk, pass-B sweep, and context-window requests proving the
  sentinel never reaches serialized request bodies; a transport assertion must also require
  `cf-aig-collect-log-payload: false`;
- provider HTTP, non-JSON, and malformed-model responses containing invented sensitive sentinels;
  persisted error detail must remain sanitized;
- a comment anchored in an early section, proving it cannot inherit a later heading;
- descriptive-alt, generic-name-only, and no-alt images, each producing distinct coverage;
- cells containing horizontal spans, vertical merges, and empty structural continuations, with a
  mutation that drops one physical cell and must fail reconciliation;
- a header/footer table whose coordinates survive ingestion;
- numbering restarts and multilevel labels, including a route that remains pending when its label
  cannot be resolved;
- an external hyperlink whose target mutation changes the provenance atom;
- accepted/rejected/current tracked-change views, proving unresolved authority cannot seal;
- an archive-part disposition mutation, proving one omitted entry makes the package census fail.

Each gate needs a deliberate red fixture or source mutation. All fixture prose and metadata must be
invented; the private document is evidence that the feature classes occur in practice, never a
template or test-data source.

## Ownership handoff

- Core `SourceBlock`, DOCX parsing, prompt view, coverage, and sealing changes belong to Claude's
  extract/expand correctness track while W1–W6 are active.
- Codex owns the independent privacy/output-boundary review and the eventual bounded vision/OCR
  adapter for images that remain unreadable after deterministic extraction.
- The operator catalogue is now schema `v2-human-contract-block-catalogue/1.1.0`: it preserves
  comment blocks, replaces reviewer-bearing origins with a generic proposal label, and reports a
  computed `commentReviewerIdentitiesWithheld` count. Its real DOCX sentinel fixture turns red if
  author/initials reappear in raw JSON stdout.
- No private DOCX may enter model extraction until the parser-to-prompt and Gateway transport
  blockers above are closed; the operator projection alone is not production containment.
- Do not deploy a parser semantic change without a version bump, these negatives, the non-blind
  regression suite, and a peer review over the finished diff.
