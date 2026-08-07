// Respondent consequence — what a finding means for a person taking the survey.
//
// AMENDMENT A: "What survey researchers need in EVERY finding (promote these):
// ... respondent consequence (wrong screen-out, ineligible follow-up, missing
// data, biased response, unusable variable, device-specific friction) ... a
// reproduction recipe in SURVEY language ... whether it is universal /
// route-specific / device-specific / intermittent".
//
// This is a fixed lookup over the finding categories the pipeline emits, not a
// generator. When a category has no entry, the report says so in words and asks
// a reviewer to state it. Inventing a consequence for an unknown category would
// be the report asserting something the record does not support.

export const CONSEQUENCE_CLASSES = {
  "no-interview": "Nobody can take the survey at all",
  "wrong-screen-out": "The respondent is screened out or kept in wrongly",
  "ineligible-follow-up": "The respondent is asked a question they should not see",
  "missing-data": "An answer the respondent gave is not captured",
  "biased-response": "The respondent is nudged toward a different answer",
  "unusable-variable": "The stored variable does not mean what it says",
  "device-friction": "The question is materially harder to answer on some devices",
  "presentation-only": "The respondent reads the specified wording; only its layout differs",
  "undetermined": "Not determined by this record",
};

const BY_CATEGORY = {
  "load-time-crash": {
    class: "no-interview",
    consequence:
      "The respondent opens the link and gets a blank page. No question is ever shown, so nobody can start the interview, let alone complete it. Every other result on this page describes a survey no respondent can currently reach.",
    retest: "Open the live link in an unmodified browser on desktop and on a phone, and confirm the welcome screen renders before anything else is re-tested.",
  },
  "missing-answer-option": {
    class: "missing-data",
    consequence:
      "A respondent whose true answer is the missing option cannot give it. They either pick an option that is not true for them or abandon the interview, so that group is either mis-coded or lost entirely.",
    retest: "Open the affected question and count the options against the answer list in the questionnaire, including the code column.",
  },
  "wrong-answer-option-text": {
    class: "unusable-variable",
    consequence:
      "The label on screen is not the label the questionnaire assigns to that code. The respondent answers the question they read, and the data file stores the code for a different band — the variable is silently unusable for analysis.",
    retest: "Open the affected question and compare every option label with the answer list, code by code.",
  },
  "routing-mismatch": {
    class: "ineligible-follow-up",
    consequence:
      "The respondent is sent to the wrong next screen. Depending on direction, they are asked a question they should never see, or they skip a question they should have been asked and the variable comes back empty.",
    retest: "Answer the trigger question with the affected code and record which screen appears next.",
  },
  "wrong-skip": {
    class: "ineligible-follow-up",
    consequence:
      "The respondent is sent to the wrong next screen: either asked a question they should never see, or skipped past one they should have answered.",
    retest: "Answer the trigger question with the affected code and record which screen appears next.",
  },
  "mobile-grid-layout": {
    class: "device-friction",
    consequence:
      "On a phone the question is materially harder to answer than on a desktop. Phone respondents mis-tap or satisfice, which biases the answer distribution by device rather than by opinion.",
    retest: "Open the affected question at a phone viewport and complete it with a thumb, then compare with the desktop layout.",
  },
  "mobile-scale-layout": {
    class: "device-friction",
    consequence:
      "The scale is presented differently on a phone than on a desktop. Respondents anchor on the visual arrangement of a scale, so a device-dependent arrangement biases the score by device.",
    retest: "Open the affected scale at a phone viewport and at a desktop viewport and compare the arrangement of the points.",
  },
  "validation-message-wording": {
    class: "biased-response",
    consequence:
      "The respondent who tries to continue without answering is stopped, but with different wording from the one the questionnaire specifies. They are not lost, but the prompt they read is not the one the study approved.",
    retest: "Try to continue past the affected question without answering and record the exact message shown.",
  },
  "orphaned-answer-retention": {
    class: "unusable-variable",
    consequence:
      "An answer the respondent has effectively retracted by changing an earlier answer is still held. The data file can carry a value on a route where the respondent was never asked the question.",
    retest: "Answer the question, go back, change the upstream answer so the question is skipped, finish, and check whether the value survives.",
  },
  "specify-box-visibility": {
    class: "biased-response",
    consequence:
      "The write-in box is visible before the option that owns it is selected. Respondents read the box as a cue and are drawn toward the option it belongs to.",
    retest: "Open the question fresh and note whether the write-in box is on screen before the owning option is selected.",
  },
  "line-break-fidelity": {
    class: "presentation-only",
    consequence:
      "The respondent reads the specified wording. Only the paragraph breaks differ, so no answer, route or stored value changes.",
    retest: "Compare the rendered text with the questionnaire wording character by character.",
  },
  "not-browser-observable": {
    class: "undetermined",
    consequence:
      "No respondent consequence can be stated from a browser session: this requirement is about behaviour a browser cannot see. It needs a different verification method, named beside it.",
    retest: "Route this to the verification method named for it — a browser re-test cannot settle it.",
  },
  "document-ambiguity": {
    class: "undetermined",
    consequence:
      "No respondent consequence can be stated until the document question is answered. Two readings of the questionnaire are both defensible, and they imply different correct behaviour.",
    retest: "Answer the document question first; only then is there a behaviour to re-test.",
  },
};

const DEVICE_CATEGORIES = new Set(["mobile-grid-layout", "mobile-scale-layout"]);

/**
 * @param {object} finding decorated finding
 * @param {object} ctx { operationalBlockerIds:Set, mixedRowIds:Set }
 */
export function respondentConsequence(finding, ctx = {}) {
  const category = finding?.category ?? null;
  const entry = (category && BY_CATEGORY[category]) || null;

  const operational = ctx.operationalBlockerIds?.has?.(finding?.findingId) ?? false;
  const itemRefs = Array.isArray(finding?.itemRefs) ? finding.itemRefs : [];
  const routeSpecific = itemRefs.some((id) => ctx.mixedRowIds?.has?.(id));

  let reach;
  if (operational) reach = { id: "universal", label: "Universal — it affects every respondent on every route" };
  else if (category && DEVICE_CATEGORIES.has(category))
    reach = { id: "device-specific", label: "Device-specific — it depends on the viewport the respondent uses" };
  else if (routeSpecific)
    reach = { id: "route-specific", label: "Route-specific — it depends on the answers the respondent gave upstream" };
  else
    reach = {
      id: "unclassified",
      label: "Reach not classified by this record — a reviewer must decide whether it is universal, route-specific, device-specific or intermittent",
    };

  if (!entry) {
    return {
      known: false,
      class: "undetermined",
      classLabel: CONSEQUENCE_CLASSES.undetermined,
      consequence: `This record does not carry a respondent consequence for finding category ${JSON.stringify(
        category
      )}. A reviewer must state, in survey language, what a respondent experiences. The report will not invent one.`,
      retest: "A reviewer must state what to re-test, in survey language.",
      reach,
    };
  }
  return {
    known: true,
    class: entry.class,
    classLabel: CONSEQUENCE_CLASSES[entry.class] ?? CONSEQUENCE_CLASSES.undetermined,
    consequence: entry.consequence,
    retest: entry.retest,
    reach,
  };
}
