import { describe, expect, it, vi } from 'vitest';
import { type PullRequest, type SearchItem } from '../../src/clients/gheTypes';
import { type ChangeStatus, type QueuedRef } from '../../src/clients/zuulTypes';
import {
  applyAddDependsOn,
  applyRemoveDependsOn,
  DependsOnService,
  extractPrCoordinates,
  MAX_CYCLE_FETCHES,
  normalizeProjectName,
  syncState,
  type UpstreamDep,
} from '../../src/services/dependsOnService';

function makePr(
  overrides: Partial<PullRequest> & {
    owner?: string;
    repo?: string;
    number?: number;
  } = {},
): PullRequest {
  const owner = overrides.owner ?? 'org';
  const repo = overrides.repo ?? 'repo';
  const num = overrides.number ?? 1;
  const fullName = `${owner}/${repo}`;

  return {
    number: num,
    html_url: overrides.html_url ?? `https://ghe.example.com/${fullName}/pull/${num}`,
    title: overrides.title ?? `PR #${num}`,
    state: overrides.state ?? 'open',
    draft: overrides.draft ?? false,
    merged: overrides.merged ?? false,
    body: overrides.body !== undefined ? overrides.body : null,
    head: overrides.head ?? {
      sha: `sha-${num}`,
      ref: `branch-${num}`,
      repo: { full_name: fullName },
    },
    base: overrides.base ?? {
      ref: 'main',
      repo: { full_name: fullName },
    },
    user: overrides.user ?? { login: 'dev' },
    labels: overrides.labels ?? [],
  };
}

function makeStatus(overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  return {
    pipeline: overrides.pipeline ?? 'check',
    queue: overrides.queue ?? 'shared',
    live: overrides.live ?? true,
    jobs: overrides.jobs ?? [],
    itemsAhead: overrides.itemsAhead ?? [],
  };
}

describe('normalizeProjectName & extractPrCoordinates', () => {
  it('normalizes project names with host prefixes to owner/repo', () => {
    expect(normalizeProjectName('ghe.example.com/org/repo')).toBe('org/repo');
    expect(normalizeProjectName('org/repo')).toBe('org/repo');
    expect(normalizeProjectName('single')).toBe('single');
  });

  it('extracts coordinates from PullRequest base repo or coordinate object', () => {
    expect(extractPrCoordinates({ owner: 'org', repo: 'repo', number: 12 })).toEqual({
      owner: 'org',
      repo: 'repo',
      number: 12,
      body: undefined,
    });

    expect(extractPrCoordinates(makePr({ owner: 'team', repo: 'service', number: 55 }))).toEqual({
      owner: 'team',
      repo: 'service',
      number: 55,
      body: null,
    });

    const noBaseRepoName = {
      ...makePr({ number: 55 }),
      base: { ref: 'main', repo: { full_name: '' } },
    };
    expect(extractPrCoordinates(noBaseRepoName)).toBeUndefined();
  });
});

