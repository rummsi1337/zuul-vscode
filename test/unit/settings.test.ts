import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  onSettingsChanged,
  onPollIntervalChanged,
  onTokenSettingsChanged,
  readGheHost,
  readSettings,
  readWorkspaceSettings,
} from '../../src/config/settings';
import {
  type ConfigurationChangeEvent,
  Disposable,
  type Listener,
  workspace,
} from '../mocks/vscode';

describe('settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns defaults when all values are undefined', () => {
    const settings = readSettings(() => undefined);

    expect(settings).toEqual({
      url: '',
      tenant: '',
      tokens: {},
      tokenFile: '',
      gheHost: '',
      authMethod: 'auto',
      oauthClientId: '',
      triggerComments: [{ label: 'Recheck', comment: 'recheck', icon: 'refresh' }],
      pinnedArtifacts: ['job-output.txt'],
      gate: {
        requiredApprovals: 1,
        requiredStatusChecks: {},
        requiredLabels: [],
        blockingLabels: ['do-not-merge', 'wip'],
        gateStatusChecks: ['{tenant}/gate'],
      },
      pollIntervalSeconds: 60,
    });
  });

  it('clamps pollIntervalSeconds to 10..3600 and falls back to 60', () => {
    const read = (value: unknown) =>
      readSettings((key) => (key === 'pollIntervalSeconds' ? value : undefined))
        .pollIntervalSeconds;
    expect(read(5)).toBe(10);
    expect(read(30)).toBe(30);
    expect(read(99999)).toBe(3600);
    expect(read('fast')).toBe(60);
    expect(read(Number.NaN)).toBe(60);
  });

  it('reads valid configured values and strips trailing slashes from url', () => {
    const values: Record<string, unknown> = {
      url: 'https://zuul.example.com///',
      tenant: 'internal',
      tokens: { ddad: 'token-ddad', swh: 'token-swh' },
      tokenFile: '~/.zuul/token',
      'ghe.host': 'git.example.com',
      'auth.method': 'gh-cli',
      'ghe.oauthClientId': 'Iv1.123456',
      triggerComments: [
        { label: 'Recheck', comment: 'recheck', icon: 'refresh' },
        { label: 'Regate', comment: 'regate' },
      ],
      pinnedArtifacts: ['job-output.txt', 'ara-report/**'],
      'gate.requiredApprovals': 2,
      'gate.requiredStatusChecks': {
        '*': ['zuul/check'],
        'acme/service': ['lint', 'unit'],
      },
      'gate.requiredLabels': ['ready-to-merge'],
      'gate.blockingLabels': ['hold'],
      'gate.gateStatusChecks': ['my-tenant/gate'],
    };

    const settings = readSettings((key) => values[key]);

    expect(settings).toEqual({
      url: 'https://zuul.example.com',
      tenant: 'internal',
      tokens: { ddad: 'token-ddad', swh: 'token-swh' },
      tokenFile: '~/.zuul/token',
      gheHost: 'git.example.com',
      authMethod: 'gh-cli',
      oauthClientId: 'Iv1.123456',
      triggerComments: [
        { label: 'Recheck', comment: 'recheck', icon: 'refresh' },
        { label: 'Regate', comment: 'regate' },
      ],
      pinnedArtifacts: ['job-output.txt', 'ara-report/**'],
      gate: {
        requiredApprovals: 2,
        requiredStatusChecks: {
          '*': ['zuul/check'],
          'acme/service': ['lint', 'unit'],
        },
        requiredLabels: ['ready-to-merge'],
        blockingLabels: ['hold'],
        gateStatusChecks: ['my-tenant/gate'],
      },
      pollIntervalSeconds: 60,
    });
  });

  it('falls back to defaults when settings have wrong types', () => {
    const badValues: Record<string, unknown> = {
      url: 42,
      tenant: null,
      tokens: 'not-an-object',
      tokenFile: 999,
      'ghe.host': ['invalid'],
      'auth.method': 'unknown-method',
      'ghe.oauthClientId': false,
      triggerComments: [{ label: 'Missing comment' }],
      pinnedArtifacts: ['ok.txt', 123],
      'gate.requiredApprovals': -1,
      'gate.requiredStatusChecks': { '*': 'not-an-array' },
      'gate.requiredLabels': 'not-an-array',
      'gate.blockingLabels': [null],
      'gate.gateStatusChecks': 'not-an-array',
    };

    const settings = readSettings((key) => badValues[key]);

    expect(settings).toEqual({
      url: '',
      tenant: '',
      tokens: {},
      tokenFile: '',
      gheHost: '',
      authMethod: 'auto',
      oauthClientId: '',
      triggerComments: [{ label: 'Recheck', comment: 'recheck', icon: 'refresh' }],
      pinnedArtifacts: ['job-output.txt'],
      gate: {
        requiredApprovals: 1,
        requiredStatusChecks: {},
        requiredLabels: [],
        blockingLabels: ['do-not-merge', 'wip'],
        gateStatusChecks: ['{tenant}/gate'],
      },
      pollIntervalSeconds: 60,
    });
  });

  it('rejects triggerComments with non-object items or non-string icon and non-plain requiredStatusChecks', () => {
    const first = readSettings((key) => {
      if (key === 'triggerComments') {
        return [null];
      }
      if (key === 'gate.requiredStatusChecks') {
        return ['array-instead-of-object'];
      }
      return undefined;
    });
    expect(first.triggerComments).toEqual([
      { label: 'Recheck', comment: 'recheck', icon: 'refresh' },
    ]);
    expect(first.gate.requiredStatusChecks).toEqual({});

    const second = readSettings((key) => {
      if (key === 'triggerComments') {
        return [{ label: 'Recheck', comment: 'recheck', icon: 99 }];
      }
      return undefined;
    });
    expect(second.triggerComments).toEqual([
      { label: 'Recheck', comment: 'recheck', icon: 'refresh' },
    ]);
  });

  it('reads workspace settings from vscode.workspace.getConfiguration("zuul")', () => {
    const map: Record<string, unknown> = {
      url: 'https://zuul.corp.local/',
      tenant: 'main',
    };
    workspace.getConfiguration.mockReturnValueOnce({
      get: vi.fn((key: string) => map[key]),
      update: vi.fn(),
    });

    const settings = readWorkspaceSettings();

    expect(workspace.getConfiguration).toHaveBeenCalledWith('zuul');
    expect(settings.url).toBe('https://zuul.corp.local');
    expect(settings.tenant).toBe('main');
  });

  it('notifies onSettingsChanged callback only when zuul configuration changes', () => {
    let capturedListener: Listener<ConfigurationChangeEvent> | undefined;
    workspace.onDidChangeConfiguration.mockImplementationOnce((listener) => {
      capturedListener = listener;
      return new Disposable();
    });
    workspace.getConfiguration.mockReturnValue({
      get: vi.fn((key: string) => (key === 'url' ? 'https://zuul.internal/' : undefined)),
      update: vi.fn(),
    });

    const cb = vi.fn();
    const disposable = onSettingsChanged(cb);

    expect(disposable).toBeInstanceOf(Disposable);
    expect(capturedListener).toBeDefined();

    capturedListener?.({
      affectsConfiguration: (section) => section === 'editor',
    });
    expect(cb).not.toHaveBeenCalled();

    capturedListener?.({
      affectsConfiguration: (section) => section === 'zuul',
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://zuul.internal',
      }),
    );
  });

  it('notifies onPollIntervalChanged only for zuul.pollIntervalSeconds', () => {
    let capturedListener: Listener<ConfigurationChangeEvent> | undefined;
    workspace.onDidChangeConfiguration.mockImplementationOnce((listener) => {
      capturedListener = listener;
      return new Disposable();
    });
    const changed = (setting: string): ConfigurationChangeEvent => ({
      affectsConfiguration: (section) => section === 'zuul' || section === setting,
    });

    const cb = vi.fn();
    onPollIntervalChanged(cb);

    capturedListener?.(changed('zuul.tokens'));
    expect(cb).not.toHaveBeenCalled();

    capturedListener?.(changed('zuul.pollIntervalSeconds'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('notifies onTokenSettingsChanged only for the settings that decide the tokens', () => {
    let capturedListener: Listener<ConfigurationChangeEvent> | undefined;
    workspace.onDidChangeConfiguration.mockImplementationOnce((listener) => {
      capturedListener = listener;
      return new Disposable();
    });
    const changed = (setting: string): ConfigurationChangeEvent => ({
      affectsConfiguration: (section) => section === 'zuul' || section === setting,
    });

    const cb = vi.fn();
    const disposable = onTokenSettingsChanged(cb);
    expect(disposable).toBeInstanceOf(Disposable);

    capturedListener?.(changed('zuul.pollIntervalSeconds'));
    expect(cb).not.toHaveBeenCalled();

    capturedListener?.(changed('zuul.tokens'));
    expect(cb).toHaveBeenCalledTimes(1);

    capturedListener?.(changed('zuul.tokenFile'));
    expect(cb).toHaveBeenCalledTimes(2);

    capturedListener?.(changed('zuul.auth.method'));
    expect(cb).toHaveBeenCalledTimes(3);
  });
});

describe('readGheHost', () => {
  it('strips scheme and path and keeps a port', () => {
    expect(readGheHost('https://ghe.example.com/')).toBe('ghe.example.com');
    expect(readGheHost(' http://ghe.example.com:8443/api/v3 ')).toBe('ghe.example.com:8443');
    expect(readGheHost('ghe.example.com')).toBe('ghe.example.com');
    expect(readGheHost(42)).toBe('');
  });
});
