import * as vscode from 'vscode';
import { onSettingsChanged, readWorkspaceSettings } from '../config/settings';
import { type API, getGitApi, type Repository } from './gitApi';
import { normalizeHost, parseRemoteUrl } from './remoteUrl';

export interface GitContext {
  repoRoot: string;
  host: string;
  owner: string;
  repo: string;
  branch?: string;
  headSha?: string;
}

export interface RepoLike {
  readonly rootUri: { readonly fsPath: string };
  readonly state: {
    readonly HEAD?: {
      readonly name?: string;
      readonly commit?: string;
    };
    readonly remotes: readonly {
      readonly name: string;
      readonly fetchUrl?: string;
      readonly pushUrl?: string;
    }[];
  };
}

export function computeGitContext(repo: RepoLike, hostOverride?: string): GitContext | undefined {
  const remotes = repo.state.remotes;
  if (remotes.length === 0) {
    return undefined;
  }

  const selectedRemote = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  const remoteUrl = selectedRemote.fetchUrl ?? selectedRemote.pushUrl;
  if (!remoteUrl) {
    return undefined;
  }

  const parsed = parseRemoteUrl(remoteUrl);
  if (!parsed) {
    return undefined;
  }

  const trimmedOverride = hostOverride?.trim();
  const host = trimmedOverride ? normalizeHost(trimmedOverride) : parsed.host;

  const context: GitContext = {
    repoRoot: repo.rootUri.fsPath,
    host,
    owner: parsed.owner,
    repo: parsed.repo,
  };

  if (repo.state.HEAD?.name) {
    context.branch = repo.state.HEAD.name;
  }
  if (repo.state.HEAD?.commit) {
    context.headSha = repo.state.HEAD.commit;
  }

  return context;
}

export function isSameGitContext(a: GitContext | undefined, b: GitContext | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.repoRoot === b.repoRoot &&
    a.host === b.host &&
    a.owner === b.owner &&
    a.repo === b.repo &&
    a.branch === b.branch &&
    a.headSha === b.headSha
  );
}

export function selectRepository<T extends { readonly rootUri: { readonly fsPath: string } }>(
  repositories: readonly T[],
  firstWorkspaceFolderPath?: string,
): T | undefined {
  if (repositories.length === 0) {
    return undefined;
  }
  if (firstWorkspaceFolderPath) {
    const normalizedFolder = firstWorkspaceFolderPath.replace(/[\\/]+$/, '');
    const match = repositories.find((repo) => {
      const normalizedRoot = repo.rootUri.fsPath.replace(/[\\/]+$/, '');
      return (
        normalizedFolder === normalizedRoot ||
        normalizedFolder.startsWith(`${normalizedRoot}/`) ||
        normalizedFolder.startsWith(`${normalizedRoot}\\`)
      );
    });
    if (match) {
      return match;
    }
  }
  return repositories[0];
}

export interface GitContextServiceOptions {
  getApi?: () => Promise<API | undefined>;
  getHostOverride?: () => string;
  onSettingsChange?: (cb: () => void) => vscode.Disposable;
  getFirstWorkspaceFolder?: () => string | undefined;
  debounceMs?: number;
}

export class GitContextService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<GitContext | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<Repository, vscode.Disposable>();
  private readonly getApi: () => Promise<API | undefined>;
  private readonly getHostOverride: () => string;
  private readonly getFirstWorkspaceFolder: () => string | undefined;
  private readonly debounceMs: number;

  private api: API | undefined;
  private _current: GitContext | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  readonly ready: Promise<void>;
  readonly onDidChange: vscode.Event<GitContext | undefined> = this.emitter.event;

  constructor(options: GitContextServiceOptions = {}) {
    this.getApi = options.getApi ?? getGitApi;
    this.getHostOverride = options.getHostOverride ?? (() => readWorkspaceSettings().gheHost);
    this.getFirstWorkspaceFolder =
      options.getFirstWorkspaceFolder ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    this.debounceMs = options.debounceMs ?? 300;

    const subscribeSettings =
      options.onSettingsChange ?? ((cb: () => void) => onSettingsChanged(() => cb()));
    this.disposables.push(
      subscribeSettings(() => {
        this.scheduleRecompute();
      }),
    );

    this.ready = this.init();
  }

  get current(): GitContext | undefined {
    return this._current;
  }

  private async init(): Promise<void> {
    const api = await this.getApi();
    if (this.disposed || !api) {
      return;
    }
    this.api = api;

    for (const repo of api.repositories) {
      this.trackRepository(repo);
    }

    this.disposables.push(
      api.onDidOpenRepository((repo) => {
        this.trackRepository(repo);
        this.scheduleRecompute();
      }),
      api.onDidCloseRepository((repo) => {
        this.untrackRepository(repo);
        this.scheduleRecompute();
      }),
    );

    this.recompute();
  }

  private trackRepository(repo: Repository): void {
    if (this.repoListeners.has(repo)) {
      return;
    }
    const sub = repo.state.onDidChange(() => {
      this.scheduleRecompute();
    });
    this.repoListeners.set(repo, sub);
  }

  private untrackRepository(repo: Repository): void {
    const sub = this.repoListeners.get(repo);
    if (sub) {
      sub.dispose();
      this.repoListeners.delete(repo);
    }
  }

  private scheduleRecompute(): void {
    if (this.disposed || !this.api) {
      return;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.recompute();
    }, this.debounceMs);
  }

  private recompute(): void {
    if (this.disposed || !this.api) {
      return;
    }
    const repo = selectRepository(this.api.repositories, this.getFirstWorkspaceFolder());
    const next = repo ? computeGitContext(repo, this.getHostOverride()) : undefined;
    if (!isSameGitContext(this._current, next)) {
      this._current = next;
      this.emitter.fire(this._current);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const sub of this.repoListeners.values()) {
      sub.dispose();
    }
    this.repoListeners.clear();
    for (const sub of this.disposables) {
      sub.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}
