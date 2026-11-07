import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type API, getGitApi, type Repository } from '../../src/git/gitApi';
import {
  computeGitContext,
  type GitContext,
  GitContextService,
  isSameGitContext,
  type RepoLike,
  selectRepository,
} from '../../src/git/gitContext';
import { EventEmitter, extensions, Uri, workspace } from '../mocks/vscode';

function createFakeRepo(opts: {
  rootPath?: string;
  branch?: string;
  commit?: string;
  remotes?: { name: string; fetchUrl?: string; pushUrl?: string }[];
}): { repo: Repository; stateEmitter: EventEmitter<void> } {
  const stateEmitter = new EventEmitter<void>();
  const state = {
    HEAD:
      opts.branch !== undefined || opts.commit !== undefined
        ? { name: opts.branch, commit: opts.commit }
        : undefined,
    remotes: opts.remotes ?? [{ name: 'origin', fetchUrl: 'git@ghe.example.com:acme/service.git' }],
    onDidChange: stateEmitter.event,
  };
  const repo: Repository = {
    rootUri: Uri.file(opts.rootPath ?? '/workspace/service'),
    state,
  };
  return { repo, stateEmitter };
}

describe('computeGitContext', () => {
  it('prefers origin remote over earlier remotes', () => {
    const repo: RepoLike = {
      rootUri: { fsPath: '/work/repo' },
      state: {
        HEAD: { name: 'main', commit: 'abc1234' },
        remotes: [
          { name: 'upstream', fetchUrl: 'git@ghe.example.com:upstream-org/service.git' },
          { name: 'origin', fetchUrl: 'git@ghe.example.com:my-org/service.git' },
        ],
      },
    };

    expect(computeGitContext(repo)).toEqual({
      repoRoot: '/work/repo',
      host: 'ghe.example.com',
      owner: 'my-org',
      repo: 'service',
      branch: 'main',
      headSha: 'abc1234',
    });
  });

  it('falls back to the first remote when origin does not exist', () => {
    const repo: RepoLike = {
      rootUri: { fsPath: '/work/repo' },
      state: {
        HEAD: { name: 'feature/x', commit: 'deadbeef' },
        remotes: [
          { name: 'upstream', fetchUrl: 'https://ghe.example.com/upstream-org/service.git' },
          { name: 'fork', fetchUrl: 'https://ghe.example.com/fork-org/service.git' },
        ],
      },
    };

    expect(computeGitContext(repo)).toEqual({
      repoRoot: '/work/repo',
      host: 'ghe.example.com',
      owner: 'upstream-org',
      repo: 'service',
      branch: 'feature/x',
      headSha: 'deadbeef',
    });
  });

  it('uses pushUrl when fetchUrl is undefined', () => {
    const repo: RepoLike = {
      rootUri: { fsPath: '/work/repo' },
      state: {
        remotes: [{ name: 'origin', pushUrl: 'ssh://git@ghe.example.com:2222/acme/tool.git' }],
      },
    };

    expect(computeGitContext(repo)).toEqual({
      repoRoot: '/work/repo',
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'tool',
    });
  });

  it('overrides host when hostOverride is provided and non-empty', () => {
    const repo: RepoLike = {
      rootUri: { fsPath: '/work/repo' },
      state: {
        HEAD: { name: 'main', commit: '111222' },
        remotes: [{ name: 'origin', fetchUrl: 'git@ssh-alias:acme/service.git' }],
      },
    };

    expect(computeGitContext(repo, 'GHE.Internal.Corp')).toEqual({
      repoRoot: '/work/repo',
      host: 'ghe.internal.corp',
      owner: 'acme',
      repo: 'service',
      branch: 'main',
      headSha: '111222',
    });

    expect(computeGitContext(repo, '')?.host).toBe('ssh-alias');
    expect(computeGitContext(repo, '   ')?.host).toBe('ssh-alias');
  });

  it('returns undefined when remotes are empty, missing URLs, or unparseable', () => {
    expect(
      computeGitContext({
        rootUri: { fsPath: '/work/repo' },
        state: { remotes: [] },
      }),
    ).toBeUndefined();

    expect(
      computeGitContext({
        rootUri: { fsPath: '/work/repo' },
        state: { remotes: [{ name: 'origin' }] },
      }),
    ).toBeUndefined();

    expect(
      computeGitContext({
        rootUri: { fsPath: '/work/repo' },
        state: { remotes: [{ name: 'origin', fetchUrl: 'not-a-valid-url' }] },
      }),
    ).toBeUndefined();
  });
});

