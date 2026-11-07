import { type GheClient } from '../clients/gheClient';
import { type PullRequest, type SearchItem } from '../clients/gheTypes';
import { type ZuulClient } from '../clients/zuulClient';
import { type ChangeStatus } from '../clients/zuulTypes';
import { type DependsOnRef, parseDependsOn } from './dependsOnParser';

export const MAX_UPSTREAM_CONCURRENCY = 5;
export const MAX_CYCLE_DEPTH = 10;
export const MAX_CYCLE_FETCHES = 50;

export type UpstreamState = 'open' | 'merged' | 'closed' | 'missing';

export interface UpstreamDep {
  ref: DependsOnRef;
  pr?: PullRequest;
  state: UpstreamState;
  zuul?: ChangeStatus[];
  inTenant: boolean;
  warning?: string;
}

export interface SyncState {
  inSync: boolean;
  missingInZuul: string[];
  extraInZuul: string[];
}

export interface PrCoordinates {
  owner: string;
  repo: string;
  number: number;
  body?: string | null;
}

export type PrIdentifier = PullRequest | PrCoordinates;

export type GheDependsOnClient = Pick<GheClient, 'getPr' | 'searchPrs'>;
export type ZuulDependsOnClient = Pick<ZuulClient, 'getChangeStatus'> &
  Partial<Pick<ZuulClient, 'listProjects'>>;

export function normalizeProjectName(project: string): string {
  const parts = project
    .trim()
    .split('/')
    .filter((part) => part.length > 0);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return project.trim();
}

