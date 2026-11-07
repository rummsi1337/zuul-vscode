import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/clients/http';
import {
  type AuthLike,
  type GitContextSource,
  isSameResolvedContext,
  type ResolvedContext,
  SIGN_IN_ACTION,
  SIGN_IN_COMMAND,
  ZuulContextService,
} from '../../src/context/zuulContext';
import { type GitContext } from '../../src/git/gitContext';
import { type Logger } from '../../src/util/logger';
import { commands, EventEmitter, window } from '../mocks/vscode';

function createFakeLogger(): Logger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: vi.fn((m: string) => messages.push(`INFO: ${m}`)),
    warn: vi.fn((m: string) => messages.push(`WARN: ${m}`)),
    error: vi.fn((m: string) => messages.push(`ERROR: ${m}`)),
  };
}

function createFakeGitSource(initial?: GitContext): {
  source: GitContextSource;
  setContext: (ctx: GitContext | undefined) => void;
} {
  let current = initial;
  const emitter = new EventEmitter<GitContext | undefined>();
  return {
    source: {
      get current() {
        return current;
      },
      onDidChange: emitter.event,
    },
    setContext: (ctx) => {
      current = ctx;
      emitter.fire(ctx);
    },
  };
}

const sampleGitCtx: GitContext = {
  repoRoot: '/workspace/service',
  host: 'ghe.example.com',
  owner: 'acme',
  repo: 'service',
  branch: 'feat/login',
  headSha: 'abc1234',
};

