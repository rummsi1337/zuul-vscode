import { vi } from 'vitest';

export class Disposable {
  private readonly callOnDispose: () => void;

  constructor(callOnDispose: () => void = () => undefined) {
    this.callOnDispose = callOnDispose;
  }

  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        d.dispose();
      }
    });
  }

  dispose(): void {
    this.callOnDispose();
  }
}

export type Listener<T> = (e: T) => unknown;
export type Event<T> = (listener: Listener<T>) => Disposable;

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => {
      this.listeners.delete(listener);
    });
  };

  fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly fsPath: string;

  constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
    this.fsPath = path;
  }

  static file(path: string): Uri {
    return new Uri('file', '', path, '', '');
  }

  static parse(value: string): Uri {
    const url = new URL(value);
    return new Uri(
      url.protocol.replace(/:$/, ''),
      url.host,
      url.pathname,
      url.search.replace(/^\?/, ''),
      url.hash.replace(/^#/, ''),
    );
  }

  static from(components: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      components.scheme,
      components.authority ?? '',
      components.path ?? '',
      components.query ?? '',
      components.fragment ?? '',
    );
  }

  with(change: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    const auth = this.authority ? `//${this.authority}` : '';
    const q = this.query ? `?${this.query}` : '';
    const f = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}:${auth}${this.path}${q}${f}`;
  }

  toJSON(): unknown {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
      fsPath: this.fsPath,
    };
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }
}

export class TreeItem {
  id?: string;
  label?: string;
  collapsibleState?: TreeItemCollapsibleState;
  description?: string | boolean;
  tooltip?: string;
  contextValue?: string;
  iconPath?: ThemeIcon | Uri;
  command?: { command: string; title: string; arguments?: unknown[] };

  constructor(
    label: string,
    collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export const window = {
  createOutputChannel: vi.fn((_name: string) => ({
    append: vi.fn(),
    appendLine: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  })),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInputBox: vi.fn(),
  setStatusBarMessage: vi.fn(),
  showQuickPick: vi.fn(),
  createStatusBarItem: vi.fn((alignment?: StatusBarAlignment, priority?: number) => ({
    alignment,
    priority,
    text: '',
    tooltip: '',
    command: undefined as string | undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
  createTreeView: vi.fn(),
  registerTreeDataProvider: vi.fn(),
  state: { focused: true },
  onDidChangeWindowState: vi.fn(() => new Disposable()),
};

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

export const workspace = {
  getConfiguration: vi.fn((_section?: string) => ({
    get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
    update: vi.fn(),
  })),
  onDidChangeConfiguration: vi.fn(
    (_listener: Listener<ConfigurationChangeEvent>) => new Disposable(),
  ),
  workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  findFiles: vi.fn(async () => []),
  createFileSystemWatcher: vi.fn(() => ({
    onDidCreate: vi.fn(() => new Disposable()),
    onDidChange: vi.fn(() => new Disposable()),
    onDidDelete: vi.fn(() => new Disposable()),
    dispose: vi.fn(),
  })),
  registerTextDocumentContentProvider: vi.fn(() => new Disposable()),
  openTextDocument: vi.fn(),
};

export const commands = {
  registerCommand: vi.fn(
    (_command: string, _callback: (...args: unknown[]) => unknown) => new Disposable(),
  ),
  executeCommand: vi.fn(),
};

export const extensions = {
  getExtension: vi.fn(),
};

export const env = {
  openExternal: vi.fn(async (_target: Uri) => true),
};
