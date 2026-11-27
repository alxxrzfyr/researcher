import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const gates = new Set(['01-central-figure-consistency', '02-central-citation-authenticity']);
const naAllowed = new Set(['01-central-figure-consistency', '09-evidence-independence']);
const presentation = new Set(['requested-apa-format', 'local-chat-attribution', 'default-chat-format']);
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const need = (condition, message) => { if (!condition) throw new Error(message); };
const decimal = x => {
  need(typeof x === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(x), 'Decimal values must be plain decimal strings');
  const neg = x.startsWith('-');
  const [whole, fraction = ''] = (neg ? x.slice(1) : x).split('.');
  return [BigInt((neg ? '-' : '') + whole + fraction), 10n ** BigInt(fraction.length)];
};
const equal = (a, b) => a[0] * b[1] === b[0] * a[1];
const subtract = (a, b) => [a[0] * b[1] - b[0] * a[1], a[1] * b[1]];
const absBigInt = x => (x < 0n ? -x : x);
const withinHalfUlp = (rate, n, d) => {
  let num = n[0] * d[1] * 100n;
  let den = n[1] * d[0];
  if (den < 0n) { num = -num; den = -den; }
  return 2n * absBigInt(num * rate[1] - rate[0] * den) <= den;
};

export async function checkResult(input) {
  need(object(input), 'Result must be an object');
  need(nonempty(input.caseId) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.caseId), 'Invalid caseId');
  const cases = await readdir(root, { withFileTypes: true });
  need(cases.some(x => x.isDirectory() && x.name === input.caseId), 'Unknown caseId');
  const files = await readdir(join(root, input.caseId, 'graders'));
  const ids = files.filter(x => x.endsWith('.md')).map(x => x.slice(0, -3)).sort();
  need(ids.length > 0, 'Case has no graders');
  need([...gates].every(id => ids.includes(id)), 'Case must contain both central gates');
  need(Array.isArray(input.verdicts), 'verdicts must be an array');
  const seen = new Map();
  for (const v of input.verdicts) {
    need(object(v) && ids.includes(v.id), `Unknown or malformed grader ID: ${v?.id}`);
    need(!seen.has(v.id), `Duplicate grader ID: ${v.id}`);
    need(['pass', 'fail', 'unassessable', 'NA'].includes(v.verdict), `Invalid verdict for ${v.id}`);
    need(object(v.evidence), `Missing evidence for ${v.id}`);
    const e = v.evidence;
    need(object(e.response) && nonempty(e.response.quote) && nonempty(e.response.locator), `Missing response quote or locator for ${v.id}`);
    need((object(e.source) && nonempty(e.source.quote) && nonempty(e.source.locator)) || nonempty(e.sourceAbsentReason), `Missing source evidence or absence reason for ${v.id}`);
    if (v.verdict === 'NA') {
      need(naAllowed.has(v.id), 'NA is only permitted for 01-central-figure-consistency or 09-evidence-independence');
      need(nonempty(v.naReason), `Missing NA justification for ${v.id}`);
    }
    seen.set(v.id, { id: v.id, verdict: v.verdict });
  }
  if (input.retrievalMappings !== undefined) {
    need(Array.isArray(input.retrievalMappings), 'retrievalMappings must be an array');
    const citations = new Set();
    for (const m of input.retrievalMappings) {
      need(object(m) && nonempty(m.citation) && nonempty(m.sourceLocator) && nonempty(m.basis), 'Malformed retrieval mapping');
      need(!citations.has(m.citation), `Duplicate retrieval mapping: ${m.citation}`);
      citations.add(m.citation);
    }
  }
  const arithmeticIds = ids.filter(id => /-reproducible-delta$/.test(id));
  const arithmeticPass = arithmeticIds.filter(id => seen.get(id)?.verdict === 'pass');
  const arithmeticErrors = [];
  if (input.arithmetic !== undefined || arithmeticPass.length) {
    const a = input.arithmetic;
    need(object(a) && Array.isArray(a.rows) && a.rows.length >= 2 && Array.isArray(a.deltas) && a.deltas.length > 0, 'Arithmetic requires at least two rows and one delta');
    const rows = new Map();
    for (const row of a.rows) {
      need(object(row) && nonempty(row.id) && nonempty(row.locator) && !rows.has(row.id), 'Malformed or duplicate arithmetic row');
      const rate = decimal(row.rate);
      need((row.numerator === undefined) === (row.denominator === undefined), `Row ${row.id} must supply both counts or neither`);
      if (row.numerator !== undefined) {
        const n = decimal(row.numerator), d = decimal(row.denominator);
        need(d[0] !== 0n, `Zero denominator in row ${row.id}`);
        if (!withinHalfUlp(rate, n, d)) arithmeticErrors.push(`Row ${row.id}: reported rate does not equal numerator / denominator * 100`);
      }
      rows.set(row.id, rate);
    }
    const deltaIds = new Set();
    for (const delta of a.deltas) {
      need(object(delta) && nonempty(delta.id) && nonempty(delta.locator) && !deltaIds.has(delta.id) && rows.has(delta.fromRow) && rows.has(delta.toRow) && delta.fromRow !== delta.toRow, 'Malformed or duplicate arithmetic delta');
      deltaIds.add(delta.id);
      if (!equal(decimal(delta.percentagePoints), subtract(rows.get(delta.toRow), rows.get(delta.fromRow)))) arithmeticErrors.push(`Delta ${delta.id}: reported percentage points do not equal toRow rate minus fromRow rate`);
    }
    if (arithmeticErrors.length) for (const id of arithmeticPass) seen.set(id, { id, verdict: 'fail', reason: arithmeticErrors.join('; ') });
  }
  const results = ids.map(id => seen.get(id) ?? { id, verdict: 'ungraded' });
  const summarize = list => Object.fromEntries(['pass', 'fail', 'unassessable', 'NA', 'ungraded'].map(v => [v, list.filter(x => x.verdict === v).map(x => x.id)]));
  const gateResults = results.filter(x => gates.has(x.id));
  const substanceResults = results.filter(x => !gates.has(x.id) && !presentation.has(x.id.replace(/^\d+-/, '')));
  const presentationResults = results.filter(x => presentation.has(x.id.replace(/^\d+-/, '')));
  const overall = gateResults.some(x => x.verdict === 'fail')
    ? 'fail'
    : substanceResults.some(x => x.verdict === 'fail')
      ? 'fail'
      : results.some(x => x.verdict === 'ungraded' || x.verdict === 'unassessable')
        ? 'ungraded'
        : results.some(x => x.verdict === 'fail')
          ? 'fail'
          : 'pass';
  return { caseId: input.caseId, overall, gates: summarize(gateResults), substance: summarize(substanceResults), presentation: summarize(presentationResults), results, arithmeticErrors };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const result = await checkResult(JSON.parse(text));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`Invalid result: ${error.message}\n`);
    process.exitCode = 1;
  }
}
