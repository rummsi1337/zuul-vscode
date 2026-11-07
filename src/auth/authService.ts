import { type Logger } from '../util/logger';
import { type AuthMethodId, type GetTokenOptions, type TokenProvider } from './types';

const AUTO_ORDER: readonly AuthMethodId[] = ['pat', 'gh-cli'];

export class AuthService {
  private readonly providers: readonly TokenProvider[];
  private readonly getMethod: () => 'auto' | AuthMethodId;
  private readonly logger: Logger;

  constructor(
    providers: readonly TokenProvider[],
    getMethod: () => 'auto' | AuthMethodId,
    logger: Logger,
  ) {
    this.providers = providers;
    this.getMethod = getMethod;
    this.logger = logger;
  }

  async getToken(
    host: string,
    opts: GetTokenOptions = { interactive: false },
  ): Promise<string | undefined> {
    const normalizedHost = host.trim().toLowerCase();
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
      const token = await provider.getToken(normalizedHost, opts);
      if (token) {
        this.logger.info(`[Auth] Resolved token for ${normalizedHost} using ${provider.id}`);
        return token;
      }
    }

    this.logger.info(`[Auth] No token available for ${normalizedHost} (method=${method})`);
    return undefined;
  }

  async reportUnauthorized(host: string): Promise<void> {
    const normalizedHost = host.trim().toLowerCase();
    if (!normalizedHost) {
      return;
    }

    this.logger.warn(`[Auth] Unauthorized for ${normalizedHost}; invalidating credentials`);
    for (const provider of this.providers) {
      if (provider.invalidate) {
        await provider.invalidate(normalizedHost);
      }
      const maybeClearCache = (provider as { clearCache?: () => void }).clearCache;
      if (typeof maybeClearCache === 'function') {
        maybeClearCache.call(provider);
      }
    }
  }
}
