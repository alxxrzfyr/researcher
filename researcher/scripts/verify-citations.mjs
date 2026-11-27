import { open, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROXY_PATTERNS = [
  /vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\b/i,
  /https?:\/\/(?:www\.)?google\.com\/url\?/i,
  /https?:\/\/(?:www\.)?bing\.com\/ck\/a\b/i,
  /https?:\/\/r\.jina\.ai\//i
];

const SCRATCHPAD_PATTERNS = [
  /—\s*wait:\s*verify\b/i,
  /\bwait:\s*verify\b/i,
  /\bLet's check:/i,
  /\[TBD\]/i,
  /\[INSERT\b/i,
  /\bTODO:/
];

const PLACEHOLDER_URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?example\.(?:com|org|net)(?:\/|$)/i,
  /doi\.org\/10\.(?:xxxx|1234)\b/i
];

const YEAR_RE = '(?:(?:19|20)\\d{2}[a-z]?|n\\.d\\.)';
const MAX_LOCAL_FILE_BYTES = 1_048_576;
const USAGE = 'Usage: node verify-citations.mjs [filePath] [--apa] [--root <dir>] [--require-local-quote] [--check-urls]\n';

function proseWithoutCode(text) {
  const lines = [];
  const listIndents = [0];
  let fence = '';
  let inParagraph = false;
  for (const original of text.split(/\r?\n/)) {
    const line = original.replace(/^(?: {0,3}> ?)+/, '').replace(/^\t+/, tabs => '    '.repeat(tabs.length));
    if (line.trim()) {
      const indent = line.length - line.trimStart().length;
      while (listIndents.at(-1) > indent) listIndents.pop();
    }
    let content = line.slice(listIndents.at(-1));
    const item = /^ {0,3}(?:[-+*]|\d{1,9}[.)]) {1,4}(?=\S)/.exec(content);
    if (item && !fence) {
      listIndents.push(listIndents.at(-1) + item[0].length);
      content = content.slice(item[0].length);
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = '';
    } else if (marker) {
      fence = marker[1];
      inParagraph = false;
      lines.push('');
    } else if (inParagraph || !/^ {4}/.test(content)) {
      lines.push(line);
      inParagraph = Boolean(content.trim()) && !/^ {0,3}#{1,6}(?:\s|$)/.test(content);
    }
  }
  return lines.join('\n').replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '');
}

