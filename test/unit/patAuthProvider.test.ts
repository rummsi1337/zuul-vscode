import { describe, expect, it, vi } from 'vitest';
import {
  PatAuthProvider,
  type PromptLike,
  type SecretStorageLike,
  patSecretKey,
  validatePatWithGhe,
} from '../../src/auth/patAuthProvider';

function createSecretStorage(initial: Record<string, string> = {}): SecretStorageLike & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key)),
    store: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
  };
}

function createPrompt(inputValue?: string): PromptLike {
  return {
    showInputBox: vi.fn(async () => inputValue),
    showErrorMessage: vi.fn(async () => undefined),
  };
}

describe('PatAuthProvider', () => {
  it('computes the secret key from the host', () => {
    expect(patSecretKey('ghe.example.com')).toBe('zuul.pat.ghe.example.com');
  });

  it('stores valid PAT and returns it via setToken', async () => {
    const secrets = createSecretStorage();
    const validate = vi.fn(async () => true);
    const prompt = createPrompt('  ghp_secret123  ');
    const provider = new PatAuthProvider(secrets, validate, prompt);

    const token = await provider.setToken('ghe.example.com');

    expect(token).toBe('ghp_secret123');
    expect(prompt.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({
        password: true,
        placeHolder: 'ghp_…',
      }),
    );
    expect(validate).toHaveBeenCalledWith('ghe.example.com', 'ghp_secret123');
    expect(secrets.store).toHaveBeenCalledWith('zuul.pat.ghe.example.com', 'ghp_secret123');
    expect(prompt.showErrorMessage).not.toHaveBeenCalled();
  });

  it('does not store invalid PAT and shows error message', async () => {
    const secrets = createSecretStorage();
    const validate = vi.fn(async () => false);
    const prompt = createPrompt('ghp_badtoken');
    const provider = new PatAuthProvider(secrets, validate, prompt);

    const token = await provider.setToken('ghe.example.com');

    expect(token).toBeUndefined();
    expect(validate).toHaveBeenCalledWith('ghe.example.com', 'ghp_badtoken');
    expect(secrets.store).not.toHaveBeenCalled();
    expect(secrets.data.size).toBe(0);
    expect(prompt.showErrorMessage).toHaveBeenCalledOnce();
  });

  it('treats validation error as invalid PAT and does not store it', async () => {
    const secrets = createSecretStorage();
    const validate = vi.fn(async () => {
      throw new Error('401 Unauthorized');
    });
    const prompt = createPrompt('ghp_errortoken');
    const provider = new PatAuthProvider(secrets, validate, prompt);

    const token = await provider.setToken('ghe.example.com');

    expect(token).toBeUndefined();
    expect(secrets.store).not.toHaveBeenCalled();
    expect(prompt.showErrorMessage).toHaveBeenCalledOnce();
  });

  it('returns undefined without validating or storing when prompt is cancelled or empty', async () => {
    const secrets = createSecretStorage();
    const validate = vi.fn(async () => true);
    const promptCancelled = createPrompt(undefined);
    const providerCancelled = new PatAuthProvider(secrets, validate, promptCancelled);

    expect(await providerCancelled.setToken('ghe.example.com')).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
    expect(secrets.store).not.toHaveBeenCalled();
    expect(promptCancelled.showErrorMessage).not.toHaveBeenCalled();

    const promptEmpty = createPrompt('   ');
    const providerEmpty = new PatAuthProvider(secrets, validate, promptEmpty);
    expect(await providerEmpty.setToken('ghe.example.com')).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it('reads existing secret in getToken without prompting', async () => {
    const secrets = createSecretStorage({ 'zuul.pat.ghe.example.com': 'ghp_existing' });
    const validate = vi.fn(async () => true);
    const prompt = createPrompt('ghp_new');
    const provider = new PatAuthProvider(secrets, validate, prompt);

    const token = await provider.getToken('ghe.example.com', { interactive: true });

    expect(token).toBe('ghp_existing');
    expect(prompt.showInputBox).not.toHaveBeenCalled();
  });

  it('returns undefined when secret is missing and interactive is false', async () => {
    const secrets = createSecretStorage();
    const validate = vi.fn(async () => true);
    const prompt = createPrompt('ghp_new');
    const provider = new PatAuthProvider(secrets, validate, prompt);

    const token = await provider.getToken('ghe.example.com', { interactive: false });

    expect(token).toBeUndefined();
    expect(prompt.showInputBox).not.toHaveBeenCalled();
  });

  it('calls setToken when secret is missing and interactive is true', async () => {
    const secrets = createSecretStorage();
    const validate = vi.fn(async () => true);
    const prompt = createPrompt('ghp_interactive');
    const provider = new PatAuthProvider(secrets, validate, prompt);

    const token = await provider.getToken('ghe.example.com', { interactive: true });

    expect(token).toBe('ghp_interactive');
    expect(prompt.showInputBox).toHaveBeenCalledOnce();
    expect(secrets.store).toHaveBeenCalledWith('zuul.pat.ghe.example.com', 'ghp_interactive');
  });

  it('clears only the requested host and has no invalidate method', async () => {
    const secrets = createSecretStorage({
      'zuul.pat.ghe.example.com': 'ghp_one',
      'zuul.pat.other.example.com': 'ghp_two',
    });
    const provider = new PatAuthProvider(secrets, async () => true, createPrompt());

    await provider.clear('ghe.example.com');
    expect(secrets.data.has('zuul.pat.ghe.example.com')).toBe(false);

    expect('invalidate' in provider).toBe(false);
    expect(secrets.data.has('zuul.pat.other.example.com')).toBe(true);
    expect(secrets.delete).toHaveBeenCalledTimes(1);
  });

  it('validates PAT with GheClient.getUser()', async () => {
    const okFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ login: 'octocat', id: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    expect(await validatePatWithGhe('ghe.example.com', 'ghp_ok', okFetch)).toBe(true);

    const badFetch = vi.fn(
      async () => new Response('Unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;

    expect(await validatePatWithGhe('ghe.example.com', 'ghp_bad', badFetch)).toBe(false);
  });
});
