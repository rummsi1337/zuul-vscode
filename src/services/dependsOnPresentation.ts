import { type SearchItem } from '../clients/gheTypes';
import { type ChangeStatus } from '../clients/zuulTypes';
import { classifyJobResult, pickPrimary } from './buildsModel';
import { searchItemToCandidate } from './dependsOnCandidates';
import { formatPrRef, toPrUrl } from './dependsOnParser';
import { type UpstreamDep, type UpstreamState } from './dependsOnService';

export function getUpstreamIconId(state: UpstreamState): string {
  switch (state) {
    case 'open':
      return 'git-pull-request';
    case 'merged':
      return 'git-merge';
    case 'closed':
      return 'git-pull-request-closed';
    case 'missing':
      return 'warning';
  }
}

export function formatUpstreamLabel(dep: UpstreamDep): string {
  if (dep.ref.owner && dep.ref.repo && dep.ref.number !== undefined) {
    return formatPrRef({ owner: dep.ref.owner, repo: dep.ref.repo, number: dep.ref.number });
  }
  return dep.ref.raw;
}

export function formatUpstreamZuulSummary(zuul: readonly ChangeStatus[] | undefined): string {
  if (!zuul || zuul.length === 0) {
    return 'not in Zuul';
  }

  const status = pickPrimary(zuul, (st) => st.pipeline);
  if (!status) {
    return 'not in Zuul';
  }

  const pipeline = status.pipeline || 'check';
  const jobs = status.jobs ?? [];
  if (jobs.length === 0) {
    return `${pipeline}: queued`;
  }

  let doneCount = 0;
  for (const job of jobs) {
    const trimmed = job.result?.trim();
    if (trimmed) {
      doneCount += 1;
      if (classifyJobResult(trimmed) === 'failure') {
        return `${pipeline}: FAILURE`;
      }
    }
  }

  if (doneCount === jobs.length) {
    return `${pipeline}: SUCCESS`;
  }

  return `${pipeline}: ${doneCount}/${jobs.length}`;
}

export function formatUpstreamDescription(dep: UpstreamDep): string {
  return `${dep.state} · ${formatUpstreamZuulSummary(dep.zuul)}`;
}

export function formatUpstreamTooltip(dep: UpstreamDep): string {
  const lines: string[] = [];
  const label = formatUpstreamLabel(dep);
  if (dep.pr?.title) {
    lines.push(`${label}: ${dep.pr.title}`);
  } else {
    lines.push(label);
  }
  lines.push(`State: ${dep.state}`);
  lines.push(`Zuul: ${formatUpstreamZuulSummary(dep.zuul)}`);
  if (dep.warning) {
    lines.push(`Warning: ${dep.warning}`);
  }
  return lines.join('\n');
}

export function resolveUpstreamUrl(dep: UpstreamDep, fallbackHost?: string): string | undefined {
  if (dep.pr?.html_url) {
    return dep.pr.html_url;
  }
  if (dep.ref.url) {
    return dep.ref.url;
  }
  const host = dep.ref.host ?? fallbackHost;
  if (host && dep.ref.owner && dep.ref.repo && dep.ref.number !== undefined) {
    return toPrUrl(host, dep.ref.owner, dep.ref.repo, dep.ref.number);
  }
  return undefined;
}

export function formatDownstreamLabel(item: SearchItem, fallbackHost = 'github.com'): string {
  const candidate = searchItemToCandidate(item, fallbackHost);
  if (candidate) {
    return formatPrRef(candidate);
  }
  return `#${item.number}`;
}

export function extractRemovalCoordinates(
  target: unknown,
): { owner: string; repo: string; number: number } | undefined {
  if (!target || typeof target !== 'object') {
    return undefined;
  }
  const obj = target as Record<string, unknown>;
  if (obj.kind === 'upstream-dep' && obj.dep && typeof obj.dep === 'object') {
    return extractRemovalCoordinates(obj.dep);
  }
  if (obj.ref && typeof obj.ref === 'object') {
    return extractRemovalCoordinates(obj.ref);
  }
  if (
    typeof obj.owner === 'string' &&
    typeof obj.repo === 'string' &&
    typeof obj.number === 'number'
  ) {
    return {
      owner: obj.owner,
      repo: obj.repo,
      number: obj.number,
    };
  }
  return undefined;
}