function extractMarkdownLinks(prose) {
  const links = [];
  const len = prose.length;
  for (let i = 0; i < len; i++) {
    if (prose[i] === '\\') {
      i++;
      continue;
    }
    if (prose[i] === '!' && prose[i + 1] === '[') {
      i++;
      continue;
    }
    if (prose[i] !== '[') continue;

    let depth = 1;
    let j = i + 1;
    let aborted = false;
    while (j < len && depth > 0) {
      if (prose[j] === '\\') {
        j += 2;
        continue;
      }
      if (prose[j] === '\n' && (prose[j + 1] === '\n' || (prose[j + 1] === '\r' && prose[j + 2] === '\n'))) {
        aborted = true;
        break;
      }
      if (prose[j] === '[') depth++;
      else if (prose[j] === ']') depth--;
      if (depth > 0) j++;
    }
    if (aborted || depth !== 0 || prose[j + 1] !== '(') continue;

    const label = prose.slice(i + 1, j);
    let k = j + 2;
    while (k < len && (prose[k] === ' ' || prose[k] === '\t')) k++;
    if (k >= len || prose[k] === '\n' || prose[k] === '\r') continue;

    let target = '';
    let closeIdx = -1;
    if (prose[k] === '<') {
      let t = k + 1;
      while (t < len && prose[t] !== '>' && prose[t] !== '\n' && prose[t] !== '\r') {
        if (prose[t] === '\\' && t + 1 < len) t += 2;
        else t++;
      }
      if (t >= len || prose[t] !== '>') continue;
      target = prose.slice(k + 1, t);
      let rest = t + 1;
      while (rest < len && (prose[rest] === ' ' || prose[rest] === '\t')) rest++;
      if (prose[rest] === ')') {
        closeIdx = rest;
      } else if (prose[rest] === '"' || prose[rest] === "'") {
        const quoteChar = prose[rest++];
        while (rest < len && prose[rest] !== quoteChar && prose[rest] !== '\n') {
          if (prose[rest] === '\\') rest += 2;
          else rest++;
        }
        if (prose[rest] === quoteChar) {
          rest++;
          while (rest < len && (prose[rest] === ' ' || prose[rest] === '\t')) rest++;
          if (prose[rest] === ')') closeIdx = rest;
        }
      }
    } else {
      let parenDepth = 0;
      let t = k;
      while (t < len) {
        const ch = prose[t];
        if (ch === '\\' && t + 1 < len) {
          t += 2;
          continue;
        }
        if (ch === '\n' || ch === '\r') break;
        if (ch === '(') {
          parenDepth++;
        } else if (ch === ')') {
          if (parenDepth === 0) {
            closeIdx = t;
            break;
          }
          parenDepth--;
        } else if (ch === ' ' || ch === '\t') {
          break;
        }
        t++;
      }
      target = prose.slice(k, t);
      if (closeIdx === -1 && (prose[t] === ' ' || prose[t] === '\t')) {
        let rest = t;
        while (rest < len && (prose[rest] === ' ' || prose[rest] === '\t')) rest++;
        if (prose[rest] === ')') {
          closeIdx = rest;
        } else if (prose[rest] === '"' || prose[rest] === "'") {
          const quoteChar = prose[rest++];
          while (rest < len && prose[rest] !== quoteChar && prose[rest] !== '\n') {
            if (prose[rest] === '\\') rest += 2;
            else rest++;
          }
          if (prose[rest] === quoteChar) {
            rest++;
            while (rest < len && (prose[rest] === ' ' || prose[rest] === '\t')) rest++;
            if (prose[rest] === ')') closeIdx = rest;
          }
        }
      }
    }

    if (closeIdx !== -1 && target.length > 0) {
      links.push({ label, target, start: i, end: closeIdx + 1 });
      i = closeIdx;
    }
  }
  return links;
}

function stripMarkdownLinksToLabels(prose) {
  const links = extractMarkdownLinks(prose);
  if (links.length === 0) return prose;
  let out = '';
  let cursor = 0;
  for (const link of links) {
    out += prose.slice(cursor, link.start) + link.label;
    cursor = link.end;
  }
  return out + prose.slice(cursor);
}

function extractBareUrls(prose) {
  const urls = [];
  for (const m of prose.matchAll(/https?:\/\/[^\s<>[\]]+/gi)) {
    let url = m[0].replace(/[.,;:!?]+$/, '');
    while (url.endsWith(')')) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        url = url.slice(0, -1).replace(/[.,;:!?]+$/, '');
      } else {
        break;
      }
    }
    if (url) urls.push(url);
  }
  return urls;
}

function parseDec(str) {
  const neg = str.startsWith('-');
  const [whole, frac = ''] = (neg ? str.slice(1) : str).split('.');
  return [BigInt((neg ? '-' : '') + whole + frac), 10n ** BigInt(frac.length)];
}

function cmpDec(a, b) {
  const diff = a[0] * b[1] - b[0] * a[1];
  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
}

function eqDec(a, b) {
  return cmpDec(a, b) === 0;
}

function absDiffDec(a, b) {
  const num = a[0] * b[1] - b[0] * a[1];
  return [num < 0n ? -num : num, a[1] * b[1]];
}

