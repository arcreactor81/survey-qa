/**
 * selftest/fixtures/sign-run.mjs — build and sign a RunRecord for a fixture run.
 *
 * The judge refuses to treat anything as current results unless an Ed25519
 * attested RunRecord pins BOTH the contract and the exact artifact set (D1), so
 * every fixture run needs one. Signing uses the scorer's TEST-ONLY fixture key,
 * which is clearly marked as such and is the same key the scorer's own
 * fixtures use.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { signRecord } from '../../../../scorer/src/lib/attest.mjs';
import { jcsHash } from '../../../../scorer/src/lib/canonical.mjs';
import { ambiguityToken } from '../../lib/contract-binding.mjs';

export const FIXTURE_KEY_DIR = join(process.cwd(), 'scorer', 'fixtures', 'keys');

export function keyPaths(repoRoot) {
  return {
    privatePem: join(repoRoot, 'scorer', 'fixtures', 'keys', 'TEST-ONLY-fixture-harness.private.pem'),
    registry: join(repoRoot, 'scorer', 'fixtures', 'keys', 'registry.json'),
    keyId: 'fixture-harness-key-1',
  };
}

const hashOf = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

/**
 * @param {object} o
 * @param {string} o.runDir
 * @param {string} o.repoRoot
 * @param {string} o.runId
 * @param {object} o.checklist
 * @param {string[]} [o.omitArtifacts] names to leave OUT of the signed catalogue
 * @param {object} [o.extraEvidence]   extra catalogue entries (duplicates, phantoms)
 * @param {boolean} [o.signAmbiguities] D5: emit the `ambiguity:<id>@<digest>`
 *   assumption tokens that bind the extraction's ambiguity set into the
 *   signature. Default true — a producer that cannot sign its ambiguities
 *   produces an unpublishable run, which is the point. Pass `false` to build the
 *   negative fixture.
 */
export function writeSignedRunRecord({ runDir, repoRoot, runId, checklist, omitArtifacts = [], extraEvidence = [], signedAt = '2026-08-02T00:00:00.000Z', signAmbiguities = true, extraAssumptions = [] }) {
  const artifactsDir = join(runDir, 'artifacts');
  const files = readdirSync(artifactsDir).filter((f) => statSync(join(artifactsDir, f)).isFile()).sort();
  const evidence = [];
  for (const f of files) {
    if (omitArtifacts.includes(f)) continue;
    const buf = readFileSync(join(artifactsDir, f));
    evidence.push({
      evidenceId: `EV-${f}`,
      type: /\.png$/i.test(f) ? 'screenshot' : 'action-trace',
      artifactRef: `runs/${runId}/artifacts/${f}`,
      contentHash: hashOf(buf),
      byteLength: buf.length,
      mediaType: /\.png$/i.test(f) ? 'image/png' : 'application/json',
      capturedAt: signedAt,
    });
  }
  for (const e of extraEvidence) evidence.push(e);

  // A content hash identifies BYTES; the identity a JudgementRecord binds to is
  // the SEALED ContractRevision. A fixture run that omits it is (correctly)
  // unpublishable, so every fixture run seals one.
  const items = checklist.obligations.map((o) => o.id);
  const revision = {
    contractRevisionId: `contract-revision:${runId}@1`,
    contractRevisionHash: jcsHash({ runId, items }),
    reviewState: 'sealed',
    sealedAt: signedAt,
    sealedBy: 'selftest-fixture',
  };

  const contract = {
    extraction: { method: 'fixture', extractorVersion: 'selftest@1', extractedAt: signedAt },
    revision,
    // D5: the ambiguity set that governs withholding is signed HERE, by the
    // producer, in the one field of the attested RunRecord schema that can carry
    // it. A judge that finds no token treats the set as unsigned and refuses to
    // publish — so this is not decoration.
    assumptions: [
      ...(signAmbiguities ? (checklist.ambiguities || []).map(ambiguityToken) : []),
      ...extraAssumptions,
    ],
    items: checklist.obligations.map((o) => ({
      itemId: o.id,
      type: o.category,
      sourceAnchor: { locator: `${o.id}`, quote: o.doc_quote ?? '', aliases: [] },
      requirement: o.statement,
      preconditions: [],
      stimulus: o.stimulus || [],
      expectedObservable: o.expected_observable || '',
      variants: [],
      confidence: o.confidence ?? 1,
    })),
  };

  const record = {
    schemaVersion: '1.0.0',
    run: {
      runId,
      target: { url: 'http://127.0.0.1:0/fixture', environment: 'selftest', buildId: `${runId}-build`, buildHash: 'sha256:' + '0'.repeat(64) },
      documentHash: jcsHash({ fixture: runId }),
      contractHash: jcsHash(contract),
      configuration: { profileId: 'selftest', configurationHash: jcsHash({ selftest: true }), parameters: {} },
      timestamps: { startedAt: signedAt, endedAt: signedAt },
    },
    contract,
    attempts: [],
    itemResults: [],
    findings: [],
    evidence,
    resources: { modelCalls: [] },
  };
  const { privatePem, keyId } = keyPaths(repoRoot);
  record.attestation = signRecord(record, readFileSync(privatePem, 'utf8'), keyId, signedAt);
  writeFileSync(join(runDir, 'run-record.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}
