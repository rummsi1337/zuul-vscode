import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../src/auth/authService';
import { GhCliAuthProvider } from '../../src/auth/ghCliAuthProvider';
import { PatAuthProvider } from '../../src/auth/patAuthProvider';
import { type AuthMethodId, type TokenProvider } from '../../src/auth/types';
import { createFakeLogger } from '../helpers';

describe('AuthService', () => {
  it('tries providers in auto priority order (pat then gh-cli) and never logs the token', async () => {
    const callOrder: string[] = [];
    const patProvider: TokenProvider = {
      id: 'pat',
      getToken: vi.fn(async () => {
        callOrder.push('pat');
        return 'secret_pat_value';
      }),
    };
    const ghCliProvider: TokenProvider = {
      id: 'gh-cli',
      getToken: vi.fn(async () => {
        callOrder.push('gh-cli');
        return 'secret_gh_value';
      }),
    };
    const logger = createFakeLogger();
    // Pass in reverse order to verify AUTO_ORDER ['pat', 'gh-cli'] is enforced
    const service = new AuthService([ghCliProvider, patProvider], () => 'auto', logger);

    const token = await service.getToken('GHE.Example.com', { interactive: false });

    expect(token).toBe('secret_pat_value');
    expect(callOrder).toEqual(['pat']);
    expect(patProvider.getToken).toHaveBeenCalledWith('ghe.example.com', expect.anything());
    expect(ghCliProvider.getToken).not.toHaveBeenCalled();
    expect(logger.messages.some((m) => m.includes('pat'))).toBe(true);
    expect(logger.messages.some((m) => m.includes('secret_pat_value'))).toBe(false);
  });

  it('falls back to gh-cli in auto mode when pat returns undefined', async () => {
    const callOrder: string[] = [];
    const patProvider: TokenProvider = {
      id: 'pat',
      getToken: vi.fn(async () => {
        callOrder.push('pat');
        return undefined;
      }),
    };
    const ghCliProvider: TokenProvider = {
      id: 'gh-cli',
      getToken: vi.fn(async () => {
        callOrder.push('gh-cli');
        return 'gho_fallback_token';
      }),
    };
    const logger = createFakeLogger();
    const service = new AuthService([patProvider, ghCliProvider], () => 'auto', logger);

    const token = await service.getToken('ghe.example.com', { interactive: false });

    expect(token).toBe('gho_fallback_token');
    expect(callOrder).toEqual(['pat', 'gh-cli']);
    expect(logger.messages.some((m) => m.includes('gh-cli'))).toBe(true);
    expect(logger.messages.some((m) => m.includes('gho_fallback_token'))).toBe(false);
  });

  it('pins to a single method when configured (pat, gh-cli, oauth)', async () => {
    let method: 'auto' | AuthMethodId = 'gh-cli';
    const patProvider: TokenProvider = {
      id: 'pat',
      getToken: vi.fn(async () => 'ghp_token'),
    };
    const ghCliProvider: TokenProvider = {
      id: 'gh-cli',
      getToken: vi.fn(async () => 'gho_token'),
    };
    const logger = createFakeLogger();
    const service = new AuthService([patProvider, ghCliProvider], () => method, logger);

    const ghToken = await service.getToken('ghe.example.com', { interactive: false });
    expect(ghToken).toBe('gho_token');
    expect(patProvider.getToken).not.toHaveBeenCalled();

    method = 'pat';
    const patToken = await service.getToken('ghe.example.com', { interactive: true });
    expect(patToken).toBe('ghp_token');
    expect(ghCliProvider.getToken).toHaveBeenCalledTimes(1);

    method = 'oauth';
    const oauthToken = await service.getToken('ghe.example.com', { interactive: false });
    expect(oauthToken).toBeUndefined();
  });

  it('invalidates providers and clears gh cache on reportUnauthorized', async () => {
    const patInvalidate = vi.fn(async () => undefined);
    const patProvider: TokenProvider = {
      id: 'pat',
      getToken: vi.fn(async () => undefined),
      invalidate: patInvalidate,
    };
    let ghCallCount = 0;
    const execFile = vi.fn(async () => {
      ghCallCount += 1;
      return { stdout: `gho_${ghCallCount}\n` };
    });
    const ghCliProvider = new GhCliAuthProvider(execFile);
    const logger = createFakeLogger();
    const service = new AuthService([patProvider, ghCliProvider], () => 'auto', logger);

    expect(await service.getToken('ghe.example.com')).toBe('gho_1');
    expect(await service.getToken('ghe.example.com')).toBe('gho_1');
    expect(execFile).toHaveBeenCalledTimes(1);

    await service.reportUnauthorized('GHE.Example.com');

    expect(patInvalidate).toHaveBeenCalledWith('ghe.example.com');
    expect(await service.getToken('ghe.example.com')).toBe('gho_2');
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('treats a throwing provider as no token and moves on', async () => {
    const throwing: TokenProvider = {
      id: 'pat',
      getToken: vi.fn(async () => {
        throw new Error('keychain locked');
      }),
    };
    const logger = createFakeLogger();
    const onTokenResult = vi.fn();
    const service = new AuthService([throwing], () => 'auto', logger, onTokenResult);
    expect(await service.getToken('ghe.example.com')).toBeUndefined();
    expect(onTokenResult).toHaveBeenCalledWith('ghe.example.com', false);

    const good: TokenProvider = { id: 'gh-cli', getToken: vi.fn(async () => 'gho_x') };
    const service2 = new AuthService([throwing, good], () => 'auto', logger);
    expect(await service2.getToken('ghe.example.com')).toBe('gho_x');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('keeps a stored PAT after reportUnauthorized', async () => {
    const data = new Map<string, string>([['zuul.pat.ghe.example.com', 'ghp_keep']]);
    const secrets = {
      get: vi.fn(async (key: string) => data.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        data.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        data.delete(key);
      }),
    };
    const pat = new PatAuthProvider(secrets, async () => true, {
      showInputBox: vi.fn(),
      showErrorMessage: vi.fn(),
    });
    const service = new AuthService([pat], () => 'auto', createFakeLogger());

    await service.reportUnauthorized('ghe.example.com');

    expect(secrets.delete).not.toHaveBeenCalled();
    expect(await service.getToken('ghe.example.com')).toBe('ghp_keep');
  });

  it('handles empty host in getToken and reportUnauthorized', async () => {
    const logger = createFakeLogger();
    const service = new AuthService([], () => 'auto', logger);

    expect(await service.getToken('   ')).toBeUndefined();
    await service.reportUnauthorized('   ');
  });
});

describe('AuthService onTokenResult', () => {
  it('reports signed-in state after every getToken', async () => {
    let token: string | undefined = 'abc';
    const provider: TokenProvider = { id: 'pat', getToken: vi.fn(async () => token) };
    const cb = vi.fn();
    const service = new AuthService([provider], () => 'pat', createFakeLogger(), cb);

    await service.getToken('Ghe.Example.com');
    token = undefined;
    await service.getToken('ghe.example.com');

    expect(cb).toHaveBeenNthCalledWith(1, 'ghe.example.com', true);
    expect(cb).toHaveBeenNthCalledWith(2, 'ghe.example.com', false);
  });
});
