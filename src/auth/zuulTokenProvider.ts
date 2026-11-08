import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Logger } from '../util/logger';
import { type PromptLike, type SecretStorageLike } from './types';

export function tokenSecretKey(tenant: string): string {
  return `zuul.token.${tenant.trim()}`;
}

const TOKEN_TENANTS_SECRET_KEY = 'zuul.tokenTenants';

export interface ZuulTokenSettings {
  tokens?: Record<string, string>;
  tokenFile?: string;
}

export interface ZuulTokenProviderOptions {
  secrets: SecretStorageLike;
  getSettings?: () => ZuulTokenSettings;
  prompt?: PromptLike;
  logger?: Pick<Logger, 'info' | 'warn'>;
  fsReadFile?: (filePath: string, encoding: 'utf8') => Promise<string>;
  homedir?: () => string;
}

function expandHome(filePath: string, homedir: () => string): string {
  const trimmed = filePath.trim();
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function looksLikeFilePath(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed === '~') {
    return true;
  }
  const prefixes = ['~/', '~\\', '/', '\\', './', '../', '.\\', '..\\'];
  if (prefixes.some((prefix) => trimmed.startsWith(prefix))) {
    return true;
  }
  return /^[a-zA-Z]:[\\/]/.test(trimmed);
}

const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

function labelFor(tenant?: string): string {
  return tenant ? `tenant "${tenant}"` : 'default';
}

export class ZuulTokenProvider {
  private readonly secrets: SecretStorageLike;
  private readonly getSettings: () => ZuulTokenSettings;
  private readonly prompt?: PromptLike;
  private readonly logger?: Pick<Logger, 'info' | 'warn'>;
  private readonly fsReadFile: (filePath: string, encoding: 'utf8') => Promise<string>;
  private readonly homedir: () => string;

  constructor(options: ZuulTokenProviderOptions) {
    this.secrets = options.secrets;
    this.getSettings = options.getSettings ?? (() => ({}));
    this.prompt = options.prompt;
    this.logger = options.logger;
    this.fsReadFile = options.fsReadFile ?? ((p) => fs.readFile(p, 'utf8'));
    this.homedir = options.homedir ?? (() => os.homedir());
  }

