/**
 * PAGE BRIDGE — adapts the evaluation harness's `ctx.browser` to the `page` interface
 * `graph-spike/crawl.mjs` already expects (`goto(url)` / `evaluate(fn, ...args)`).
 *
 * WHY THIS FILE EXISTS AT ALL, rather than the arm launching its own Chrome:
 *
 *   PRE-REGISTRATION.md §4.5 computes `coverage_honesty` from the HARNESS's visit log.
 *   An arm that drives its own browser is self-attesting its own coverage — the exact
 *   failure the experiment exists to detect. Arm B's entire claim is "coverage is
 *   COMPUTED, not attested", so it is the one arm that cannot afford to reach around
 *   this interface. Every navigation and every probe therefore goes through
 *   `ctx.browser`, which counts the action, appends the screen to the harness visit
 *   log, and checks the budget — none of which this module can influence.
 *
 * TWO PROPERTIES THIS FILE MUST PRESERVE
 *
 *  1. ARGUMENT PASSING. `ctx.browser.act(fn)` evaluates a ZERO-ARGUMENT function in the
 *     page, but `crawl.mjs` calls `page.evaluate(PAGE_ANSWER, spec)`. `bindArgs` closes
 *     the arguments into the function SOURCE, because the driver transports functions by
 *     `toString()` and a real closure would not survive the trip.
 *
 *  2. BLINDING. `ctx.browser.observe()` returns the page's raw `html`, INCLUDING any
 *     inlined manifest, because the harness reads it before the arm gets a chance to
 *     blind the page. That is correct for the harness and fatal for the arm. So this
 *     bridge NEVER calls `observe()` and never exposes it: the only way out of here is
 *     `evaluate()`, which runs after `crawl.mjs`'s `PAGE_BLIND` has deleted the oracle.
 *     `assertNoObserve` makes that structural rather than a promise.
 */

/** Close `args` into the function source so it survives `toString()` transport. */
export function bindArgs(fn, args) {
  if (!args.length) return fn;
  const payload = JSON.stringify(args, (_k, v) => (v === undefined ? null : v));
  // eslint-disable-next-line no-new-func
  return new Function(`return (${fn.toString()}).apply(null, ${payload});`);
}

/**
 * @param browser  ctx.browser from run-arm.mjs
 * @param counters an object this bridge increments so the arm can report what it did
 *                 (self-reported, and cross-checkable against harness telemetry — §3.4
 *                 says self-reported cost is recorded and never scored, which is exactly
 *                 the use we make of it)
 */
export function makePageBridge(browser, counters = {}) {
  counters.gotos ??= 0;
  counters.evaluates ??= 0;

  if (!browser?.available) {
    throw new Error(
      "ARM B REQUIRES A BROWSER DRIVER. Pass --driver graph-spike/arm/driver.mjs. " +
        "Arm B recovers the site graph by traversal; without a browser it has nothing to " +
        "compare and would report an empty finding list that looks like a clean bill of health.",
    );
  }

  return {
    async goto(url) {
      counters.gotos += 1;
      await browser.goto(url);
    },
    async evaluate(fn, ...args) {
      counters.evaluates += 1;
      return browser.act(bindArgs(fn, args));
    },
    // Deliberately absent: observe(). See the header.
  };
}
