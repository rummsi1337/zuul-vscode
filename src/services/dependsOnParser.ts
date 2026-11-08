export interface DependsOnRef {
  raw: string;
  line: number;
  kind: 'url' | 'shorthand' | 'unknown';
  host?: string;
  owner?: string;
  repo?: string;
  number?: number;
  url?: string;
}

const DEPENDS_ON_LINE_RE = /^\s*depends-on:\s*(\S+)\s*$/i;
const PR_URL_RE =
  /^https:\/\/([^/?#\s]+)\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)(?:\/(?:files\/?)?)?(?:#\S*)?$/;
const SHORTHAND_RE = /^([^/?#:\s]+)\/([^/?#:\s]+)#([1-9]\d*)$/;

export function toPrUrl(host: string, owner: string, repo: string, n: number): string {
  return `https://${host.toLowerCase()}/${owner}/${repo}/pull/${n}`;
}

function parseTarget(raw: string, line: number): DependsOnRef {
  const urlMatch = PR_URL_RE.exec(raw);
  if (urlMatch) {
    const [, rawHost, owner, repo, numStr] = urlMatch;
    const host = rawHost.toLowerCase();
    const prNumber = Number(numStr);
    if (
      owner !== '.' &&
      owner !== '..' &&
      repo !== '.' &&
      repo !== '..' &&
      Number.isSafeInteger(prNumber) &&
      prNumber > 0
    ) {
      return {
        raw,
        line,
        kind: 'url',
        host,
        owner,
        repo,
        number: prNumber,
        url: toPrUrl(host, owner, repo, prNumber),
      };
    }
  }

  const shorthandMatch = SHORTHAND_RE.exec(raw);
  if (shorthandMatch) {
    const [, owner, repo, numStr] = shorthandMatch;
    const prNumber = Number(numStr);
    if (
      owner !== '.' &&
      owner !== '..' &&
      repo !== '.' &&
      repo !== '..' &&
      Number.isSafeInteger(prNumber) &&
      prNumber > 0
    ) {
      return {
        raw,
        line,
        kind: 'shorthand',
        owner,
        repo,
        number: prNumber,
      };
    }
  }

  return {
    raw,
    line,
    kind: 'unknown',
  };
}

function parseLine(lineText: string, lineNumber: number): DependsOnRef | undefined {
  const match = DEPENDS_ON_LINE_RE.exec(lineText);
  if (!match) {
    return undefined;
  }
  return parseTarget(match[1], lineNumber);
}

export function formatPrRef(ref: { owner: string; repo: string; number: number }): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function prRefKey(ref: { owner: string; repo: string; number: number }): string;
export function prRefKey(ref: {
  owner?: string;
  repo?: string;
  number?: number;
}): string | undefined;
export function prRefKey(ref: {
  owner?: string;
  repo?: string;
  number?: number;
}): string | undefined {
  if (!ref.owner || !ref.repo || ref.number === undefined) {
    return undefined;
  }
  return formatPrRef({ owner: ref.owner, repo: ref.repo, number: ref.number }).toLowerCase();
}

export function parseDependsOn(body: string | null): DependsOnRef[] {
  if (!body) {
    return [];
  }

  const lines = body.split(/\r?\n/);
  const result: DependsOnRef[] = [];
  const seenWithHost = new Set<string>();
  const seenCoordinates = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseLine(lines[i], i + 1);
    if (!parsed) {
      continue;
    }
    const key = prRefKey(parsed);
    if (key !== undefined) {
      // A hostless shorthand collapses onto any earlier ref with the same coordinates;
      // a URL only onto an earlier ref on the same host.
      const duplicate = parsed.host
        ? seenWithHost.has(`${parsed.host}|${key}`)
        : seenCoordinates.has(key);
      if (duplicate) {
        continue;
      }
      seenCoordinates.add(key);
      if (parsed.host) {
        seenWithHost.add(`${parsed.host}|${key}`);
      }
    }
    result.push(parsed);
  }

  return result;
}

const TRAILING_EOL_RE = /(\r\n|\n)$/;

export function addDependsOn(body: string | null, url: string): string {
  const current = body ?? '';
  const trimmedUrl = url.trim();
  const targetRef = parseTarget(trimmedUrl, 1);
  const targetKey = prRefKey(targetRef);
  const canonicalUrl = targetRef.url ?? trimmedUrl;

  const existing = parseDependsOn(current);
  for (const item of existing) {
    if (
      targetKey !== undefined &&
      prRefKey(item) === targetKey &&
      sameHostOrUnknown(item.host, targetRef.host)
    ) {
      return current;
    }
    if (item.raw === trimmedUrl || item.raw === canonicalUrl) {
      return current;
    }
  }

  const newLine = `Depends-On: ${canonicalUrl}`;
  if (current.length === 0) {
    return newLine;
  }

  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const trailing = TRAILING_EOL_RE.exec(current)?.[1] ?? '';
  const core = trailing ? current.slice(0, current.length - trailing.length) : current;
  const lines = core.split(/\r?\n/);
  const lastLine = lines[lines.length - 1];

  if (DEPENDS_ON_LINE_RE.test(lastLine) || lastLine.trim() === '') {
    return `${core}${eol}${newLine}${trailing}`;
  }

  return `${core}${eol}${eol}${newLine}${trailing}`;
}

interface BodyLine {
  text: string;
  eol: string;
}

function sameHostOrUnknown(a: string | undefined, b: string | undefined): boolean {
  return !a || !b || a.toLowerCase() === b.toLowerCase();
}

/** `host`, when given, keeps lines for the same PR number on another host untouched. */
export function removeDependsOn(
  body: string | null,
  ref: { owner: string; repo: string; number: number; host?: string },
): string {
  const current = body ?? '';
  if (current.length === 0) {
    return '';
  }

  const targetKey = prRefKey(ref);
  const parts = current.split(/(\r\n|\n)/);
  const lines: BodyLine[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push({ text: parts[i], eol: parts[i + 1] ?? '' });
  }
  // Splitting "a\n" leaves a phantom empty last line; it only records the trailing ending.
  const last = lines[lines.length - 1];
  const finalEol = last.text === '' && lines.length > 1 ? lines[lines.length - 2].eol : '';
  if (finalEol) {
    lines.pop();
  }

  const kept: BodyLine[] = [];
  let removed = false;
  let removedAfterContent = false;
  for (const line of lines) {
    const parsed = parseLine(line.text, 1);
    if (parsed && prRefKey(parsed) === targetKey && sameHostOrUnknown(parsed.host, ref.host)) {
      removed = true;
      removedAfterContent = true;
      continue;
    }
    if (line.text.trim() !== '') {
      removedAfterContent = false;
    }
    kept.push(line);
  }

  if (!removed) {
    return current;
  }

  // Blank lines are dropped only when the removal left them dangling at the end.
  if (removedAfterContent) {
    while (kept.length > 0 && kept[kept.length - 1].text.trim() === '') {
      kept.pop();
    }
  }

  if (kept.length === 0) {
    return '';
  }

  kept[kept.length - 1] = { text: kept[kept.length - 1].text, eol: finalEol };
  return kept.map((line) => line.text + line.eol).join('');
}
