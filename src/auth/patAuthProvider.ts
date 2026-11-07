import { GheClient } from '../clients/gheClient';
import { type PromptLike, type SecretStorageLike, type TokenProvider } from './types';

export { type PromptLike, type SecretStorageLike } from './types';

export function patSecretKey(host: string): string {
  return `zuul.pat.${host.trim().toLowerCase()}`;
}

export async function validatePatWithGhe(
  host: string,
  token: string,
  fetchFn?: typeof fetch,
): Promise<boolean> {
  try {
    const client = new GheClient(host, async () => token, fetchFn);
    await client.getUser();
    return true;
  } catch {
    return false;
  }
}

export class PatAuthProvider implements TokenProvider {
  readonly id = 'pat' as const;
  private readonly secrets: SecretStorageLike;
  private readonly validate: (host: string, token: string) => Promise<boolean>;
  private readonly prompt: PromptLike;

  constructor(
    secrets: SecretStorageLike,
    validate: (host: string, token: string) => Promise<boolean>,
    prompt: PromptLike,
  ) {
    this.secrets = secrets;
    this.validate = validate;
    this.prompt = prompt;
  }

  async setToken(host: string): Promise<string | undefined> {
    const normalizedHost = host.trim().toLowerCase();
    if (!normalizedHost) {
      return undefined;
    }

    const input = await this.prompt.showInputBox({
      prompt: `Enter Personal Access Token for ${normalizedHost}`,
      placeHolder: 'ghp_…',
      password: true,
      ignoreFocusOut: true,
    });

    const token = input?.trim();
    if (!token) {
      return undefined;
    }

    let isValid = false;
    try {
      isValid = await this.validate(normalizedHost, token);
    } catch {
      isValid = false;
    }

    if (!isValid) {
      await this.prompt.showErrorMessage(`Invalid Personal Access Token for ${normalizedHost}.`);
      return undefined;
    }

    await this.secrets.store(patSecretKey(normalizedHost), token);
    return token;
  }

  async getToken(
    host: string,
    opts: { interactive: boolean } = { interactive: false },
  ): Promise<string | undefined> {
    const normalizedHost = host.trim().toLowerCase();
    if (!normalizedHost) {
      return undefined;
    }

    const stored = await this.secrets.get(patSecretKey(normalizedHost));
    const trimmed = stored?.trim();
    if (trimmed) {
      return trimmed;
    }

    if (opts.interactive) {
      return this.setToken(normalizedHost);
    }

    return undefined;
  }

  async clear(host: string): Promise<void> {
    const normalizedHost = host.trim().toLowerCase();
    if (!normalizedHost) {
      return;
    }
    await this.secrets.delete(patSecretKey(normalizedHost));
  }

  async invalidate(host: string): Promise<void> {
    await this.clear(host);
  }
}