function formatDec(dec) {
  const [num, den] = dec;
  if (den === 1n) return num.toString();
  const digits = den.toString().length - 1;
  const s = num.toString().padStart(digits + 1, '0');
  const intPart = s.slice(0, -digits) || '0';
  const fracPart = s.slice(-digits).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function checkQuantitativeClaims(prose, addErr) {
  const plain = stripMarkdownLinksToLabels(prose);
  const sentences = plain.split(/(?<=[.!?])\s+|\n+/);
  const skipSentenceRe = /\b(?:not|never|no|neither|nor|whether|if|unless|claimed|claims|alleged|alleges|falsely|incorrectly|mistakenly|wrongly|erroneously|seem|seems|seemed|appear|appears|appeared|versus|vs\.?|while|whereas|although|though|however|but)\b|n['’]t\b|;/i;
  const fromToRe = /\bfrom\s+(\d+(?:\.\d+)?)%\s+(?:(?:in|during|for|at|as of)\s+[A-Za-z0-9–\-]+\s*,?\s*)?to\s+(\d+(?:\.\d+)?)%/gi;
  const upRe = /\b(?:rose|risen|rising|increased|increasing|climbed|grew|jumped|surged|up|increase|gain|rise|growth)\b/i;
  const downRe = /\b(?:fell|fallen|falling|decreased|decreasing|dropped|declined|declining|slipped|plunged|down|decrease|drop|decline|fall|reduction)\b/i;
  const ppRe = /\b(\d+(?:\.\d+)?)\s*(?:percentage[\s-]+points?\b|pp\b)/gi;
  const pctChangeRe = /\b(?:by|of)\s+(\d+(?:\.\d+)?)%(?!\s*(?:in|to)\b)/gi;

  for (const rawSent of sentences) {
    const sent = rawSent.trim();
    if (!sent || sent.endsWith('?') || skipSentenceRe.test(sent)) continue;

    const fromToMatches = [...sent.matchAll(fromToRe)];
    if (fromToMatches.length !== 1) continue;

    const fromVal = parseDec(fromToMatches[0][1]);
    const toVal = parseDec(fromToMatches[0][2]);
    const cmp = cmpDec(toVal, fromVal);
    const truePp = absDiffDec(toVal, fromVal);

    const hasUp = upRe.test(sent);
    const hasDown = downRe.test(sent);
    if (hasUp && !hasDown && cmp < 0) {
      addErr('DIRECTION_CONTRADICTS_FIGURES', `Prose states an increase while figures fall from ${fromToMatches[0][1]}% to ${fromToMatches[0][2]}%: ${sent}`);
    } else if (hasDown && !hasUp && cmp > 0) {
      addErr('DIRECTION_CONTRADICTS_FIGURES', `Prose states a decrease while figures rise from ${fromToMatches[0][1]}% to ${fromToMatches[0][2]}%: ${sent}`);
    }

    const ppMatches = [...sent.matchAll(ppRe)];
    if (ppMatches.length === 1) {
      const statedPp = parseDec(ppMatches[0][1]);
      if (!eqDec(statedPp, truePp)) {
        addErr('DELTA_ARITHMETIC_MISMATCH', `Stated ${ppMatches[0][1]} pp differs from |${fromToMatches[0][2]} - ${fromToMatches[0][1]}| = ${formatDec(truePp)} pp: ${sent}`);
      }
    } else if (ppMatches.length === 0 && cmp !== 0 && fromVal[0] !== 0n && !eqDec(fromVal, [100n, 1n])) {
      const pctMatches = [...sent.matchAll(pctChangeRe)];
      if (pctMatches.length === 1) {
        const statedPct = parseDec(pctMatches[0][1]);
        if (eqDec(statedPct, truePp)) {
          addErr('PERCENT_POINT_UNIT_CONFUSION', `Change of ${formatDec(truePp)} from ${fromToMatches[0][1]}% to ${fromToMatches[0][2]}% is percentage points (pp), not relative %: ${sent}`);
        }
      }
    }
  }
}

function normalizeAuthorKey(raw) {
  let s = raw
    .replace(/^(?:see\s+also|see|e\.g\.,|for\s+example,)\s+/i, '')
    .replace(/\s+et\s+al\.?/i, '')
    .replace(/\s+(?:and|&)\s+.+$/i, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[.,]+$/g, '')
    .trim();
  if (s.includes(',')) s = s.split(',')[0].trim();
  return s.toLowerCase();
}

function splitReferencesSection(text) {
  const lines = text.split(/\r?\n/);
  const headingIdx = lines.findIndex(l => /^(?:#{1,4}\s+References\b|\*\*References\*\*)/i.test(l.trim()));
  if (headingIdx === -1) return { body: text, refLines: [], hasRefSection: false };
  const body = lines.slice(0, headingIdx).join('\n');
  const refLines = [];
  const entryStartRe = new RegExp(`^.+?\\s*\\((?:${YEAR_RE})(?:,\\s*[^)]*)?\\)\\.`);
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (/^(?:#{1,4}\s+|---\s*$)/.test(trimmed)) break;
    if (trimmed.length === 0) continue;
    const isIndentedContinuation = /^\s{2,}\S/.test(raw) && refLines.length > 0 && !/^(?:[-*]|\d+[.)])\s+/.test(trimmed) && !entryStartRe.test(trimmed);
    if (isIndentedContinuation) {
      refLines[refLines.length - 1] += ' ' + trimmed;
    } else {
      refLines.push(trimmed.replace(/^(?:[-*]|\d+[.)])\s+/, ''));
    }
  }
  return { body, refLines, hasRefSection: true };
}

function parseReferenceEntries(refLines) {
  const entries = [];
  const malformed = [];
  const entryRe = new RegExp(`^(.+?)\\s*\\((${YEAR_RE})(?:,\\s*[^)]*)?\\)\\.`);
  for (const line of refLines) {
    const m = line.match(entryRe);
    if (!m) {
      malformed.push(line);
      continue;
    }
    const authorPart = m[1].trim();
    const year = m[2].toLowerCase();
    const keys = new Set();
    const abbrMatch = authorPart.match(/\[([A-Z0-9]{2,})\]/);
    if (abbrMatch) keys.add(abbrMatch[1].toLowerCase());
    const cleanAuthor = authorPart.replace(/\[[^\]]+\]/g, '').trim();
    let isGroup = false;
    let authorCount = 1;
    let surnames = [];

    if (cleanAuthor.includes(',')) {
      keys.add(cleanAuthor.split(',')[0].trim().toLowerCase());
      surnames = [...cleanAuthor.matchAll(/([\p{L}'’\-]+(?:\s+[\p{L}'’\-]+)*),\s*(?:[\p{Lu}]\.)/gu)].map(s => s[1].trim().toLowerCase());
      if (/\.\s*\.\s*\.|…|\bet\s+al\b/i.test(cleanAuthor)) {
        authorCount = 20;
      } else if (!/&/.test(cleanAuthor) && surnames.length <= 1) {
        authorCount = 1;
      } else if (/&/.test(cleanAuthor)) {
        const beforeAmp = cleanAuthor.split('&')[0];
        if (/^[^,]+,\s*(?:[A-Z]\.(?:-[A-Z]\.)?\s*)+,?\s*$/.test(beforeAmp.trim()) && surnames.length === 2) {
          authorCount = 2;
        } else {
          authorCount = Math.max(surnames.length, 3);
        }
      } else {
        authorCount = Math.max(surnames.length, 2);
      }
    } else if (/^[\p{Lu}]\.\s+(?:[\p{Lu}]\.\s+)?[\p{Lu}][\p{Ll}]{2,}/u.test(cleanAuthor)) {
      isGroup = false;
      keys.add(cleanAuthor.toLowerCase());
    } else {
      isGroup = true;
      const groupName = cleanAuthor.replace(/\.+$/, '').trim();
      keys.add(groupName.toLowerCase());
      const initials = groupName
        .split(/[\s\-]+/)
        .filter(w => /^[A-Z]/.test(w))
        .map(w => w[0].toLowerCase())
        .join('');
      if (initials.length >= 2) keys.add(initials);
    }
    entries.push({ line, authorPart, year, keys, isGroup, authorCount, surnames });
  }
  return { entries, malformed };
}

function extractInTextCitations(body, groupKeys) {
  const found = [];
  const parenGroupRe = /\(([^()]+)\)/g;
  for (const m of body.matchAll(parenGroupRe)) {
    const inner = m[1];
    if (!new RegExp(YEAR_RE).test(inner)) continue;
    for (const part of inner.split(';')) {
      let segment = part.trim();
      if (!segment) continue;
      const citedIn = segment.match(/\bas\s+cited\s+in\s+(.+)$/i);
      if (citedIn) segment = citedIn[1].trim();
      const cm = segment.match(new RegExp(`^((?:(?:see\\s+also|see|e\\.g\\.,|for\\s+example,)\\s+)?(?:(?:van|von|de|del|della|der|den|la|le|les|du|des|da|dos|das)\\s+)*[\\p{Lu}][\\p{L}0-9.'’\\-\\s&,\\[\\]]+?),\\s*(${YEAR_RE})(?:,\\s*[^)]+)?$`, 'u'));
      if (!cm) continue;
      const rawAuthor = cm[1].trim();
      if (/^(?:e\.g\.|i\.e\.|see|vs\.|about|approx\.|from|since|through|during|in|on|as\s+of|up|down|mean|median|range|table|figure)$/i.test(rawAuthor)) continue;
      const cleanAuthor = rawAuthor.replace(/^(?:see\s+also|see|e\.g\.,|for\s+example,)\s+/i, '').replace(/\[[^\]]+\]/g, '').replace(/[.,]+$/g, '').trim();
      const keys = new Set([cleanAuthor.toLowerCase(), normalizeAuthorKey(rawAuthor)]);
      const abbr = rawAuthor.match(/\[([A-Z0-9]{2,})\]/);
      if (abbr) keys.add(abbr[1].toLowerCase());
      const hasEtAl = /\bet\s+al\.?/i.test(rawAuthor);
      const isKnownGroup = groupKeys.has(cleanAuthor.toLowerCase());
      const twoMatch = !hasEtAl && !isKnownGroup ? /^([\p{L}'’\-]+)\s+(?:&|and)\s+([\p{L}'’\-]+)$/u.exec(cleanAuthor) : null;
      const parentheticalAnd = !hasEtAl && !isKnownGroup && /\s+and\s+/i.test(cleanAuthor);
      found.push({
        raw: segment,
        keys,
        year: cm[2].toLowerCase(),
        hasEtAl,
        parentheticalAnd,
        twoAuthors: twoMatch ? [twoMatch[1].toLowerCase(), twoMatch[2].toLowerCase()] : null
      });
    }
  }
  const narrativeRe = new RegExp(`(?<![\\p{L}\\p{N}_])((?:(?:van|von|de|del|della|der|den|la|le|les|du|des|da|dos|das)\\s+)*[\\p{Lu}][\\p{L}'’\\-]+(?:\\s+(?:(?:and|&|of|the|for|des|de|du|la|le|les|et|in|on|to|van|von|der|den|del|da)\\s+)*[\\p{Lu}][\\p{L}'’\\-]+|\\s+et\\s+al\\.){0,6})\\s*\\((${YEAR_RE})(?:,\\s*[^)]*)?\\)`, 'gu');
  for (const m of body.matchAll(narrativeRe)) {
    const rawAuthor = m[1].trim();
    if (/^(?:In|From|Since|As|By|For|Until|Through|Between|After|Before|During|January|February|March|April|May|June|July|August|September|October|November|December|Table|Figure|Section|Chapter|Box|Step)$/i.test(rawAuthor)) continue;
    const cleanAuthor = rawAuthor.replace(/\[[^\]]+\]/g, '').replace(/[.,]+$/g, '').trim();
    const keys = new Set([cleanAuthor.toLowerCase(), normalizeAuthorKey(rawAuthor)]);
    const hasEtAl = /\bet\s+al\.?/i.test(rawAuthor);
    const isKnownGroup = groupKeys.has(cleanAuthor.toLowerCase());
    const twoMatch = !hasEtAl && !isKnownGroup ? /^([\p{L}'’\-]+)\s+(?:&|and)\s+([\p{L}'’\-]+)$/u.exec(cleanAuthor) : null;
    found.push({
      raw: `${rawAuthor} (${m[2]})`,
      keys,
      year: m[2].toLowerCase(),
      hasEtAl,
      parentheticalAnd: false,
      twoAuthors: twoMatch ? [twoMatch[1].toLowerCase(), twoMatch[2].toLowerCase()] : null
    });
  }
  return found;
}

