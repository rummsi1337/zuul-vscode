import * as vscode from 'vscode';
import { type SearchItem } from '../clients/gheTypes';
import { type ZuulProject } from '../clients/zuulTypes';
import { readWorkspaceSettings } from '../config/settings';
import { getGitApi } from '../git/gitApi';
import { computeGitContext, type GitContext } from '../git/gitContext';
import { addDependsOn, parseDependsOn, toPrUrl } from '../services/dependsOnParser';
import { DependsOnService, normalizeProjectName } from '../services/dependsOnService';
import { type PrSnapshot, type ZuulContextSource } from '../services/prTracker';
import { type Logger } from '../util/logger';

export const SEARCH_DEBOUNCE_MS = 300;
export const CYCLE_ERROR_MESSAGE = 'Would create a dependency cycle';

const initialShowQuickPick = vscode.window.showQuickPick;

const HTTP_PR_URL_RE =
  /^https?:\/\/([^/?#\s]+)\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)(?:\/(?:files\/?)?)?(?:#\S*)?$/i;
const REPO_URL_RE = /\/repos\/([^/?#\s]+)\/([^/?#\s]+)\/?$/;

export interface DependsOnCandidate {
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  title?: string;
}

export interface DependsOnQuickPickItem extends vscode.QuickPickItem {
  readonly candidate?: DependsOnCandidate;
}

export interface AddDependsOnTrackerSource {
  readonly snapshot: PrSnapshot | undefined;
  refresh(): Promise<void>;
}

export interface AddDependsOnOptions {
  ctx: ZuulContextSource;
  tracker: AddDependsOnTrackerSource;
  logger: Logger;
  getWorkspaceContexts?: () => Promise<GitContext[]>;
  onUpdated?: () => void;
  targetArg?: unknown;
}

export function parsePrUrlCandidate(
  input: string,
  fallbackHost?: string,
): DependsOnCandidate | undefined {
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
  const host = (fallbackHost?.trim() || rawHost).toLowerCase();

  return {
    host,
    owner,
    repo,
    number: prNumber,
    url: toPrUrl(host, owner, repo, prNumber),
  };
}

export function searchItemToCandidate(
  item: SearchItem,
  defaultHost: string,
): DependsOnCandidate | undefined {
  if (item.html_url) {
    const fromHtml = parsePrUrlCandidate(item.html_url, defaultHost);
    if (fromHtml) {
      return {
        ...fromHtml,
        title: item.title,
      };
    }
  }

  if (item.repository_url) {
    const repoMatch = REPO_URL_RE.exec(item.repository_url);
    if (repoMatch) {
      const [, owner, repo] = repoMatch;
      const host = defaultHost.toLowerCase();
      return {
        host,
        owner,
        repo,
        number: item.number,
        url: toPrUrl(host, owner, repo, item.number),
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
    set.add(currentProject);
    set.add(currentProject.toLowerCase());
    set.add(normalizeProjectName(currentProject).toLowerCase());
  }
  for (const project of projects) {
    set.add(project.name);
    set.add(project.name.toLowerCase());
    set.add(normalizeProjectName(project.name).toLowerCase());
    if (project.canonical_name) {
      const normalized = normalizeProjectName(project.canonical_name);
      set.add(normalized);
      set.add(normalized.toLowerCase());
    }
  }
  return set;
}

export function isCandidateInTenant(
  candidate: Pick<DependsOnCandidate, 'owner' | 'repo'>,
  tenantProjects: ReadonlySet<string>,
): boolean {
  const full = `${candidate.owner}/${candidate.repo}`;
  const lower = full.toLowerCase();
  if (tenantProjects.has(full) || tenantProjects.has(lower)) {
    return true;
  }
  for (const entry of tenantProjects) {
    if (entry.toLowerCase() === lower || normalizeProjectName(entry).toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}

function candidateKey(candidate: Pick<DependsOnCandidate, 'owner' | 'repo' | 'number'>): string {
  return `${candidate.owner.toLowerCase()}/${candidate.repo.toLowerCase()}#${candidate.number}`;
}

function toQuickPickItem(
  candidate: DependsOnCandidate,
  alwaysShow = false,
): DependsOnQuickPickItem {
  const ref = `${candidate.owner}/${candidate.repo}#${candidate.number}`;
  return {
    label: ref,
    description: candidate.title ?? candidate.url,
    detail: candidate.title ? candidate.url : undefined,
    alwaysShow,
    candidate,
  };
}

function makeSeparator(label: string): DependsOnQuickPickItem {
  const separatorKind =
    (vscode as unknown as { QuickPickItemKind?: { Separator?: number } }).QuickPickItemKind
      ?.Separator ?? -1;
  return {
    label,
    kind: separatorKind as vscode.QuickPickItemKind,
  };
}

async function defaultGetWorkspaceContexts(): Promise<GitContext[]> {
  try {
    const api = await getGitApi();
    if (!api) {
      return [];
    }
    const hostOverride = readWorkspaceSettings().gheHost;
    const contexts: GitContext[] = [];
    for (const repo of api.repositories) {
      const computed = computeGitContext(repo, hostOverride);
      if (computed) {
        contexts.push(computed);
      }
    }
    return contexts;
  } catch {
    return [];
  }
}

function coerceDirectCandidate(arg: unknown, defaultHost: string): DependsOnCandidate | undefined {
  if (typeof arg === 'string') {
    return parsePrUrlCandidate(arg, defaultHost);
  }
  if (arg && typeof arg === 'object') {
    const obj = arg as Record<string, unknown>;
    if (typeof obj.candidate === 'object' && obj.candidate !== null) {
      return coerceDirectCandidate(obj.candidate, defaultHost);
    }
    if (
      typeof obj.owner === 'string' &&
      typeof obj.repo === 'string' &&
      typeof obj.number === 'number'
    ) {
      const host = typeof obj.host === 'string' && obj.host.trim() ? obj.host.trim() : defaultHost;
      return {
        host: host.toLowerCase(),
        owner: obj.owner,
        repo: obj.repo,
        number: obj.number,
        url: toPrUrl(host, obj.owner, obj.repo, obj.number),
        title: typeof obj.title === 'string' ? obj.title : undefined,
      };
    }
    if (typeof obj.url === 'string') {
      return parsePrUrlCandidate(obj.url, defaultHost);
    }
    if (typeof obj.detail === 'string') {
      const fromDetail = parsePrUrlCandidate(obj.detail, defaultHost);
      if (fromDetail) {
        return fromDetail;
      }
    }
    if (typeof obj.description === 'string') {
      const fromDesc = parsePrUrlCandidate(obj.description, defaultHost);
      if (fromDesc) {
        return fromDesc;
      }
    }
    if (typeof obj.label === 'string') {
      return parsePrUrlCandidate(obj.label, defaultHost);
    }
  }
  return undefined;
}

export function buildSectionedQuickPickItems(params: {
  myPrs: readonly DependsOnCandidate[];
  workspacePrs: readonly DependsOnCandidate[];
  searchPrs?: readonly DependsOnCandidate[];
  pastedCandidate?: DependsOnCandidate;
}): DependsOnQuickPickItem[] {
  const items: DependsOnQuickPickItem[] = [];

  if (params.pastedCandidate) {
    items.push(makeSeparator('Pasted URL'));
    items.push({
      label: `$(link) ${params.pastedCandidate.owner}/${params.pastedCandidate.repo}#${params.pastedCandidate.number}`,
      description: params.pastedCandidate.url,
      alwaysShow: true,
      candidate: params.pastedCandidate,
    });
  }

  if (params.searchPrs && params.searchPrs.length > 0) {
    items.push(makeSeparator('Search results'));
    for (const candidate of params.searchPrs) {
      items.push(toQuickPickItem(candidate, true));
    }
  }

  if (params.myPrs.length > 0) {
    items.push(makeSeparator('My open PRs'));
    for (const candidate of params.myPrs) {
      items.push(toQuickPickItem(candidate, false));
    }
  }

  if (params.workspacePrs.length > 0) {
    items.push(makeSeparator('Workspace repositories'));
    for (const candidate of params.workspacePrs) {
      items.push(toQuickPickItem(candidate, false));
    }
  }

  return items;
}

async function promptForCandidate(params: {
  host: string;
  selfKey: string;
  loadBaseSections: () => Promise<{
    myPrs: DependsOnCandidate[];
    workspacePrs: DependsOnCandidate[];
  }>;
  searchOpenPrs: (query: string) => Promise<DependsOnCandidate[]>;
}): Promise<DependsOnCandidate | undefined> {
  const showQuickPickOverridden = vscode.window.showQuickPick !== initialShowQuickPick;
  const createQuickPickFn = (
    vscode.window as unknown as {
      createQuickPick?: <T extends vscode.QuickPickItem>() => vscode.QuickPick<T>;
    }
  ).createQuickPick;

  if (showQuickPickOverridden || typeof createQuickPickFn !== 'function') {
    const sections = await params.loadBaseSections();
    const items = buildSectionedQuickPickItems(sections);
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an open pull request or paste a PR URL',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return coerceDirectCandidate(picked, params.host);
  }

  const qp = createQuickPickFn<DependsOnQuickPickItem>();
  if (!qp) {
    const sections = await params.loadBaseSections();
    const items = buildSectionedQuickPickItems(sections);
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an open pull request or paste a PR URL',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return coerceDirectCandidate(picked, params.host);
  }

  return new Promise<DependsOnCandidate | undefined>((resolve) => {
    let settled = false;
    let myPrs: DependsOnCandidate[] = [];
    let workspacePrs: DependsOnCandidate[] = [];
    let searchPrs: DependsOnCandidate[] = [];
    let pastedCandidate: DependsOnCandidate | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let searchSeq = 0;

    const clearDebounce = (): void => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
    };

    const finish = (result: DependsOnCandidate | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearDebounce();
      qp.dispose();
      resolve(result);
    };

    const refreshItems = (): void => {
      if (settled) {
        return;
      }
      qp.items = buildSectionedQuickPickItems({
        myPrs,
        workspacePrs,
        searchPrs,
        pastedCandidate,
      });
    };

    qp.title = 'Add Depends-On';
    qp.placeholder = 'Select an open PR, search, or paste a PR URL (https://.../pull/123)';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.busy = true;

    qp.onDidChangeValue((value) => {
      clearDebounce();
      const trimmed = value.trim();
      const parsedUrl = parsePrUrlCandidate(trimmed, params.host);
      pastedCandidate =
        parsedUrl && candidateKey(parsedUrl) !== params.selfKey ? parsedUrl : undefined;

      if (!trimmed) {
        searchSeq += 1;
        searchPrs = [];
        qp.busy = false;
        refreshItems();
        return;
      }

      refreshItems();

      const seq = ++searchSeq;
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (settled || seq !== searchSeq) {
          return;
        }
        qp.busy = true;
        void params
          .searchOpenPrs(trimmed)
          .then((results) => {
            if (settled || seq !== searchSeq) {
              return;
            }
            searchPrs = results;
            qp.busy = false;
            refreshItems();
          })
          .catch(() => {
            if (settled || seq !== searchSeq) {
              return;
            }
            qp.busy = false;
          });
      }, SEARCH_DEBOUNCE_MS);
    });

    qp.onDidAccept(() => {
      const fromValue = parsePrUrlCandidate(qp.value ?? '', params.host);
      if (fromValue) {
        finish(fromValue);
        return;
      }
      const selected = qp.selectedItems?.[0] ?? qp.activeItems?.[0];
      const candidate = coerceDirectCandidate(selected, params.host);
      if (candidate) {
        finish(candidate);
      }
    });

    qp.onDidHide(() => {
      finish(undefined);
    });

    qp.show();

    void params
      .loadBaseSections()
      .then((sections) => {
        if (settled) {
          return;
        }
        myPrs = sections.myPrs;
        workspacePrs = sections.workspacePrs;
        qp.busy = false;
        refreshItems();
      })
      .catch(() => {
        if (settled) {
          return;
        }
        qp.busy = false;
      });
  });
}

export async function pickAndAddDependsOn(options: AddDependsOnOptions): Promise<boolean> {
  const currentCtx = options.ctx.current;
  const snapshot = options.tracker.snapshot;
  if (!currentCtx || !snapshot) {
    options.logger.warn('[DependsOn] Cannot add Depends-On: no active pull request');
    return false;
  }

  const selfKey = candidateKey({
    owner: currentCtx.owner,
    repo: currentCtx.repo,
    number: snapshot.pr.number,
  });

  let tenantProjectsPromise: Promise<Set<string>> | undefined;
  const getTenantProjects = (): Promise<Set<string>> => {
    if (!tenantProjectsPromise) {
      tenantProjectsPromise = (async () => {
        try {
          const projects = await currentCtx.zuul.listProjects(currentCtx.tenant);
          return buildTenantProjectSet(projects, currentCtx.project);
        } catch (err) {
          options.logger.error('[DependsOn] Failed to list tenant projects', err);
          return buildTenantProjectSet([], currentCtx.project);
        }
      })();
    }
    return tenantProjectsPromise;
  };

  const toCandidates = (
    items: readonly SearchItem[],
    filterTenant?: ReadonlySet<string>,
  ): DependsOnCandidate[] => {
    const seen = new Set<string>([selfKey]);
    const list: DependsOnCandidate[] = [];
    for (const item of items) {
      const candidate = searchItemToCandidate(item, currentCtx.host);
      if (!candidate) {
        continue;
      }
      const key = candidateKey(candidate);
      if (seen.has(key)) {
        continue;
      }
      if (filterTenant && !isCandidateInTenant(candidate, filterTenant)) {
        continue;
      }
      seen.add(key);
      list.push(candidate);
    }
    return list;
  };

  const loadBaseSections = async (): Promise<{
    myPrs: DependsOnCandidate[];
    workspacePrs: DependsOnCandidate[];
  }> => {
    const getWorkspaceContexts = options.getWorkspaceContexts ?? defaultGetWorkspaceContexts;
    const [tenantProjects, mySearchItems, workspaceContexts] = await Promise.all([
      getTenantProjects(),
      currentCtx.ghe.searchPrs('is:open author:@me').catch(() => [] as SearchItem[]),
      getWorkspaceContexts(),
    ]);

    const myPrs = toCandidates(mySearchItems, tenantProjects);

    const currentRepoKey = `${currentCtx.owner.toLowerCase()}/${currentCtx.repo.toLowerCase()}`;
    const otherRepos: { owner: string; repo: string }[] = [];
    const seenRepos = new Set<string>([currentRepoKey]);

    for (const gitCtx of workspaceContexts) {
      if (gitCtx.host.toLowerCase() !== currentCtx.host.toLowerCase()) {
        continue;
      }
      const repoKey = `${gitCtx.owner.toLowerCase()}/${gitCtx.repo.toLowerCase()}`;
      if (seenRepos.has(repoKey)) {
        continue;
      }
      if (!isCandidateInTenant({ owner: gitCtx.owner, repo: gitCtx.repo }, tenantProjects)) {
        continue;
      }
      seenRepos.add(repoKey);
      otherRepos.push({ owner: gitCtx.owner, repo: gitCtx.repo });
    }

    const workspaceSearchLists = await Promise.all(
      otherRepos.map((r) =>
        currentCtx.ghe
          .searchPrs(`repo:${r.owner}/${r.repo} is:open`)
          .catch(() => [] as SearchItem[]),
      ),
    );
    const workspacePrs = toCandidates(workspaceSearchLists.flat(), tenantProjects);

    return { myPrs, workspacePrs };
  };

  const searchOpenPrs = async (query: string): Promise<DependsOnCandidate[]> => {
    const items = await currentCtx.ghe.searchPrs(`${query} is:open`);
    return toCandidates(items);
  };

  const candidate =
    coerceDirectCandidate(options.targetArg, currentCtx.host) ??
    (await promptForCandidate({
      host: currentCtx.host,
      selfKey,
      loadBaseSections,
      searchOpenPrs,
    }));

  if (!candidate) {
    return false;
  }

  const tenantProjects = await getTenantProjects();
  const sameHost = candidate.host.toLowerCase() === currentCtx.host.toLowerCase();
  if (!sameHost || !isCandidateInTenant(candidate, tenantProjects)) {
    const message = `Repository ${candidate.owner}/${candidate.repo} is not part of tenant ${currentCtx.tenant}`;
    options.logger.warn(`[DependsOn] ${message}`);
    void vscode.window.showErrorMessage(message);
    return false;
  }

  const service = new DependsOnService(
    currentCtx.ghe,
    currentCtx.zuul,
    currentCtx.tenant,
    async () => tenantProjects,
  );

  const createsCycle = await service.wouldCreateCycle(
    {
      owner: currentCtx.owner,
      repo: currentCtx.repo,
      number: snapshot.pr.number,
      body: snapshot.pr.body,
    },
    {
      owner: candidate.owner,
      repo: candidate.repo,
      number: candidate.number,
    },
  );

  if (createsCycle) {
    options.logger.warn(
      `[DependsOn] Rejected ${candidate.owner}/${candidate.repo}#${candidate.number}: ${CYCLE_ERROR_MESSAGE}`,
    );
    void vscode.window.showErrorMessage(CYCLE_ERROR_MESSAGE);
    return false;
  }

  const freshPr = await currentCtx.ghe.getPr(currentCtx.owner, currentCtx.repo, snapshot.pr.number);
  const canonicalUrl = toPrUrl(currentCtx.host, candidate.owner, candidate.repo, candidate.number);
  const nextBody = addDependsOn(freshPr.body, canonicalUrl);

  await currentCtx.ghe.updatePrBody(
    currentCtx.owner,
    currentCtx.repo,
    snapshot.pr.number,
    nextBody,
  );

  options.logger.info(
    `[DependsOn] Added Depends-On ${canonicalUrl} on ${currentCtx.owner}/${currentCtx.repo}#${snapshot.pr.number}`,
  );

  options.onUpdated?.();
  await options.tracker.refresh();
  return true;
}
