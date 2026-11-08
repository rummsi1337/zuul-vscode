import { HttpError } from '../clients/http';
import { type Logger } from './logger';

export const SIGN_IN_ACTION = 'Sign in';
const MAX_REASON_LENGTH = 120;

export function isRateLimitError(err: unknown): boolean {
  return err instanceof HttpError && err.status === 403 && /rate limit/i.test(err.body);
}

/** A 401, or a 403 that is not a rate limit, can be fixed by signing in. */
export function offersSignIn(err: unknown): boolean {
  if (!(err instanceof HttpError)) {
    return false;
  }
  return err.status === 401 || (err.status === 403 && !isRateLimitError(err));
}

export function shortReason(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return 'not signed in, or the token was rejected (HTTP 401)';
    }
    if (isRateLimitError(err)) {
      return 'rate limit reached (HTTP 403)';
    }
    if (err.status === 403) {
      return 'access denied (HTTP 403)';
    }
    if (err.status === 404) {
      return 'not found (HTTP 404)';
    }
    if (err.status >= 500) {
      return `server error (HTTP ${err.status})`;
    }
  }
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split(/\r?\n/, 1)[0].trim() || 'unknown error';
  return firstLine.length > MAX_REASON_LENGTH
    ? `${firstLine.slice(0, MAX_REASON_LENGTH - 1)}…`
    : firstLine;
}

export function formatCommandError(action: string, err: unknown): string {
  return `Could not ${action}: ${shortReason(err)}`;
}

/** The button on an auth failure, and the command it runs. */
export interface SignInOption {
  readonly label: string;
  readonly command: string;
}

export interface CommandErrorDeps {
  readonly logger: Logger;
  showErrorMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
  runCommand(command: string): PromiseLike<unknown>;
  /** Picks the sign-in that can fix this error. */
  signInFor(err: unknown): SignInOption;
}

/**
 * Wraps a command handler. A failure becomes one error message such as
 * `Could not post "recheck" on org/repo#12: server error (HTTP 502)`.
 * `describe` returns the action text and runs before the handler.
 */
export function wrapCommand<A extends unknown[], R>(
  deps: CommandErrorDeps,
  describe: (...args: A) => string,
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | undefined> {
  return async (...args: A): Promise<R | undefined> => {
    const action = describe(...args);
    try {
      return await handler(...args);
    } catch (err) {
      const message = formatCommandError(action, err);
      deps.logger.error(`[Command] ${message}`, err);
      const signIn = offersSignIn(err) ? deps.signInFor(err) : undefined;
      const choice = await (signIn
        ? deps.showErrorMessage(message, signIn.label)
        : deps.showErrorMessage(message));
      if (signIn && choice === signIn.label) {
        await deps.runCommand(signIn.command);
      }
      return undefined;
    }
  };
}
