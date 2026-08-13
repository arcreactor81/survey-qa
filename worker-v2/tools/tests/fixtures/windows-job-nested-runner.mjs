import { runSuite } from "../../mutate-runner.mjs";

const [exactName, timeoutText] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);
if (typeof exactName !== "string" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
  process.exit(2);
}

const result = await runSuite({ exactTestNames: [exactName], timeoutMs });
process.stdout.write(`${JSON.stringify({
  completed: result.completed,
  passed: result.passed,
  total: result.total,
  finalActiveProcesses: result.finalActiveProcesses,
  containmentScope: result.containmentScope,
})}\n`);
process.exit(result.completed && result.finalActiveProcesses === 0 ? 0 : 3);
