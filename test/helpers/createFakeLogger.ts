import { vi } from 'vitest';
import { type Logger } from '../../src/util/logger';

export type FakeLogger = Logger & {
  messages: string[];
  errors: { msg: string; err: unknown }[];
};

export function createFakeLogger(): FakeLogger {
  const messages: string[] = [];
  const errors: { msg: string; err: unknown }[] = [];
  return {
    messages,
    errors,
    info: vi.fn((m: string) => {
      messages.push(`INFO: ${m}`);
    }),
    warn: vi.fn((m: string) => {
      messages.push(`WARN: ${m}`);
    }),
    error: vi.fn((m: string, err?: unknown) => {
      messages.push(`ERROR: ${m}`);
      errors.push({ msg: m, err });
    }),
  };
}
