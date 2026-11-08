import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/clients/http';
import { type ZuulClient } from '../../src/clients/zuulClient';
import {
  type AuthLike,
  type GitContextSource,
  isSameResolvedContext,
  type ResolvedContext,
  SIGN_IN_ACTION,
  SIGN_IN_COMMAND,
  ZuulContextService,
  type ZuulContextServiceOptions,
} from '../../src/context/zuulContext';
import { resolveTenant } from '../../src/context/tenantResolver';
import { type GitContext } from '../../src/git/gitContext';
import { createFakeLogger, type FakeLogger } from '../helpers';
import { EventEmitter } from '../mocks/vscode';

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
    expect(
      logger.messages.some((m) => m.includes('No git repository with a GitHub remote found')),
    ).toBe(true);
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
    expect(logger.messages.some((m) => m.includes('Setting "zuul.url" is not configured'))).toBe(
      true,
    );
    expect(events).toEqual([undefined]);
    service.dispose();
  });

  it('publishes GitHub without Zuul when tenant discovery throws', async () => {
    const { source } = createFakeGitSource(sampleGitCtx);
    const auth: AuthLike = {
      getToken: vi.fn(async () => undefined),
      reportUnauthorized: vi.fn(async () => undefined),
    };
    let error: unknown = new Error('network boom');
    const service = new ZuulContextService({
      gitContext: source,
      auth,
      logger: createFakeLogger(),
      getSettings: () => ({ url: 'https://zuul.example.com', tenant: '' }),
      onSettingsChange: () => ({ dispose: () => undefined }),
      showErrorMessage: vi.fn(async () => undefined),
      resolveTenantFn: vi.fn(async () => {
        throw error;
      }),
    });

    const events: (ResolvedContext | undefined)[] = [];
    service.onDidChange((ctx) => events.push(ctx));

    await service.ready;
    expect(service.problem).toBeUndefined();
    expect(service.zuulProblem).toBe('zuul-unreachable');
    expect(events).toHaveLength(1);

    error = new HttpError(503, 'Unavailable');
    await service.recompute();
    expect(service.zuulProblem).toBe('zuul-unreachable');
    expect(events).toHaveLength(1);

    error = new HttpError(401, 'Unauthorized');
    await service.recompute();
    expect(service.problem).toBeUndefined();
    expect(service.zuulProblem).toBe('zuul-auth');
    expect(service.current?.ghe).toBeDefined();
    expect(service.current?.project).toBe('acme/service');
    expect(service.current?.zuul).toBeUndefined();
    // Only the Zuul problem changed, and that alone must still reach the listeners.
    expect(events).toHaveLength(2);

    error = new HttpError(403, 'Forbidden');
    await service.recompute();
    expect(service.zuulProblem).toBe('zuul-auth');
    service.dispose();
  });

  it('clears the Zuul problem and adds Zuul once discovery works again', async () => {
    const { source } = createFakeGitSource(sampleGitCtx);
    let fail = true;
    const service = new ZuulContextService({
      gitContext: source,
      auth: { getToken: vi.fn(async () => 't'), reportUnauthorized: vi.fn(async () => undefined) },
      logger: createFakeLogger(),
      getSettings: () => ({ url: 'https://zuul.example.com', tenant: '' }),
      onSettingsChange: () => ({ dispose: () => undefined }),
      showErrorMessage: vi.fn(async () => undefined),
      resolveTenantFn: vi.fn(async () => {
        if (fail) {
          throw new HttpError(401, 'Unauthorized');
        }
        return 'main';
      }),
    });
    await service.ready;
    expect(service.zuulProblem).toBe('zuul-auth');

    fail = false;
    await service.recompute();

    expect(service.zuulProblem).toBeUndefined();
    expect(service.current?.zuul?.tenant).toBe('main');
    service.dispose();
  });

  it('sets problem to no-tenant when the tenant cannot be resolved, and unreachable when it throws', async () => {
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
    expect(service.current?.zuul).toBeUndefined();
    expect(service.current?.ghe).toBeDefined();
    expect(service.problem).toBeUndefined();
    expect(service.zuulProblem).toBe('zuul-unreachable');
    expect(logger.messages.some((m) => m.includes('Failed to resolve tenant'))).toBe(true);

    shouldThrow = false;
    await service.recompute();
    expect(service.current).toBeUndefined();
    expect(service.problem).toBe('no-tenant');
    expect(service.zuulProblem).toBeUndefined();

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
    const resolveTenantFn = vi.fn(async (_zuul, _host, _project, configured?: string) => {
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
    expect(resolveTenantFn).toHaveBeenCalledWith(
      expect.anything(),
      sampleGitCtx.host,
      'acme/service',
      '',
      undefined,
    );
    expect(service.problem).toBeUndefined();
    expect(firstResolved.zuul?.url).toBe('https://zuul.example.com');
    expect(firstResolved.zuul?.tenant).toBe('auto-tenant');
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
    expect(service.current?.zuul?.client).toBe(firstResolved.zuul?.client);

    service.dispose();
  });

  function createGheService(
    token: () => string | undefined,
    fetchFn: typeof fetch,
    showErrorMessage?: ZuulContextServiceOptions['showErrorMessage'],
  ) {
    const { source } = createFakeGitSource(sampleGitCtx);
    const auth: AuthLike = {
      getToken: vi.fn(async () => token()),
      reportUnauthorized: vi.fn(async () => undefined),
    };
    const executeCommand = vi.fn();
    const show = vi.fn(showErrorMessage ?? (async () => undefined));
    const service = new ZuulContextService({
      gitContext: source,
      auth,
      logger: createFakeLogger(),
      getSettings: () => ({ url: 'https://zuul.example.com', tenant: 'main' }),
      fetchFn,
      showErrorMessage: show,
      executeCommand,
    });
    return { service, auth, show, executeCommand };
  }

  const unauthorizedFetch = () =>
    vi.fn<typeof fetch>(async () => new Response('{"message":"Bad credentials"}', { status: 401 }));

  it('reports a 401 with a token, toasts once, and offers Sign in', async () => {
    const { service, auth, show, executeCommand } = createGheService(
      () => 'expired-token',
      unauthorizedFetch(),
      async () => SIGN_IN_ACTION,
    );
    await service.ready;

    await expect(service.current!.ghe.getUser()).rejects.toThrow(HttpError);
    await expect(service.current!.ghe.getUser()).rejects.toThrow(HttpError);
    await expect(service.current!.ghe.getUser()).rejects.toThrow(HttpError);

    expect(auth.getToken).toHaveBeenCalledWith('ghe.example.com', { interactive: false });
    expect(auth.reportUnauthorized).toHaveBeenCalledTimes(3);
    expect(auth.reportUnauthorized).toHaveBeenCalledWith('ghe.example.com');
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(
      'GitHub Enterprise authentication failed for ghe.example.com.',
      SIGN_IN_ACTION,
    );
    await vi.waitFor(() => {
      expect(executeCommand).toHaveBeenCalledWith(SIGN_IN_COMMAND, 'ghe.example.com');
    });
    service.dispose();
  });

  it('toasts again when the token changed', async () => {
    let token = 'one';
    const { service, auth, show } = createGheService(() => token, unauthorizedFetch());
    await service.ready;

    await expect(service.current!.ghe.getUser()).rejects.toThrow(HttpError);
    token = 'two';
    await expect(service.current!.ghe.getUser()).rejects.toThrow(HttpError);

    expect(show).toHaveBeenCalledTimes(2);
    expect(auth.reportUnauthorized).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('gives no toast and no report for a 401 without a token', async () => {
    const { service, auth, show } = createGheService(() => undefined, unauthorizedFetch());
    await service.ready;

    await expect(service.current!.ghe.getUser()).rejects.toThrow(HttpError);

    expect(auth.reportUnauthorized).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    service.dispose();
  });

  it('does not trigger reportUnauthorized on a non-401 error', async () => {
    const { service, auth, show } = createGheService(
      () => 'token',
      vi.fn<typeof fetch>(async () => new Response('Not Found', { status: 404 })),
    );
    await service.ready;

    await expect(service.current!.ghe.getUser()).rejects.toThrow(HttpError);

    expect(auth.reportUnauthorized).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    service.dispose();
  });

  it('compares ResolvedContext values accurately with isSameResolvedContext', () => {
    const access = { url: 'https://zuul.example.com', tenant: 'main', client: {} as ZuulClient };
    const a: ResolvedContext = {
      ...sampleGitCtx,
      project: 'acme/service',
      ghe: {} as ResolvedContext['ghe'],
      zuul: access,
    };

    expect(isSameResolvedContext(undefined, undefined)).toBe(true);
    expect(isSameResolvedContext(a, undefined)).toBe(false);
    expect(isSameResolvedContext(undefined, a)).toBe(false);
    expect(isSameResolvedContext(a, { ...a })).toBe(true);
    expect(isSameResolvedContext(a, { ...a, zuul: { ...access, tenant: 'other' } })).toBe(false);
    expect(
      isSameResolvedContext(a, { ...a, zuul: { ...access, url: 'https://zuul2.example.com' } }),
    ).toBe(false);
    expect(isSameResolvedContext(a, { ...a, zuul: undefined })).toBe(false);
    expect(isSameResolvedContext({ ...a, zuul: undefined }, { ...a, zuul: undefined })).toBe(true);
  });

  it('prompts user to set Zuul token when a Zuul client request returns 401', async () => {
    const { source } = createFakeGitSource(sampleGitCtx);
    const auth: AuthLike = {
      getToken: vi.fn(async () => 'ghe-token'),
      reportUnauthorized: vi.fn(async () => undefined),
    };
    const logger = createFakeLogger();
    const executeCommand = vi.fn();
    const showErrorMessage = vi.fn(async (_msg: string, ..._items: string[]) => 'Set Zuul Token');

    const service = new ZuulContextService({
      gitContext: source,
      auth,
      logger,
      getSettings: () => ({ url: 'https://zuul.example.com', tenant: 'ddad' }),
      createZuulClient: () =>
        ({
          listBuilds: vi.fn(async () => {
            throw new HttpError(401, 'Unauthorized');
          }),
        }) as unknown as ZuulClient,
      showErrorMessage,
      executeCommand,
    });

    await service.ready;
    expect(service.current).toBeDefined();

    await expect(service.current!.zuul!.client.listBuilds('ddad')).rejects.toThrow(HttpError);
    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Zuul authentication failed for tenant "ddad"'),
      'Set Zuul Token',
    );
    expect(executeCommand).toHaveBeenCalledWith('zuul.setTenantToken', 'ddad');

    service.dispose();
  });

  it('offers a Zuul token for a Zuul auth failure and a GitHub sign-in otherwise', async () => {
    const { source } = createFakeGitSource(sampleGitCtx);
    const auth: AuthLike = {
      getToken: vi.fn(async () => 'ghe-token'),
      reportUnauthorized: vi.fn(async () => undefined),
    };
    const service = new ZuulContextService({
      gitContext: source,
      auth,
      logger: createFakeLogger(),
      getSettings: () => ({ url: 'https://zuul.example.com', tenant: 'ddad' }),
      createZuulClient: () =>
        ({
          listBuilds: vi.fn(async () => {
            throw new HttpError(401, 'Unauthorized');
          }),
        }) as unknown as ZuulClient,
      showErrorMessage: vi.fn(async () => undefined),
      executeCommand: vi.fn(),
    });

    await service.ready;
    const zuulError: unknown = await service
      .current!.zuul!.client.listBuilds('ddad')
      .catch((e) => e);

    expect(zuulError).toBeInstanceOf(HttpError);
    expect(service.signInFor(zuulError)).toEqual({
      label: 'Set Zuul Token',
      command: 'zuul.setTenantToken',
    });
    expect(service.signInFor(new HttpError(401, 'Unauthorized'))).toEqual({
      label: SIGN_IN_ACTION,
      command: SIGN_IN_COMMAND,
    });

    service.dispose();
  });

  function createZuulAuthService(opts: {
    listBuilds: () => Promise<unknown>;
    candidates?: () => Promise<string[]>;
    tenant?: string;
    url?: string;
    showErrorMessage?: (message: string, ...items: string[]) => Promise<string | undefined>;
    resolveTenantFn?: ZuulContextServiceOptions['resolveTenantFn'];
    createZuulClient?: ZuulContextServiceOptions['createZuulClient'];
    logger?: FakeLogger;
  }) {
    const { source } = createFakeGitSource(sampleGitCtx);
    const showErrorMessage = vi.fn(
      opts.showErrorMessage ?? (async (_message: string, ..._items: string[]) => undefined),
    );
    const service = new ZuulContextService({
      gitContext: source,
      auth: { getToken: vi.fn(async () => 't'), reportUnauthorized: vi.fn(async () => undefined) },
      zuulAuth: { getTokenCandidates: vi.fn(opts.candidates ?? (async () => ['a'])) },
      logger: opts.logger ?? createFakeLogger(),
      getSettings: () => ({
        url: opts.url ?? 'https://zuul.example.com',
        tenant: opts.tenant ?? 'ddad',
      }),
      resolveTenantFn: opts.resolveTenantFn,
      createZuulClient:
        opts.createZuulClient ?? (() => ({ listBuilds: opts.listBuilds }) as unknown as ZuulClient),
      showErrorMessage,
      executeCommand: vi.fn(),
    });
    return { service, showErrorMessage };
  }

  it('shows one popup for repeated 401s with the same candidates', async () => {
    const { service, showErrorMessage } = createZuulAuthService({
      listBuilds: async () => {
        throw new HttpError(401, 'Unauthorized');
      },
    });
    await service.ready;
    for (let i = 0; i < 3; i++) {
      await expect(service.current!.zuul!.client.listBuilds('ddad')).rejects.toThrow(HttpError);
    }
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('shows a second popup when the candidate list changed', async () => {
    let candidates = ['a'];
    const { service, showErrorMessage } = createZuulAuthService({
      candidates: async () => candidates,
      listBuilds: async () => {
        throw new HttpError(401, 'Unauthorized');
      },
    });
    await service.ready;
    await expect(service.current!.zuul!.client.listBuilds('ddad')).rejects.toThrow(HttpError);
    candidates = ['a', 'b'];
    await expect(service.current!.zuul!.client.listBuilds('ddad')).rejects.toThrow(HttpError);
    expect(showErrorMessage).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('shows the no-access popup for a 403', async () => {
    const { service, showErrorMessage } = createZuulAuthService({
      tenant: 'swh',
      listBuilds: async () => {
        throw new HttpError(403, 'Forbidden');
      },
    });
    await service.ready;
    await expect(service.current!.zuul!.client.listBuilds('swh')).rejects.toThrow(HttpError);
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Your Zuul token has no access to tenant "swh".',
      'Set Zuul Token',
    );
    service.dispose();
  });

  it('gives a GitHub-only context and one popup when detection gets 401 for all tenants', async () => {
    const raw = {
      baseUrl: 'https://zuul.example.com',
      listTenants: vi.fn(async () => [{ name: 'alpha' }, { name: 'beta' }]),
      listProjects: vi.fn(async () => {
        throw new HttpError(401, 'Unauthorized');
      }),
    };
    const { service, showErrorMessage } = createZuulAuthService({
      tenant: '',
      listBuilds: async () => [],
      resolveTenantFn: resolveTenant,
      createZuulClient: () => raw as unknown as ZuulClient,
    });
    await service.ready;
    expect(service.problem).toBeUndefined();
    expect(service.zuulProblem).toBe('zuul-auth');
    expect(service.current?.ghe).toBeDefined();
    expect(service.current?.zuul).toBeUndefined();
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(showErrorMessage).toHaveBeenCalledWith('Zuul authentication failed.', 'Set Zuul Token');
    service.dispose();
  });

  it('resolves without a popup when detection skips a forbidden tenant', async () => {
    const raw = {
      baseUrl: 'https://zuul.example.com',
      listTenants: vi.fn(async () => [{ name: 'alpha' }, { name: 'beta' }]),
      listProjects: vi.fn(async (tenant: string) => {
        if (tenant === 'alpha') {
          throw new HttpError(403, 'Forbidden');
        }
        return [{ name: 'acme/service' }];
      }),
    };
    const { service, showErrorMessage } = createZuulAuthService({
      tenant: '',
      listBuilds: async () => [],
      resolveTenantFn: resolveTenant,
      createZuulClient: () => raw as unknown as ZuulClient,
    });
    await service.ready;
    expect(service.current?.zuul?.tenant).toBe('beta');
    expect(showErrorMessage).not.toHaveBeenCalled();
    service.dispose();
  });

  it('warns when zuul.url uses http://', async () => {
    const logger = createFakeLogger();
    const { service } = createZuulAuthService({
      url: 'HTTP://zuul.example.com',
      listBuilds: async () => [],
      logger,
    });
    await service.ready;
    expect(logger.messages).toContain(
      'WARN: [Zuul] zuul.url uses http://, so Zuul tokens are sent unencrypted',
    );
    service.dispose();
  });
});
