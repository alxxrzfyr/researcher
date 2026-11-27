import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkResult } from './check_results.mjs';
import { verifyDraft } from '../researcher/scripts/verify-citations.mjs';

const evidence = { response: { quote: 'A claim', locator: 'response line 1' }, source: { quote: 'A source', locator: 'source table 1' } };
const caseId = 'current-statistic-with-dates';
const ids = (await readdir(new URL(`./${caseId}/graders/`, import.meta.url))).filter(x => x.endsWith('.md')).map(x => x.slice(0, -3));
const complete = () => ({ caseId, verdicts: ids.map(id => ({ id, verdict: 'pass', evidence })), arithmetic: { rows: [{ id: 'a', locator: 'table 1', rate: '0.1' }, { id: 'b', locator: 'table 2', rate: '0.3' }], deltas: [{ id: 'd', locator: 'line 1', fromRow: 'a', toRow: 'b', percentagePoints: '0.2' }] } });

test('checks multiline quotes, encoded file names, end of file, and the local source root', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'researcher-passages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rootDir = join(dir, 'packet');
  const other = join(dir, 'archive');
  await mkdir(rootDir);
  await mkdir(other);
  await writeFile(join(rootDir, 'source notes.txt'), 'header\r\nCafé opens\r\nat nine.\r\n');
  await writeFile(join(other, 'record.txt'), 'another record');
  await symlink(other, join(rootDir, 'linked'), 'junction');

  const draft = '[“Café opens at nine.”](source%20notes.txt#L2-L3)';
  const checked = await verifyDraft(draft, { rootDir });
  assert.equal(checked.ok, true);
  assert.equal(checked.stats.localQuotesMatched, 1);
  const unchecked = await verifyDraft(draft);
  assert.equal(unchecked.stats.localQuotesMatched, 0);
  assert.ok(unchecked.warnings.some(w => w.code === 'LOCAL_PASSAGE_UNCHECKED'));

  for (const [target, expected] of [
    ['source%20notes.txt#L4', 'INVALID_LOCAL_LINE_RANGE'],
    ['absent.txt#L1', 'MISSING_LOCAL_FILE'],
    ['../archive/record.txt#L1', 'LOCAL_PASSAGE_OUTSIDE_ROOT'],
    ['linked/record.txt#L1', 'LOCAL_PASSAGE_OUTSIDE_ROOT']
  ]) {
    const result = await verifyDraft(`[record](${target})`, { rootDir });
    assert.deepEqual(result.errors.map(error => error.code), [expected]);
  }
});

test('rollup distinguishes failures, unassessable and missing verdicts', async () => {
  const x = complete();
  assert.equal((await checkResult(x)).overall, 'pass');
  x.verdicts[2].verdict = 'fail';
  assert.equal((await checkResult(x)).overall, 'fail');
  x.verdicts.pop();
  assert.equal((await checkResult(x)).overall, 'fail');
  x.verdicts[2].verdict = 'unassessable';
  assert.equal((await checkResult(x)).overall, 'ungraded');
  x.verdicts.push({ id: ids.at(-1), verdict: 'pass', evidence });
  assert.equal((await checkResult(x)).overall, 'ungraded');
});

test('a required local quotation must appear as a citation in the answer', async () => {
  const rootDir = fileURLToPath(new URL('../examples/', import.meta.url));
  const quote = '[“2024,4.0”](us-unemployment.csv#L3)';
  const options = { rootDir, requireLocalQuote: true };
  assert.equal((await verifyDraft(quote, options)).stats.localQuotesMatched, 1);
  assert.equal((await verifyDraft('1. Annual rates\n\n    - ' + quote, options)).stats.localQuotesMatched, 1);
  for (const text of [
    'The annual rate rose.',
    '[Table](us-unemployment.csv#L3)',
    '`' + quote + '`',
    ['~~~md', quote, '~~~'].join('\n'),
    ['> ~~~md', '> ' + quote, '> ~~~'].join('\n'),
    '    ' + quote,
    '!' + quote
  ]) {
    const result = await verifyDraft(text, options);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.code === 'NO_VERIFIED_LOCAL_QUOTE'));
  }
  const scriptPath = fileURLToPath(new URL('../researcher/scripts/verify-citations.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [scriptPath, '--root', rootDir, '--require-local-quote'], { input, encoding: 'utf8' });
  assert.equal(run(quote).status, 0);
  assert.equal(run('[Table](us-unemployment.csv)').status, 1);
  const missingDir = spawnSync(process.execPath, [scriptPath, '--root', '--require-local-quote'], { input: quote, encoding: 'utf8' });
  assert.equal(missingDir.status, 1);
  assert.match(missingDir.stderr, /--root requires a directory/);
});

