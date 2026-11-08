import * as vscode from 'vscode';
import { type ZuulTokenProvider } from '../auth/zuulTokenProvider';
import { GheClient } from '../clients/gheClient';
import { HttpError } from '../clients/http';
import { ZuulClient } from '../clients/zuulClient';
import { onSettingsChanged, readWorkspaceSettings, type ZuulSettings } from '../config/settings';
import { type GitContext, isSameGitContext } from '../git/gitContext';
import { normalizeHost } from '../git/remoteUrl';
import { type Logger } from '../util/logger';
import { type KeyValueStore, resolveTenant } from './tenantResolver';
import { SIGN_IN_ACTION, type SignInOption } from '../util/commandErrors';

export type ContextProblem = 'no-repo' | 'no-zuul-url' | 'no-tenant';
export type ZuulProblem = 'zuul-auth' | 'zuul-unreachable';

export { SIGN_IN_ACTION };
export const SIGN_IN_COMMAND = 'zuul.setGhePat';
const SET_ZUUL_TOKEN_ACTION = 'Set Zuul Token';
const SET_ZUUL_TOKEN_COMMAND = 'zuul.setTenantToken';

export interface ZuulAccess {
  url: string;
  tenant: string;
  client: ZuulClient;
}

export interface ResolvedContext extends GitContext {
  project: string;
  ghe: GheClient;
  zuul?: ZuulAccess;
}

export interface GitContextSource {
  readonly current: GitContext | undefined;
  readonly onDidChange: vscode.Event<GitContext | undefined>;
  readonly ready?: Promise<void>;
}

export interface AuthLike {
  getToken(host: string, opts?: { interactive: boolean }): Promise<string | undefined>;
  reportUnauthorized(host: string): Promise<void>;
}

export interface ZuulContextServiceOptions {
  gitContext: GitContextSource;
  auth: AuthLike;
  zuulAuth?: Pick<ZuulTokenProvider, 'getTokenCandidates'>;
  logger: Logger;
  cache?: KeyValueStore;
  getSettings?: () => Pick<ZuulSettings, 'url' | 'tenant'>;
  onSettingsChange?: (cb: () => void) => vscode.Disposable;
  resolveTenantFn?: typeof resolveTenant;
  createGheClient?: (
    host: string,
    getToken: () => Promise<string | undefined>,
    fetchFn?: typeof fetch,
  ) => GheClient;
  createZuulClient?: (baseUrl: string, fetchFn?: typeof fetch) => ZuulClient;
  fetchFn?: typeof fetch;
  showErrorMessage?: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined> | Promise<string | undefined> | string | undefined;
  executeCommand?: (command: string, ...rest: unknown[]) => Thenable<unknown> | Promise<unknown>;
}

export function isSameResolvedContext(
  a: ResolvedContext | undefined,
  b: ResolvedContext | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    isSameGitContext(a, b) &&
    a.zuul?.url === b.zuul?.url &&
    a.zuul?.tenant === b.zuul?.tenant &&
    a.project === b.project
  );
}

