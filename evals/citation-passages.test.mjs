import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Point at a saved verifier revision to replay the same drafts against it.
const verifier = process.env.RESEARCHER_TEST_VERIFIER
  ? pathToFileURL(resolve(process.env.RESEARCHER_TEST_VERIFIER))
  : new URL('../researcher/scripts/verify-citations.mjs', import.meta.url);
const { verifyDraft } = await import(verifier);
const rootDir = fileURLToPath(new URL('../', import.meta.url));
const table = 'examples/us-unemployment.csv';
const packet = 'evals/blocked-source-fallback/sources';

const cases = [
  {
    name: 'accepts a verbatim row from the BLS transcription',
    draft: `The 2024 rate was 4.0%. [“2024,4.0”](${table}#L3)`
  },
  {
    name: 'accepts a verbatim excerpt from the simulated abstract',
    draft: `The authors describe a ["25% reduction in symptom scores"](${packet}/repository-abstract.md#L5).`
  },
  {
    name: 'rejects a changed number in a quoted row',
    draft: `The 2024 rate was 3.0%. [“2024,3.0”](${table}#L3)`,
    error: 'LOCAL_QUOTE_MISMATCH'
  },
  {
    name: 'rejects a genuine quote attributed to the wrong line',
    draft: `The 2024 rate was 4.0%. [“2024,4.0”](${table}#L2)`,
    error: 'LOCAL_QUOTE_MISMATCH'
  },
  {
    name: 'rejects an existing file cited at a nonexistent line',
    draft: `The 2024 rate was 4.0%. [Annual table](${table}#L30)`,
    error: 'INVALID_LOCAL_LINE_RANGE'
  },
  {
    name: 'rejects a genuine passage attributed to another document',
    draft: `The authors describe a [“25% reduction in symptom scores”](${packet}/weaker-summary.md#L3).`,
    error: 'LOCAL_QUOTE_MISMATCH'
  },
  {
    name: 'rejects a reversed line range',
    draft: `The two annual observations appear in the [table](${table}#L3-L2).`,
    error: 'INVALID_LOCAL_LINE_RANGE'
  },
  {
    name: 'scope control: a false interpretation with genuine linked rows passes the mechanical checks',
    draft: `The annual rate fell. [“2023,3.6”](${table}#L2) and [“2024,4.0”](${table}#L3).`
  }
];

for (const example of cases) {
  test(example.name, async () => {
    const result = await verifyDraft(example.draft, { rootDir });
    assert.deepEqual(result.errors.map(error => error.code), example.error ? [example.error] : []);
    assert.equal(result.ok, !example.error);
  });
}