test('rejects malformed evidence, unknown IDs and duplicates', async () => {
  const x = complete();
  x.verdicts.push(x.verdicts[0]);
  await assert.rejects(checkResult(x), /Duplicate grader/);
  x.verdicts.pop(); x.verdicts[0].id = 'unknown';
  await assert.rejects(checkResult(x), /Unknown or malformed/);
  x.verdicts[0].id = ids[0]; x.verdicts[0].evidence = {};
  await assert.rejects(checkResult(x), /response quote/);
  x.verdicts[0].evidence = evidence;
  x.retrievalMappings = [{ citation: 'A', sourceLocator: 'table', basis: 'observed' }, { citation: 'A', sourceLocator: 'table', basis: 'observed' }];
  await assert.rejects(checkResult(x), /Duplicate retrieval/);
  await assert.rejects(checkResult({ ...x, caseId: '../escape' }), /Invalid caseId/);
});

test('checks decimal rates and percentage points exactly', async () => {
  const x = complete();
  x.arithmetic = { rows: [{ id: 'a', locator: 'table row 1', rate: '0.1' }, { id: 'b', locator: 'table row 2', numerator: '3', denominator: '10', rate: '30' }], deltas: [{ id: 'd', locator: 'response line 2', fromRow: 'a', toRow: 'b', percentagePoints: '29.9' }] };
  assert.deepEqual((await checkResult(x)).arithmeticErrors, []);
  x.arithmetic.deltas[0].percentagePoints = '29.900000000000001';
  assert.match((await checkResult(x)).arithmeticErrors[0], /Delta d/);
});

test('stdin CLI returns structured output and rejects invalid JSON', () => {
  const scriptPath = fileURLToPath(new URL('./check_results.mjs', import.meta.url));
  const run = text => spawnSync(process.execPath, [scriptPath], { input: text, encoding: 'utf8' });
  const good = run(JSON.stringify(complete()));
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).overall, 'pass');
  assert.equal(run('{').status, 1);
});

test('gate failure outranks missing verdict and arithmetic failures invalidate a claimed pass', async () => {
  const dirs = await readdir(new URL('./', import.meta.url), { withFileTypes: true });
  let exercised = false;
  for (const dir of dirs.filter(d => d.isDirectory())) {
    let names;
    try { names = (await readdir(new URL(`./${dir.name}/graders/`, import.meta.url))).filter(x => x.endsWith('.md')).map(x => x.slice(0, -3)); } catch { continue; }
    const gate = names.find(x => x === '01-central-figure-consistency');
    const arithmetic = names.find(x => /^(06|07)-reproducible-delta$/.test(x));
    if (!gate || !arithmetic) continue;
    exercised = true;
    const x = { caseId: dir.name, verdicts: [{ id: gate, verdict: 'fail', evidence }] };
    assert.equal((await checkResult(x)).overall, 'fail');
    x.verdicts = names.map(id => ({ id, verdict: 'pass', evidence }));
    await assert.rejects(checkResult(x), /Arithmetic requires/);
    x.arithmetic = { rows: [{ id: 'a', locator: 'table 1', rate: '0.1' }, { id: 'b', locator: 'table 2', rate: '0.3' }], deltas: [{ id: 'd', locator: 'line 1', fromRow: 'a', toRow: 'b', percentagePoints: '0.3' }] };
    const result = await checkResult(x);
    assert.equal(result.overall, 'fail');
    assert.equal(result.results.find(v => v.id === arithmetic).verdict, 'fail');
    x.arithmetic.deltas[0].percentagePoints = '0.2';
    assert.equal((await checkResult(x)).overall, 'pass');
  }
  assert.ok(exercised, 'Expected a case with central gate and reproducible delta');
});

