import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type TokenProvider } from './types';

const GH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const execFileAsync = promisify(nodeExecFile);

export type ExecFileOutput = { stdout: string; stderr?: string } | string;

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
  callback?: (error: Error | null, stdout: string, stderr: string) => void,
) => Promise<ExecFileOutput> | unknown;

const defaultExecFile: ExecFileFn = (file, args, options) => execFileAsync(file, args, options);

async function invokeExecFile(
  execFileFn: ExecFileFn,
  file: string,
  args: readonly string[],
  options: { timeout: number },
): Promise<string> {
  if (execFileFn.length >= 4) {
    return new Promise<string>((resolve, reject) => {
      execFileFn(file, args, options, (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(typeof stdout === 'string' ? stdout : '');
      });
    });
  }

  const out = (await execFileFn(file, args, options)) as ExecFileOutput | undefined;
  if (typeof out === 'string') {
    return out;
  }
  if (out && typeof out.stdout === 'string') {
    return out.stdout;
  }
  return '';
}

interface CacheEntry {
  token: string;
  expiresAt: number;
}

export class GhCliAuthProvider implements TokenProvider {
  readonly id = 'gh-cli' as const;
  private readonly execFile: ExecFileFn;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(execFile: ExecFileFn = defaultExecFile, now: () => number = Date.now) {
    this.execFile = execFile;
    this.now = now;
  }

  async getToken(
    host: string,
    _opts: { interactive: boolean } = { interactive: false },
  ): Promise<string | undefined> {
    const normalizedHost = host.trim().toLowerCase();
    if (!normalizedHost) {
      return undefined;
    }

    const cached = this.cache.get(normalizedHost);
    const currentTime = this.now();
    if (cached !== undefined && currentTime < cached.expiresAt) {
      return cached.token;
    }

    try {
      const stdout = await invokeExecFile(
        this.execFile,
        'gh',
        ['auth', 'token', '--hostname', normalizedHost],
        { timeout: GH_TIMEOUT_MS },
      );
      const token = stdout.trim();
      if (!token) {
        this.cache.delete(normalizedHost);
        return undefined;
      }

      this.cache.set(normalizedHost, {
        token,
        expiresAt: this.now() + CACHE_TTL_MS,
      });
      return token;
    } catch {
      this.cache.delete(normalizedHost);
      return undefined;
    }
  }

  async invalidate(host: string): Promise<void> {
    const normalizedHost = host.trim().toLowerCase();
    if (!normalizedHost) {
      return;
    }
    this.cache.delete(normalizedHost);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
