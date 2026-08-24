#!/usr/bin/env node
/**
 * judge.mjs — CLI for the derived-verdict engine.
 *
 *   node pipeline/judge/judge.mjs <runDir> [--out <dir>] [--route-table] [--json]
 *                                 [--key-registry <path>] [--fixture-keys] [--run-record <path>]
 *                                 [--sign-key <pem>] [--key-id <id>] [--signed-at <iso>]
 *
 * Reads `<runDir>/checklist.json`, `<runDir>/run-record.json` and
 * `<runDir>/artifacts/`, re-derives every verdict from the SIGNED artifacts,
 * and writes the result. `observations.json` is read only for the diagnostic
 * prior-claim cross-check; it is never an input to a verdict.
 *
 * WITHOUT `--key-registry` the run has no signed evidence authority: artifacts
 * are read unattested, the output is marked `diagnostic-only`, and no
 * JudgementRecord is minted. That state is deliberate and loud — it is the only
 * honest thing to report when nothing pins what the artifacts are supposed to
 * contain.
 *
 * A registry that declares `"testOnly": true` — i.e. the checked-in fixture
 * registry, whose private half is published — is likewise refused unless
 * `--fixture-keys` (or SURVEY_QA_ALLOW_FIXTURE_KEYS=1) names it as such.
 *
 * The run directory is opened read-only. Output goes where --out says,
 * defaulting to `pipeline/judge/out/<basename(runDir)>`.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeRun } from './lib/engine.mjs';
import { loadEvidenceAuthority } from './lib/authority.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--out', '--key-registry', '--run-record', '--sign-key', '--key-id', '--signed-at']);
const flag = (f) => argv.includes(f);
const argOf = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };

const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));
const runDir = resolve(positional[0] || '');
if (!positional.length || !existsSync(join(runDir, 'checklist.json'))) {
  console.error('usage: node pipeline/judge/judge.mjs <runDir> [--out <dir>] [--key-registry <path>] [--fixture-keys] [--route-table] [--json]');
  console.error('       <runDir> must contain checklist.json and artifacts/');
  process.exit(2);
}
const outDir = resolve(argOf('--out', join(here, 'out', basename(runDir))));

const checklist = JSON.parse(readFileSync(join(runDir, 'checklist.json'), 'utf8'));
const priorObservations = existsSync(join(runDir, 'observations.json'))
  ? JSON.parse(readFileSync(join(runDir, 'observations.json'), 'utf8'))
  : null;

const keyRegistryPath = argOf('--key-registry', null);
const authority = loadEvidenceAuthority({
  runDir,
  checklist,
  runRecordPath: argOf('--run-record', null),
  keyRegistryPath: keyRegistryPath ? resolve(keyRegistryPath) : null,
  allowFixtureKeys: flag('--fixture-keys'),
});

const signKeyPath = argOf('--sign-key', null);
const signer = signKeyPath
  ? { privateKeyPem: readFileSync(resolve(signKeyPath), 'utf8'), keyId: argOf('--key-id', 'judge-key-1'), signedAt: argOf('--signed-at', new Date().toISOString()) }
  : null;

const out = await judgeRun({ runDir, checklist, priorObservations, authority, signer });

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'verdicts.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
writeFileSync(join(outDir, 'route-table.json'), `${JSON.stringify(out.routeTable, null, 2)}\n`, 'utf8');
writeFileSync(join(outDir, 'judgement-record.json'), `${JSON.stringify(out.judgement, null, 2)}\n`, 'utf8');

if (flag('--json')) {
  console.log(JSON.stringify({ counts: out.counts, certification: out.certification.facets, status: out.status }, null, 2));
} else {
  const c = out.counts;
  const f = out.certification.facets;
  console.log(`status             ${out.status}${out.publishable ? ' (attested)' : ''}`);
  console.log(`authority          verified=${out.authority.verified} signature=${out.authority.signatureVerified} contract=${out.authority.contractBound} manifest=${out.authority.manifestComplete} artifacts=${out.authority.signedArtifacts}`);
  console.log(`obligations        ${out.denominator.obligations}`);
  console.log(`verdicts           pass ${c.byVerdict.pass} · fail ${c.byVerdict.fail} · inconclusive ${c.byVerdict.inconclusive} · not-assessed ${c.byVerdict['not-assessed']}`);
  console.log(`coverage           ${JSON.stringify(c.byCoverage)}`);
  console.log(`withheld           ${c.withheldFails} fail(s), ${c.withheldPasses} pass(es) — ambiguity precedence`);
  console.log(`untyped            ${c.noTypedExpectation} obligation(s) had no typed expectation (NOT passes)`);
  console.log(`certification      recordAuthentic=${f.recordAuthentic} evidenceValid=${f.evidenceValid} contractReviewed=${f.contractReviewed} resultsReviewed=${f.resultsReviewed} testComplete=${f.testComplete} defectFree=${f.defectFree}`);
  console.log(`certifiable        ${out.certification.certifiable}  blockers ${out.certification.blockers.length}`);
  console.log(`written            ${outDir}`);
}

if (flag('--route-table')) {
  console.log('');
  console.log('question  answer                              -> destinations');
  for (const r of out.routeTable.rows) {
    console.log(`${r.question.padEnd(9)} ${r.answer.slice(0, 34).padEnd(35)} -> ${Object.entries(r.destinations).map(([k, v]) => `${k} x${v.count}`).join(', ')}${r.pathConsistency === 'mixed' ? '   [MIXED]' : ''}`);
  }
}