test('presentation passes cannot mask a gate failure; NA is limited to the figure gate', async () => {
  const x = complete();
  x.verdicts.find(v => v.id === '01-central-figure-consistency').verdict = 'fail';
  const result = await checkResult(x);
  assert.equal(result.overall, 'fail');
  assert.ok(result.gates.fail.includes('01-central-figure-consistency'));
  const figure = x.verdicts.find(v => v.id === '01-central-figure-consistency');
  figure.verdict = 'NA'; figure.naReason = 'No central numerical figure appears in the response.';
  assert.equal((await checkResult(x)).overall, 'pass');
  x.verdicts.find(v => v.id === '02-central-citation-authenticity').verdict = 'NA';
  await assert.rejects(checkResult(x), /NA is only permitted/);
});

test('substance fail outranks ungraded/unassessable; 09-evidence-independence permits NA; count-derived rates allow half-ULP rounding', async () => {
  const x = complete();
  x.verdicts[2].verdict = 'fail';
  x.verdicts[3].verdict = 'unassessable';
  assert.equal((await checkResult(x)).overall, 'fail');
  x.verdicts.pop();
  assert.equal((await checkResult(x)).overall, 'fail');

  const fastingIds = (await readdir(new URL('./full-report-with-apa/graders/', import.meta.url)))
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3));
  const fasting = {
    caseId: 'full-report-with-apa',
    verdicts: fastingIds.map(id => id === '09-evidence-independence'
      ? { id, verdict: 'NA', naReason: 'No accessible review-trial pair was available to inspect.', evidence }
      : { id, verdict: 'pass', evidence })
  };
  assert.equal((await checkResult(fasting)).overall, 'pass');

  const rounded = complete();
  rounded.arithmetic = {
    rows: [
      { id: 'a', locator: 'table row 1', numerator: '2150', denominator: '47800', rate: '4.5' },
      { id: 'b', locator: 'table row 2', rate: '5.0' }
    ],
    deltas: [{ id: 'd', locator: 'response line 2', fromRow: 'a', toRow: 'b', percentagePoints: '0.5' }]
  };
  const roundedRes = await checkResult(rounded);
  assert.equal(roundedRes.overall, 'pass');
  assert.deepEqual(roundedRes.arithmeticErrors, []);

  rounded.arithmetic.rows[0].rate = '4.6';
  const badRounded = await checkResult(rounded);
  assert.equal(badRounded.overall, 'fail');
  assert.match(badRounded.arithmeticErrors[0], /\* 100$/);

  rounded.arithmetic.rows[0].rate = '4.5';
  rounded.arithmetic.deltas[0].toRow = 'a';
  rounded.arithmetic.deltas[0].percentagePoints = '0';
  await assert.rejects(checkResult(rounded), /Malformed or duplicate arithmetic delta/);
});

test('all eval cases have valid structure, gates, unique prefixes, and clean text', async () => {
  const evalsUrl = new URL('./', import.meta.url);
  const dirs = (await readdir(evalsUrl, { withFileTypes: true })).filter(d => d.isDirectory());
  assert.ok(dirs.length >= 6);
  for (const dir of dirs) {
    const caseUrl = new URL(`./${dir.name}/`, evalsUrl);
    const entries = await readdir(caseUrl);
    assert.ok(entries.includes('case.yaml'), `${dir.name} missing case.yaml`);
    assert.ok(entries.includes('prompt.md'), `${dir.name} missing prompt.md`);
    assert.ok(entries.includes('graders'), `${dir.name} missing graders/`);
    const graderFiles = (await readdir(new URL('./graders/', caseUrl))).filter(f => f.endsWith('.md')).sort();
    assert.ok(graderFiles.includes('01-central-figure-consistency.md'), `${dir.name} missing figure gate`);
    assert.ok(graderFiles.includes('02-central-citation-authenticity.md'), `${dir.name} missing citation gate`);
    const prefixes = graderFiles.map(f => f.match(/^(\d+)-/)?.[1]);
    assert.ok(prefixes.every(Boolean) && new Set(prefixes).size === prefixes.length, `${dir.name} has duplicate or missing numeric prefixes`);
    for (const sub of ['graders', ...(entries.includes('sources') ? ['sources'] : [])]) {
      const subUrl = new URL(`./${sub}/`, caseUrl);
      for (const file of await readdir(subUrl)) {
        const text = await readFile(new URL(`./${file}`, subUrl), 'utf8');
        assert.equal(/\w\?s\b|\?[A-Z]/.test(text), false, `${dir.name}/${sub}/${file} contains mangled '?' punctuation`);
      }
    }
  }
});

