import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const tokenProvider = vi.hoisted(() => ({
  setToken: vi.fn(),
  clearToken: vi.fn(),
  listStoredTenants: vi.fn(),
}));

vi.mock('../../src/auth/zuulTokenProvider', () => ({
  ZuulTokenProvider: vi.fn(function () {
    return tokenProvider;
  }),
}));

import { ZuulContextService } from '../../src/context/zuulContext';
import { activate } from '../../src/extension';

type Handler = (...args: unknown[]) => Promise<unknown>;

function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    secrets: {
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      onDidChange: vi.fn(),
    },
    workspaceState: {
      get: vi.fn(() => undefined),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => []),
    },
    globalState: {
      get: vi.fn(() => undefined),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => []),
    },
  } as unknown as vscode.ExtensionContext;
}

function commandHandler(name: string): Handler {
  const call = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([n]) => n === name);
  if (!call) {
    throw new Error(`command not registered: ${name}`);
  }
  return call[1] as Handler;
}

function fireConfigChange(changed: string): void {
  const calls = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls;
  for (const [listener] of calls) {
    listener({ affectsConfiguration: (section: string) => section === changed });
  }
}

function refreshCalls(): unknown[][] {
  return vi
    .mocked(vscode.commands.executeCommand)
    .mock.calls.filter(([command]) => command === 'zuul.refresh');
}

describe('extension wiring: token changes run Refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tokenProvider.listStoredTenants.mockResolvedValue(['t1']);
    activate(fakeContext());
    vi.mocked(vscode.commands.executeCommand).mockClear();
  });

  it('zuul.setTenantToken runs refresh when a token is entered', async () => {
    tokenProvider.setToken.mockResolvedValue('secret');
    await commandHandler('zuul.setTenantToken')();
    expect(refreshCalls()).toHaveLength(1);
  });

  it('zuul.setTenantToken does not run refresh when the prompt is cancelled', async () => {
    tokenProvider.setToken.mockResolvedValue(undefined);
    await commandHandler('zuul.setTenantToken')();
    expect(refreshCalls()).toHaveLength(0);
  });

  it('zuul.clearTenantToken runs refresh when the token is cleared', async () => {
    tokenProvider.clearToken.mockResolvedValue(undefined);
    await commandHandler('zuul.clearTenantToken')('t1');
    expect(refreshCalls()).toHaveLength(1);
  });

  it('changing zuul.tokens runs refresh', () => {
    fireConfigChange('zuul.tokens');
    expect(refreshCalls()).toHaveLength(1);
  });

  it('changing zuul.tokenFile runs refresh', () => {
    fireConfigChange('zuul.tokenFile');
    expect(refreshCalls()).toHaveLength(1);
  });

  it('changing zuul.pollIntervalSeconds does not run refresh', () => {
    fireConfigChange('zuul.pollIntervalSeconds');
    expect(refreshCalls()).toHaveLength(0);
  });
});

describe('extension wiring: Refresh clears client caches', () => {
  it('zuul.refresh calls clearClientCaches', async () => {
    vi.clearAllMocks();
    activate(fakeContext());
    const spy = vi.spyOn(ZuulContextService.prototype, 'clearClientCaches');
    await commandHandler('zuul.refresh')();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
