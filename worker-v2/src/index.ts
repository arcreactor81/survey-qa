/**
 * survey-qa-v2 entrypoint.
 *
 * NOT a modification of the production `survey-qa` worker. Different worker name,
 * different Workflow, different R2 prefix, different run-id namespace. See MIGRATION.md
 * for the boundary and DEPLOY.md for the (unrun) deploy sequence.
 *
 * NO AUTHENTICATION LOGIC LIVES HERE, ON PURPOSE. Access sits in front of the hostname
 * and the Worker never sees an unauthenticated request. Re-implementing a check inside
 * the Worker would create a second, weaker gate that could disagree with the real one —
 * and the failure mode of the weaker gate agreeing when it should not is silent. The
 * corollary is a deploy-order constraint, not a code one: the route must not exist before
 * the Access application does, which is why `wrangler.jsonc` ships with `routes`
 * commented out and `workers_dev: false`.
 */

import type { Env } from "./types/env";
import { route } from "./api/router";
import { sweep } from "./sweeper";

export { SurveyRunWorkflowV2 } from "./workflow/run-workflow";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/v2/")) return route(req, env, ctx);

    // `/runs/<runId>` is the shareable watch URL. There is no `runs/<id>.html` asset and
    // there never will be — one static shell serves every run, and tracker.js reads the
    // run id back out of `location.pathname`. So the shell is fetched under its real
    // asset path while the BROWSER's URL stays `/runs/<id>`: a redirect would destroy the
    // shareable link, and a client-side rewrite would make the first paint a 404.
    const watch = /^\/runs\/([^/]+)\/?$/.exec(url.pathname);
    if (watch) {
      const shell = new URL(req.url);
      shell.pathname = "/watch.html";
      const res = await env.ASSETS.fetch(new Request(shell.toString(), req));
      // Never let a run page be cached as if it were the run: the shell is static, the
      // run it displays is not, and the tracker polls for everything that changes.
      const headers = new Headers(res.headers);
      headers.set("cache-control", "no-store");
      return new Response(res.body, { status: res.status, headers });
    }

    // Everything else is the static shell. `run_worker_first` keeps the API paths above
    // from ever being shadowed by an asset of the same name.
    return env.ASSETS.fetch(req);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await sweep(env, new Date());
          console.log("v2 sweep:", JSON.stringify(result));
        } catch (err) {
          console.error("v2 sweep failed:", err);
        }
      })(),
    );
  },
};