test('researcher directory is valid, lean, self-consistent, and has clean UTF-8 text', async () => {
  const skillDir = new URL('../researcher/', import.meta.url);
  const skillPath = new URL('./SKILL.md', skillDir);
  const skill = await readFile(skillPath, 'utf8');
  assert.match(skill, /^---\nname: researcher\ndescription: .+\n---\n/, 'Invalid or missing YAML frontmatter');
  assert.ok(Buffer.byteLength(skill, 'utf8') <= 6144, 'SKILL.md exceeds lean 6 KB budget');

  const refsDir = new URL('./references/', skillDir);
  const refFiles = (await readdir(refsDir)).filter(f => f.endsWith('.md')).sort();
  const linkedRefs = new Set([...skill.matchAll(/\]\((references\/[^)]+\.md)\)/g)].map(m => m[1].replace(/^references\//, '')));
  assert.ok(linkedRefs.size >= 2, 'Expected reference links in SKILL.md');
  for (const target of linkedRefs) {
    assert.ok(refFiles.includes(target), `Broken reference link in SKILL.md: references/${target}`);
  }
  for (const file of refFiles) {
    assert.ok(linkedRefs.has(file), `Orphaned reference file not linked from SKILL.md: references/${file}`);
  }

  const scriptFiles = await readdir(new URL('./scripts/', skillDir));
  assert.ok(scriptFiles.includes('verify-citations.mjs'), 'Missing scripts/verify-citations.mjs');

  for (const [name, url] of [
    ['SKILL.md', skillPath],
    ['scripts/verify-citations.mjs', new URL('./scripts/verify-citations.mjs', skillDir)],
    ...refFiles.map(f => [`references/${f}`, new URL(`./${f}`, refsDir)])
  ]) {
    const text = await readFile(url, 'utf8');
    assert.equal(text.startsWith('\uFEFF'), false, `${name} contains UTF-8 BOM`);
    assert.equal(text.includes('\r\n'), false, `${name} contains CRLF line endings`);
    assert.equal(/\w\?s\b|\?[A-Z]/.test(text), false, `${name} contains mangled '?' punctuation`);
  }
});

test('verify-citations catches proxy URLs, scratchpad leaks, missing links, and APA errors', async () => {
  const goodChat = await verifyDraft('The latest CPI rate is 3.7% in September 2026 ([BLS CPI Release](https://www.bls.gov/news.release/cpi.nr.htm)), down 5.4 pp from June 2022.');
  assert.equal(goodChat.ok, true);
  assert.equal(goodChat.errors.length, 0);

  const proxyChat = await verifyDraft('The rate is 3.7% ([BLS](https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABC123)).');
  assert.equal(proxyChat.ok, false);
  assert.ok(proxyChat.errors.some(e => e.code === 'PROXY_URL'));

  const leakChat = await verifyDraft('Rate is 5.0% ([BW](https://bworldonline.com/2026/05)) — wait: verify exact URL before citing.');
  assert.equal(leakChat.ok, false);
  assert.ok(leakChat.errors.some(e => e.code === 'LEAKED_SCRATCHPAD'));

  const uncitedChat = await verifyDraft('Humans use 100% of their brains according to modern neuroimaging, clinical neurology, and evolutionary biology over many decades.');
  assert.equal(uncitedChat.ok, false);
  assert.ok(uncitedChat.errors.some(e => e.code === 'NO_CITATIONS_IN_CHAT'));

  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const badLocal = await verifyDraft('The abstract reports 25% ([missing](evals/blocked-source-fallback/sources/does-not-exist.md)) over 12 weeks.', { rootDir: repoRoot });
  assert.equal(badLocal.ok, false);
  assert.ok(badLocal.errors.some(e => e.code === 'MISSING_LOCAL_FILE'));

  const goodLocal = await verifyDraft('The abstract reports 25% ([abstract](evals/blocked-source-fallback/sources/repository-abstract.md)) over 12 weeks.', { rootDir: repoRoot });
  assert.equal(goodLocal.ok, true);

  const badApa = await verifyDraft([
    'Fasting matched restriction (Trepanowski et al., 2017) and showed similar outcomes (Cho et al., 2019).',
    '',
    '## References',
    '',
    'Patikorn, C. (2021). Umbrella review. *JAMA Network Open*. https://doi.org/10.1001/test.',
    'Semnani-Azad, Z., et al. (2025). Network meta-analysis. *The BMJ*. https://doi.org/10.1136/bmj-2024-082007',
    'Trepanowski, J. F., C. M. Kroeger, & Varady, K. A. (2017). Trial. *JAMA Internal Medicine*. https://doi.org/10.1001/jamainternmed.2017.0936'
  ].join('\n'), { apa: true });
  assert.equal(badApa.ok, false);
  const badCodes = new Set(badApa.errors.map(e => e.code));
  assert.ok(badCodes.has('ORPHAN_IN_TEXT_CITATION'));
  assert.ok(badCodes.has('UNCITED_REFERENCE'));
  assert.ok(badCodes.has('REVERSED_AUTHOR_ORDER'));
  assert.ok(badCodes.has('TRAILING_PERIOD_ON_URL'));
  assert.ok(badCodes.has('REFERENCE_ET_AL'));

  const goodApa = await verifyDraft([
    'According to World Health Organization (WHO, 2020), results match earlier findings (Rabbitt, 1982, as cited in Lyon et al., 2014).',
    'Later, WHO (2020) confirmed this alongside Bureau International des Poids et Mesures (n.d.).',
    '',
    '## References',
    '',
    'Bureau International des Poids et Mesures. (n.d.). *SI base unit: Second (s)*. https://www.bipm.org/en/si-base-units/second',
    'Lyon, A., & Smith, B. (2014). Review. *Journal*. https://doi.org/10.1000/1',
    'World Health Organization. (2020). *Report*. https://www.who.int/report'
  ].join('\n'), { apa: true });
  assert.equal(goodApa.ok, true, JSON.stringify(goodApa.errors));
  assert.ok(goodApa.stats.httpLinks >= 1);

  const scriptPath = fileURLToPath(new URL('../researcher/scripts/verify-citations.mjs', import.meta.url));
  const helpRun = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(helpRun.status, 0);
  assert.match(helpRun.stdout, /^Usage:/);
});

test('verify-citations supports balanced parentheses in URLs, nested brackets in labels, and bare APA URLs', async () => {
  const wikiUrl = 'https://en.wikipedia.org/wiki/Ten_percent_of_the_brain_myth_(neuroscience)';
  const mdLinkRes = await verifyDraft(`See [Neuroscience [myth]](${wikiUrl}) and [WHO [2020]](https://www.who.int/report).`);
  assert.equal(mdLinkRes.ok, true, JSON.stringify(mdLinkRes.errors));
  assert.equal(mdLinkRes.stats.markdownLinks, 2);
  assert.equal(mdLinkRes.stats.httpLinks, 2);

  const apaBareRes = await verifyDraft([
    'The myth is debunked (Beyerstein, 1999).',
    '',
    '## References',
    '',
    `Beyerstein, B. L. (1999). Ten percent myth. *Wikipedia*. ${wikiUrl}`
  ].join('\n'), { apa: true });
  assert.equal(apaBareRes.ok, true, JSON.stringify(apaBareRes.errors));
  assert.equal(apaBareRes.stats.httpLinks, 1);
});

test('verify-citations rejects sandbox escapes without #L fragments and verifies whole-file and inline quotes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'researcher-sandbox-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rootDir = join(dir, 'packet');
  const outsideDir = join(dir, 'outside');
  await mkdir(rootDir);
  await mkdir(outsideDir);
  await writeFile(join(outsideDir, 'secret.txt'), 'secret data\n');
  await symlink(outsideDir, join(rootDir, 'linked'), 'junction');

  for (const target of ['../outside/secret.txt', 'linked/secret.txt']) {
    const res = await verifyDraft(`[secret](${target})`, { rootDir });
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors.map(e => e.code), ['LOCAL_PASSAGE_OUTSIDE_ROOT']);
  }

  const abstractRoot = fileURLToPath(new URL('./blocked-source-fallback/sources/', import.meta.url));
  const wholePass = await verifyDraft('[“25% reduction in symptom scores”](repository-abstract.md)', { rootDir: abstractRoot, requireLocalQuote: true });
  assert.equal(wholePass.ok, true, JSON.stringify(wholePass.errors));
  assert.equal(wholePass.stats.localQuotesMatched, 1);

  const wholeFail = await verifyDraft('[“35% reduction”](repository-abstract.md)', { rootDir: abstractRoot });
  assert.equal(wholeFail.ok, false);
  assert.deepEqual(wholeFail.errors.map(e => e.code), ['LOCAL_QUOTE_MISMATCH']);

  const examplesDir = fileURLToPath(new URL('../examples/', import.meta.url));
  const inlinePass = await verifyDraft('[BLS 2024: "2024,4.0"](us-unemployment.csv#L3)', { rootDir: examplesDir, requireLocalQuote: true });
  assert.equal(inlinePass.ok, true, JSON.stringify(inlinePass.errors));
  assert.equal(inlinePass.stats.localQuotesMatched, 1);

  const inlineFail = await verifyDraft('[BLS 2024: "2024,3.0"](us-unemployment.csv#L3)', { rootDir: examplesDir });
  assert.equal(inlineFail.ok, false);
  assert.deepEqual(inlineFail.errors.map(e => e.code), ['LOCAL_QUOTE_MISMATCH']);
});

