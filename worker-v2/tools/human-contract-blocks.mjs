#!/usr/bin/env node

/**
 * Print the exact source-block vocabulary the human-contract validator will use.
 *
 * This is an authoring aid only. It imports the production DOCX parser through an in-memory
 * esbuild bundle, emits no cases or predicate information, and never writes an authority
 * artifact. The submitted Worker re-parses and re-hashes the DOCX independently.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { build } from "esbuild";
import {
  isCommentProposalSourceBlock,
  operatorSourceBlock,
} from "./source-block-output.mjs";

const [inputPath, ...extras] = process.argv.slice(2);
if (!inputPath || extras.length > 0) {
  process.stderr.write("usage: node tools/human-contract-blocks.mjs <questionnaire.docx>\n");
  process.exit(2);
}

const absolute = resolve(inputPath);
let bytes;
try {
  if (!statSync(absolute).isFile()) throw new Error("path is not a file");
  bytes = readFileSync(absolute);
} catch (error) {
  process.stderr.write(`cannot read ${JSON.stringify(absolute)}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const bundled = await build({
  stdin: {
    contents: 'export { parseDocxBlocks } from "./src/extract/docx-blocks.ts";',
    resolveDir: resolve(import.meta.dirname, ".."),
    sourcefile: "human-contract-parser-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  write: false,
  logLevel: "silent",
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`;
const { parseDocxBlocks } = await import(moduleUrl);
const parsed = parseDocxBlocks(new Uint8Array(bytes));
const documentSha256 = createHash("sha256").update(bytes).digest("hex");
const commentReviewerIdentitiesWithheld = parsed.blocks.filter((block) =>
  isCommentProposalSourceBlock(block),
).length;

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: "v2-human-contract-block-catalogue/1.1.0",
      documentSha256,
      counts: parsed.counts,
      parserCoverage: parsed.coverage,
      privacy: { commentReviewerIdentitiesWithheld },
      blocks: parsed.blocks.map(operatorSourceBlock),
    },
    null,
    2,
  )}\n`,
);
