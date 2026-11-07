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

function refKey(ref: { owner?: string; repo?: string; number?: number }): string | undefined {
  if (!ref.owner || !ref.repo || ref.number === undefined) {
    return undefined;
  }
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

export function parseDependsOn(body: string | null): DependsOnRef[] {
  if (!body) {
    return [];
  }

  const lines = body.split(/\r?\n/);
  const result: DependsOnRef[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseLine(lines[i], i + 1);
    if (!parsed) {
      continue;
    }
    const key = refKey(parsed);
    if (key !== undefined) {
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
    }
    result.push(parsed);
  }

  return result;
}

export function addDependsOn(body: string | null, url: string): string {
  const current = body ?? '';
  const trimmedUrl = url.trim();
  const targetRef = parseTarget(trimmedUrl, 1);
  const targetKey = refKey(targetRef);
  const canonicalUrl = targetRef.url ?? trimmedUrl;

  const existing = parseDependsOn(current);
  for (const item of existing) {
    if (targetKey !== undefined && refKey(item) === targetKey) {
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
  const lines = current.split(/\r?\n/);
  const lastLine = lines[lines.length - 1];

  if (DEPENDS_ON_LINE_RE.test(lastLine) || lastLine.trim() === '') {
    return `${current}${eol}${newLine}`;
  }

  return `${current}${eol}${eol}${newLine}`;
}

export function removeDependsOn(
  body: string | null,
  ref: { owner: string; repo: string; number: number },
): string {
  const current = body ?? '';
  if (current.length === 0) {
    return '';
  }

  const targetKey = refKey(ref);
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current.split(eol);
  const kept: string[] = [];
  let removed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseLine(lines[i], i + 1);
    if (parsed && refKey(parsed) === targetKey) {
      removed = true;
      continue;
    }
    kept.push(lines[i]);
  }

  if (!removed) {
    return current;
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }

  return kept.join(eol);
}