test('verify-citations checks quantitative prose and avoids false positives', async () => {
  const validProse = await verifyDraft('The rate rose by 0.4 percentage points, from 3.6% in 2023 to 4.0% in 2024 ([BLS](https://www.bls.gov/cps)).');
  assert.equal(validProse.ok, true, JSON.stringify(validProse.errors));

  const examplesDir = fileURLToPath(new URL('../examples/', import.meta.url));
  const exampleText = await readFile(new URL('../examples/us-unemployment.md', import.meta.url), 'utf8');
  const exampleRes = await verifyDraft(exampleText, { rootDir: examplesDir, requireLocalQuote: true });
  assert.equal(exampleRes.ok, true, JSON.stringify(exampleRes.errors));

  for (const [text, expectedCode] of [
    ['The rate fell from 3.6% in 2023 to 4.0% in 2024 ([BLS](https://www.bls.gov/cps)).', 'DIRECTION_CONTRADICTS_FIGURES'],
    ['The rate rose from 4.8% to 4.2% ([BLS](https://www.bls.gov/cps)).', 'DIRECTION_CONTRADICTS_FIGURES'],
    ['The rate rose by 0.6 percentage points, from 3.6% to 4.0% ([BLS](https://www.bls.gov/cps)).', 'DELTA_ARITHMETIC_MISMATCH'],
    ['The rate decreased by 2.0%, from 6.0% to 4.0% ([BLS](https://www.bls.gov/cps)).', 'PERCENT_POINT_UNIT_CONFUSION']
  ]) {
    const res = await verifyDraft(text);
    assert.equal(res.ok, false, `Expected failure for: ${text}`);
    assert.deepEqual(res.errors.map(e => e.code), [expectedCode]);
  }

  for (const safeText of [
    'Did the rate fall from 3.6% to 4.0%? ([BLS](https://www.bls.gov/cps))',
    'Critics falsely claimed the rate fell from 3.6% to 4.0% ([BLS](https://www.bls.gov/cps)).',
    'Completion fell by 5% from 100% to 95% ([BLS](https://www.bls.gov/cps)).'
  ]) {
    const res = await verifyDraft(safeText);
    assert.equal(res.ok, true, `Unexpected error for "${safeText}": ${JSON.stringify(res.errors)}`);
  }
});

