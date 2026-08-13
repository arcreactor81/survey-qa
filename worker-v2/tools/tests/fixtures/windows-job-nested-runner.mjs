import { runSuite } from "../../mutate-runner.mjs";

const [exactName, timeoutText, ...fixtureArguments] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);
if (typeof exactName !== "string" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
  process.exit(2);
}

const additionalEnvironment = fixtureArguments.length === 4
  ? {
      JOB_SUPERVISOR_FIXTURE_PATH: fixtureArguments[0],
      JOB_SUPERVISOR_STARTED_PATH: fixtureArguments[1],
      JOB_SUPERVISOR_SEVERED_PATH: fixtureArguments[2],
      JOB_SUPERVISOR_FORBIDDEN_PATH: fixtureArguments[3],
    }
  : {};
if (fixtureArguments.length !== 0 && fixtureArguments.length !== 4) process.exit(2);
const result = await runSuite({
  exactTestNames: [exactName],
  timeoutMs,
  additionalEnvironment,
});
process.stdout.write(`${JSON.stringify({
  completed: result.completed,
  passed: result.passed,
  total: result.total,
  finalActiveProcesses: result.finalActiveProcesses,
  containmentScope: result.containmentScope,
})}\n`);
process.exit(result.completed && result.finalActiveProcesses === 0 ? 0 : 3);