describe('selectRepository and isSameGitContext', () => {
  it('selects the repository containing the first workspace folder or falls back to first', () => {
    const repoA = { rootUri: { fsPath: '/work/repo' } };
    const repoB = { rootUri: { fsPath: '/work/repo-two' } };

    expect(selectRepository([], '/work/repo')).toBeUndefined();
    expect(selectRepository([repoA, repoB], '/work/repo-two')).toBe(repoB);
    expect(selectRepository([repoA, repoB], '/work/repo-two/packages/sub')).toBe(repoB);
    expect(selectRepository([repoA, repoB], '/other/path')).toBe(repoA);
    expect(selectRepository([repoA, repoB], undefined)).toBe(repoA);
  });

  it('compares GitContext instances by value', () => {
    const base: GitContext = {
      repoRoot: '/work/repo',
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'app',
      branch: 'main',
      headSha: '123',
    };

    expect(isSameGitContext(undefined, undefined)).toBe(true);
    expect(isSameGitContext(base, undefined)).toBe(false);
    expect(isSameGitContext(undefined, base)).toBe(false);
    expect(isSameGitContext(base, { ...base })).toBe(true);
    expect(isSameGitContext(base, { ...base, branch: 'dev' })).toBe(false);
    expect(isSameGitContext(base, { ...base, headSha: '456' })).toBe(false);
  });
});

describe('getGitApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined when vscode.git extension is not found or disabled', async () => {
    extensions.getExtension.mockReturnValueOnce(undefined);
    expect(await getGitApi()).toBeUndefined();

    extensions.getExtension.mockReturnValueOnce({
      isActive: true,
      exports: { enabled: false, getAPI: vi.fn() },
    });
    expect(await getGitApi()).toBeUndefined();
  });

  it('returns API from active or newly activated vscode.git extension', async () => {
    const fakeApi = { repositories: [] };
    const getAPI = vi.fn(() => fakeApi);

    extensions.getExtension.mockReturnValueOnce({
      isActive: true,
      exports: { enabled: true, getAPI },
    });
    expect(await getGitApi()).toBe(fakeApi);
    expect(getAPI).toHaveBeenCalledWith(1);

    const activate = vi.fn(async () => ({ enabled: true, getAPI }));
    extensions.getExtension.mockReturnValueOnce({
      isActive: false,
      activate,
    });
    expect(await getGitApi()).toBe(fakeApi);
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

describe('GitContextService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    workspace.workspaceFolders = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes initial context and debounces subsequent changes by 300ms', async () => {
    const openEmitter = new EventEmitter<Repository>();
    const closeEmitter = new EventEmitter<Repository>();
    const settingsEmitter = new EventEmitter<void>();
    const { repo, stateEmitter } = createFakeRepo({
      rootPath: '/workspace/app',
      branch: 'main',
      commit: 'sha-1',
    });

    let hostOverride = '';
    const api: API = {
      repositories: [repo],
      onDidOpenRepository: openEmitter.event,
      onDidCloseRepository: closeEmitter.event,
    };

    const service = new GitContextService({
      getApi: async () => api,
      getHostOverride: () => hostOverride,
      onSettingsChange: (cb) => settingsEmitter.event(cb),
      getFirstWorkspaceFolder: () => '/workspace/app',
    });

    const events: (GitContext | undefined)[] = [];
    service.onDidChange((ctx) => events.push(ctx));

    await service.ready;

    expect(service.current).toEqual({
      repoRoot: '/workspace/app',
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'service',
      branch: 'main',
      headSha: 'sha-1',
    });
    expect(events).toHaveLength(1);

    // Fire state change without changing any field -> should not emit
    stateEmitter.fire();
    vi.advanceTimersByTime(300);
    expect(events).toHaveLength(1);

    // Mutate branch and fire twice rapidly -> should debounce and emit once after 300ms
    (repo.state as { HEAD?: { name?: string; commit?: string } }).HEAD = {
      name: 'feat/one',
      commit: 'sha-2',
    };
    stateEmitter.fire();
    vi.advanceTimersByTime(150);
    (repo.state as { HEAD?: { name?: string; commit?: string } }).HEAD = {
      name: 'feat/two',
      commit: 'sha-3',
    };
    stateEmitter.fire();
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(1);

    vi.advanceTimersByTime(100);
    expect(events).toHaveLength(2);
    expect(service.current?.branch).toBe('feat/two');
    expect(service.current?.headSha).toBe('sha-3');

    // Change host override via settings -> emits after 300ms
    hostOverride = 'ghe.custom.internal';
    settingsEmitter.fire();
    vi.advanceTimersByTime(300);
    expect(events).toHaveLength(3);
    expect(service.current?.host).toBe('ghe.custom.internal');

    // Close the repository -> emits undefined after 300ms
    (api.repositories as Repository[]).length = 0;
    closeEmitter.fire(repo);
    vi.advanceTimersByTime(300);
    expect(events).toHaveLength(4);
    expect(service.current).toBeUndefined();

    // Open a new repository -> emits new context after 300ms
    const { repo: repo2 } = createFakeRepo({
      rootPath: '/workspace/app',
      branch: 'develop',
      commit: 'sha-9',
    });
    (api.repositories as Repository[]).push(repo2);
    openEmitter.fire(repo2);
    vi.advanceTimersByTime(300);
    expect(events).toHaveLength(5);
    expect(service.current?.branch).toBe('develop');

    service.dispose();
  });
});
