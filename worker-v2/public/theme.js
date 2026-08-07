/* Survey QA — theme bootstrap (head, no defer).
 *
 * Runs synchronously in <head> BEFORE first paint so it can apply the persisted
 * light/dark theme with zero FOUC. Externalized from an inline <head> <script>
 * to follow the sibling pa-extractor pattern; behavior is identical to the
 * former inline bootstrap. The self-contained /reports pages keep their own
 * inline copy so they still theme correctly when saved offline.
 *
 * 1. Apply any persisted theme (or the OS preference) before paint.
 * 2. After two frames, flag the document .theme-ready so the color crossfade
 *    only animates deliberate theme toggles, never the initial paint. */
(function () {
  var t = null;
  try { t = localStorage.getItem("sqa-theme"); } catch (e) { /* storage unavailable */ }
  if (t !== "light" && t !== "dark") {
    t = "light";
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) t = "dark";
    } catch (e) { /* matchMedia unavailable */ }
  }
  document.documentElement.dataset.theme = t;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      document.documentElement.classList.add("theme-ready");
    });
  });
})();
