export interface ParsedRemoteUrl {
  host: string;
  owner: string;
  repo: string;
}

const SCP_REMOTE_RE = /^git@([^:/?#\s]+):([^/?#\s]+)\/([^/?#\s]+?)\/?$/;
const URL_REMOTE_RE =
  /^(?:ssh|https?):\/\/(?:[^@/?#\s]+@)?([^:/?#\s]+)(?::(\d+))?\/([^/?#\s]+)\/([^/?#\s]+?)\/?$/;

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function normalizeParts(
  rawHost: string,
  owner: string,
  rawRepo: string,
): ParsedRemoteUrl | undefined {
  const host = normalizeHost(rawHost);
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  if (
    !host ||
    !owner ||
    !repo ||
    owner === '.' ||
    owner === '..' ||
    repo === '.' ||
    repo === '..'
  ) {
    return undefined;
  }
  return { host, owner, repo };
}

export function parseRemoteUrl(url: string): ParsedRemoteUrl | undefined {
  const scpMatch = SCP_REMOTE_RE.exec(url);
  if (scpMatch) {
    const [, rawHost, owner, rawRepo] = scpMatch;
    return normalizeParts(rawHost, owner, rawRepo);
  }

  const urlMatch = URL_REMOTE_RE.exec(url);
  if (urlMatch) {
    const [, rawHost, port, owner, rawRepo] = urlMatch;
    if (port !== undefined) {
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return undefined;
      }
    }
    return normalizeParts(rawHost, owner, rawRepo);
  }

  return undefined;
}
