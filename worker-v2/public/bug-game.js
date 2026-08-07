/* survey-qa v2 — the optional "play while you wait" panel.
 *
 * Three rules, all carried forward deliberately:
 *
 *  1. IT NEVER ADVANCES FROM BACKEND PROGRESS. Nothing in this file reads the run state,
 *     and nothing in the tracker reads the score. It is a toy beside an instrument, and
 *     it says so in its own copy so nobody mistakes a squashed bug for a finding.
 *  2. It is OPT-IN and off by default. A capped, real-money test is running; motion is
 *     the user's choice, not the page's.
 *  3. MOTION MODE IS COMMITTED PER BUG AT SPAWN. JS is the single authority — a media
 *     query cannot flip a bug mid-animation. Under reduced motion the bug does not
 *     crawl: it appears at a fixed spot and dwells (opacity only, on the child glyph, so
 *     the button itself never fades and its focus outline stays visible). Keyboard focus
 *     pauses the dwell so a target cannot fade out from under a keyboard user.
 */
(function () {
  "use strict";

  var toggleBtn = document.getElementById("gameToggle");
  var field = document.getElementById("gameField");
  var scoreEl = document.getElementById("gameScore");
  var motionBtn = document.getElementById("gameMotion");
  if (!toggleBtn || !field || !scoreEl) return;

  var GLYPHS = ["🐛", "🐜", "🦟", "🕷️"];
  var playing = false;
  var score = 0;
  var spawnTimer = null;
  var motionAllowed = !prefersReduce();

  function prefersReduce() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }

  function setScore() {
    scoreEl.textContent = score === 1 ? "1 bug squashed (still not a finding)" : score + " bugs squashed (still not findings)";
  }

  function spawn() {
    if (!playing) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "bug " + (motionAllowed ? "is-scurry" : "is-still");
    var glyph = document.createElement("span");
    glyph.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
    b.appendChild(glyph);
    b.setAttribute("aria-label", "Squash a bug (a game; it has no effect on the run)");

    var h = field.clientHeight || 180;
    var w = field.clientWidth || 600;
    if (motionAllowed) {
      var y = 12 + Math.random() * Math.max(10, h - 50);
      b.style.top = y + "px";
      b.style.setProperty("--x0", "-40px");
      b.style.setProperty("--x1", (w + 60) + "px");
      b.style.setProperty("--y1", (Math.random() * 40 - 20) + "px");
      b.style.setProperty("--flip", "1");
      b.style.setProperty("--bug-dur", (6 + Math.random() * 5).toFixed(1) + "s");
    } else {
      b.style.top = (12 + Math.random() * Math.max(10, h - 50)) + "px";
      b.style.left = (12 + Math.random() * Math.max(10, w - 50)) + "px";
      b.style.setProperty("--dwell-dur", "9s");
    }

    b.addEventListener("click", function () {
      if (b.classList.contains("is-squashed")) return;
      b.classList.add("is-squashed");
      score += 1;
      setScore();
      setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 500);
    });
    b.addEventListener("animationend", function (ev) {
      if (ev.target !== glyph && ev.target !== b) return;
      setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 0);
    });
    field.appendChild(b);
    spawnTimer = setTimeout(spawn, 1400 + Math.random() * 2200);
  }

  function start() {
    playing = true;
    field.hidden = false;
    toggleBtn.setAttribute("aria-pressed", "true");
    toggleBtn.textContent = "Stop playing";
    spawn();
  }
  function stop() {
    playing = false;
    field.hidden = true;
    toggleBtn.setAttribute("aria-pressed", "false");
    toggleBtn.textContent = "Play while you wait";
    if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null; }
    field.textContent = "";
  }

  toggleBtn.addEventListener("click", function () { playing ? stop() : start(); });
  if (motionBtn) {
    motionBtn.setAttribute("aria-pressed", motionAllowed ? "true" : "false");
    motionBtn.textContent = motionAllowed ? "Crawling: on" : "Crawling: off (still targets)";
    motionBtn.addEventListener("click", function () {
      motionAllowed = !motionAllowed;
      motionBtn.setAttribute("aria-pressed", motionAllowed ? "true" : "false");
      motionBtn.textContent = motionAllowed ? "Crawling: on" : "Crawling: off (still targets)";
    });
  }
  setScore();
})();
