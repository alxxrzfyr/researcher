# Contributing to Researcher

Open an issue for reproducible bugs or to discuss broader changes. For an incorrect answer or citation, include the prompt, agent and model, date of the run, relevant output, and the source passage or locator you expected the agent to use. Share only material you have permission to disclose.

## Make a change

1. Fork and clone the repository, then create a branch from `version-1`.
2. Edit [the skill instructions](../researcher/SKILL.md), [the reference guides](../researcher/references/), or [the citation verifier](../researcher/scripts/verify-citations.mjs), as appropriate.
3. Run the tests from the repository root with Node.js 22. If the change affects research behavior, rerun a relevant prompt and record the evidence. Follow the [evaluation guide](../evals/README.md).
4. Commit with a Conventional Commit summary such as `fix: preserve citation locators for local sources`. In your pull request, describe the behavior change and include the checks you ran.

```bash
node --test
```