function formatPrRef(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

function formatPrRefKey(owner: string, repo: string, prNumber: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}`;
}

function isProjectInTenant(owner: string, repo: string, projects: ReadonlySet<string>): boolean {
  const target = `${owner}/${repo}`.toLowerCase();
  if (projects.has(`${owner}/${repo}`) || projects.has(target)) {
    return true;
  }
  for (const project of projects) {
    if (
      project.toLowerCase() === target ||
      normalizeProjectName(project).toLowerCase() === target
    ) {
      return true;
    }
  }
  return false;
}

function classifyPrState(pr: PullRequest): 'open' | 'merged' | 'closed' {
  if (pr.merged) {
    return 'merged';
  }
  if (pr.state === 'open') {
    return 'open';
  }
  return 'closed';
}

export function extractPrCoordinates(pr: PrIdentifier): PrCoordinates | undefined {
  if (
    'owner' in pr &&
    'repo' in pr &&
    typeof pr.owner === 'string' &&
    typeof pr.repo === 'string'
  ) {
    return {
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      body: pr.body,
    };
  }

  const pull = pr as PullRequest;
  const fullName = pull.base?.repo?.full_name || pull.head?.repo?.full_name;
  if (fullName) {
    const normalized = normalizeProjectName(fullName);
    const slashIdx = normalized.indexOf('/');
    if (slashIdx > 0 && slashIdx < normalized.length - 1) {
      return {
        owner: normalized.slice(0, slashIdx),
        repo: normalized.slice(slashIdx + 1),
        number: pull.number,
        body: pull.body,
      };
    }
  }

  if (pull.html_url) {
    const parsed = parseDependsOn(`Depends-On: ${pull.html_url}`)[0];
    if (parsed?.owner && parsed.repo && parsed.number !== undefined) {
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        body: pull.body,
      };
    }
  }

  return undefined;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const concurrency = Math.min(Math.max(1, limit), items.length);

  const runners = Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
  return results;
}

export function syncState(
  prOrUpstream: Pick<PullRequest, 'body'> | readonly UpstreamDep[],
  statuses: readonly ChangeStatus[],
  upstreamDeps?: readonly UpstreamDep[],
): SyncState {
  if (statuses.length === 0) {
    return {
      inSync: true,
      missingInZuul: [],
      extraInZuul: [],
    };
  }

  const bodyMap = new Map<string, string>();
  const resolvedUpstream = Array.isArray(prOrUpstream) ? prOrUpstream : upstreamDeps;

  if (resolvedUpstream) {
    for (const dep of resolvedUpstream) {
      if (dep.state !== 'open') {
        continue;
      }
      const { owner, repo, number: prNum } = dep.ref;
      if (!owner || !repo || prNum === undefined) {
        continue;
      }
      const key = formatPrRefKey(owner, repo, prNum);
      if (!bodyMap.has(key)) {
        bodyMap.set(key, formatPrRef(owner, repo, prNum));
      }
    }
  } else {
    const pr = prOrUpstream as Pick<PullRequest, 'body'>;
    const refs = parseDependsOn(pr.body);
    for (const ref of refs) {
      if (!ref.owner || !ref.repo || ref.number === undefined) {
        continue;
      }
      const key = formatPrRefKey(ref.owner, ref.repo, ref.number);
      if (!bodyMap.has(key)) {
        bodyMap.set(key, formatPrRef(ref.owner, ref.repo, ref.number));
      }
    }
  }

  const zuulMap = new Map<string, string>();
  for (const status of statuses) {
    for (const item of status.itemsAhead) {
      if (item.live !== false || item.change === undefined || !item.project) {
        continue;
      }
      const normalizedProject = normalizeProjectName(item.project);
      const slashIdx = normalizedProject.indexOf('/');
      if (slashIdx <= 0 || slashIdx === normalizedProject.length - 1) {
        continue;
      }
      const owner = normalizedProject.slice(0, slashIdx);
      const repo = normalizedProject.slice(slashIdx + 1);
      const key = formatPrRefKey(owner, repo, item.change);
      if (!zuulMap.has(key)) {
        zuulMap.set(key, formatPrRef(owner, repo, item.change));
      }
    }
  }

  const missingInZuul: string[] = [];
  for (const [key, display] of bodyMap) {
    if (!zuulMap.has(key)) {
      missingInZuul.push(display);
    }
  }

  const extraInZuul: string[] = [];
  for (const [key, display] of zuulMap) {
    if (!bodyMap.has(key)) {
      extraInZuul.push(display);
    }
  }

  return {
    inSync: missingInZuul.length === 0 && extraInZuul.length === 0,
    missingInZuul,
    extraInZuul,
  };
}

export class DependsOnService {
  private readonly ghe: GheDependsOnClient;
  private readonly zuul: ZuulDependsOnClient;
  private readonly tenant: string;
  private readonly tenantProjects: () => Promise<Set<string>>;

  constructor(
    ghe: GheDependsOnClient,
    zuul: ZuulDependsOnClient,
    tenant: string,
    tenantProjects?: () => Promise<Set<string>>,
  ) {
    this.ghe = ghe;
    this.zuul = zuul;
    this.tenant = tenant;
    this.tenantProjects =
      tenantProjects ??
      (async () => {
        if (!this.zuul.listProjects) {
          return new Set<string>();
        }
        const projects = await this.zuul.listProjects(this.tenant);
        const names = new Set<string>();
        for (const p of projects) {
          names.add(p.name);
          if (p.canonical_name) {
            names.add(normalizeProjectName(p.canonical_name));
          }
        }
        return names;
      });
  }

  async getUpstream(pr: Pick<PullRequest, 'body'>): Promise<UpstreamDep[]> {
    const parsedRefs = parseDependsOn(pr.body).filter(
      (ref): ref is DependsOnRef & { owner: string; repo: string; number: number } =>
        Boolean(ref.owner && ref.repo && ref.number !== undefined),
    );
    if (parsedRefs.length === 0) {
      return [];
    }

    const projects = await this.tenantProjects();

    return mapWithConcurrency(parsedRefs, MAX_UPSTREAM_CONCURRENCY, async (ref) => {
      const inTenant = isProjectInTenant(ref.owner, ref.repo, projects);
      let warning: string | undefined;
      if (ref.kind === 'shorthand') {
        warning = `Zuul ignores \`${ref.owner}/${ref.repo}#${ref.number}\` — use the full URL`;
      } else if (!inTenant) {
        warning = `Repository is not part of tenant ${this.tenant}`;
      }

      try {
        const upstreamPr = await this.ghe.getPr(ref.owner, ref.repo, ref.number);
        const state = classifyPrState(upstreamPr);
        let zuulStatuses: ChangeStatus[] | undefined;

        if (inTenant && upstreamPr.head?.sha) {
          try {
            zuulStatuses = await this.zuul.getChangeStatus(
              this.tenant,
              upstreamPr.number,
              upstreamPr.head.sha,
            );
          } catch {
            zuulStatuses = undefined;
          }
        }

        const dep: UpstreamDep = {
          ref,
          pr: upstreamPr,
          state,
          inTenant,
        };
        if (zuulStatuses !== undefined) {
          dep.zuul = zuulStatuses;
        }
        if (warning !== undefined) {
          dep.warning = warning;
        }
        return dep;
      } catch {
        const dep: UpstreamDep = {
          ref,
          state: 'missing',
          inTenant,
        };
        if (warning !== undefined) {
          dep.warning = warning;
        }
        return dep;
      }
    });
  }

  async getDownstream(pr: Pick<PullRequest, 'number' | 'html_url'>): Promise<SearchItem[]> {
    const query = `"${pr.html_url}" in:body is:open`;
    const items = await this.ghe.searchPrs(query);
    const selfUrl = pr.html_url.replace(/\/+$/, '').toLowerCase();

    return items.filter((item) => {
      if (item.html_url && selfUrl) {
        return item.html_url.replace(/\/+$/, '').toLowerCase() !== selfUrl;
      }
      return item.number !== pr.number;
    });
  }

  syncState(
    prOrUpstream: Pick<PullRequest, 'body'> | readonly UpstreamDep[],
    statuses: readonly ChangeStatus[],
    upstreamDeps?: readonly UpstreamDep[],
  ): SyncState {
    return syncState(prOrUpstream, statuses, upstreamDeps);
  }

  async wouldCreateCycle(fromPr: PrIdentifier, targetPr: PrIdentifier): Promise<boolean> {
    const fromCoords = extractPrCoordinates(fromPr);
    const targetCoords = extractPrCoordinates(targetPr);
    if (!fromCoords || !targetCoords) {
      return false;
    }

    const fromKey = formatPrRefKey(fromCoords.owner, fromCoords.repo, fromCoords.number);
    const targetKey = formatPrRefKey(targetCoords.owner, targetCoords.repo, targetCoords.number);
    if (fromKey === targetKey) {
      return true;
    }

    const minDepthByKey = new Map<string, number>([[targetKey, 0]]);
    const bodyCache = new Map<string, string | null>();
    if (targetCoords.body !== undefined) {
      bodyCache.set(targetKey, targetCoords.body);
    }
    let fetchedCount = 0;

    const dfs = async (current: PrCoordinates, depth: number): Promise<boolean> => {
      if (depth >= MAX_CYCLE_DEPTH) {
        return false;
      }

      const currentKey = formatPrRefKey(current.owner, current.repo, current.number);
      let body: string | null | undefined = bodyCache.get(currentKey);

      if (body === undefined && !bodyCache.has(currentKey)) {
        if (fetchedCount >= MAX_CYCLE_FETCHES) {
          return false;
        }
        fetchedCount += 1;
        try {
          const pr = await this.ghe.getPr(current.owner, current.repo, current.number);
          body = pr.body;
          bodyCache.set(currentKey, body);
        } catch {
          bodyCache.set(currentKey, null);
          return false;
        }
      }

      const refs = parseDependsOn(body ?? null);
      for (const ref of refs) {
        if (!ref.owner || !ref.repo || ref.number === undefined) {
          continue;
        }
        const nextKey = formatPrRefKey(ref.owner, ref.repo, ref.number);
        if (nextKey === fromKey) {
          return true;
        }

        const nextDepth = depth + 1;
        if (nextDepth >= MAX_CYCLE_DEPTH) {
          continue;
        }

        const prevDepth = minDepthByKey.get(nextKey);
        if (prevDepth !== undefined && prevDepth <= nextDepth) {
          continue;
        }
        minDepthByKey.set(nextKey, nextDepth);

        const reached = await dfs(
          { owner: ref.owner, repo: ref.repo, number: ref.number },
          nextDepth,
        );
        if (reached) {
          return true;
        }
      }

      return false;
    };

    return dfs(targetCoords, 0);
  }
}
