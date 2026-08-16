/**
 * Pass-B real replay: decode every real chunk artifact from the run that died.
 *
 * OPT-IN via PASS_B_REAL_REPLAY_DIR. When unset the test is explicitly SKIPPED
 * with a named message — private bytes never enter the committed tree.
 *
 * When the env var IS set, all nine chunk artifacts are loaded and decoded
 * through the REAL current decodePassBOutput (strict) or salvagePassBOutput
 * (tolerant). Chunks 01, 03-07 landed on the old decoder; 02, 08, 09 were
 * killed by expansion-shape rejections. The fix (decoder 1.2.0) normalises
 * absent expansion fields, so all nine must now decode clean.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { assert, assertEq, loadWorker, suite, test } from "../testkit.mjs";

const mod = async () => (await loadWorker()).mod;

const REPLAY_DIR = process.env.PASS_B_REAL_REPLAY_DIR;

/**
 * Build the minimal SourceBlock array the decoder needs from a chunk artifact.
 *
 * For each blockId the decoder checks:
 *   - the blockId is in the allowed set
 *   - evidence_quotes: source.text.includes(quote)
 *
 * We reconstruct source text from the longest evidence quote per block.
 * Blocks with no evidence quotes get placeholder text (the decoder never
 * checks text for blocks that appear only in block_dispositions or
 * construct_checklist).
 */
function buildSourceBlocks(artifact) {
  const blockIds = artifact.blockIds;
  const modelOutput = artifact.modelOutput;

  // Collect the longest evidence quote per blockId.
  const quoteMap = new Map();
  const collectQuotes = (items) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!Array.isArray(item.evidence_quotes)) continue;
      for (const eq of item.evidence_quotes) {
        const existing = quoteMap.get(eq.block_id);
        if (!existing || existing.length < eq.quote.length) {
          quoteMap.set(eq.block_id, eq.quote);
        }
      }
    }
  };
  collectQuotes(modelOutput.obligations);
  collectQuotes(modelOutput.ambiguities);
  collectQuotes(modelOutput.unverifiable_from_browser);

  return blockIds.map((blockId) => ({
    blockId,
    kind: "paragraph",
    text: quoteMap.get(blockId) ?? `placeholder text for ${blockId}`,
    origin: "body",
    section: null,
    coords: null,
    tableId: null,
    formatting: {},
    semanticSpans: [],
  }));
}

suite("pass-B real replay (opt-in, private fixtures)", () => {
  if (!REPLAY_DIR) {
    test("SKIPPED: PASS_B_REAL_REPLAY_DIR not set — real chunk artifact replay was NOT run", () => {
      // Repo rule: a skipped check must be visibly skipped, never silently green.
      // This test name makes the skip visible in the runner output.
      assert(true, "intentional skip");
    });
    return;
  }

  // Discover all chunk files.
  const chunkFiles = readdirSync(REPLAY_DIR)
    .filter((f) => /^chunk-\d+\.json$/u.test(f))
    .sort();

  test(`found ${chunkFiles.length} chunk artifacts in replay directory`, () => {
    assertEq(chunkFiles.length, 9, "expected exactly 9 chunk artifacts");
  });

  // Previously-landed chunk numbers (1-indexed).
  const PREVIOUSLY_OK = new Set([1, 3, 4, 5, 6, 7]);
  // Previously-fatal chunk numbers.
  const PREVIOUSLY_FATAL = new Set([2, 8, 9]);

  for (const file of chunkFiles) {
    const chunkNumber = parseInt(file.match(/chunk-(\d+)/u)[1], 10);
    const wasOk = PREVIOUSLY_OK.has(chunkNumber);
    const wasFatal = PREVIOUSLY_FATAL.has(chunkNumber);
    const label = wasOk ? "previously-ok" : "previously-fatal";

    test(`chunk-${String(chunkNumber).padStart(2, "0")} (${label}) decodes clean under current decoder`, async () => {
      const m = await mod();
      const artifactPath = path.join(REPLAY_DIR, file);
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
      const unitId = artifact.chunkId;
      const sourceBlocks = buildSourceBlocks(artifact);
      const evidenceBlocks = artifact.evidenceBlockIds.map((id) =>
        sourceBlocks.find((b) => b.blockId === id) ?? {
          blockId: id,
          kind: "paragraph",
          text: `placeholder for evidence block ${id}`,
          origin: "body",
          section: null,
          coords: null,
          tableId: null,
          formatting: {},
          semanticSpans: [],
        },
      );

      // Attempt strict decode — the production path.
      let decoded;
      let decodeError = null;
      try {
        decoded = m.passB.decodePassBOutput(
          artifact.modelOutput,
          unitId,
          sourceBlocks,
          evidenceBlocks,
        );
      } catch (error) {
        decodeError = error;
      }

      if (decodeError !== null) {
        // If strict decode failed, try salvage (the tolerant path).
        const salvage = m.passB.salvagePassBOutput(
          artifact.modelOutput,
          unitId,
          sourceBlocks,
          evidenceBlocks,
        );
        if (salvage !== null) {
          decoded = salvage.decoded;
        } else {
          throw new Error(
            `chunk-${String(chunkNumber).padStart(2, "0")} (${label}) failed both strict ` +
            `decode and salvage. Strict error: ${decodeError.message}`,
          );
        }
      }

      // For all chunks: the decode must have produced obligations.
      assert(decoded !== null, "decoded output must not be null");
      assert(
        decoded.obligations.length > 0,
        `expected at least one obligation, got ${decoded.obligations.length}`,
      );

      // For previously-ok chunks: the obligation count must match what the artifact recorded.
      if (wasOk) {
        const expectedCount = artifact.modelOutput.obligations.length;
        assertEq(
          decoded.obligations.length,
          expectedCount,
          `obligation count must match artifact record (${expectedCount})`,
        );
      }

      // For previously-fatal chunks: reaching here means the decoder fixed them.
      if (wasFatal) {
        assert(
          decodeError === null,
          `previously-fatal chunk-${String(chunkNumber).padStart(2, "0")} should now ` +
          `decode clean under the strict decoder, but got: ${decodeError?.message ?? "unknown"}`,
        );
        const expectedCount = artifact.modelOutput.obligations.length;
        assertEq(
          decoded.obligations.length,
          expectedCount,
          `all ${expectedCount} obligations from the previously-fatal chunk must survive`,
        );
      }
    });
  }
});
