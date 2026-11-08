import * as vscode from 'vscode';

export type AuthMethodSetting = 'auto' | 'oauth' | 'gh-cli' | 'pat';

export interface TriggerComment {
  label: string;
  comment: string;
  icon?: string;
}

export interface GateSettings {
  requiredApprovals: number;
  requiredStatusChecks: Record<string, string[]>;
  requiredLabels: string[];
  blockingLabels: string[];
}

export interface ZuulSettings {
  url: string;
  tenant: string;
  gheHost: string;
  authMethod: AuthMethodSetting;
  oauthClientId: string;
  triggerComments: TriggerComment[];
  pinnedArtifacts: string[];
  gate: GateSettings;
}

const VALID_AUTH_METHODS: readonly AuthMethodSetting[] = ['auto', 'oauth', 'gh-cli', 'pat'];

const DEFAULT_TRIGGER_COMMENTS: readonly TriggerComment[] = [
  { label: 'Recheck', comment: 'recheck', icon: 'refresh' },
];
const DEFAULT_PINNED_ARTIFACTS: readonly string[] = ['job-output.txt'];
const DEFAULT_REQUIRED_APPROVALS = 1;
const DEFAULT_REQUIRED_LABELS: readonly string[] = [];
const DEFAULT_BLOCKING_LABELS: readonly string[] = ['do-not-merge', 'wip'];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readAuthMethod(value: unknown): AuthMethodSetting {
  if (typeof value === 'string' && (VALID_AUTH_METHODS as readonly string[]).includes(value)) {
    return value as AuthMethodSetting;
  }
  return 'pat';
}

function isTriggerComment(value: unknown): value is TriggerComment {
  if (!isPlainObject(value)) {
    return false;
  }
  const candidate = value;
  if (typeof candidate.label !== 'string' || typeof candidate.comment !== 'string') {
    return false;
  }
  if (candidate.icon !== undefined && typeof candidate.icon !== 'string') {
    return false;
  }
  return true;
}

function readTriggerComments(value: unknown): TriggerComment[] {
  if (!Array.isArray(value) || !value.every(isTriggerComment)) {
    return DEFAULT_TRIGGER_COMMENTS.map((item) => ({ ...item }));
  }
  return value.map((item) =>
    item.icon !== undefined
      ? { label: item.label, comment: item.comment, icon: item.icon }
      : { label: item.label, comment: item.comment },
  );
}

function readStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!isStringArray(value)) {
    return [...fallback];
  }
  return [...value];
}

function readRequiredApprovals(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return DEFAULT_REQUIRED_APPROVALS;
}

function readRequiredStatusChecks(value: unknown): Record<string, string[]> {
  if (!isPlainObject(value)) {
    return {};
  }
  const result: Record<string, string[]> = {};
  for (const [key, checks] of Object.entries(value)) {
    if (!isStringArray(checks)) {
      return {};
    }
    result[key] = [...checks];
  }
  return result;
}

export function readSettings(get: (key: string) => unknown): ZuulSettings {
  const rawUrl = readString(get('url'), '');
  const url = rawUrl.replace(/\/+$/, '');

  return {
    url,
    tenant: readString(get('tenant'), ''),
    gheHost: readString(get('ghe.host'), ''),
    authMethod: readAuthMethod(get('auth.method')),
    oauthClientId: readString(get('ghe.oauthClientId'), ''),
    triggerComments: readTriggerComments(get('triggerComments')),
    pinnedArtifacts: readStringArray(get('pinnedArtifacts'), DEFAULT_PINNED_ARTIFACTS),
    gate: {
      requiredApprovals: readRequiredApprovals(get('gate.requiredApprovals')),
      requiredStatusChecks: readRequiredStatusChecks(get('gate.requiredStatusChecks')),
      requiredLabels: readStringArray(get('gate.requiredLabels'), DEFAULT_REQUIRED_LABELS),
      blockingLabels: readStringArray(get('gate.blockingLabels'), DEFAULT_BLOCKING_LABELS),
    },
  };
}

export function readWorkspaceSettings(): ZuulSettings {
  const config = vscode.workspace.getConfiguration('zuul');
  return readSettings((key) => config.get(key));
}

export function onSettingsChanged(cb: (settings: ZuulSettings) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('zuul')) {
      cb(readWorkspaceSettings());
    }
  });
}
