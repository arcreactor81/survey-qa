#!/usr/bin/env node
/**
 * EVIDENCE THAT THE D51 STORAGE BOUNDARY CAN FAIL.
 *
 * Nothing under src/** is edited. The shared mutation runner rewrites the esbuild input,
 * establishes an unmutated baseline, rejects no-op/ambiguous anchors, and credits a kill
 * only when the named D51 test becomes newly red.
 *
 *   node tools/mutate-keyspace.mjs
 */

import { runMutantSuite } from "./mutate-runner.mjs";

const KEYSPACE = "src/store/evidence-keyspace.ts";
const ROUTER = "src/api/router.ts";
const CORE_WORKFLOW = "src/workflow/run-workflow.ts";
const VISUAL_WORKFLOW = "src/workflow/visual-shadow-workflow.ts";

const RAW_WRITE = "THE RAW BUCKET: an arm write lands only below its physical arm prefix";
const LIST_DELETE = "LIST AND DELETE: an arm cannot enumerate or delete a production object";
const FAIL_CLOSED = "FAIL CLOSED: a missing or unknown V2_PREFIX never defaults to production";
const CROSS = "CROSS-NAMESPACE KEYS: logical callers cannot name an arm directly";
const HTTP = "HTTP ENTRYPOINT: route reads are translated before any handler reaches R2";
const CORE = "CORE WORKFLOW ENTRYPOINT: its instance Env is scoped before the first durable step";
const VISUAL = "VISUAL WORKFLOW ENTRYPOINT: the separately invoked child has the same boundary";

await runMutantSuite({
  title: "D51 arm R2 keyspace mutation proof",
  filter: "physical R2 isolation",
  mutants: [
    {
      name: "the key translator returns the production logical key unchanged",
      breaks: "arm writes physically land in production v2/",
      file: KEYSPACE,
      find: "  return prefix + key.slice(V2_PREFIX.length);",
      replace: "  return key;",
      kills: [RAW_WRITE],
    },
    {
      name: "an unconfigured deployment silently defaults to production",
      breaks: "a missing arm variable becomes authority to write v2/",
      file: KEYSPACE,
      find: "  const prefix = env.V2_PREFIX;",
      replace: "  const prefix = env.V2_PREFIX ?? V2_PREFIX;",
      kills: [FAIL_CLOSED],
    },
    {
      name: "list() sends no translated prefix to the shared bucket",
      breaks: "an arm can enumerate production objects and feed them to delete",
      file: KEYSPACE,
      find: "        prefix: physicalPrefix(prefix, options.prefix),",
      replace: "        prefix: options.prefix,",
      kills: [LIST_DELETE],
    },
    {
      name: "physical arm paths are accepted as ordinary logical keys",
      breaks: "production or one arm can address an arm namespace directly",
      file: KEYSPACE,
      find: "  if (key.startsWith(RESERVED_ARM_ROOT)) {",
      replace: "  if (false && key.startsWith(RESERVED_ARM_ROOT)) {",
      kills: [CROSS],
    },
    {
      name: "the HTTP router keeps the raw shared bucket",
      breaks: "API handlers in an arm read and write production v2/",
      file: ROUTER,
      find: "    env = scopeEvidenceEnv(env);",
      replace: "    env = env;",
      kills: [HTTP],
    },
    {
      name: "the core Workflow keeps the raw shared bucket",
      breaks: "durable core steps in an arm write production v2/",
      file: CORE_WORKFLOW,
      find: "    super(ctx, scopeEvidenceEnv(env));",
      replace: "    super(ctx, env);",
      kills: [CORE],
    },
    {
      name: "the visual child Workflow keeps the raw shared bucket",
      breaks: "visual artifacts in an arm write production v2/",
      file: VISUAL_WORKFLOW,
      find: "    super(ctx, scopeEvidenceEnv(env));",
      replace: "    super(ctx, env);",
      kills: [VISUAL],
    },
  ],
});