test('verify-citations performs deep APA 7 and placeholder URL checks', async () => {
  const malformedRef = await verifyDraft([
    'Study findings (Lyon, 2014).',
    '',
    '## References',
    '',
    'Lyon, A. Review without a year. *Journal*. https://doi.org/10.1000/1'
  ].join('\n'), { apa: true });
  assert.equal(malformedRef.ok, false);
  assert.ok(malformedRef.errors.some(e => e.code === 'MALFORMED_REFERENCE_ENTRY'));

  const orphanTwoAuthor = await verifyDraft([
    'Previous work (Lyon & Patel, 2014) showed this.',
    '',
    '## References',
    '',
    'Lyon, A., & Smith, B. (2014). Review. *Journal*. https://doi.org/10.1000/1'
  ].join('\n'), { apa: true });
  assert.equal(orphanTwoAuthor.ok, false);
  assert.ok(orphanTwoAuthor.errors.some(e => e.code === 'ORPHAN_IN_TEXT_CITATION'));

  const hangingAndWarnings = await verifyDraft([
    'First claim (Lyon and Smith, 2014) and second claim (Lyon et al., 2014).',
    '',
    '## References',
    '',
    'Lyon, A., & Smith, B. (2014). Review. *Journal*.',
    '  https://doi.org/10.1000/1'
  ].join('\n'), { apa: true });
  assert.equal(hangingAndWarnings.ok, true, JSON.stringify(hangingAndWarnings.errors));
  const warnCodes = new Set(hangingAndWarnings.warnings.map(w => w.code));
  assert.ok(warnCodes.has('PARENTHETICAL_AND'));
  assert.ok(warnCodes.has('ET_AL_UNDER_THREE_AUTHORS'));

  for (const placeholderUrl of ['https://example.com/study', 'https://doi.org/10.xxxx/fake']) {
    const res = await verifyDraft(`See [Study](${placeholderUrl}).`);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.code === 'PLACEHOLDER_URL'));
  }
});

