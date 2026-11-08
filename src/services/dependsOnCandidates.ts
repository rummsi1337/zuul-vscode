import { type SearchItem } from '../clients/gheTypes';
import { type ZuulProject } from '../clients/zuulTypes';
import { formatPrRef, parseDependsOn, toPrUrl } from './dependsOnParser';
import { normalizeProjectName } from './dependsOnService';

export const HTTP_PR_URL_RE =
  /^https?:\/\/([^/?#\s]+)\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)(?:\/(?:files\/?)?)?(?:#\S*)?$/i;

export interface DependsOnCandidate {
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  title?: string;
}

export interface CandidateRow {
  label: string;
  description?: string;
  detail?: string;
  alwaysShow?: boolean;
  candidate?: DependsOnCandidate;
  separator?: true;
}

export function parsePrUrlCandidate(input: string): DependsOnCandidate | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = parseDependsOn(`Depends-On: ${trimmed}`)[0];
  if (parsed?.kind === 'url' && parsed.host && parsed.owner && parsed.repo && parsed.number) {
    return {
      host: parsed.host,
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      url: toPrUrl(parsed.host, parsed.owner, parsed.repo, parsed.number),
    };
  }

  const match = HTTP_PR_URL_RE.exec(trimmed);
  if (!match) {
    return undefined;
  }

  const [, rawHost, owner, repo, numStr] = match;
  const prNumber = Number(numStr);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return undefined;
  }
  const host = rawHost.toLowerCase();

  return {
    host,
    owner,
    repo,
    number: prNumber,
    url: toPrUrl(host, owner, repo, prNumber),
  };
}

export function searchItemToCandidate(item: SearchItem): DependsOnCandidate | undefined {
  if (item.html_url) {
    const fromHtml = parsePrUrlCandidate(item.html_url);
    if (fromHtml) {
      return {
        ...fromHtml,
        title: item.title,
      };
    }
  }

  return undefined;
}

export function buildTenantProjectSet(
  projects: readonly ZuulProject[],
  currentProject?: string,
): Set<string> {
  const set = new Set<string>();
  if (currentProject) {
    set.add(normalizeProjectName(currentProject).toLowerCase());
  }
  for (const project of projects) {
    set.add(normalizeProjectName(project.name).toLowerCase());
    if (project.canonical_name) {
      set.add(normalizeProjectName(project.canonical_name).toLowerCase());
    }
  }
  return set;
}

export function toQuickPickItem(candidate: DependsOnCandidate, alwaysShow = false): CandidateRow {
  const ref = formatPrRef(candidate);
  return {
    label: ref,
    description: candidate.title ?? candidate.url,
    detail: candidate.title ? candidate.url : undefined,
    alwaysShow,
    candidate,
  };
}

function section(label: string): CandidateRow {
  return { label, separator: true };
}

export function buildSectionedQuickPickItems(params: {
  myPrs: readonly DependsOnCandidate[];
  workspacePrs: readonly DependsOnCandidate[];
  searchPrs?: readonly DependsOnCandidate[];
  pastedCandidate?: DependsOnCandidate;
}): CandidateRow[] {
  const items: CandidateRow[] = [];

  if (params.pastedCandidate) {
    items.push(section('Pasted URL'));
    items.push({
      label: `$(link) ${formatPrRef(params.pastedCandidate)}`,
      description: params.pastedCandidate.url,
      alwaysShow: true,
      candidate: params.pastedCandidate,
    });
  }

  if (params.searchPrs && params.searchPrs.length > 0) {
    items.push(section('Search results'));
    for (const candidate of params.searchPrs) {
      items.push(toQuickPickItem(candidate, true));
    }
  }

  if (params.myPrs.length > 0) {
    items.push(section('My open PRs'));
    for (const candidate of params.myPrs) {
      items.push(toQuickPickItem(candidate, false));
    }
  }

  if (params.workspacePrs.length > 0) {
    items.push(section('Workspace repositories'));
    for (const candidate of params.workspacePrs) {
      items.push(toQuickPickItem(candidate, false));
    }
  }

  return items;
}
