import * as vscode from 'vscode';
import { GheClient } from '../clients/gheClient';
import { HttpError } from '../clients/http';
import { ZuulClient } from '../clients/zuulClient';
import { onSettingsChanged, readWorkspaceSettings, type ZuulSettings } from '../config/settings';
import { type GitContext, isSameGitContext } from '../git/gitContext';
import { normalizeHost } from '../git/remoteUrl';
import { type Logger } from '../util/logger';
import { type KeyValueStore, resolveTenant } from './tenantResolver';

export type ContextProblem = 'no-repo' | 'no-zuul-url' | 'no-tenant';

export const SIGN_IN_ACTION = 'Sign in';
export const SIGN_IN_COMMAND = 'zuul.setGhePat';

export interface ResolvedContext extends GitContext {
  zuulUrl: string;
  tenant: string;
  project: string;
  ghe: GheClient;
  zuul: ZuulClient;
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
    a.zuulUrl === b.zuulUrl &&
    a.tenant === b.tenant &&
    a.project === b.project
  );
}

export class ZuulContextService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ResolvedContext | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly gitContext: GitContextSource;
  private readonly auth: AuthLike;
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

  private _current: ResolvedContext | undefined;
  private _problem: ContextProblem | undefined;
  private cachedGheHost: string | undefined;
  private cachedGheClient: GheClient | undefined;
  private cachedZuulUrl: string | undefined;
  private cachedZuulClient: ZuulClient | undefined;
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
    this.logger = options.logger;
    this.cache = options.cache;
    this.getSettings = options.getSettings ?? readWorkspaceSettings;
    this.resolveTenantFn = options.resolveTenantFn ?? resolveTenant;
    this.createGheClient =
      options.createGheClient ??
      ((host, getToken, fetchFn) => new GheClient(host, getToken, fetchFn, this.logger));
    this.createZuulClient =
      options.createZuulClient ??
      ((baseUrl, fetchFn) => new ZuulClient(baseUrl, undefined, fetchFn, undefined, this.logger));
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

  private async init(): Promise<void> {
    await (this.gitContext.ready ?? Promise.resolve());
    if (this.disposed) {
      return;
    }
    await this.recompute();
  }

  async handleGheError(err: unknown, host = this.gitContext.current?.host): Promise<void> {
    if (!(err instanceof HttpError) || err.status !== 401 || !host) {
      return;
    }
    if (this.handledErrors.has(err)) {
      return;
    }
    this.handledErrors.add(err);
    await this.handleUnauthorizedGhe(host);
  }

  private async handleUnauthorizedGhe(host: string): Promise<void> {
    const normalizedHost = normalizeHost(host);
    await this.auth.reportUnauthorized(normalizedHost);
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

  private wrapGheClient(client: GheClient, host: string): GheClient {
    return new Proxy(client, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          try {
            const result = value.apply(target, args);
            if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
              return (result as Promise<unknown>).catch(async (err: unknown) => {
                await this.handleGheError(err, host);
                throw err;
              });
            }
            return result;
          } catch (err) {
            void this.handleGheError(err, host);
            throw err;
          }
        };
      },
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
        const body = await res.text();
        const err = new HttpError(401, body);
        this.handledErrors.add(err);
        await this.handleUnauthorizedGhe(normalizedHost);
        throw err;
      }
      return res;
    };

    const getToken = () => this.auth.getToken(normalizedHost, { interactive: false });
    const rawClient = this.createGheClient(normalizedHost, getToken, wrappedFetch);
    const proxied = this.wrapGheClient(rawClient, normalizedHost);

    this.cachedGheHost = normalizedHost;
    this.cachedGheClient = proxied;
    return proxied;
  }

  private getOrCreateZuulClient(zuulUrl: string): ZuulClient {
    if (this.cachedZuulClient && this.cachedZuulUrl === zuulUrl) {
      return this.cachedZuulClient;
    }
    const client = this.createZuulClient(zuulUrl, this.fetchFn);
    this.cachedZuulUrl = zuulUrl;
    this.cachedZuulClient = client;
    return client;
  }

  private updateState(
    next: ResolvedContext | undefined,
    problem: ContextProblem | undefined,
  ): void {
    const contextChanged = !isSameResolvedContext(this._current, next);
    const problemChanged = this._problem !== problem;
    this._current = next;
    this._problem = problem;
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
    const zuul = this.getOrCreateZuulClient(zuulUrl);
    const ghe = this.getOrCreateGheClient(gitCtx.host);

    let tenant: string | undefined;
    try {
      tenant = await this.resolveTenantFn(zuul, project, settings.tenant, this.cache);
    } catch (err) {
      if (this.disposed || seq !== this.recomputeSeq) {
        return;
      }
      this.logger.error(`[Zuul] Failed to resolve tenant for ${project}`, err);
      this.updateState(undefined, 'no-tenant');
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
      zuulUrl,
      tenant,
      project,
      ghe,
      zuul,
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
