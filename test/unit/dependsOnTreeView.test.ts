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
      tenant: 't',
      project: 'acme/service',
      ghe,
      zuul: { listProjects: vi.fn(async () => []), getChangeStatus: vi.fn(async () => []) },
    } as unknown as ResolvedContext;
    const snapshot: PrSnapshot = { pr, statuses: [], builds: [], fetchedAt: 0 };
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
      tenant: 't',
      project: 'acme/service',
      ghe: {
        getPr: vi.fn(),
        searchPrs: vi.fn(async () => {
          throw new Error('boom');
        }),
      },
      zuul: { listProjects: vi.fn(async () => []), getChangeStatus: vi.fn(async () => []) },
    } as unknown as ResolvedContext;
    const snapshot: PrSnapshot = { pr, statuses: [], builds: [], fetchedAt: 0 };
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
});