export class ZuulContextService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ResolvedContext | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly gitContext: GitContextSource;
  private readonly auth: AuthLike;
  private readonly zuulAuth?: Pick<ZuulTokenProvider, 'getTokenCandidates'>;
  private readonly logger: Logger;
  private readonly cache?: KeyValueStore;
  private readonly getSettings: () => Pick<ZuulSettings, 'url' | 'tenant'>;
  private readonly resolveTenantFn: typeof resolveTenant;
  private readonly createGheClient: (
    host: string,
    getToken: () => Promise<string | undefined>,
    fetchFn?: typeof fetch,
  ) => GheClient;
  private readonly createZuulClient: (baseUrl: string, fetchFn?: typeof fetch) => ZuulClient;
  private readonly fetchFn?: typeof fetch;
  private readonly showErrorMessage: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined> | Promise<string | undefined> | string | undefined;
  private readonly executeCommand: (
    command: string,
    ...rest: unknown[]
  ) => Thenable<unknown> | Promise<unknown>;
  private readonly handledErrors = new WeakSet<HttpError>();
  private readonly zuulAuthNotices = new Map<string, string>();
  private readonly gheAuthNotices = new Map<string, string>();

  private _current: ResolvedContext | undefined;
  private _problem: ContextProblem | undefined;
  private _zuulProblem: ZuulProblem | undefined;
  private cachedGheHost: string | undefined;
  private cachedGheClient: GheClient | undefined;
  private cachedZuulUrl: string | undefined;
  private cachedZuulClient: ZuulClient | undefined;
  private cachedRawZuulClient: ZuulClient | undefined;
  private recomputeSeq = 0;
  private disposed = false;

  readonly ready: Promise<void>;
  readonly onDidChange: vscode.Event<ResolvedContext | undefined> = this.emitter.event;

  constructor(options: ZuulContextServiceOptions);
  constructor(
    gitContext: GitContextSource,
    auth: AuthLike,
    logger: Logger,
    cache?: KeyValueStore,
    extra?: Partial<Omit<ZuulContextServiceOptions, 'gitContext' | 'auth' | 'logger' | 'cache'>>,
  );
  constructor(
    optionsOrGitContext: ZuulContextServiceOptions | GitContextSource,
    auth?: AuthLike,
    logger?: Logger,
    cache?: KeyValueStore,
    extra?: Partial<Omit<ZuulContextServiceOptions, 'gitContext' | 'auth' | 'logger' | 'cache'>>,
  ) {
    const options: ZuulContextServiceOptions =
      'gitContext' in optionsOrGitContext
        ? optionsOrGitContext
        : {
            gitContext: optionsOrGitContext,
            auth: auth!,
            logger: logger!,
            cache,
            ...extra,
          };

    this.gitContext = options.gitContext;
    this.auth = options.auth;
    this.zuulAuth = options.zuulAuth;
    this.logger = options.logger;
    this.cache = options.cache;
    this.getSettings = options.getSettings ?? readWorkspaceSettings;
    this.resolveTenantFn = options.resolveTenantFn ?? resolveTenant;
    this.createGheClient =
      options.createGheClient ??
      ((host, getToken, fetchFn) => new GheClient(host, getToken, fetchFn, this.logger));
    this.createZuulClient =
      options.createZuulClient ??
      ((baseUrl, fetchFn) =>
        new ZuulClient(
          baseUrl,
          (tenant) => this.zuulAuth?.getTokenCandidates(tenant) ?? Promise.resolve(undefined),
          fetchFn,
          undefined,
          this.logger,
        ));
    this.fetchFn = options.fetchFn;
    this.showErrorMessage =
      options.showErrorMessage ??
      ((message, ...items) => vscode.window.showErrorMessage(message, ...items));
    this.executeCommand =
      options.executeCommand ??
      ((command, ...rest) => vscode.commands.executeCommand(command, ...rest));

    const subscribeSettings =
      options.onSettingsChange ?? ((cb: () => void) => onSettingsChanged(() => cb()));

    this.disposables.push(
      this.gitContext.onDidChange(() => {
        void this.recompute();
      }),
      subscribeSettings(() => {
        void this.recompute();
      }),
    );

    this.ready = this.init();
  }

  get current(): ResolvedContext | undefined {
    return this._current;
  }

  get problem(): ContextProblem | undefined {
    return this._problem;
  }

  /** Why `current` has no `zuul`, when the GitHub side was published without it. */
  get zuulProblem(): ZuulProblem | undefined {
    return this._zuulProblem;
  }

  private async init(): Promise<void> {
    await (this.gitContext.ready ?? Promise.resolve());
    if (this.disposed) {
      return;
    }
    await this.recompute();
  }

  private async handleUnauthorizedGhe(host: string, authorization: string): Promise<void> {
    const normalizedHost = normalizeHost(host);
    await this.auth.reportUnauthorized(normalizedHost);
    if (this.gheAuthNotices.get(normalizedHost) === authorization) {
      return;
    }
    this.gheAuthNotices.set(normalizedHost, authorization);
    void Promise.resolve(
      this.showErrorMessage(
        `GitHub Enterprise authentication failed for ${normalizedHost}.`,
        SIGN_IN_ACTION,
      ),
    ).then(async (action) => {
      if (action === SIGN_IN_ACTION) {
        await this.executeCommand(SIGN_IN_COMMAND, normalizedHost);
      }
    });
  }

  private getOrCreateGheClient(host: string): GheClient {
    const normalizedHost = normalizeHost(host);
    if (this.cachedGheClient && this.cachedGheHost === normalizedHost) {
      return this.cachedGheClient;
    }

    const baseFetch = this.fetchFn ?? globalThis.fetch;
    const wrappedFetch: typeof fetch = async (input, init) => {
      const res = await baseFetch(input, init);
      if (res.status === 401) {
        const headers = new Headers(init?.headers);
        const authorization = headers.get('authorization');
        if (authorization) {
          await this.handleUnauthorizedGhe(normalizedHost, authorization);
        }
      }
      return res;
    };

    const getToken = () => this.auth.getToken(normalizedHost, { interactive: false });
    const client = this.createGheClient(normalizedHost, getToken, wrappedFetch);

    this.cachedGheHost = normalizedHost;
    this.cachedGheClient = client;
    return client;
  }

  async handleZuulError(err: unknown, tenant?: string): Promise<void> {
    if (!(err instanceof HttpError) || (err.status !== 401 && err.status !== 403)) {
      return;
    }
    if (this.handledErrors.has(err)) {
      return;
    }
    this.handledErrors.add(err);
    await this.handleUnauthorizedZuul(err.status, tenant);
  }

  private async handleUnauthorizedZuul(status: 401 | 403, tenant?: string): Promise<void> {
    let noticeValue: string;
    try {
      noticeValue = (await this.zuulAuth?.getTokenCandidates(tenant))?.join('\n') ?? '';
    } catch {
      noticeValue = '';
    }
    const key = tenant ?? '';
    if (this.zuulAuthNotices.get(key) === noticeValue) {
      return;
    }
    this.zuulAuthNotices.set(key, noticeValue);

    const tenantLabel = tenant ? `tenant "${tenant}"` : 'Zuul';
    this.logger.warn(`[Zuul] Authentication failed (${status}) for ${tenantLabel}`);
    let message: string;
    if (status === 401) {
      message = tenant
        ? `Zuul authentication failed for tenant "${tenant}".`
        : 'Zuul authentication failed.';
    } else {
      message = tenant
        ? `Your Zuul token has no access to tenant "${tenant}".`
        : 'Your Zuul token was refused.';
    }
    void Promise.resolve(this.showErrorMessage(message, SET_ZUUL_TOKEN_ACTION)).then(
      async (action) => {
        if (action === SET_ZUUL_TOKEN_ACTION) {
          await this.executeCommand(SET_ZUUL_TOKEN_COMMAND, tenant);
        }
      },
    );
  }

  /** A Zuul auth failure needs a Zuul token. Everything else is a GitHub sign-in. */
  signInFor(err: unknown): SignInOption {
    return err instanceof HttpError && this.handledErrors.has(err)
      ? { label: SET_ZUUL_TOKEN_ACTION, command: SET_ZUUL_TOKEN_COMMAND }
      : { label: SIGN_IN_ACTION, command: SIGN_IN_COMMAND };
  }

  private wrapZuulClient(client: ZuulClient): ZuulClient {
    return new Proxy(client, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          const tenant = typeof args[0] === 'string' ? args[0] : undefined;
          try {
            const result = value.apply(target, args);
            if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
              return (result as Promise<unknown>).catch(async (err: unknown) => {
                await this.handleZuulError(err, tenant);
                throw err;
              });
            }
            return result;
          } catch (err) {
            void this.handleZuulError(err, tenant);
            throw err;
          }
        };
      },
    });
  }

  private getOrCreateZuulClient(zuulUrl: string): { proxied: ZuulClient; raw: ZuulClient } {
    if (this.cachedZuulClient && this.cachedRawZuulClient && this.cachedZuulUrl === zuulUrl) {
      return { proxied: this.cachedZuulClient, raw: this.cachedRawZuulClient };
    }
    if (/^http:\/\//i.test(zuulUrl)) {
      this.logger.warn('[Zuul] zuul.url uses http://, so Zuul tokens are sent unencrypted');
    }
    const rawClient = this.createZuulClient(zuulUrl, this.fetchFn);
    const proxied = this.wrapZuulClient(rawClient);
    this.cachedZuulUrl = zuulUrl;
    this.cachedZuulClient = proxied;
    this.cachedRawZuulClient = rawClient;
    return { proxied, raw: rawClient };
  }

  private updateState(
    next: ResolvedContext | undefined,
    problem: ContextProblem | undefined,
    zuulProblem?: ZuulProblem,
  ): void {
    const contextChanged = !isSameResolvedContext(this._current, next);
    const problemChanged = this._problem !== problem || this._zuulProblem !== zuulProblem;
    this._current = next;
    this._problem = problem;
    this._zuulProblem = zuulProblem;
    if (contextChanged || problemChanged) {
      this.emitter.fire(this._current);
    }
  }

  async recompute(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const seq = ++this.recomputeSeq;
    const gitCtx = this.gitContext.current;
    if (!gitCtx) {
      if (this._problem !== 'no-repo') {
        this.logger.info(
          '[Zuul] No git repository with a GitHub remote found in workspace (waiting for repository)',
        );
      }
      this.updateState(undefined, 'no-repo');
      return;
    }

    const settings = this.getSettings();
    const zuulUrl = settings.url.trim().replace(/\/+$/, '');
    if (!zuulUrl) {
      if (this._problem !== 'no-zuul-url') {
        this.logger.info('[Zuul] Setting "zuul.url" is not configured');
      }
      this.updateState(undefined, 'no-zuul-url');
      return;
    }

    const project = `${gitCtx.owner}/${gitCtx.repo}`;
    this.logger.info(
      `[Zuul] Resolving context for owner=${gitCtx.owner} repo=${gitCtx.repo} branch=${gitCtx.branch ?? 'none'} host=${gitCtx.host} (zuulUrl=${zuulUrl})`,
    );
    const { proxied: zuul, raw: rawZuul } = this.getOrCreateZuulClient(zuulUrl);
    const ghe = this.getOrCreateGheClient(gitCtx.host);

    let tenant: string | undefined;
    try {
      tenant = await this.resolveTenantFn(
        rawZuul,
        gitCtx.host,
        project,
        settings.tenant,
        this.cache,
      );
    } catch (err) {
      if (this.disposed || seq !== this.recomputeSeq) {
        return;
      }
      this.logger.error(`[Zuul] Failed to resolve tenant for ${project}`, err);
      const authFailure = err instanceof HttpError && (err.status === 401 || err.status === 403);
      // GitHub features don't need Zuul, so publish the context without it.
      this.updateState(
        { ...gitCtx, project, ghe },
        undefined,
        authFailure ? 'zuul-auth' : 'zuul-unreachable',
      );
      await this.handleZuulError(err);
      return;
    }

    if (this.disposed || seq !== this.recomputeSeq) {
      return;
    }

    if (!tenant) {
      this.logger.warn(`[Zuul] Could not resolve tenant for ${project} on ${zuulUrl}`);
      this.updateState(undefined, 'no-tenant');
      return;
    }

    const resolved: ResolvedContext = {
      ...gitCtx,
      project,
      ghe,
      zuul: { url: zuulUrl, tenant, client: zuul },
    };

    const changed = !isSameResolvedContext(this._current, resolved);
    this.updateState(resolved, undefined);
    if (changed) {
      this.logger.info(`[Zuul] Resolved context: tenant=${tenant} project=${project} (${zuulUrl})`);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const sub of this.disposables) {
      sub.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}
