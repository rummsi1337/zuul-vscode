import { describe, expect, it, vi } from 'vitest';
import { ZuulTokenProvider } from '../../src/auth/zuulTokenProvider';

class MemorySecretStorage {
  private readonly storeMap = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.storeMap.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.storeMap.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.storeMap.delete(key);
  }

  dump(): Record<string, string> {
    return Object.fromEntries(this.storeMap.entries());
  }
}

describe('ZuulTokenProvider', () => {
  it('returns tenant-specific token from SecretStorage', async () => {
    const secrets = new MemorySecretStorage();
    await secrets.store('zuul.token.ddad', 'jwt-for-ddad');
    await secrets.store('zuul.token.swh', 'jwt-for-swh');

    const provider = new ZuulTokenProvider({ secrets });

    expect(await provider.getToken('ddad')).toBe('jwt-for-ddad');
    expect(await provider.getToken('swh')).toBe('jwt-for-swh');
  });

  it('falls back to ddad token when accessing swh tenant if swh has no token', async () => {
    const secrets = new MemorySecretStorage();
    // Only ddad token is stored
    await secrets.store('zuul.token.ddad', 'jwt-for-ddad');
    await secrets.store('zuul.tokenTenants', JSON.stringify(['ddad']));

    const provider = new ZuulTokenProvider({ secrets });

    // swh has no token configured, so provider tests/falls back to the ddad token
    const swhToken = await provider.getToken('swh');
    expect(swhToken).toBe('jwt-for-ddad');
  });

  it('prefers swh token over ddad token when both are configured', async () => {
    const secrets = new MemorySecretStorage();
    await secrets.store('zuul.token.ddad', 'jwt-for-ddad');
    await secrets.store('zuul.token.swh', 'jwt-for-swh');
    await secrets.store('zuul.tokenTenants', JSON.stringify(['ddad', 'swh']));

    const provider = new ZuulTokenProvider({ secrets });

    expect(await provider.getToken('ddad')).toBe('jwt-for-ddad');
    expect(await provider.getToken('swh')).toBe('jwt-for-swh');
  });

  it('reads tenant tokens from workspace settings via file paths', async () => {
    const secrets = new MemorySecretStorage();
    const files = new Map<string, string>([
      ['/tokens/ddad', 'setting-token-ddad\n'],
      ['/tokens/swh', 'setting-token-swh\n'],
    ]);

    const provider = new ZuulTokenProvider({
      secrets,
      getSettings: () => ({ tokens: { ddad: '/tokens/ddad', swh: '/tokens/swh' } }),
      fsReadFile: async (p) => files.get(p) ?? '',
    });

    expect(await provider.getToken('ddad')).toBe('setting-token-ddad');
    expect(await provider.getToken('swh')).toBe('setting-token-swh');
  });

  it('resolves wildcard token as fallback', async () => {
    const secrets = new MemorySecretStorage();
    await secrets.store('zuul.token.*', 'wildcard-jwt');

    const provider = new ZuulTokenProvider({ secrets });

    expect(await provider.getToken('ddad')).toBe('wildcard-jwt');
    expect(await provider.getToken('swh')).toBe('wildcard-jwt');
    expect(await provider.getToken(undefined)).toBe('wildcard-jwt');
  });

  it('reads token directly from a file path with ~ expansion', async () => {
    const secrets = new MemorySecretStorage();
    const files = new Map<string, string>([
      ['/Users/testuser/.zuul/token', 'file-based-jwt-token\n'],
    ]);

    const provider = new ZuulTokenProvider({
      secrets,
      getSettings: () => ({
        tokenFile: '~/.zuul/token',
      }),
      fsReadFile: async (filePath) => {
        const content = files.get(filePath);
        if (content === undefined) {
          throw new Error(`ENOENT: ${filePath}`);
        }
        return content;
      },
      homedir: () => '/Users/testuser',
    });

    expect(await provider.getToken('ddad')).toBe('file-based-jwt-token');
    expect(await provider.getToken('swh')).toBe('file-based-jwt-token');

    // Dynamic update test: file changes on disk, token provider returns new token
    files.set('/Users/testuser/.zuul/token', 'refreshed-jwt-token');
    expect(await provider.getToken('ddad')).toBe('refreshed-jwt-token');
  });

  it('reads tenant-keyed tokens from a JSON token file', async () => {
    const secrets = new MemorySecretStorage();
    const jsonContent = JSON.stringify({
      ddad: 'json-token-ddad',
      swh: 'json-token-swh',
      '*': 'json-token-default',
    });

    const provider = new ZuulTokenProvider({
      secrets,
      getSettings: () => ({
        tokenFile: '/etc/zuul/tokens.json',
      }),
      fsReadFile: async () => jsonContent,
    });

    expect(await provider.getToken('ddad')).toBe('json-token-ddad');
    expect(await provider.getToken('swh')).toBe('json-token-swh');
    expect(await provider.getToken('other')).toBe('json-token-default');
  });

  it('prompts and saves token via setToken', async () => {
    const secrets = new MemorySecretStorage();
    const showInputBox = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce('ddad') // tenant
      .mockResolvedValueOnce('pasted-jwt-token'); // token

    const provider = new ZuulTokenProvider({
      secrets,
      prompt: {
        showInputBox,
        showErrorMessage: vi.fn(),
      },
    });

    const stored = await provider.setToken();
    expect(stored).toBe('pasted-jwt-token');
    expect(await secrets.get('zuul.token.ddad')).toBe('pasted-jwt-token');
    expect(await provider.getToken('ddad')).toBe('pasted-jwt-token');
  });

  it('clears token for a specific tenant and all tenants', async () => {
    const secrets = new MemorySecretStorage();
    await secrets.store('zuul.token.ddad', 'token-ddad');
    await secrets.store('zuul.token.swh', 'token-swh');
    await secrets.store('zuul.tokenTenants', JSON.stringify(['ddad', 'swh']));

    const provider = new ZuulTokenProvider({ secrets });

    await provider.clearToken('ddad');
    expect(await secrets.get('zuul.token.ddad')).toBeUndefined();
    expect(await secrets.get('zuul.token.swh')).toBe('token-swh');

    await provider.clearToken();
    expect(await secrets.get('zuul.token.swh')).toBeUndefined();
    expect(await secrets.get('zuul.tokenTenants')).toBeUndefined();
  });

  it('logs warning when token file cannot be read', async () => {
    const secrets = new MemorySecretStorage();
    const warn = vi.fn();

    const provider = new ZuulTokenProvider({
      secrets,
      getSettings: () => ({
        tokens: { ddad: '/nonexistent/path/token' },
      }),
      fsReadFile: async () => {
        throw new Error('File not found');
      },
      logger: { info: vi.fn(), warn },
    });

    const token = await provider.getToken('ddad');
    expect(token).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to read token file'));
  });

  it('ignores raw values in zuul.tokens without leaking them', async () => {
    const warn = vi.fn();
    const provider = new ZuulTokenProvider({
      secrets: new MemorySecretStorage(),
      getSettings: () => ({ tokens: { ddad: 'raw-secret-value' } }),
      logger: { info: vi.fn(), warn },
    });

    expect(await provider.getToken('ddad')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('only file paths are allowed'));
    expect(warn.mock.calls.flat().join('\n')).not.toContain('raw-secret-value');
  });

  it('does not treat tokenFile without a path prefix as a token or read it', async () => {
    const fsReadFile = vi.fn(async () => 'should-not-be-read');
    const provider = new ZuulTokenProvider({
      secrets: new MemorySecretStorage(),
      getSettings: () => ({ tokenFile: 'token.txt' }),
      fsReadFile,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(await provider.getToken('ddad')).toBeUndefined();
    expect(fsReadFile).not.toHaveBeenCalled();
  });

  it('rejects multi-line token files without leaking content', async () => {
    const warn = vi.fn();
    const provider = new ZuulTokenProvider({
      secrets: new MemorySecretStorage(),
      getSettings: () => ({ tokenFile: '/etc/zuul/token' }),
      fsReadFile: async () => 'line-one-secret\nline-two-secret',
      logger: { info: vi.fn(), warn },
    });

    expect(await provider.getToken('ddad')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).not.toContain('line-one-secret');
    expect(logged).not.toContain('line-two-secret');
  });

  it('selects tokens from JSON token files strictly', async () => {
    const make = (content: string) =>
      new ZuulTokenProvider({
        secrets: new MemorySecretStorage(),
        getSettings: () => ({ tokenFile: '/etc/zuul/tokens.json' }),
        fsReadFile: async () => content,
        logger: { info: vi.fn(), warn: vi.fn() },
      });

    const two = make(JSON.stringify({ ddad: 'tok-ddad', swh: 'tok-swh' }));
    expect(await two.getToken('other')).toBeUndefined();

    const one = make(JSON.stringify({ ddad: 'tok-ddad' }));
    expect(await one.getToken('swh')).toBe('tok-ddad');

    const empty = make('{}');
    expect(await empty.getToken('swh')).toBeUndefined();
  });

  it('returns a stored secret with a slash in the middle unchanged', async () => {
    const secrets = new MemorySecretStorage();
    await secrets.store('zuul.token.ddad', 'abc/def+ghi==');
    const provider = new ZuulTokenProvider({ secrets });

    expect(await provider.getToken('ddad')).toBe('abc/def+ghi==');
  });

  it('does not log the path when a read fails', async () => {
    const warn = vi.fn();
    const provider = new ZuulTokenProvider({
      secrets: new MemorySecretStorage(),
      getSettings: () => ({ tokenFile: '/very/secret/location/token' }),
      fsReadFile: async () => {
        throw Object.assign(new Error('nope /very/secret/location/token'), { code: 'ENOENT' });
      },
      logger: { info: vi.fn(), warn },
    });

    expect(await provider.getToken('ddad')).toBeUndefined();
    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('ENOENT');
    expect(logged).not.toContain('/very/secret/location');
  });

  it('getTokenCandidates returns direct token only, or all unique fallbacks', async () => {
    const secrets = new MemorySecretStorage();
    await secrets.store('zuul.token.ddad', 'jwt-ddad');
    await secrets.store('zuul.token.swh', 'jwt-swh');
    await secrets.store('zuul.token.dup', 'jwt-ddad');
    await secrets.store('zuul.tokenTenants', JSON.stringify(['ddad', 'swh', 'dup']));
    const provider = new ZuulTokenProvider({
      secrets,
      getSettings: () => ({ tokens: { other: '/tokens/other' } }),
      fsReadFile: async () => 'jwt-other\n',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(await provider.getTokenCandidates('ddad')).toEqual(['jwt-ddad']);
    expect(await provider.getTokenCandidates('unknown')).toEqual([
      'jwt-ddad',
      'jwt-swh',
      'jwt-other',
    ]);
  });

  it('does not use zuul.token.default as a wildcard', async () => {
    const secrets = new MemorySecretStorage();
    await secrets.store('zuul.token.default', 'default-jwt');
    const provider = new ZuulTokenProvider({ secrets });

    expect(await provider.getToken('ddad')).toBeUndefined();
    expect(await provider.getToken(undefined)).toBeUndefined();
  });

  it('passes the suggested tenant as the tenant prompt value', async () => {
    const showInputBox = vi
      .fn<(options?: { value?: string }) => Promise<string | undefined>>()
      .mockResolvedValueOnce('ddad')
      .mockResolvedValueOnce('pasted-jwt-token');
    const provider = new ZuulTokenProvider({
      secrets: new MemorySecretStorage(),
      prompt: { showInputBox, showErrorMessage: vi.fn() },
    });

    await provider.setToken(undefined, 'ddad');
    expect(showInputBox.mock.calls[0][0]).toEqual(expect.objectContaining({ value: 'ddad' }));
  });
});
