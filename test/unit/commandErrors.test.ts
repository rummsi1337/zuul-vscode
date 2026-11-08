import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/clients/http';
import {
  formatCommandError,
  offersSignIn,
  shortReason,
  SIGN_IN_ACTION,
  wrapCommand,
} from '../../src/util/commandErrors';
import { createFakeLogger } from '../helpers';

function makeDeps(choice?: string) {
  return {
    logger: createFakeLogger(),
    showErrorMessage: vi.fn(() => Promise.resolve(choice)),
    runCommand: vi.fn(() => Promise.resolve(undefined)),
    signInFor: vi.fn((_err: unknown) => ({ label: SIGN_IN_ACTION, command: 'zuul.setGhePat' })),
  };
}

const rateLimit = new HttpError(403, '{"message":"API rate limit exceeded"}');

describe('shortReason', () => {
  it('describes HTTP statuses briefly', () => {
    expect(shortReason(new HttpError(401, 'x'))).toContain('HTTP 401');
    expect(shortReason(new HttpError(403, 'nope'))).toBe('access denied (HTTP 403)');
    expect(shortReason(rateLimit)).toBe('rate limit reached (HTTP 403)');
    expect(shortReason(new HttpError(404, 'x'))).toBe('not found (HTTP 404)');
    expect(shortReason(new HttpError(502, 'x'))).toBe('server error (HTTP 502)');
  });

  it('uses the first line of other errors and truncates it', () => {
    expect(shortReason(new Error('boom\nstack'))).toBe('boom');
    expect(shortReason('plain')).toBe('plain');
    expect(shortReason(new Error('x'.repeat(300))).length).toBe(120);
    expect(shortReason(new Error(''))).toBe('unknown error');
  });
});

describe('offersSignIn', () => {
  it('offers sign in for 401 and non-rate-limit 403 only', () => {
    expect(offersSignIn(new HttpError(401, ''))).toBe(true);
    expect(offersSignIn(new HttpError(403, 'forbidden'))).toBe(true);
    expect(offersSignIn(rateLimit)).toBe(false);
    expect(offersSignIn(new HttpError(500, ''))).toBe(false);
    expect(offersSignIn(new Error('x'))).toBe(false);
  });
});

describe('wrapCommand', () => {
  it('returns the handler result when nothing fails', async () => {
    const deps = makeDeps();
    const run = wrapCommand(
      deps,
      () => 'do it',
      () => Promise.resolve(7),
    );
    expect(await run()).toBe(7);
    expect(deps.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows one message in the documented format', async () => {
    const deps = makeDeps();
    const run = wrapCommand(
      deps,
      (comment: string) => `post "${comment}" on org/repo#12`,
      () => Promise.reject(new HttpError(502, 'bad gateway')),
    );
    expect(await run('recheck')).toBeUndefined();
    expect(deps.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(deps.showErrorMessage).toHaveBeenCalledWith(
      'Could not post "recheck" on org/repo#12: server error (HTTP 502)',
    );
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('adds Sign in on 401 and runs the sign-in command when chosen', async () => {
    const deps = makeDeps(SIGN_IN_ACTION);
    const run = wrapCommand(
      deps,
      () => 'post "recheck" on org/repo#12',
      () => Promise.reject(new HttpError(401, '')),
    );
    await run();
    expect(deps.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Could not post "recheck" on org/repo#12:'),
      SIGN_IN_ACTION,
    );
    expect(deps.runCommand).toHaveBeenCalledWith('zuul.setGhePat');
  });

  it('uses the button and command chosen for the failing error', async () => {
    const deps = makeDeps('Set Zuul Token');
    deps.signInFor.mockReturnValue({ label: 'Set Zuul Token', command: 'zuul.setTenantToken' });
    const failure = new HttpError(401, '');
    const run = wrapCommand(
      deps,
      () => 'refresh Zuul data',
      () => Promise.reject(failure),
    );
    await run();
    expect(deps.signInFor).toHaveBeenCalledWith(failure);
    expect(deps.showErrorMessage).toHaveBeenCalledWith(expect.any(String), 'Set Zuul Token');
    expect(deps.runCommand).toHaveBeenCalledWith('zuul.setTenantToken');
  });

  it('does not offer Sign in for a rate limit', async () => {
    const deps = makeDeps();
    const run = wrapCommand(
      deps,
      () => 'x',
      () => Promise.reject(rateLimit),
    );
    await run();
    expect(deps.showErrorMessage).toHaveBeenCalledWith(expect.any(String));
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it('formats an action and a reason', () => {
    expect(formatCommandError('refresh', new Error('x'))).toBe('Could not refresh: x');
  });
});