describe('DependsOnService.getUpstream', () => {
  it('returns empty array without fetching tenant projects when body has no valid refs', async () => {
    const ghe = { getPr: vi.fn(), searchPrs: vi.fn() };
    const zuul = { getChangeStatus: vi.fn() };
    const tenantProjects = vi.fn().mockResolvedValue(new Set(['org/repo']));
    const service = new DependsOnService(ghe, zuul, 'main-tenant', tenantProjects);

    const res = await service.getUpstream(makePr({ body: 'Depends-On: invalid-target' }));
    expect(res).toEqual([]);
    expect(tenantProjects).not.toHaveBeenCalled();
    expect(ghe.getPr).not.toHaveBeenCalled();
  });

  it('enriches open, merged, closed, and missing upstream PRs with warnings and Zuul status', async () => {
    const body = [
      'Depends-On: https://ghe.example.com/org/open-repo/pull/10',
      'Depends-On: https://ghe.example.com/org/merged-repo/pull/20',
      'Depends-On: https://ghe.example.com/org/closed-repo/pull/30',
      'Depends-On: https://ghe.example.com/org/missing-repo/pull/40',
      'Depends-On: org/open-repo#50',
      'Depends-On: https://ghe.example.com/external/untracked/pull/60',
    ].join('\n');

    const pr10 = makePr({ owner: 'org', repo: 'open-repo', number: 10, state: 'open' });
    const pr20 = makePr({
      owner: 'org',
      repo: 'merged-repo',
      number: 20,
      state: 'closed',
      merged: true,
    });
    const pr30 = makePr({
      owner: 'org',
      repo: 'closed-repo',
      number: 30,
      state: 'closed',
      merged: false,
    });
    const pr50 = makePr({ owner: 'org', repo: 'open-repo', number: 50, state: 'open' });
    const pr60 = makePr({ owner: 'external', repo: 'untracked', number: 60, state: 'open' });

    const ghe = {
      getPr: vi.fn(async (owner: string, repo: string, num: number) => {
        if (num === 10) return pr10;
        if (num === 20) return pr20;
        if (num === 30) return pr30;
        if (num === 50) return pr50;
        if (num === 60) return pr60;
        throw new Error(`404 Not Found: ${owner}/${repo}#${num}`);
      }),
      searchPrs: vi.fn(),
    };

    const status10 = [makeStatus({ pipeline: 'check' })];
    const zuul = {
      getChangeStatus: vi.fn(async (_tenant: string, prNum: number | string) => {
        if (prNum === 10) return status10;
        return [];
      }),
    };

    const tenantProjects = vi
      .fn()
      .mockResolvedValue(
        new Set(['org/open-repo', 'org/merged-repo', 'org/closed-repo', 'org/missing-repo']),
      );

    const service = new DependsOnService(ghe, zuul, 'corp-tenant', tenantProjects);
    const upstream = await service.getUpstream(makePr({ body }));

    expect(upstream).toHaveLength(6);

    expect(upstream[0]).toEqual({
      ref: expect.objectContaining({ owner: 'org', repo: 'open-repo', number: 10, kind: 'url' }),
      pr: pr10,
      state: 'open',
      zuul: status10,
      inTenant: true,
    });

    expect(upstream[1]).toEqual({
      ref: expect.objectContaining({ owner: 'org', repo: 'merged-repo', number: 20, kind: 'url' }),
      pr: pr20,
      state: 'merged',
      zuul: [],
      inTenant: true,
    });

    expect(upstream[2]).toEqual({
      ref: expect.objectContaining({ owner: 'org', repo: 'closed-repo', number: 30, kind: 'url' }),
      pr: pr30,
      state: 'closed',
      zuul: [],
      inTenant: true,
    });

    expect(upstream[3]).toEqual({
      ref: expect.objectContaining({ owner: 'org', repo: 'missing-repo', number: 40, kind: 'url' }),
      state: 'missing',
      inTenant: true,
    });

    expect(upstream[4]).toEqual({
      ref: expect.objectContaining({
        owner: 'org',
        repo: 'open-repo',
        number: 50,
        kind: 'shorthand',
      }),
      pr: pr50,
      state: 'open',
      zuul: [],
      inTenant: true,
      warning: 'Zuul ignores `org/open-repo#50` — use the full URL',
    });

    expect(upstream[5]).toEqual({
      ref: expect.objectContaining({
        owner: 'external',
        repo: 'untracked',
        number: 60,
        kind: 'url',
      }),
      pr: pr60,
      state: 'open',
      inTenant: false,
      warning: 'Repository is not part of tenant corp-tenant',
    });
  });

  it('limits concurrent getPr requests to at most 5 in parallel', async () => {
    const urls = Array.from(
      { length: 12 },
      (_, i) => `Depends-On: https://ghe.example.com/org/repo/pull/${i + 1}`,
    ).join('\n');

    let inFlight = 0;
    let maxInFlight = 0;

    const ghe = {
      getPr: vi.fn(async (owner: string, repo: string, num: number) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return makePr({ owner, repo, number: num });
      }),
      searchPrs: vi.fn(),
    };
    const zuul = {
      getChangeStatus: vi.fn().mockResolvedValue([]),
    };
    const service = new DependsOnService(ghe, zuul, 'tenant-a', async () => new Set(['org/repo']));

    const result = await service.getUpstream(makePr({ body: urls }));
    expect(result).toHaveLength(12);
    expect(result.map((r) => r.ref.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('falls back to zuul.listProjects when tenantProjects callback is omitted', async () => {
    const ghe = {
      getPr: vi.fn(async (owner: string, repo: string, num: number) =>
        makePr({ owner, repo, number: num }),
      ),
      searchPrs: vi.fn(),
    };
    const zuul = {
      getChangeStatus: vi.fn().mockRejectedValue(new Error('zuul error')),
      listProjects: vi
        .fn()
        .mockResolvedValue([{ name: 'org/repo', canonical_name: 'ghe.example.com/org/repo' }]),
    };

    const service = new DependsOnService(ghe, zuul, 'tenant-a');
    const deps = await service.getUpstream(
      makePr({ body: 'Depends-On: https://ghe.example.com/org/repo/pull/7' }),
    );

    expect(zuul.listProjects).toHaveBeenCalledWith('tenant-a');
    expect(deps).toHaveLength(1);
    expect(deps[0].inTenant).toBe(true);
    expect(deps[0].zuul).toBeUndefined();
  });
});

describe('DependsOnService.getDownstream', () => {
  it('queries open PRs referencing pr.html_url in body and excludes the PR itself', async () => {
    const rootPr = makePr({
      owner: 'org',
      repo: 'repo',
      number: 42,
      html_url: 'https://ghe.example.com/org/repo/pull/42',
    });

    const items: SearchItem[] = [
      {
        number: 42,
        title: 'Self PR',
        html_url: 'https://ghe.example.com/org/repo/pull/42/',
        state: 'open',
      },
      {
        number: 42,
        title: 'Downstream in another repo with same number',
        html_url: 'https://ghe.example.com/org/other-repo/pull/42',
        state: 'open',
      },
      {
        number: 99,
        title: 'Downstream PR #99',
        html_url: 'https://ghe.example.com/org/repo/pull/99',
        state: 'open',
      },
    ];

    const ghe = {
      getPr: vi.fn(),
      searchPrs: vi.fn().mockResolvedValue(items),
    };
    const zuul = { getChangeStatus: vi.fn() };
    const service = new DependsOnService(ghe, zuul, 'tenant-a', async () => new Set(['org/repo']));

    const downstream = await service.getDownstream(rootPr);
    expect(ghe.searchPrs).toHaveBeenCalledWith(
      '"https://ghe.example.com/org/repo/pull/42" in:body is:open',
    );
    expect(downstream).toEqual([items[1], items[2]]);
  });
});

describe('syncState', () => {
  it('returns inSync: true when the queue was not read, even if the body has dependencies', () => {
    const pr = makePr({
      body: 'Depends-On: https://ghe.example.com/org/dep/pull/10',
    });
    expect(syncState(pr, undefined)).toEqual({
      inSync: true,
      missingInZuul: [],
      extraInZuul: [],
    });
  });

  it('is in sync when body dependencies match the queue ahead', () => {
    const pr = makePr({
      body: [
        'Depends-On: https://ghe.example.com/org/dep1/pull/10',
        'Depends-On: https://ghe.example.com/org/dep2/pull/20',
      ].join('\n'),
    });
    const queueAhead: QueuedRef[] = [
      { project: 'ghe.example.com/org/dep1', change: 10, live: false },
      { project: 'org/dep2', change: 20, live: false },
      { project: 'org/unrelated-queue-item', change: 99, live: true },
    ];

    expect(syncState(pr, queueAhead)).toEqual({
      inSync: true,
      missingInZuul: [],
      extraInZuul: [],
    });
  });

  it('reports a dependency missing from the queue', () => {
    const pr = makePr({ body: 'Depends-On: https://ghe.example.com/org/only-body/pull/20' });
    expect(syncState(pr, [])).toEqual({
      inSync: false,
      missingInZuul: ['org/only-body#20'],
      extraInZuul: [],
    });
  });

  it('does not count a transitive dependency as extra (A -> B -> C)', () => {
    const pr = makePr({ body: 'Depends-On: https://ghe.example.com/org/b/pull/2' });
    const queueAhead: QueuedRef[] = [
      { project: 'org/c', change: 3, live: false },
      { project: 'org/b', change: 2, live: false },
    ];
    expect(syncState(pr, queueAhead, undefined, new Set(['org/b#2', 'org/c#3']))).toEqual({
      inSync: true,
      missingInZuul: [],
      extraInZuul: [],
    });
  });

  it('reports a removed dependency still queued as extra', () => {
    const pr = makePr({ body: 'Depends-On: https://ghe.example.com/org/in-both/pull/10' });
    const queueAhead: QueuedRef[] = [
      { project: 'ghe/org/in-both', change: 10, live: false },
      { project: 'ghe.example.com/org/only-zuul', change: 30, live: false },
    ];
    const service = new DependsOnService(
      { getPr: vi.fn(), searchPrs: vi.fn() },
      { getChangeStatus: vi.fn() },
      'tenant-a',
      async () => new Set(),
    );

    expect(service.syncState(pr, queueAhead, undefined, new Set(['org/in-both#10']))).toEqual({
      inSync: false,
      missingInZuul: [],
      extraInZuul: ['org/only-zuul#30'],
    });
  });

  it('ignores non-open upstream dependencies when UpstreamDep[] is provided', () => {
    const mkDep = (name: string, n: number, state: 'open' | 'merged'): UpstreamDep => ({
      ref: {
        raw: `https://ghe.example.com/org/${name}/pull/${n}`,
        line: 1,
        kind: 'url',
        owner: 'org',
        repo: name,
        number: n,
      },
      state,
      inTenant: true,
    });
    const upstream = [mkDep('open-dep', 10, 'open'), mkDep('merged-dep', 20, 'merged')];
    const queueAhead: QueuedRef[] = [{ project: 'org/open-dep', change: 10, live: false }];

    expect(syncState(upstream, queueAhead)).toEqual({
      inSync: true,
      missingInZuul: [],
      extraInZuul: [],
    });
  });
});

describe('DependsOnService.getTransitiveUpstreamKeys', () => {
  it('walks Depends-On bodies down the chain', async () => {
    const bodies = new Map<number, string | null>([
      [2, 'Depends-On: https://ghe.example.com/org/c/pull/3'],
      [3, null],
    ]);
    const getPr = vi.fn(async (_o: string, _r: string, n: number) =>
      makePr({ number: n, body: bodies.get(n) ?? null }),
    );
    const service = new DependsOnService(
      { getPr, searchPrs: vi.fn() },
      { getChangeStatus: vi.fn() },
      'tenant-a',
      async () => new Set(),
    );

    const keys = await service.getTransitiveUpstreamKeys({
      body: 'Depends-On: https://ghe.example.com/org/b/pull/2',
    });
    expect([...keys].sort()).toEqual(['org/b#2', 'org/c#3']);
  });

  it('stops at depth 5', async () => {
    const getPr = vi.fn(async (_o: string, _r: string, n: number) =>
      makePr({ number: n, body: `Depends-On: https://ghe.example.com/org/repo/pull/${n + 1}` }),
    );
    const service = new DependsOnService(
      { getPr, searchPrs: vi.fn() },
      { getChangeStatus: vi.fn() },
      'tenant-a',
      async () => new Set(),
    );

    const keys = await service.getTransitiveUpstreamKeys({
      body: 'Depends-On: https://ghe.example.com/org/repo/pull/1',
    });
    expect(keys.size).toBe(5);
    expect(getPr).toHaveBeenCalledTimes(4);
  });
});

describe('DependsOnService.wouldCreateCycle', () => {
  it('detects direct self-cycle and 2-node / multi-hop cycles', async () => {
    const prs = new Map<number, PullRequest>([
      [1, makePr({ number: 1, body: null })],
      [2, makePr({ number: 2, body: 'Depends-On: https://ghe.example.com/org/repo/pull/3' })],
      [3, makePr({ number: 3, body: 'Depends-On: https://ghe.example.com/org/repo/pull/1' })],
      [4, makePr({ number: 4, body: null })],
    ]);

    const ghe = {
      getPr: vi.fn(async (_owner: string, _repo: string, num: number) => {
        const found = prs.get(num);
        if (!found) throw new Error('404');
        return found;
      }),
      searchPrs: vi.fn(),
    };
    const zuul = { getChangeStatus: vi.fn() };
    const service = new DependsOnService(ghe, zuul, 'tenant-a', async () => new Set(['org/repo']));

    // Self cycle: 1 -> 1
    expect(await service.wouldCreateCycle(prs.get(1)!, prs.get(1)!)).toBe(true);

    // Multi-hop cycle: 1 -> 2 -> 3 -> 1
    expect(
      await service.wouldCreateCycle(prs.get(1)!, { owner: 'org', repo: 'repo', number: 2 }),
    ).toBe(true);

    // No cycle: 1 -> 4
    expect(await service.wouldCreateCycle(prs.get(1)!, prs.get(4)!)).toBe(false);
  });

  it('handles cycles in unrelated subgraphs without infinite recursion', async () => {
    const prs = new Map<number, PullRequest>([
      [1, makePr({ number: 1, body: null })],
      [2, makePr({ number: 2, body: 'Depends-On: https://ghe.example.com/org/repo/pull/3' })],
      [3, makePr({ number: 3, body: 'Depends-On: https://ghe.example.com/org/repo/pull/2' })],
    ]);

    const ghe = {
      getPr: vi.fn(async (_owner: string, _repo: string, num: number) => prs.get(num)!),
      searchPrs: vi.fn(),
    };
    const service = new DependsOnService(
      ghe,
      { getChangeStatus: vi.fn() },
      'tenant-a',
      async () => new Set(['org/repo']),
    );

    expect(await service.wouldCreateCycle(prs.get(1)!, prs.get(2)!)).toBe(false);
  });

  it('enforces max depth 10', async () => {
    // Chain: 100 -> 101 -> 102 -> ... -> 111
    const prs = new Map<number, PullRequest>();
    for (let i = 100; i <= 112; i += 1) {
      prs.set(
        i,
        makePr({
          number: i,
          body: i < 112 ? `Depends-On: https://ghe.example.com/org/repo/pull/${i + 1}` : null,
        }),
      );
    }

    const ghe = {
      getPr: vi.fn(async (_owner: string, _repo: string, num: number) => prs.get(num)!),
      searchPrs: vi.fn(),
    };
    const service = new DependsOnService(
      ghe,
      { getChangeStatus: vi.fn() },
      'tenant-a',
      async () => new Set(['org/repo']),
    );

    // Within 10 hops: 100 -> ... -> 110 (depth 10)
    expect(
      await service.wouldCreateCycle({ owner: 'org', repo: 'repo', number: 110 }, prs.get(100)!),
    ).toBe(true);

    // Beyond 10 hops: 100 -> ... -> 111 (depth 11)
    expect(
      await service.wouldCreateCycle({ owner: 'org', repo: 'repo', number: 111 }, prs.get(100)!),
    ).toBe(false);
  });

  it('enforces max 50 PRs fetched limit', async () => {
    // Wide tree: target #1 depends on #2..#60, each of #2..#60 has empty body except #60 which depends on #999
    const depLines = Array.from(
      { length: 60 },
      (_, i) => `Depends-On: https://ghe.example.com/org/repo/pull/${i + 2}`,
    ).join('\n');

    const targetPr = makePr({ number: 1, body: depLines });
    const ghe = {
      getPr: vi.fn(async (_owner: string, _repo: string, num: number) =>
        makePr({
          number: num,
          body: num === 60 ? 'Depends-On: https://ghe.example.com/org/repo/pull/999' : null,
        }),
      ),
      searchPrs: vi.fn(),
    };
    const service = new DependsOnService(
      ghe,
      { getChangeStatus: vi.fn() },
      'tenant-a',
      async () => new Set(['org/repo']),
    );

    const hasCycle = await service.wouldCreateCycle(
      { owner: 'org', repo: 'repo', number: 999 },
      targetPr,
    );
    expect(hasCycle).toBe(false);
    expect(ghe.getPr).toHaveBeenCalledTimes(MAX_CYCLE_FETCHES);
  });
});

describe('applyAddDependsOn / applyRemoveDependsOn', () => {
  const ref = { owner: 'org', repo: 'repo', number: 1 };

  it('adds to the fresh body, not a stale one', async () => {
    const ghe = {
      getPr: vi.fn().mockResolvedValue(makePr({ body: 'fresh text' })),
      updatePrBody: vi.fn().mockResolvedValue(undefined),
    };
    await applyAddDependsOn(
      ghe,
      { ...ref, body: 'stale text' },
      'https://ghe.example.com/org/other/pull/2',
    );
    expect(ghe.getPr).toHaveBeenCalledWith('org', 'repo', 1);
    expect(ghe.updatePrBody).toHaveBeenCalledTimes(1);
    const [, , , body] = ghe.updatePrBody.mock.calls[0] as [string, string, number, string];
    expect(body).toContain('fresh text');
    expect(body).not.toContain('stale text');
    expect(body).toContain('Depends-On: https://ghe.example.com/org/other/pull/2');
  });

  it('removes from the fresh body, not a stale one', async () => {
    const ghe = {
      getPr: vi
        .fn()
        .mockResolvedValue(
          makePr({ body: 'fresh\nDepends-On: https://ghe.example.com/org/other/pull/2' }),
        ),
      updatePrBody: vi.fn().mockResolvedValue(undefined),
    };
    await applyRemoveDependsOn(
      ghe,
      { ...ref, body: 'stale\nDepends-On: https://ghe.example.com/org/other/pull/2' },
      { owner: 'org', repo: 'other', number: 2 },
    );
    const [owner, repo, n, body] = ghe.updatePrBody.mock.calls[0] as [
      string,
      string,
      number,
      string,
    ];
    expect([owner, repo, n]).toEqual(['org', 'repo', 1]);
    expect(body).toContain('fresh');
    expect(body).not.toContain('stale');
    expect(body).not.toContain('Depends-On');
  });

  it('does not update when getPr fails', async () => {
    const ghe = {
      getPr: vi.fn().mockRejectedValue(new Error('nope')),
      updatePrBody: vi.fn(),
    };
    await expect(applyAddDependsOn(ghe, ref, 'https://x/o/r/pull/2')).rejects.toThrow('nope');
    expect(ghe.updatePrBody).not.toHaveBeenCalled();
  });
});