  private async getStoredTenants(): Promise<string[]> {
    const raw = await this.secrets.get(TOKEN_TENANTS_SECRET_KEY);
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return [];
    }
  }

  private async recordStoredTenant(tenant: string): Promise<void> {
    const list = await this.getStoredTenants();
    const set = new Set(list);
    set.add(tenant);
    await this.secrets.store(TOKEN_TENANTS_SECRET_KEY, JSON.stringify([...set]));
  }

  private async removeStoredTenant(tenant: string): Promise<void> {
    const list = await this.getStoredTenants();
    const filtered = list.filter((t) => t !== tenant);
    await this.secrets.store(TOKEN_TENANTS_SECRET_KEY, JSON.stringify(filtered));
  }

  private checkToken(value: string | undefined, tenant?: string): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!TOKEN_PATTERN.test(value)) {
      this.logger?.warn(
        `[Zuul] Ignoring token for ${labelFor(tenant)}: it contains whitespace or invalid characters`,
      );
      return undefined;
    }
    return value;
  }

  private async readTokenFile(filePath: string, tenant?: string): Promise<string | undefined> {
    const label = labelFor(tenant);
    const resolvedPath = expandHome(filePath, this.homedir);
    if (!path.isAbsolute(resolvedPath)) {
      this.logger?.warn(`[Zuul] Token file for ${label} must be an absolute path or start with ~/`);
      return undefined;
    }

    let content: string;
    try {
      content = (await this.fsReadFile(resolvedPath, 'utf8')).trim();
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      this.logger?.warn(
        `[Zuul] Failed to read token file for ${label}: ${typeof code === 'string' ? code : 'unknown error'}`,
      );
      return undefined;
    }

    if (!content.startsWith('{')) {
      return this.checkToken(content, tenant);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      this.logger?.warn(`[Zuul] Token file for ${label} is not valid JSON`);
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.logger?.warn(`[Zuul] Token file for ${label} must contain a JSON object`);
      return undefined;
    }

    const map = parsed as Record<string, unknown>;
    let value: string | undefined;
    if (tenant && typeof map[tenant] === 'string') {
      value = map[tenant] as string;
    } else if (typeof map['*'] === 'string') {
      value = map['*'] as string;
    } else {
      const values = Object.values(map).filter((v): v is string => typeof v === 'string');
      if (values.length === 1) {
        value = values[0];
      }
    }
    if (value === undefined) {
      return undefined;
    }
    return this.checkToken(value.trim(), tenant);
  }

  private async resolveSecret(
    raw: string | undefined,
    tenant?: string,
  ): Promise<string | undefined> {
    const trimmed = raw?.trim();
    if (!trimmed) {
      return undefined;
    }
    if (looksLikeFilePath(trimmed)) {
      return this.readTokenFile(trimmed, tenant);
    }
    return this.checkToken(trimmed, tenant);
  }

  private async resolveConfigured(
    key: string,
    raw: unknown,
    tenant?: string,
  ): Promise<string | undefined> {
    if (typeof raw !== 'string') {
      return undefined;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    if (looksLikeFilePath(trimmed)) {
      return this.readTokenFile(trimmed, tenant);
    }
    this.logger?.warn(
      `[Zuul] Ignoring zuul.tokens["${key}"]: only file paths are allowed. Use the "Set Zuul Tenant Token" command for raw tokens.`,
    );
    return undefined;
  }

  async listStoredTenants(): Promise<string[]> {
    return this.getStoredTenants();
  }

  async getTokenCandidates(tenant?: string): Promise<string[]> {
    const targetTenant = tenant?.trim() || undefined;
    const settings = this.getSettings();
    const configuredTokens = settings.tokens ?? {};

    // Primary lookup
    if (targetTenant) {
      const direct = await this.resolveSecret(
        await this.secrets.get(tokenSecretKey(targetTenant)),
        targetTenant,
      );
      if (direct) {
        return [direct];
      }
      const configured = await this.resolveConfigured(
        targetTenant,
        configuredTokens[targetTenant],
        targetTenant,
      );
      if (configured) {
        return [configured];
      }
    }

    const wildcardSecret = await this.resolveSecret(
      await this.secrets.get(tokenSecretKey('*')),
      targetTenant,
    );
    if (wildcardSecret) {
      return [wildcardSecret];
    }
    const wildcardConfigured = await this.resolveConfigured(
      '*',
      configuredTokens['*'],
      targetTenant,
    );
    if (wildcardConfigured) {
      return [wildcardConfigured];
    }

    if (settings.tokenFile?.trim()) {
      const fromFile = await this.readTokenFile(settings.tokenFile.trim(), targetTenant);
      if (fromFile) {
        return [fromFile];
      }
    }

    // Fallback: tokens of other tenants
    const candidates = new Set<string>();
    const sources: string[] = [];
    const addSource = (name: string): void => {
      if (!sources.includes(name)) {
        sources.push(name);
      }
    };

    for (const t of await this.getStoredTenants()) {
      if (t === targetTenant || t === '*') {
        continue;
      }
      const resolved = await this.resolveSecret(await this.secrets.get(tokenSecretKey(t)), t);
      if (resolved) {
        candidates.add(resolved);
        addSource(t);
      }
    }
    for (const [t, raw] of Object.entries(configuredTokens)) {
      if (t === targetTenant || t === '*') {
        continue;
      }
      const resolved = await this.resolveConfigured(t, raw, t);
      if (resolved) {
        candidates.add(resolved);
        addSource(t);
      }
    }

    if (candidates.size > 0) {
      this.logger?.info(
        `[Zuul] No token for ${labelFor(targetTenant)}; trying tokens from: ${sources.join(', ')}`,
      );
    }
    return [...candidates];
  }

  async getToken(tenant?: string): Promise<string | undefined> {
    return (await this.getTokenCandidates(tenant))[0];
  }

  async setToken(tenant?: string, suggestedTenant?: string): Promise<string | undefined> {
    if (!this.prompt) {
      return undefined;
    }

    let targetTenant = tenant?.trim();
    if (!targetTenant) {
      const inputTenant = await this.prompt.showInputBox({
        prompt: 'Enter Zuul tenant name (or * for all tenants)',
        placeHolder: 'e.g. ddad',
        value: suggestedTenant,
        ignoreFocusOut: true,
      });
      targetTenant = inputTenant?.trim();
      if (!targetTenant) {
        return undefined;
      }
    }

    const input = await this.prompt.showInputBox({
      prompt: `Enter Zuul read-only token (JWT) or path to token file for tenant "${targetTenant}"`,
      placeHolder: 'eyJ... or ~/.zuul/token',
      password: true,
      ignoreFocusOut: true,
    });

    const tokenOrPath = input?.trim();
    if (!tokenOrPath) {
      return undefined;
    }

    await this.secrets.store(tokenSecretKey(targetTenant), tokenOrPath);
    await this.recordStoredTenant(targetTenant);
    this.logger?.info(`[Zuul] Stored token for tenant "${targetTenant}"`);
    return tokenOrPath;
  }

  async clearToken(tenant?: string): Promise<void> {
    const target = tenant?.trim();
    if (target) {
      await this.secrets.delete(tokenSecretKey(target));
      await this.removeStoredTenant(target);
      return;
    }

    const stored = await this.getStoredTenants();
    for (const t of stored) {
      await this.secrets.delete(tokenSecretKey(t));
    }
    await this.secrets.delete(tokenSecretKey('*'));
    await this.secrets.delete(TOKEN_TENANTS_SECRET_KEY);
  }
}
