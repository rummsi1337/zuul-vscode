import * as vscode from 'vscode';
import { type SearchItem } from '../clients/gheTypes';
import { readWorkspaceSettings } from '../config/settings';
import { getGitApi } from '../git/gitApi';
import { computeGitContext, type GitContext } from '../git/gitContext';
import { normalizeHost } from '../git/remoteUrl';
import {
  buildSectionedQuickPickItems,
  buildTenantProjectSet,
  type CandidateRow,
  type DependsOnCandidate,
  parsePrUrlCandidate,
  searchItemToCandidate,
} from '../services/dependsOnCandidates';
import { formatPrRef, prRefKey, toPrUrl } from '../services/dependsOnParser';
import { applyAddDependsOn, DependsOnService, isInTenant } from '../services/dependsOnService';
import { type PrSnapshot, type ZuulContextSource } from '../services/prTracker';
import { NO_PR_MESSAGE } from '../services/triggerService';
import { type Logger } from '../util/logger';

export const SEARCH_DEBOUNCE_MS = 300;
export const CYCLE_ERROR_MESSAGE = 'Would create a dependency cycle';

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

function coerceDirectCandidate(arg: unknown): DependsOnCandidate | undefined {
  if (typeof arg === 'string') {
    return parsePrUrlCandidate(arg);
  }
  if (arg && typeof arg === 'object') {
    const url = (arg as { url?: unknown }).url;
    if (typeof url === 'string') {
      return parsePrUrlCandidate(url);
    }
  }
  return undefined;
}

function toVscodeItems(rows: readonly CandidateRow[]): DependsOnQuickPickItem[] {
  return rows.map((row) =>
    row.separator
      ? { label: row.label, kind: vscode.QuickPickItemKind.Separator }
      : (row as DependsOnQuickPickItem),
  );
}

async function promptForCandidate(params: {
  selfKey: string;
  loadBaseSections: () => Promise<{
    myPrs: DependsOnCandidate[];
    workspacePrs: DependsOnCandidate[];
  }>;
  searchOpenPrs: (query: string) => Promise<DependsOnCandidate[]>;
}): Promise<DependsOnCandidate | undefined> {
  const qp = vscode.window.createQuickPick<DependsOnQuickPickItem>();

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
      qp.items = toVscodeItems(
        buildSectionedQuickPickItems({ myPrs, workspacePrs, searchPrs, pastedCandidate }),
      );
    };

    qp.title = 'Add Depends-On';
    qp.placeholder = 'Select an open PR, search, or paste a PR URL (https://.../pull/123)';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.busy = true;

    qp.onDidChangeValue((value) => {
      clearDebounce();
      const trimmed = value.trim();
      const parsedUrl = parsePrUrlCandidate(trimmed);
      pastedCandidate = parsedUrl && prRefKey(parsedUrl) !== params.selfKey ? parsedUrl : undefined;

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
      const fromValue = parsePrUrlCandidate(qp.value);
      if (fromValue) {
        finish(fromValue);
        return;
      }
      const selected = qp.selectedItems[0] ?? qp.activeItems[0];
      const candidate = selected?.candidate;
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
    void vscode.window.showInformationMessage(NO_PR_MESSAGE);
    return false;
  }

  const zuul = currentCtx.zuul;
  if (!zuul) {
    const message = 'Zuul is not available, so a Depends-On cannot be added right now.';
    options.logger.warn(`[DependsOn] ${message}`);
    void vscode.window.showErrorMessage(message);
    return false;
  }

  const selfKey = prRefKey({
    owner: currentCtx.owner,
    repo: currentCtx.repo,
    number: snapshot.pr.number,
  });

  let tenantProjectsPromise: Promise<Set<string>> | undefined;
  const getTenantProjects = (): Promise<Set<string>> => {
    if (!tenantProjectsPromise) {
      tenantProjectsPromise = (async () => {
        try {
          const projects = await zuul.client.listProjects(zuul.tenant);
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
      const candidate = searchItemToCandidate(item);
      if (!candidate) {
        continue;
      }
      const key = prRefKey(candidate);
      if (seen.has(key)) {
        continue;
      }
      if (filterTenant && !isInTenant(candidate.owner, candidate.repo, filterTenant)) {
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
      if (normalizeHost(gitCtx.host) !== normalizeHost(currentCtx.host)) {
        continue;
      }
      const repoKey = `${gitCtx.owner.toLowerCase()}/${gitCtx.repo.toLowerCase()}`;
      if (seenRepos.has(repoKey)) {
        continue;
      }
      if (!isInTenant(gitCtx.owner, gitCtx.repo, tenantProjects)) {
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
    coerceDirectCandidate(options.targetArg) ??
    (await promptForCandidate({
      selfKey,
      loadBaseSections,
      searchOpenPrs,
    }));

  if (!candidate) {
    return false;
  }

  const tenantProjects = await getTenantProjects();
  const sameHost = normalizeHost(candidate.host) === normalizeHost(currentCtx.host);
  if (!sameHost || !isInTenant(candidate.owner, candidate.repo, tenantProjects)) {
    const message = `Repository ${candidate.owner}/${candidate.repo} is not part of tenant ${zuul.tenant}`;
    options.logger.warn(`[DependsOn] ${message}`);
    void vscode.window.showErrorMessage(message);
    return false;
  }

  const service = new DependsOnService(
    currentCtx.ghe,
    zuul.client,
    zuul.tenant,
    async () => tenantProjects,
  );

  const createsCycle = await service.wouldCreateCycle(
    {
      owner: currentCtx.owner,
      repo: currentCtx.repo,
      number: snapshot.pr.number,
    },
    {
      owner: candidate.owner,
      repo: candidate.repo,
      number: candidate.number,
    },
  );

  if (createsCycle) {
    options.logger.warn(`[DependsOn] Rejected ${formatPrRef(candidate)}: ${CYCLE_ERROR_MESSAGE}`);
    void vscode.window.showErrorMessage(CYCLE_ERROR_MESSAGE);
    return false;
  }

  const canonicalUrl = toPrUrl(currentCtx.host, candidate.owner, candidate.repo, candidate.number);
  const changed = await applyAddDependsOn(
    currentCtx.ghe,
    { owner: currentCtx.owner, repo: currentCtx.repo, number: snapshot.pr.number },
    canonicalUrl,
  );

  const prLabel = formatPrRef({
    owner: currentCtx.owner,
    repo: currentCtx.repo,
    number: snapshot.pr.number,
  });
  if (changed) {
    options.logger.info(`[DependsOn] Added Depends-On ${canonicalUrl} on ${prLabel}`);
  } else {
    options.logger.warn(
      `[DependsOn] Depends-On ${canonicalUrl} was not added on ${prLabel}: the body did not change`,
    );
  }

  options.onUpdated?.();
  await options.tracker.refresh();
  return true;
}
