import { describe, expect, it, vi } from 'vitest';
import { type PullRequest } from '../../src/clients/gheTypes';
import { type ResolvedContext } from '../../src/context/zuulContext';
import { type PrSnapshot } from '../../src/services/prTracker';
import {
  CONFIRM_REMOVE_ACTION,
  DependsOnTreeDataProvider,
  openDependencyPrExternally,
} from '../../src/views/dependsOnTreeView';
import { createFakeLogger } from '../helpers';
import { EventEmitter, window } from '../mocks/vscode';

describe('openDependencyPrExternally URL schemes', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x/y'])(
    'does not open %s',
    async (url) => {
      const openExternal = vi.fn(async () => true);
      await openDependencyPrExternally(url, openExternal);
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it('opens https URLs', async () => {
    const openExternal = vi.fn(async () => true);
    await openDependencyPrExternally('https://ghe.example.com/acme/service/pull/1', openExternal);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});

describe('DependsOnTreeDataProvider.removeDependsOn', () => {
  it('warns, and neither logs "Removed" nor writes, when the fresh body lacks the target', async () => {
    const pr = {
      number: 5,
      html_url: 'https://ghe.example.com/acme/service/pull/5',
      body: 'Depends-On: https://ghe.example.com/org/dep/pull/9',
      state: 'open',
      merged: false,
      base: { ref: 'main', repo: { full_name: 'acme/service' } },
      head: { sha: 'x', ref: 'f', repo: { full_name: 'acme/service' } },
    } as unknown as PullRequest;
    const updatePrBody = vi.fn();
    const ghe = {
      getPr: vi.fn(async () => ({ ...pr, body: 'already removed' })),
      updatePrBody,
      searchPrs: vi.fn(async () => []),
    };
    const ctx = {
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'service',
      project: 'acme/service',
      ghe,
      zuul: {
        url: 'https://zuul.example.com',
        tenant: 't',
        client: { listProjects: vi.fn(async () => []), getChangeStatus: vi.fn(async () => []) },
      },
    } as unknown as ResolvedContext;
    const snapshot: PrSnapshot = {
      pr,
      statuses: [],
      builds: [],
      fetchedAt: 0,
      zuul: { kind: 'ok' },
    };
    const refresh = vi.fn(async () => undefined);
    const logger = createFakeLogger();
    const provider = new DependsOnTreeDataProvider(
      { current: ctx, onDidChange: new EventEmitter<ResolvedContext | undefined>().event },
      { snapshot, onDidChange: new EventEmitter<PrSnapshot | undefined>().event, refresh },
      logger,
    );
    window.showWarningMessage.mockResolvedValue(CONFIRM_REMOVE_ACTION);

    const done = await provider.removeDependsOn({ owner: 'org', repo: 'dep', number: 9 });

    expect(done).toBe(true);
    expect(updatePrBody).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('was not removed'));
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Removed'));
    provider.dispose();
  });
});

describe('DependsOnTreeDataProvider load failures', () => {
  it('shows one retry node instead of "Depends On (0)" when the load fails', async () => {
    const pr = {
      number: 5,
      html_url: 'https://ghe.example.com/acme/service/pull/5',
      body: 'no deps',
      state: 'open',
      merged: false,
      base: { ref: 'main', repo: { full_name: 'acme/service' } },
      head: { sha: 'x', ref: 'f', repo: { full_name: 'acme/service' } },
    } as unknown as PullRequest;
    const ctx = {
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'service',
      project: 'acme/service',
      ghe: {
        getPr: vi.fn(),
        searchPrs: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
      zuul: {
        url: 'https://zuul.example.com',
        tenant: 't',
        client: { listProjects: vi.fn(async () => []), getChangeStatus: vi.fn(async () => []) },
      },
    } as unknown as ResolvedContext;
    const snapshot: PrSnapshot = {
      pr,
      statuses: [],
      builds: [],
      fetchedAt: 0,
      zuul: { kind: 'ok' },
    };
    const logger = createFakeLogger();
    const provider = new DependsOnTreeDataProvider(
      { current: ctx, onDidChange: new EventEmitter<ResolvedContext | undefined>().event },
      {
        snapshot,
        onDidChange: new EventEmitter<PrSnapshot | undefined>().event,
        refresh: vi.fn(async () => undefined),
      },
      logger,
    );

    const nodes = await provider.getChildren();

    expect(nodes).toEqual([{ kind: 'load-error' }]);
    const item = provider.getTreeItem(nodes[0]);
    expect(item.label).toBe('Could not load dependencies, click to retry');
    expect(item.command?.command).toBe('zuul.refresh');
    expect(item.id).toBeUndefined();
    provider.dispose();
  });

  it.each([
    ['the context has no Zuul', { kind: 'ok' } as PrSnapshot['zuul'], false],
    [
      'the snapshot says Zuul failed',
      {
        kind: 'unavailable',
        reason: 'needs-token',
        message: 'HTTP 401',
        stopped: true,
      } as PrSnapshot['zuul'],
      true,
    ],
  ])('lists both groups and sends no Zuul requests when %s', async (_name, zuulState, hasZuul) => {
    const upstreamUrl = 'https://ghe.example.com/org/dep/pull/9';
    const pr = {
      number: 5,
      html_url: 'https://ghe.example.com/acme/service/pull/5',
      body: `Depends-On: ${upstreamUrl}`,
      state: 'open',
      merged: false,
      base: { ref: 'main', repo: { full_name: 'acme/service' } },
      head: { sha: 'x', ref: 'f', repo: { full_name: 'acme/service' } },
    } as unknown as PullRequest;
    const upstreamPr = {
      ...pr,
      number: 9,
      html_url: upstreamUrl,
      body: null,
      head: { sha: 'y', ref: 'g', repo: { full_name: 'org/dep' } },
    };
    const downstream = { number: 12, html_url: 'https://ghe.example.com/acme/other/pull/12' };
    const searchPrs = vi.fn(async () => [downstream]);
    const listProjects = vi.fn(async () => {
      throw new Error('HTTP 401');
    });
    const getChangeStatus = vi.fn(async () => {
      throw new Error('HTTP 401');
    });
    const ctx = {
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'service',
      project: 'acme/service',
      ghe: { getPr: vi.fn(async () => upstreamPr), searchPrs },
      ...(hasZuul
        ? {
            zuul: {
              url: 'https://zuul.example.com',
              tenant: 't',
              client: { listProjects, getChangeStatus },
            },
          }
        : {}),
    } as unknown as ResolvedContext;
    const snapshot: PrSnapshot = {
      pr,
      statuses: [],
      builds: [],
      fetchedAt: 0,
      zuul: hasZuul
        ? zuulState
        : { kind: 'unavailable', reason: 'unreachable', message: 'x', stopped: true },
    };
    const provider = new DependsOnTreeDataProvider(
      { current: ctx, onDidChange: new EventEmitter<ResolvedContext | undefined>().event },
      {
        snapshot,
        onDidChange: new EventEmitter<PrSnapshot | undefined>().event,
        refresh: vi.fn(async () => undefined),
      },
      createFakeLogger(),
    );

    const kinds = (await provider.getChildren()).map((n) => n.kind);

    expect(kinds).not.toContain('load-error');
    expect(kinds).toContain('depends-on-group');
    expect(kinds).toContain('needed-by-group');
    expect(listProjects).not.toHaveBeenCalled();
    expect(getChangeStatus).not.toHaveBeenCalled();
    provider.dispose();
  });

  it('reloads, without Zuul data, when the snapshot flips to unavailable', async () => {
    const upstreamUrl = 'https://ghe.example.com/org/dep/pull/9';
    const pr = {
      number: 5,
      html_url: 'https://ghe.example.com/acme/service/pull/5',
      body: `Depends-On: ${upstreamUrl}`,
      state: 'open',
      merged: false,
      base: { ref: 'main', repo: { full_name: 'acme/service' } },
      head: { sha: 'x', ref: 'f', repo: { full_name: 'acme/service' } },
    } as unknown as PullRequest;
    const upstreamPr = {
      ...pr,
      number: 9,
      html_url: upstreamUrl,
      body: null,
      head: { sha: 'y', ref: 'g', repo: { full_name: 'org/dep' } },
    };
    const getPr = vi.fn(async () => upstreamPr);
    const getChangeStatus = vi.fn(async () => []);
    const ctx = {
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'service',
      project: 'acme/service',
      ghe: { getPr, searchPrs: vi.fn(async () => []) },
      zuul: {
        url: 'https://zuul.example.com',
        tenant: 't',
        client: { listProjects: vi.fn(async () => [{ name: 'org/dep' }]), getChangeStatus },
      },
    } as unknown as ResolvedContext;
    const emitter = new EventEmitter<PrSnapshot | undefined>();
    const tracker = {
      snapshot: {
        pr,
        statuses: [],
        builds: [],
        fetchedAt: 0,
        zuul: { kind: 'ok' },
      } as PrSnapshot,
      onDidChange: emitter.event,
      refresh: vi.fn(async () => undefined),
    };
    const provider = new DependsOnTreeDataProvider(
      { current: ctx, onDidChange: new EventEmitter<ResolvedContext | undefined>().event },
      tracker,
      createFakeLogger(),
    );

    await provider.getChildren();
    expect(getChangeStatus).toHaveBeenCalledTimes(1);
    expect(getPr).toHaveBeenCalledTimes(1);

    tracker.snapshot = {
      ...tracker.snapshot,
      zuul: { kind: 'unavailable', reason: 'needs-token', message: 'HTTP 401', stopped: true },
    };
    emitter.fire(tracker.snapshot);
    await provider.getChildren();

    expect(getPr).toHaveBeenCalledTimes(2);
    expect(getChangeStatus).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('fetches nothing on a snapshot change until getChildren is called', async () => {
    const searchPrs = vi.fn(async () => []);
    const getPr = vi.fn();
    const pr = {
      number: 5,
      html_url: 'https://ghe.example.com/acme/service/pull/5',
      body: '',
      state: 'open',
      merged: false,
      base: { ref: 'main', repo: { full_name: 'acme/service' } },
      head: { sha: 'x', ref: 'f', repo: { full_name: 'acme/service' } },
    } as unknown as PullRequest;
    const ctx = {
      host: 'ghe.example.com',
      owner: 'acme',
      repo: 'service',
      project: 'acme/service',
      ghe: { getPr, searchPrs },
      zuul: {
        url: 'https://zuul.example.com',
        tenant: 't',
        client: { listProjects: vi.fn(async () => []), getChangeStatus: vi.fn(async () => []) },
      },
    } as unknown as ResolvedContext;
    const emitter = new EventEmitter<PrSnapshot | undefined>();
    const snapshot = {
      pr,
      statuses: [],
      builds: [],
      fetchedAt: 0,
      zuul: { kind: 'ok' },
    } as PrSnapshot;
    const tracker = {
      snapshot,
      onDidChange: emitter.event,
      refresh: vi.fn(async () => undefined),
    };
    const provider = new DependsOnTreeDataProvider(
      { current: ctx, onDidChange: new EventEmitter<ResolvedContext | undefined>().event },
      tracker,
      createFakeLogger(),
    );

    emitter.fire(snapshot);
    await new Promise((resolve) => setImmediate(resolve));
    expect(searchPrs).not.toHaveBeenCalled();

    await provider.getChildren();
    expect(searchPrs).toHaveBeenCalled();
    provider.dispose();
  });
});
