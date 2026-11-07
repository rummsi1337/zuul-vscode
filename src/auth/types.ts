export type AuthMethodId = 'oauth' | 'gh-cli' | 'pat';

export interface GetTokenOptions {
  interactive: boolean;
}

export interface TokenProvider {
  readonly id: AuthMethodId;
  getToken(host: string, opts: { interactive: boolean }): Promise<string | undefined>;
  invalidate?(host: string): Promise<void>;
}

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface InputBoxOptionsLike {
  prompt?: string;
  placeHolder?: string;
  password?: boolean;
  ignoreFocusOut?: boolean;
}

export interface PromptLike {
  showInputBox(options?: InputBoxOptionsLike): PromiseLike<string | undefined>;
  showErrorMessage(message: string): PromiseLike<unknown> | void;
}
