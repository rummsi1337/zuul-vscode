import { normalizeHost } from '../git/remoteUrl';
import { type Logger } from '../util/logger';
import { type AuthMethodId, type GetTokenOptions, type TokenProvider } from './types';

const AUTO_ORDER: readonly AuthMethodId[] = ['pat', 'gh-cli'];

export class AuthService {
  private readonly providers: readonly TokenProvider[];
  private readonly getMethod: () => 'auto' | AuthMethodId;
  private readonly logger: Logger;
  private readonly onTokenResult?: (host: string, signedIn: boolean) => void;

  constructor(
    providers: readonly TokenProvider[],
    getMethod: () => 'auto' | AuthMethodId,
    logger: Logger,
    onTokenResult?: (host: string, signedIn: boolean) => void,
  ) {
    this.onTokenResult = onTokenResult;
    this.providers = providers;
    this.getMethod = getMethod;
    this.logger = logger;
  }

  async getToken(
    host: string,
    opts: GetTokenOptions = { interactive: false },
  ): Promise<string | undefined> {
    const token = await this.resolveToken(host, opts);
    const normalized = normalizeHost(host);
    if (normalized) {
      this.onTokenResult?.(normalized, token !== undefined);
    }
    return token;
  }

  private async resolveToken(host: string, opts: GetTokenOptions): Promise<string | undefined> {
    const normalizedHost = normalizeHost(host);
    if (!normalizedHost) {
      return undefined;
    }

    const method = this.getMethod();
    const candidateIds: readonly AuthMethodId[] = method === 'auto' ? AUTO_ORDER : [method];

    for (const id of candidateIds) {
      const provider = this.providers.find((p) => p.id === id);
      if (!provider) {
        continue;
      }
      let token: string | undefined;
      try {
        token = await provider.getToken(normalizedHost, opts);
      } catch (err) {
        this.logger.warn(
          `[Auth] Provider ${provider.id} failed for ${normalizedHost}: ${String(err)}`,
        );
        continue;
      }
      if (token) {
        this.logger.info(`[Auth] Resolved token for ${normalizedHost} using ${provider.id}`);
        return token;
      }
    }

    this.logger.info(`[Auth] No token available for ${normalizedHost} (method=${method})`);
    return undefined;
  }

  async reportUnauthorized(host: string): Promise<void> {
    const normalizedHost = normalizeHost(host);
    if (!normalizedHost) {
      return;
    }

    this.logger.warn(`[Auth] Unauthorized for ${normalizedHost}; clearing cached credentials`);
    for (const provider of this.providers) {
      if (provider.invalidate) {
        await provider.invalidate(normalizedHost);
      }
      provider.clearCache?.();
    }
  }
}