function localLinkPath(rootDir, target) {
  if (/^file:\/\//i.test(target)) {
    try { return fileURLToPath(target); } catch { return null; }
  }
  try { return resolve(rootDir, decodeURIComponent(target)); } catch { return resolve(rootDir, target); }
}

function outsideRoot(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

function extractQuotedExcerpt(label, allowInline) {
  const trimmed = label.trim();
  const whole = /^(?:"([^"\r\n]*)"|“([^“”\r\n]*)”)$/u.exec(trimmed);
  if (whole) return whole[1] ?? whole[2];
  if (!allowInline) return undefined;
  const inline = [...trimmed.matchAll(/["“]([^"”]+)["”]/gu)];
  return inline.length === 1 ? inline[0][1] : undefined;
}

async function checkLocalTarget(rootDir, filePath, range, quote, target) {
  const outside = { code: 'LOCAL_PASSAGE_OUTSIDE_ROOT', message: `Passage is outside the source root: ${target}` };
  if (!filePath) return { issue: { code: 'MISSING_LOCAL_FILE', message: `Local Markdown link does not exist: ${target}` } };
  if (outsideRoot(resolve(rootDir), filePath)) return { issue: outside };

  let realSource;
  try {
    const [realRoot, resolvedSource] = await Promise.all([realpath(rootDir), realpath(filePath)]);
    realSource = resolvedSource;
    if (outsideRoot(realRoot, realSource)) return { issue: outside };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return { issue: { code: 'MISSING_LOCAL_FILE', message: `Local Markdown link does not exist: ${target}` } };
    }
    return { issue: { code: 'UNREADABLE_LOCAL_PASSAGE', message: `Could not read the cited file: ${target}` } };
  }

  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2] ?? range[1]);
    const invalidRange = { code: 'INVALID_LOCAL_LINE_RANGE', message: `Line range does not exist: ${target}` };
    if (!Number.isSafeInteger(end) || start < 1 || end < start) return { issue: invalidRange };
    try {
      if (!(await stat(realSource)).isFile()) {
        return { issue: { code: 'UNREADABLE_LOCAL_PASSAGE', message: `Line citations require a text file: ${target}` } };
      }
      const file = await open(realSource, 'r');
      const selected = [];
      let lineNumber = 0;
      try {
        for await (const line of file.readLines()) {
          lineNumber++;
          if (quote !== undefined && lineNumber >= start) selected.push(line);
          if (lineNumber === end) break;
        }
      } finally {
        await file.close();
      }
      if (lineNumber < end) return { issue: invalidRange };
      if (quote !== undefined) {
        const wanted = quote.replace(/\s+/gu, ' ').trim();
        const passage = selected.join(' ').replace(/\s+/gu, ' ');
        if (!wanted || !passage.includes(wanted)) {
          return { issue: { code: 'LOCAL_QUOTE_MISMATCH', message: `Linked quotation differs from the cited lines: ${target}` } };
        }
        return { quoteMatched: true };
      }
      return { quoteMatched: false };
    } catch {
      return { issue: { code: 'UNREADABLE_LOCAL_PASSAGE', message: `Could not read the cited lines: ${target}` } };
    }
  }

  if (quote !== undefined) {
    try {
      const info = await stat(realSource);
      if (!info.isFile() || info.size > MAX_LOCAL_FILE_BYTES) {
        return { issue: { code: 'UNREADABLE_LOCAL_PASSAGE', message: `Quoted local file is unreadable or too large: ${target}` } };
      }
      const wholeText = (await readFile(realSource, 'utf8')).replace(/\s+/gu, ' ');
      const wanted = quote.replace(/\s+/gu, ' ').trim();
      if (!wanted || !wholeText.includes(wanted)) {
        return { issue: { code: 'LOCAL_QUOTE_MISMATCH', message: `Linked quotation differs from the cited file: ${target}` } };
      }
      return { quoteMatched: true };
    } catch {
      return { issue: { code: 'UNREADABLE_LOCAL_PASSAGE', message: `Could not read the cited file: ${target}` } };
    }
  }

  return { quoteMatched: false };
}

