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
const series = 'evals/non-comparable-series/sources/official-releases.json';
const packet = 'evals/blocked-source-fallback/sources';

const cases = [
  {
    name: 'accepts a verbatim line from the official releases packet',
    draft: `The 2024 annual rate was 4.8%. [“"rate_percent": "4.8"”](${series}#L17)`
  },
  {
    name: 'accepts a verbatim excerpt from the simulated abstract',
    draft: `The authors describe a ["25% reduction in symptom scores"](${packet}/repository-abstract.md#L5).`
  },
  {
    name: 'rejects a changed number in a quoted line',
    draft: `The 2024 annual rate was 3.9%. [“"rate_percent": "3.9"”](${series}#L17)`,
    error: 'LOCAL_QUOTE_MISMATCH'
  },
  {
    name: 'rejects a genuine quote attributed to the wrong line',
    draft: `The 2024 annual rate was 4.8%. [“"rate_percent": "4.8"”](${series}#L11)`,
    error: 'LOCAL_QUOTE_MISMATCH'
  },
  {
    name: 'rejects an existing file cited at a nonexistent line',
    draft: `The 2024 annual rate was 4.8%. [Official releases](${series}#L40)`,
    error: 'INVALID_LOCAL_LINE_RANGE'
  },
  {
    name: 'rejects a genuine passage attributed to another document',
    draft: `The authors describe a [“25% reduction in symptom scores”](${packet}/weaker-summary.md#L3).`,
    error: 'LOCAL_QUOTE_MISMATCH'
  },
  {
    name: 'rejects a reversed line range',
    draft: `The two annual observations appear in the [release](${series}#L17-L11).`,
    error: 'INVALID_LOCAL_LINE_RANGE'
  },
  {
    name: 'scope control: a false interpretation with genuine linked lines passes the mechanical checks',
    draft: `The annual rate fell. [“"rate_percent": "4.2"”](${series}#L11) and [“"rate_percent": "4.8"”](${series}#L17).`
  }
];

for (const example of cases) {
  test(example.name, async () => {
    const result = await verifyDraft(example.draft, { rootDir });
    assert.deepEqual(result.errors.map(error => error.code), example.error ? [example.error] : []);
    assert.equal(result.ok, !example.error);
  });
}
