/**
 * Operator source-block output must never emit DOCX comment reviewer identity.
 *
 * This is an executable negative fixture: before the boundary projection existed, the
 * sentinel author and initials below appeared verbatim in the CLI's JSON stdout. The test
 * exercises the real parser and the real CLI, not a parallel reimplementation.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { assert, assertEq, loadWorker, suite, test } from "../testkit.mjs";

const SENTINEL_AUTHOR = "PRIVATE_REVIEWER_SENTINEL";
const SENTINEL_INITIALS = "PRS";

const docxWithComment = ({
  partName = "word/comments.xml",
  relationshipTarget = "comments.xml",
  author = SENTINEL_AUTHOR,
  initials = SENTINEL_INITIALS,
} = {}) =>
  zipSync(
    {
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:body><w:p><w:r><w:t>Question body</w:t></w:r><w:commentReference w:id="0"/></w:p></w:body></w:document>`,
      ),
      // The parser may not infer comments from a fixed filename: only this OPC relationship
      // establishes that a part is a review comment, including when a vendor renames it.
      "word/_rels/document.xml.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rComment" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="${relationshipTarget}"/>` +
          `</Relationships>`,
      ),
      [partName]: strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:comment w:id="0" w:author="${author}" w:initials="${initials}">` +
          `<w:p><w:r><w:t>Proposed review wording</w:t></w:r></w:p>` +
          `</w:comment></w:comments>`,
      ),
    },
    { mtime: "2026-08-11T00:00:00.000Z" },
  );

suite("operator source-block privacy boundary", () => {
  test("human-contract catalogue structurally withholds comment author and initials from a relationship-backed part", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "survey-qa-comment-privacy-"));
    try {
      const questionnaire = path.join(directory, "questionnaire.docx");
      writeFileSync(questionnaire, docxWithComment());

      const result = spawnSync(
        process.execPath,
        [path.resolve(import.meta.dirname, "..", "human-contract-blocks.mjs"), questionnaire],
        { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", windowsHide: true },
      );
      assertEq(result.status, 0, result.stderr || result.stdout);
      assert(!result.stdout.includes(SENTINEL_AUTHOR), "comment author escaped into operator stdout");
      assert(!result.stdout.includes(SENTINEL_INITIALS), "comment initials escaped into operator stdout");

      const catalogue = JSON.parse(result.stdout);
      assertEq(catalogue.schemaVersion, "v2-human-contract-block-catalogue/1.1.0");
      assertEq(catalogue.privacy.commentReviewerIdentitiesWithheld, 1);
      const comment = catalogue.blocks.find((block) => block.text === "Proposed review wording");
      assert(comment, "the comment block was silently dropped instead of privacy-projected");
      assertEq(
        comment.origin,
        "comment — PROPOSAL, reviewer identity withheld; resolution unknown",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("renamed OPC comment parts with different reviewer metadata are still structurally redacted", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "survey-qa-comment-privacy-renamed-"));
    try {
      const questionnaire = path.join(directory, "renamed.docx");
      writeFileSync(questionnaire, docxWithComment({
        partName: "word/review/renamed-comments.xml",
        relationshipTarget: "review/renamed-comments.xml",
        author: "RENAMED_PART_REVIEWER",
        initials: "RPR",
      }));
      const result = spawnSync(
        process.execPath,
        [path.resolve(import.meta.dirname, "..", "human-contract-blocks.mjs"), questionnaire],
        { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", windowsHide: true },
      );
      assertEq(result.status, 0, result.stderr || result.stdout);
      assert(!result.stdout.includes("RENAMED_PART_REVIEWER"), "renamed-part author escaped into operator stdout");
      assert(!result.stdout.includes("RPR"), "renamed-part initials escaped into operator stdout");
      const catalogue = JSON.parse(result.stdout);
      assertEq(catalogue.privacy.commentReviewerIdentitiesWithheld, 1);
      const comment = catalogue.blocks.find((block) => block.text === "Proposed review wording");
      assert(comment, "renamed comment block was silently dropped instead of privacy-projected");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("only the structural comment role redacts; a non-comment origin lookalike remains verbatim", async () => {
    const m = (await loadWorker()).mod.sourceBlockOutput;
    const commentOrigin = "comment 7 [part=word/review/renamed-comments.xml] by PRIVATE_REVIEWER_SENTINEL (PRS)  PROPOSAL, resolution unknown";
    const comment = m.operatorSourceBlock({
      blockId: "b0001", kind: "paragraph", text: "Proposed review wording", origin: commentOrigin,
      sourceSubrole: "comment-proposal", section: null, coords: null,
    });
    assert(!comment.origin.includes(SENTINEL_AUTHOR), "the structural comment role strips author identity");
    assert(!comment.origin.includes(SENTINEL_INITIALS), "the structural comment role strips initials");
    const origin = "comment 7 [part=body] by visibly-authored survey copy";
    const projected = m.operatorSourceBlock({
      blockId: "b0001", kind: "paragraph", text: "A respondent-visible option", origin,
      sourceSubrole: null, section: null, coords: null,
    });
    assertEq(projected.origin, origin, "origin text alone is never privacy authority");
  });
});
