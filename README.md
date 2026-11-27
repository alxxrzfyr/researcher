<div align="center">

# Researcher

**Source-grounded research and deterministic citation verification for AI agents.**

Researcher gives compatible AI agents a structured workflow for checking facts, reconciling conflicting figures, and citing inspected passages. Its zero-dependency Node.js verifier checks saved drafts against local source lines, quantitative change claims, and APA 7 references.

[Quick Start](#quick-start) · [Why Researcher?](#why-researcher) · [How it works](#how-it-works) · [Usage](#usage) · [Citation verifier](#citation-verifier) · [Evaluation](#evaluation)

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-Standard-2EA44F)](https://agentskills.io/specification)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-5FA04E?logo=nodedotjs&logoColor=white)](#citation-verifier)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

<br>

## Quick Start

Use a compatible [Agent Skills](https://agentskills.io/specification) agent with file and web access. Installing via the [Skills CLI](https://github.com/vercel-labs/skills) requires Git and Node.js 22.20+, while running the standalone citation verifier requires only Node.js 22+. Researcher itself requires no API key.

Install Researcher into your project from GitHub (or run `npx skills add . --skill researcher` from a local checkout):

```bash
npx skills add alxxrzfyr/researcher --skill researcher
```

In a new agent session, run a lookup prompt:

```text
Use the researcher skill to find the official SI definition of the second.
Keep the answer brief and link to the governing source.
```

Expect a concise answer with a clickable source link next to the definition.

### Install manually from a checkout

From the repository root, copy the skill files (`SKILL.md`, `references/`, and `scripts/`) into your agent's skills directory (for example, `~/.agents/skills/researcher`):

```bash
mkdir -p ~/.agents/skills/researcher
cp researcher/SKILL.md ~/.agents/skills/researcher/
cp -R researcher/references researcher/scripts ~/.agents/skills/researcher/
```

In PowerShell, run the equivalent copy from the repository root:

```powershell
$skillDir = Join-Path $env:USERPROFILE '.agents/skills/researcher'
New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
Copy-Item -Path .\researcher\SKILL.md, .\researcher\references, .\researcher\scripts -Destination $skillDir -Recurse -Force
```

In chat tools that use custom instructions, supply [SKILL.md](researcher/SKILL.md) and attach the reference guides as context.

### Verify a cited draft offline

From the repository root, run the citation verifier on the included [example answer](examples/us-unemployment.md):

```bash
node researcher/scripts/verify-citations.mjs examples/us-unemployment.md --root examples --require-local-quote
```

Expect `"ok": true` and `"localQuotesMatched": 2`. If you change the draft's quoted 2024 value from `4.0` to `3.0` in a copy and re-run the command, the verifier exits with status 1 and reports `LOCAL_QUOTE_MISMATCH`.

<br>

## Why Researcher?

Generating fluent prose with links is not the same as verifying claims against inspected evidence. In a human audit of four generative search engines ([Liu, Zhang, & Liang, Findings of EMNLP 2023](https://aclanthology.org/2023.findings-emnlp.467/)), only 51.5% of sentences were fully supported by their citations and 74.5% of citations supported the accompanying sentence. In [DeepResearch Bench (2025)](https://deepresearch-bench.github.io/static/papers/deepresearch-bench.pdf), citation volume and accuracy diverged across systems (for example, 111.21 citations at 81.44% accuracy versus 31.26 at 90.24%), changing how systems ranked when evaluated on citation accuracy.

Hosted AI deep-research products hide their retrieval and verification behind proprietary black boxes. Researcher provides three structural advantages that stay in your repository:

- **Portable epistemic discipline across agents:** Built on the open [Agent Skills](https://agentskills.io/specification) format, [SKILL.md](researcher/SKILL.md) enforces passage inspection, primary-vs-secondary conflict resolution, and comparator checks across any compatible model or harness.
- **Post-edit zero-LLM deterministic verification:** [verify-citations.mjs](researcher/scripts/verify-citations.mjs) runs locally in Node.js with no API calls to catch local line-range and verbatim-quote mismatches, `from X% to Y%` direction errors and `pp` vs. `%` unit confusions, APA 7 1:1 in-text and reference mismatches, proxy redirect URLs (`grounding-api-redirect` and similar wrappers), placeholder URLs, and leaked scratchpad notes.
- **Two-gate adversarial evaluation with exact `BigInt` decimal rollups:** The [evaluation suite](evals/README.md) separates central figure consistency and citation authenticity gates from substance and presentation criteria, while [check_results.mjs](evals/check_results.mjs) validates rates and percentage-point deltas using exact `BigInt` rational arithmetic.

<br>

## How it works

Researcher routes effort to the question's scope and closes the loop with deterministic verification before you share a draft.

| Mode | Trigger | Search & scaling | Stop condition |
| --- | --- | --- | --- |
| **Lookup** | Single fact, definition, or quick myth-check | 1–2 queries, 1 primary inspection | Stop the instant the governing source settles the fact |
| **Focused** | Current stat/trend, premise check, conflict, or blocked primary | ~3–6 queries with batched fetches; pivot once on 403/timeout | Stop once latest governing figure and comparable trend endpoints verify |
| **Deep** | Multi-faceted review, contested evidence, or full report | Broad landscape, then 2–4 disjoint parallel branches with compressed returns | Stop when marginal information gain hits zero or routes exhaust |

Across every mode, the workflow follows five steps:

1. **Anchor & decompose:** Pin time-sensitive queries to the current date, extract population, comparator, outcome, and timeframe, and check embedded premises.
2. **Search by information gain:** Start with high-signal official terms, record figures and locators immediately, and pivot vocabulary or access paths rather than repeating failing queries.
3. **Consolidate & scale:** Keep Lookup and Focused runs in one pass; for Deep runs, track verified claims in a compact ledger across disjoint branches.
4. **Verify, chain & compute:** Resolve primary-vs-secondary conflicts in favor of the governing record, check series comparability, and recompute percentage-point (`pp`) and relative (`%`) changes from comparable endpoints.
5. **Draft & verify:** Write clean prose with inline clickable links next to supported claims (or APA 7 when requested), then run `verify-citations.mjs` until it exits with status 0.

<br>

## Usage

Name the skill in your prompt and specify the scope, timeframe, or citation format you need. For local evidence packets, give the agent the starting file and read access to its sibling sources.

| Task | Example prompt | Expected result |
| --- | --- | --- |
| Quick lookup | “What is the SI definition of the second? Cite its governing source.” | A brief answer with a clickable link to the official source. |
| Current statistic | “Find the latest Philippine unemployment rate. Compare it with a compatible rate from five years earlier and show the percentage-point change.” | Dated figures, comparability basis, and the percentage-point calculation. |
| Evidence comparison | “Start with the two sources under `evals/non-comparable-series/sources/`. Reconcile their claims about the 2023–2024 unemployment change.” | An explanation of which figures are comparable, with links to the supplied evidence. |
| Cited report | “Compare the evidence on intermittent fasting and ordinary calorie restriction for adult weight loss. Use APA 7.” | A report identifying direct comparisons, uncertainty, in-text citations, and APA 7 references. |

Ordinary chat answers use inline clickable Markdown links beside supported claims. Consult the [APA 7 citation guide](researcher/references/apa7-citation-guide.md) for academic formatting and [source and evidence checks](researcher/references/source-and-evidence-checks.md) for study quality, conflicting results, and comparability rules.

<br>

## Citation verifier

Run [verify-citations.mjs](researcher/scripts/verify-citations.mjs) with Node.js 22+ on a saved Markdown file or via standard input:

```bash
node researcher/scripts/verify-citations.mjs draft.md --root . --require-local-quote
node researcher/scripts/verify-citations.mjs draft.md --apa --check-urls
```

- `--root <dir>`: Resolve relative local links against `<dir>`, verify `#L<start>` or `#L<start>-L<end>` line ranges exist, and match double-quoted excerpts (`["exact text"](file.csv#L3)`) against those lines.
- `--require-local-quote`: Fail if the draft contains zero verified local quoted excerpts.
- `--apa`: Enforce APA 7 reference formatting, author-order rules, no `et al.` in References, and 1:1 matching between in-text citations and References entries.
- `--check-urls`: Probe external HTTP/HTTPS URLs (`HEAD` with `GET` fallback) and flag HTTP 404/410 as `DEAD_URL` errors or other failures as warnings.
- Omit `filePath` to pipe Markdown over standard input.

The verifier prints a JSON summary and exits with status 1 on errors. It catches mechanical defects—proxy redirect URLs, placeholder URLs, leaked scratchpad notes, broken Markdown links, missing clickable citations in ordinary chat (`>= 120` chars), local file/line/quote mismatches, `from X% to Y%` direction and `pp` vs. `%` arithmetic errors, and APA 7 structural mismatches—while human review remains necessary to confirm that cited passages logically entail the surrounding claim ([citation-passages.test.mjs](evals/citation-passages.test.mjs)).

<br>

## Evaluation

Run the automated test suite from the repository root with Node.js 22+:

```bash
node --test
```

The test suite validates the skill directory layout, `verify-citations.mjs`, and `check_results.mjs`. See the [evaluation guide](evals/README.md) to run the six agent evaluation cases and score saved answers against their graders.

<br>

## Contributing

See the [contributing guidelines](.github/CONTRIBUTING.md) for reporting research failures, updating skill instructions or verifier checks, and running tests before opening a pull request.

<br>

## License

Researcher is available under the [MIT License](LICENSE). Copyright © 2026 Alex L Berin.
