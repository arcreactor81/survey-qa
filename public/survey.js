/*
 * Mock survey under test for the Survey QA PoC.
 *
 * This survey intentionally deviates from spec/canon.json in EXACTLY the 10
 * seeded errors E01-E10 listed in canon.json "seededErrors". Everything else
 * (S2, Q3, all other texts/options/instructions) matches canon verbatim so
 * the checker's false-positive rate can be measured.
 *
 * Seeded errors:
 *   E01 S1 option 1: "Practicing physican" (typo)
 *   E02 Q1: "BIMZELX" option omitted
 *   E03 Q2: "Rapid skin clearance" -> "Rapid skin cleanse"
 *   E04 Q4: literal unresolved piping token {Q3brand} (unknown question name;
 *           SurveyJS leaves unknown placeholders as literal text)
 *   E05 Q5: second matrix column duplicated as "Strongly agree"
 *   E06 Q2: "Favorable safety profile" / "Convenient dosing schedule" swapped
 *   E07 Q6: title numbered "Q5." (duplicate number)
 *   E08 Q7: mojibake "patientsâ€™" instead of "patients'"
 *   E09 Q8: duplicated word "you you"
 *   E10 Q1: instruction "Select all that apply." omitted
 */
(function () {
  "use strict";

  var surveyJson = {
    title: "Dermatologist Perceptions of Biologic Therapies in Moderate-to-Severe Plaque Psoriasis",
    description: "Thank you for participating. This survey takes approximately 10 minutes. Your responses are confidential and reported only in aggregate.",
    showQuestionNumbers: "off",
    focusFirstQuestionAutomatic: false,
    completedHtml: "<h3>Thank you for completing the survey.</h3><p>Your responses have been recorded.</p>",
    pages: [
      {
        name: "page1",
        elements: [
          {
            type: "radiogroup",
            name: "S1",
            title: "S1. Which of the following best describes your primary professional role?",
            isRequired: false,
            choices: [
              // E01: typo ("physican" instead of "physician")
              "Practicing physican",
              "Nurse practitioner",
              "Physician assistant",
              "Pharmacist"
            ]
          },
          {
            type: "text",
            name: "S2",
            title: "S2. How many years have you been in clinical practice?",
            description: "Enter a whole number between 0 and 50.",
            isRequired: false,
            inputType: "number",
            min: 0,
            max: 50
          }
        ]
      },
      {
        name: "page2",
        elements: [
          {
            type: "checkbox",
            name: "Q1",
            title: "Q1. Which of the following biologic treatments for moderate-to-severe plaque psoriasis are you aware of?",
            // E10: instruction "Select all that apply." intentionally omitted (no description)
            isRequired: false,
            choices: [
              "SKYRIZI",
              "TREMFYA",
              "COSENTYX",
              "TALTZ",
              // E02: "BIMZELX" intentionally omitted
              "None of the above"
            ]
          },
          {
            type: "radiogroup",
            name: "Q2",
            title: "Q2. What is your most important treatment goal when selecting a biologic for plaque psoriasis?",
            isRequired: false,
            choices: [
              // E03: "Rapid skin clearance" -> "Rapid skin cleanse"
              "Rapid skin cleanse",
              "Durable long-term response",
              // E06: these two options are swapped relative to canon order
              "Convenient dosing schedule",
              "Favorable safety profile",
              "Patient affordability"
            ]
          }
        ]
      },
      {
        name: "page3",
        elements: [
          {
            type: "radiogroup",
            name: "Q3",
            title: "Q3. Which biologic do you prescribe most often for moderate-to-severe plaque psoriasis?",
            isRequired: false,
            choices: [
              "SKYRIZI",
              "TREMFYA",
              "COSENTYX",
              "TALTZ",
              "BIMZELX"
            ]
          },
          {
            type: "radiogroup",
            name: "Q4",
            // E04: broken piping. {Q3brand} references a question name that does
            // not exist, so SurveyJS renders the literal token "{Q3brand}".
            title: "Q4. How satisfied are you with {Q3brand} for your moderate-to-severe plaque psoriasis patients?",
            isRequired: false,
            choices: [
              "Very satisfied",
              "Somewhat satisfied",
              "Neither satisfied nor dissatisfied",
              "Somewhat dissatisfied",
              "Very dissatisfied"
            ]
          }
        ]
      },
      {
        name: "page4",
        elements: [
          {
            type: "matrix",
            name: "Q5",
            title: "Q5. Please rate your agreement with each of the following statements.",
            isRequired: false,
            rows: [
              "Biologics have transformed outcomes in plaque psoriasis",
              "Access barriers limit my use of newer biologics",
              "I am comfortable initiating biologics in biologic-naive patients"
            ],
            columns: [
              "Strongly agree",
              // E05: second column duplicates "Strongly agree" instead of "Somewhat agree"
              "Strongly agree",
              "Neither agree nor disagree",
              "Somewhat disagree",
              "Strongly disagree"
            ]
          },
          {
            type: "text",
            name: "Q6",
            // E07: visibly numbered "Q5." instead of "Q6."
            title: "Q5. What percentage of your moderate-to-severe plaque psoriasis patients currently receive a biologic?",
            description: "Enter a whole number between 0 and 100.",
            isRequired: false,
            inputType: "number",
            min: 0,
            max: 100
          }
        ]
      },
      {
        name: "page5",
        elements: [
          {
            type: "comment",
            name: "Q7",
            // E08: mojibake encoding artifact. â€™ renders as the
            // literal three-character sequence a-circumflex, euro sign, trade
            // mark sign -- exactly the "rendered" bytes in canon.json.
            title: "Q7. In your view, what is the single biggest barrier to your patientsâ€™ access to biologic therapy?",
            isRequired: false
          },
          {
            type: "rating",
            name: "Q8",
            // E09: duplicated word "you you"
            title: "Q8. How likely are you you to recommend biologic therapy to a colleague treating moderate-to-severe plaque psoriasis?",
            description: "0 = Not at all likely, 10 = Extremely likely",
            isRequired: false,
            rateMin: 0,
            rateMax: 10
          }
        ]
      }
    ]
  };

  function init() {
    var container = document.getElementById("surveyElement");
    if (!container) {
      return;
    }
    var model = new Survey.Model(surveyJson);
    if (typeof model.render === "function") {
      model.render(container);
    } else if (typeof SurveyUI !== "undefined" && typeof SurveyUI.renderSurvey === "function") {
      SurveyUI.renderSurvey(model, container);
    }
    // Expose for the automated walker / manual debugging.
    window.survey = model;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
