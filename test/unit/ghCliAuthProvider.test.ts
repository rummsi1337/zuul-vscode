import { describe, expect, it, vi } from 'vitest';
import { type ExecFileFn, GhCliAuthProvider } from '../../src/auth/ghCliAuthProvider';

describe('GhCliAuthProvider', () => {
  it('runs gh auth token --hostname <host> with 5s timeout and trims stdout', async () => {
    const execFile = vi.fn(async () => ({ stdout: '  gho_clitoken123\n', stderr: '' }));
    const provider = new GhCliAuthProvider(execFile);

    const token = await provider.getToken('ghe.example.com', { interactive: false });

    expect(token).toBe('gho_clitoken123');
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['auth', 'token', '--hostname', 'ghe.example.com'],
      {
        timeout: 5000,
      },
    );
  });

  it('returns undefined when gh is not installed (ENOENT)', async () => {
    const execFile = vi.fn(async () => {
      const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
      throw err;
    });
    const provider = new GhCliAuthProvider(execFile);

    const token = await provider.getToken('ghe.example.com');

    expect(token).toBeUndefined();
  });

  it('returns undefined on non-zero exit or empty stdout', async () => {
    const failingExec = vi.fn(async () => {
      const err = Object.assign(new Error('Command failed: gh auth token'), { code: 1 });
      throw err;
    });
    const failingProvider = new GhCliAuthProvider(failingExec);
    expect(await failingProvider.getToken('ghe.example.com')).toBeUndefined();

    const emptyExec = vi.fn(async () => ({ stdout: '   \n', stderr: '' }));
    const emptyProvider = new GhCliAuthProvider(emptyExec);
    expect(await emptyProvider.getToken('ghe.example.com')).toBeUndefined();
  });

  it('caches tokens per host for 5 minutes and expires after TTL', async () => {
    let currentTime = 1_000_000;
    let callCount = 0;
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      callCount += 1;
      return { stdout: `tok-${args[3]}-${callCount}\n` };
    });
    const provider = new GhCliAuthProvider(execFile, () => currentTime);

    const first = await provider.getToken('ghe.example.com');
    expect(first).toBe('tok-ghe.example.com-1');
    expect(execFile).toHaveBeenCalledTimes(1);

    // Within 5 min TTL -> cached
    currentTime += 4 * 60 * 1000;
    const second = await provider.getToken('ghe.example.com');
    expect(second).toBe('tok-ghe.example.com-1');
    expect(execFile).toHaveBeenCalledTimes(1);

    // Different host -> separate cache entry
    const otherHost = await provider.getToken('github.com');
    expect(otherHost).toBe('tok-github.com-2');
    expect(execFile).toHaveBeenCalledTimes(2);

    // Past 5 min TTL -> re-fetched
    currentTime += 2 * 60 * 1000;
    const third = await provider.getToken('ghe.example.com');
    expect(third).toBe('tok-ghe.example.com-3');
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it('invalidates a single host or clears entire cache', async () => {
    let callCount = 0;
    const execFile = vi.fn(async () => {
      callCount += 1;
      return `token-${callCount}\n`;
    });
    const provider = new GhCliAuthProvider(execFile);

    expect(await provider.getToken('ghe.example.com')).toBe('token-1');
    expect(await provider.getToken('ghe.example.com')).toBe('token-1');
    expect(execFile).toHaveBeenCalledTimes(1);

    await provider.invalidate('ghe.example.com');
    expect(await provider.getToken('ghe.example.com')).toBe('token-2');
    expect(execFile).toHaveBeenCalledTimes(2);

    provider.clearCache();
    expect(await provider.getToken('ghe.example.com')).toBe('token-3');
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it('supports callback-style execFile', async () => {
    const callbackExec: ExecFileFn = (
      _file: string,
      _args: readonly string[],
      _options: { timeout?: number } | undefined,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb?.(null, 'cb_token\n', '');
    };
    const provider = new GhCliAuthProvider(callbackExec);

    expect(await provider.getToken('ghe.example.com')).toBe('cb_token');
  });
});