test('verify-citations handles Unicode/particle APA surnames, reversed first authors, and structural link warnings', async () => {
  const unicodeApa = await verifyDraft([
    'Åström (2020) and later work (van der Berg, 2020) confirmed the pattern.',
    '',
    '## References',
    '',
    'Åström, K. (2020). Nordic study. *Journal*. https://doi.org/10.1000/3',
    'van der Berg, L. (2020). Particle study. *Journal*. https://doi.org/10.1000/2'
  ].join('\n'), { apa: true });
  assert.equal(unicodeApa.ok, true, JSON.stringify(unicodeApa.errors));

  const unsortedApa = await verifyDraft([
    'Alpha (2020) and Zulu (2021) agree.',
    '',
    '## References',
    '',
    'Zulu, B. (2021). Second. *Journal*. https://doi.org/10.1000/5',
    'Alpha, A. (2020). First. *Journal*. https://doi.org/10.1000/4'
  ].join('\n'), { apa: true });
  assert.equal(unsortedApa.ok, true, JSON.stringify(unsortedApa.errors));
  assert.ok(unsortedApa.warnings.some(w => w.code === 'UNSORTED_REFERENCES'));

  const reversedFirst = await verifyDraft([
    'Prior work (Trepanowski & Varady, 2017) is cited.',
    '',
    '## References',
    '',
    'J. F. Trepanowski & K. A. Varady (2017). Trial. *JAMA*. https://doi.org/10.1001/test'
  ].join('\n'), { apa: true });
  assert.equal(reversedFirst.ok, false);
  assert.ok(reversedFirst.errors.some(e => e.code === 'REVERSED_AUTHOR_ORDER'));

  const missingRefs = await verifyDraft('Study findings (Smith, 2020).', { apa: true });
  assert.equal(missingRefs.ok, false);
  assert.ok(missingRefs.errors.some(e => e.code === 'MISSING_REFERENCES'));

  const bareHomepage = await verifyDraft('See [BIPM](https://www.bipm.org/).');
  assert.equal(bareHomepage.ok, true);
  assert.ok(bareHomepage.warnings.some(w => w.code === 'BARE_HOMEPAGE_LINK'));

  const emptyLink = await verifyDraft('See [Empty]().');
  assert.equal(emptyLink.ok, false);
  assert.ok(emptyLink.errors.some(e => e.code === 'BROKEN_MARKDOWN_LINK'));
});

test('verify-citations --check-urls handles 200, HEAD 405->GET 200 fallback, 404 DEAD_URL, and 403 warnings offline', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200);
      res.end();
    } else if (req.url === '/head-405') {
      res.writeHead(req.method === 'HEAD' ? 405 : 200);
      res.end();
    } else if (req.url === '/missing') {
      res.writeHead(404);
      res.end();
    } else if (req.url === '/blocked') {
      res.writeHead(403);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const goodRes = await verifyDraft(`See [OK](${base}/ok) and [Fallback](${base}/head-405).`, { checkUrls: true });
  assert.equal(goodRes.ok, true, JSON.stringify(goodRes.errors));
  assert.equal(goodRes.warnings.length, 0);

  const deadRes = await verifyDraft(`See [Missing](${base}/missing).`, { checkUrls: true });
  assert.equal(deadRes.ok, false);
  assert.deepEqual(deadRes.errors.map(e => e.code), ['DEAD_URL']);

  const blockedRes = await verifyDraft(`See [Blocked](${base}/blocked).`, { checkUrls: true });
  assert.equal(blockedRes.ok, true);
  assert.deepEqual(blockedRes.warnings.map(w => w.code), ['URL_BLOCKED_OR_TIMEOUT']);
});