describe('ZuulContextService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets problem to no-repo when there is no git context', async () => {
    const { source } = createFakeGitSource(undefined);
    const auth: AuthLike = {
      getToken: vi.fn(async () => undefined),
      reportUnauthorized: vi.fn(async () => undefined),
    };
    const logger = createFakeLogger();

    const service = new ZuulContextService({
      gitContext: source,
      auth,
      logger,
      getSettings: () => ({ url: 'https://zuul.example.com', tenant: '' }),
    });

    await service.ready;

    expect(service.current).toBeUndefined();
    expect(service.problem).toBe('no-repo');
    service.dispose();
  });

  it('sets problem to no-zuul-url when zuul.url is empty', async () => {
    const { source } = createFakeGitSource(sampleGitCtx);
    const auth: AuthLike = {
      getToken: vi.fn(async () => undefined),
      reportUnauthorized: vi.fn(async () => undefined),
    };
    const logger = createFakeLogger();
    const events: (ResolvedContext | undefined)[] = [];

    const service = new ZuulContextService({
      gitContext: source,
      auth,
      logger,
      getSettings: () => ({ url: '   ', tenant: '' }),
    });
    service.onDidChange((ctx) => events.push(ctx));

    await service.ready;

    expect(service.current).toBeUndefined();
    expect(service.problem).toBe('no-zuul-url');
    expect(events).toEqual([undefined]);
    service.dispose();
  });

  it('sets problem to no-tenant when tenant cannot be resolved or throws', async () => {
    const { source } = createFakeGitSource(sampleGitCtx);
    const auth: AuthLike = {
      getToken: vi.fn(async () => undefined),
      reportUnauthorized: vi.fn(async () => undefined),
    };
    const logger = createFakeLogger();
    const settingsEmitter = new EventEmitter<void>();
    let shouldThrow = false;

    const service = new ZuulContextService({
      gitContext: source,
      auth,
      logger,
      getSettings: () => ({ url: 'https://zuul.example.com', tenant: '' }),
      onSettingsChange: (cb) => settingsEmitter.event(cb),
      resolveTenantFn: vi.fn(async () => {
        if (shouldThrow) {
          throw new Error('network boom');
        }
        return undefined;
      }),
    });

    await service.ready;
    expect(service.current).toBeUndefined();
    expect(service.problem).toBe('no-tenant');

    shouldThrow = true;
    await service.recompute();
    expect(service.current).toBeUndefined();
    expect(service.problem).toBe('no-tenant');
    expect(logger.messages.some((m) => m.includes('Failed to resolve tenant'))).toBe(true);

    service.dispose();
  });

  it('resolves context and recomputes when git context or settings change', async () => {
    const { source, setContext } = createFakeGitSource(sampleGitCtx);
    const settingsEmitter = new EventEmitter<void>();
    const auth: AuthLike = {
      getToken: vi.fn(async () => 'token-1'),
      reportUnauthorized: vi.fn(async () => undefined),
    };
    const logger = createFakeLogger();

    let settings = { url: '', tenant: '' };
    const resolveTenantFn = vi.fn(async (_zuul, _project, configured?: string) => {
      return configured || 'auto-tenant';
    });

    const service = new ZuulContextService(source, auth, logger, undefined, {
      getSettings: () => settings,
      onSettingsChange: (cb) => settingsEmitter.event(cb),
      resolveTenantFn,
    });

    const events: (ResolvedContext | undefined)[] = [];
    service.onDidChange((ctx) => events.push(ctx));

    await service.ready;
    expect(service.problem).toBe('no-zuul-url');
    expect(service.current).toBeUndefined();

    // Update settings with Zuul URL
    settings = { url: 'https://zuul.example.com/', tenant: '' };
    settingsEmitter.fire();
    await vi.waitFor(() => {
      expect(service.current).toBeDefined();
    });

    const firstResolved = service.current!;
    expect(service.problem).toBeUndefined();
    expect(firstResolved.zuulUrl).toBe('https://zuul.example.com');
    expect(firstResolved.tenant).toBe('auto-tenant');
    expect(firstResolved.project).toBe('acme/service');
    expect(firstResolved.branch).toBe('feat/login');

    // Recompute with identical state should not emit again
    const eventCountBefore = events.length;
    await service.recompute();
    expect(events).toHaveLength(eventCountBefore);

    // Branch change in same repo reuses ghe and zuul clients
    setContext({ ...sampleGitCtx, branch: 'feat/next', headSha: 'def5678' });
    await vi.waitFor(() => {
      expect(service.current?.branch).toBe('feat/next');
    });
    expect(service.current?.ghe).toBe(firstResolved.ghe);
    expect(service.current?.zuul).toBe(firstResolved.zuul);

    service.dispose();
  });

  it('passes interactive: false to auth.getToken and handles 401 from GHE with Sign in action', async () => {
    const { source } = createFakeGitSource(sampleGitCtx);
    const auth: AuthLike = {
      getToken: vi.fn(async () => 'expired-token'),
      reportUnauthorized: vi.fn(async () => undefined),
    };
    const logger = createFakeLogger();

    const fetchFn = vi.fn<typeof fetch>(async () => {
      return new Response('{"message":"Bad credentials"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    window.showErrorMessage.mockResolvedValueOnce(SIGN_IN_ACTION);

    const service = new ZuulContextService({
      gitContext: source,
      auth,
      logger,
      getSettings: () => ({ url: 'https://zuul.example.com', tenant: 'main' }),
      fetchFn,
    });

    await service.ready;
    const ctx = service.current!;
    expect(ctx).toBeDefined();

    await expect(ctx.ghe.getUser()).rejects.toThrow(HttpError);

    expect(auth.getToken).toHaveBeenCalledWith('ghe.example.com', { interactive: false });
    expect(auth.reportUnauthorized).toHaveBeenCalledTimes(1);
    expect(auth.reportUnauthorized).toHaveBeenCalledWith('ghe.example.com');
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      'GitHub Enterprise authentication failed for ghe.example.com.',
      SIGN_IN_ACTION,
    );
    expect(commands.executeCommand).toHaveBeenCalledWith(SIGN_IN_COMMAND, 'ghe.example.com');

    service.dispose();
  });

  it('does not trigger reportUnauthorized on non-401 HttpError and handles direct HttpError(401)', async () => {
    const { source } = createFakeGitSource(sampleGitCtx);
    const auth: AuthLike = {
      getToken: vi.fn(async () => 'token'),
      reportUnauthorized: vi.fn(async () => undefined),
    };
    const logger = createFakeLogger();

    const fetchFn = vi.fn<typeof fetch>(async () => {
      return new Response('Not Found', { status: 404 });
    });

    const service = new ZuulContextService({
      gitContext: source,
      auth,
      logger,
      getSettings: () => ({ url: 'https://zuul.example.com', tenant: 'main' }),
      fetchFn,
    });

    await service.ready;
    await expect(service.current!.ghe.getUser()).rejects.toThrow(HttpError);
    expect(auth.reportUnauthorized).not.toHaveBeenCalled();

    // Direct handleGheError with 401 when user dismisses prompt or leaves toast open
    window.showErrorMessage.mockImplementationOnce(() => new Promise(() => undefined));
    await service.handleGheError(new HttpError(401, 'Unauthorized'));
    expect(auth.reportUnauthorized).toHaveBeenCalledTimes(1);
    expect(commands.executeCommand).not.toHaveBeenCalled();

    service.dispose();
  });

  it('compares ResolvedContext values accurately with isSameResolvedContext', () => {
    const a = {
      ...sampleGitCtx,
      zuulUrl: 'https://zuul.example.com',
      tenant: 'main',
      project: 'acme/service',
      ghe: {} as ResolvedContext['ghe'],
      zuul: {} as ResolvedContext['zuul'],
    };

    expect(isSameResolvedContext(undefined, undefined)).toBe(true);
    expect(isSameResolvedContext(a, undefined)).toBe(false);
    expect(isSameResolvedContext(undefined, a)).toBe(false);
    expect(isSameResolvedContext(a, { ...a })).toBe(true);
    expect(isSameResolvedContext(a, { ...a, tenant: 'other' })).toBe(false);
    expect(isSameResolvedContext(a, { ...a, zuulUrl: 'https://zuul2.example.com' })).toBe(false);
  });
});