export async function verifyDraft(text, options = {}) {
  const { apa = false, rootDir, checkUrls = false, requireLocalQuote = false } = options;
  const errors = [];
  const warnings = [];
  const addErr = (code, message) => errors.push({ code, message });
  const addWarn = (code, message) => warnings.push({ code, message });

  const { body, refLines, hasRefSection } = splitReferencesSection(text);
  const isApa = apa || hasRefSection;
  const prose = proseWithoutCode(text);

  for (const re of PROXY_PATTERNS) {
    if (re.test(prose)) addErr('PROXY_URL', `Raw search-proxy or redirect wrapper URL detected (${re.source})`);
  }
  for (const re of SCRATCHPAD_PATTERNS) {
    if (re.test(prose)) addErr('LEAKED_SCRATCHPAD', `Internal draft/scratchpad text leaked into output (${re.source})`);
  }

  for (const line of prose.split(/\r?\n/)) {
    if (/\]\(\s*\)/.test(line)) addErr('BROKEN_MARKDOWN_LINK', 'Empty Markdown link target `]()`');
    if (/\]\(https?:\/\/[^\s)]*$/.test(line.trim())) addErr('BROKEN_MARKDOWN_LINK', `Unclosed Markdown link on line: ${line.trim()}`);
  }

  const mdLinks = extractMarkdownLinks(prose);
  const httpSet = new Set();
  const placeholderSeen = new Set();
  let localQuotesMatched = 0;

  for (const { label, target } of mdLinks) {
    if (/^https?:\/\//i.test(target)) {
      httpSet.add(target);
      try {
        const u = new URL(target);
        if ((u.pathname === '' || u.pathname === '/') && !u.search) {
          addWarn('BARE_HOMEPAGE_LINK', `Bare homepage link used instead of specific page: ${target}`);
        }
      } catch {
        addErr('BROKEN_MARKDOWN_LINK', `Malformed URL in Markdown link: ${target}`);
      }
    } else if (!target.startsWith('#') && !/^mailto:/i.test(target)) {
      const [path, fragment] = target.split(/#(.*)/s);
      const range = /^L(\d+)(?:-L(\d+))?$/.exec(fragment ?? '');
      const quote = extractQuotedExcerpt(label, Boolean(range));
      if (!rootDir) {
        if (range || quote !== undefined) addWarn('LOCAL_PASSAGE_UNCHECKED', `Pass --root to check the cited local source: ${target}`);
        continue;
      }
      const filePath = localLinkPath(rootDir, path);
      if (!filePath) {
        addErr('MISSING_LOCAL_FILE', `Local Markdown link does not exist: ${target}`);
        continue;
      }
      const checked = await checkLocalTarget(rootDir, filePath, range, quote, target);
      if (checked.issue) errors.push(checked.issue);
      else if (checked.quoteMatched) localQuotesMatched++;
    }
  }

  if (requireLocalQuote && !localQuotesMatched) {
    addErr('NO_VERIFIED_LOCAL_QUOTE', 'Supply --root and a double-quoted excerpt linked to its local source');
  }

  for (const bare of extractBareUrls(prose)) {
    httpSet.add(bare);
  }
  const httpLinks = [...httpSet];
  for (const url of httpLinks) {
    if (PLACEHOLDER_URL_PATTERNS.some(re => re.test(url)) && !placeholderSeen.has(url)) {
      placeholderSeen.add(url);
      addErr('PLACEHOLDER_URL', `Placeholder or fabricated example URL/DOI cited: ${url}`);
    }
  }

  checkQuantitativeClaims(prose, addErr);

  if (!isApa && text.trim().length >= 120 && mdLinks.length === 0) {
    addErr('NO_CITATIONS_IN_CHAT', 'Ordinary chat answer (>=120 chars) has zero clickable Markdown links');
  }

  let apaStats = { inTextCount: 0, referenceCount: 0 };
  if (isApa) {
    if (!hasRefSection || refLines.length === 0) {
      addErr('MISSING_REFERENCES', 'APA mode requested or detected, but no References entries found');
    } else {
      const { entries, malformed } = parseReferenceEntries(refLines);
      for (const badLine of malformed) {
        addErr('MALFORMED_REFERENCE_ENTRY', `References entry is missing valid APA author (year) structure: ${badLine}`);
      }
      const groupKeys = new Set();
      for (const e of entries) {
        if (e.isGroup) {
          for (const k of e.keys) groupKeys.add(k);
        }
      }
      const citations = extractInTextCitations(proseWithoutCode(body), groupKeys);
      apaStats = { inTextCount: citations.length, referenceCount: entries.length };

      for (const e of entries) {
        if (/https?:\/\/\S+\.$/.test(e.line)) {
          addErr('TRAILING_PERIOD_ON_URL', `Trailing period after URL/DOI in reference: ${e.line}`);
        }
        if (/\bet\s+al\.?/i.test(e.authorPart)) {
          addErr('REFERENCE_ET_AL', `APA 7 References must never use "et al."—list up to 20 authors, or first 19, ". . .", and the final author: ${e.authorPart}`);
        }
        if (/(?:^|[,&]\s+)[\p{Lu}]\.\s+(?:[\p{Lu}]\.\s+)?[\p{Lu}][\p{Ll}]{2,}/u.test(e.authorPart)) {
          addErr('REVERSED_AUTHOR_ORDER', `Non-APA author order (initials before surname) in: ${e.authorPart}`);
        }
      }

      const sortedKeys = entries.map(e => e.authorPart.toLowerCase());
      for (let i = 1; i < sortedKeys.length; i++) {
        if (sortedKeys[i] < sortedKeys[i - 1]) {
          addWarn('UNSORTED_REFERENCES', 'References list is not sorted alphabetically');
          break;
        }
      }

      const matchedEntries = new Set();
      for (const c of citations) {
        const matchIdx = entries.findIndex(e => {
          if (e.year !== c.year || ![...c.keys].some(k => e.keys.has(k))) return false;
          if (c.twoAuthors && !e.isGroup) {
            return e.authorCount === 2 && e.surnames[0] === c.twoAuthors[0] && e.surnames[1] === c.twoAuthors[1];
          }
          return true;
        });
        if (matchIdx === -1) {
          addErr('ORPHAN_IN_TEXT_CITATION', `In-text citation has no matching References entry: ${c.raw}`);
        } else {
          matchedEntries.add(matchIdx);
          const matched = entries[matchIdx];
          if (c.parentheticalAnd && !matched.isGroup) {
            addWarn('PARENTHETICAL_AND', `Use "&" instead of "and" in parenthetical citation: ${c.raw}`);
          }
          if (c.hasEtAl && !matched.isGroup && matched.authorCount < 3) {
            addWarn('ET_AL_UNDER_THREE_AUTHORS', `APA 7 uses "et al." only for three or more authors: ${c.raw}`);
          }
        }
      }
      entries.forEach((e, idx) => {
        if (!matchedEntries.has(idx)) {
          addErr('UNCITED_REFERENCE', `References entry is never cited in text: ${e.authorPart} (${e.year})`);
        }
      });
    }
  }

  if (checkUrls && httpLinks.length > 0) {
    const unique = [...new Set(httpLinks)];
    const headers = {
      Accept: 'text/html,application/xhtml+xml,*/*',
      'User-Agent': 'researcher-citation-verifier/1.0'
    };
    await Promise.all(unique.map(async url => {
      try {
        let res = await fetch(url, { method: 'HEAD', headers, redirect: 'follow', signal: AbortSignal.timeout(8000) });
        if ([400, 403, 405, 501].includes(res.status)) {
          await res.body?.cancel();
          res = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: AbortSignal.timeout(8000) });
        }
        await res.body?.cancel();
        if (res.status === 404 || res.status === 410) {
          addErr('DEAD_URL', `Cited URL returned HTTP ${res.status}: ${url}`);
        } else if (res.status >= 400) {
          addWarn('URL_BLOCKED_OR_TIMEOUT', `Cited URL returned HTTP ${res.status}: ${url}`);
        }
      } catch (err) {
        addWarn('URL_BLOCKED_OR_TIMEOUT', `Could not reach URL (${err.message}): ${url}`);
      }
    }));
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { markdownLinks: mdLinks.length, httpLinks: httpLinks.length, localQuotesMatched, ...apaStats }
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
  } else {
    let filePath = null;
    let apa = false;
    let rootDir;
    let checkUrls = false;
    let requireLocalQuote = false;
    let argumentError;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--apa') apa = true;
      else if (args[i] === '--check-urls') checkUrls = true;
      else if (args[i] === '--require-local-quote') requireLocalQuote = true;
      else if (args[i] === '--root' && args[i + 1] && !args[i + 1].startsWith('--')) rootDir = args[++i];
      else if (!args[i].startsWith('--') && !filePath) filePath = args[i];
      else {
        argumentError = args[i] === '--root' ? '--root requires a directory' : `Unexpected argument: ${args[i]}`;
        break;
      }
    }
    if (argumentError || (!filePath && process.stdin.isTTY)) {
      if (argumentError) process.stderr.write(argumentError + '\n');
      process.stderr.write(USAGE);
      process.exitCode = 1;
    } else {
      const text = filePath ? await readFile(filePath, 'utf8') : await new Promise(res => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', d => { buf += d; });
        process.stdin.on('end', () => res(buf));
      });
      const result = await verifyDraft(text, { apa, rootDir, checkUrls, requireLocalQuote });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!result.ok) process.exitCode = 1;
    }
  }
}
