# Researcher evaluations

Run a prompt against an agent, inspect the evidence it used, and record how the answer fares against that case's rubrics. The result checker reports the verdicts and independently checks any supplied arithmetic.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

<br>

## Quick Start

You need Node.js 22, an agent with Researcher installed, and access to the source material used in the case. For your first run, use the [blocked-source prompt](blocked-source-fallback/prompt.md) from the repository root so its relative paths resolve. Give the agent read access to the packet, provide the text below the prompt's YAML header, and save the answer and the observed source-access record.

Review the answer with the [case's graders](blocked-source-fallback/graders/) and save your verdicts to `result.json`. From the repository root, run the checker:

```bash
node evals/check_results.mjs < result.json
```

In PowerShell, run the same command through Command Prompt to pass the file's UTF-8 bytes directly:

```powershell
cmd /c "node evals/check_results.mjs < result.json"
```

The checker prints a JSON rollup to standard output. A valid result exits with status 0 for any rubric outcome. An invalid result exits with status 1 and prints a diagnostic to standard error.

<br>

## Run the cases

Each case contains its prompt, expected outcome, and per-criterion graders. Use the prompt's allowed tools and keep the agent's answer and source-access record for review.

| Case | What to look for |
| --- | --- |
| [Single-authority lookup](single-authority-lookup/prompt.md) | Give the official SI definition of the second, use APA 7 as requested, and stop once the governing source settles it. |
| [Short question with citations](short-question-still-cited/prompt.md) | Correct a myth with a proportionate lookup and a clickable citation. |
| [Current statistic with dates](current-statistic-with-dates/prompt.md) | Find the latest official rate and reproduce a change using comparable dated figures. |
| [Full report with APA](full-report-with-apa/prompt.md) | Compare matched outcomes and follow-up periods, check evidence overlap where accessible, and use APA 7. |
| [Blocked-source fallback](blocked-source-fallback/prompt.md) | Use the accessible abstract and give the limits of the evidence in the supplied packet. |
| [Non-comparable series](non-comparable-series/prompt.md) | Resolve a conflict in the supplied packet and compute the change from comparable annual figures. |

The first four cases use live research tools. Run the last two from the repository root with their `sources/` directories intact. Both are read-only simulations. Treat the blocked-source access receipt as the recorded observation for the exercise.

<br>

## Record verdicts

Set `caseId` to a case directory name. Use the exact grader filename without `.md` as each verdict's `id`. Include an exact response quote and locator, plus a source quote and locator from the inspected passage, or a `sourceAbsentReason` if the evidence is genuinely absent. Use `unassessable` when the available evidence leaves the result uncertain. Use `NA` only for `01-central-figure-consistency` when the answer has no central figure, or for `09-evidence-independence` when no accessible review–trial pair can be inspected. Include a specific `naReason`.

The following partial `result.json` uses the blocked-source case. Run it to see how a passed criterion and missing verdicts are reported. A complete assessment covers every grader.

```json
{
  "caseId": "blocked-source-fallback",
  "verdicts": [
    {
      "id": "01-central-figure-consistency",
      "verdict": "pass",
      "evidence": {
        "response": {
          "quote": "Participants reported a 25% reduction in symptom scores from baseline at 12 weeks.",
          "locator": "example response line 1"
        },
        "source": {
          "quote": "participants receiving the Aster program reported a 25% reduction in symptom scores from baseline at 12 weeks",
          "locator": "sources/repository-abstract.md, line 5"
        }
      }
    }
  ]
}
```

An optional `retrievalMappings` array lets you connect a citation to the observed retrieval record. Each entry requires `citation`, `sourceLocator`, and `basis`. Map each citation once and explain the connection when the retrieved and cited URLs differ.

### Record arithmetic

A passing `*-reproducible-delta` verdict requires an `arithmetic` object with at least two source rows and one delta. For example, the annual rates in the [simulated agency release](non-comparable-series/sources/official-releases.json) yield a change of 0.6 percentage points:

```json
{
  "rows": [
    { "id": "annual-2023", "locator": "official-releases.json, annual-2023", "rate": "4.2" },
    { "id": "annual-2024", "locator": "official-releases.json, annual-2024", "rate": "4.8" }
  ],
  "deltas": [
    {
      "id": "annual-change",
      "locator": "example response line 2",
      "fromRow": "annual-2023",
      "toRow": "annual-2024",
      "percentagePoints": "0.6"
    }
  ]
}
```

Supply rates and percentage points as plain decimal strings. The checker calculates the change as the destination rate minus the starting rate. When raw counts are available, add both `numerator` and `denominator` as strings to the row. The checker compares `numerator / denominator × 100` with the reported rate within half of its last reported decimal place. A confirmed mismatch changes a claimed arithmetic pass to fail.

<br>

## Read the rollup

The rollup groups the two central gates, substance criteria, and presentation criteria. A confirmed gate or substance failure makes the result `fail`. Otherwise a missing or unassessable verdict makes it `ungraded`, followed by `fail` for any remaining presentation failure. It reports `pass` when all applicable criteria pass. Reviewers are responsible for checking the authenticity and relevance of quotes, whether the evidence supports the claim, and each NA justification.

Pair [verify-citations.mjs](../researcher/scripts/verify-citations.mjs) with [check_results.mjs](check_results.mjs) during evaluation: run `verify-citations.mjs` on the saved agent draft first to catch missing clickable links, local line-quote mismatches, quantitative direction or unit errors, proxy URLs, scratchpad leaks, and APA 7 reference mismatches, then record the rubric verdicts and arithmetic in `result.json` for `check_results.mjs` to validate.

Run the automated tests from the repository root to verify the checker, skill layout, and citation verifier:

```bash
node --test
```
