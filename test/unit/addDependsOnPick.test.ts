import { describe, expect, it, vi } from 'vitest';
import { type PullRequest } from '../../src/clients/gheTypes';
import { type ResolvedContext } from '../../src/context/zuulContext';
import { type PrSnapshot } from '../../src/services/prTracker';
import { pickAndAddDependsOn } from '../../src/views/addDependsOnPick';
import { createFakeLogger } from '../helpers';
import { EventEmitter } from '../mocks/vscode';

describe('pickAndAddDependsOn', () => {
  it('warns, and neither logs "Added" nor writes, when the fresh body already has the target', async () => {
    const url = 'https://ghe.example.com/acme/service/pull/7';
    const pr = {
      number: 5,
      html_url: 'https://ghe.example.com/acme/service/pull/5',
      body: null,
      state: 'open',
      merged: false,
      base: { ref: 'main', repo: { full_name: 'acme/service' } },
      head: { sha: 'x', ref: 'f', repo: { full_name: 'acme/service' } },
    } as unknown as PullRequest;
    const updatePrBody = vi.fn();
    const ghe = {
      getPr: vi.fn(async (_o: string, _r: string, n: number) =>
        n === 5 ? { ...pr, body: `Depends-On: ${url}` } : { ...pr, number: n, body: null },
      ),
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
      zuul: { listProjects: vi.fn(async () => []) },
    } as unknown as ResolvedContext;
    const snapshot: PrSnapshot = { pr, statuses: [], builds: [], fetchedAt: 0 };
    const logger = createFakeLogger();
    const onUpdated = vi.fn();

    const done = await pickAndAddDependsOn({
      ctx: { current: ctx, onDidChange: new EventEmitter<ResolvedContext | undefined>().event },
      tracker: { snapshot, refresh: vi.fn(async () => undefined) },
      logger,
      onUpdated,
      targetArg: url,
    });

    expect(done).toBe(true);
    expect(updatePrBody).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('was not added'));
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Added'));
  });
});
