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
import { assert, assertEq, suite, test } from "../testkit.mjs";

const SENTINEL_AUTHOR = "PRIVATE_REVIEWER_SENTINEL";
const SENTINEL_INITIALS = "PRS";

const docxWithComment = () =>
  zipSync(
    {
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:body><w:p><w:r><w:t>Question body</w:t></w:r></w:p></w:body></w:document>`,
      ),
      "word/comments.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:comment w:id="0" w:author="${SENTINEL_AUTHOR}" w:initials="${SENTINEL_INITIALS}">` +
          `<w:p><w:r><w:t>Proposed review wording</w:t></w:r></w:p>` +
          `</w:comment></w:comments>`,
      ),
    },
    { mtime: "2026-08-11T00:00:00.000Z" },
  );

suite("operator source-block privacy boundary", () => {
  test("human-contract catalogue withholds comment author and initials and reports the omission", () => {
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
});
