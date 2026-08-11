#!/usr/bin/env node
/**
 * Evidence that the pre-publication axis terminalization test can fail.
 *
 * The mutant disables only the write performed by close-test-axis. Finalize still repairs the
 * checkpoint later, so a checkpoint-only assertion remains green; the named test is killed only
 * because the already-published signed closure retains the earlier non-terminal state.
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const TEST = "WORKFLOW: a blocked axis is terminal in the signed closure before the report is published";

await runMutantSuite({
  title: "test-axis closure is terminal before signed/report publication",
  filter: "blocked axis is terminal",
  mutants: [
    {
      name: "close-test-axis leaves the axis open and delegates terminalization to finalize again",
      breaks: "signed closure must observe the terminal result, not a later checkpoint repair",
      file: "src/workflow/run-workflow.ts",
      find: "              if (!isTerminalTest(d.completion.test)) {\n",
      replace: "              if (false && !isTerminalTest(d.completion.test)) {\n",
      kills: [TEST],
    },
  ],
});
