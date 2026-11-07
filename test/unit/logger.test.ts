import { describe, expect, it } from 'vitest';
import { createOutputLogger } from '../../src/util/logger';

describe('createOutputLogger', () => {
  const fixedNow = () => new Date('2026-01-02T03:04:05.678Z');

  it('formats info, warn, and error messages with ISO time and level', () => {
    const lines: string[] = [];
    const logger = createOutputLogger(
      {
        appendLine: (s) => lines.push(s),
      },
      fixedNow,
    );

    logger.info('[Zuul] activated');
    logger.warn('[Poll] slow response');
    logger.error('[GHE] request failed');
    logger.error('[GHE] unexpected failure', new Error('boom'));
    logger.error('[Auth] rejected', 'bad-token-shape');

    expect(lines).toEqual([
      '2026-01-02T03:04:05.678Z [INFO] [Zuul] activated',
      '2026-01-02T03:04:05.678Z [WARN] [Poll] slow response',
      '2026-01-02T03:04:05.678Z [ERROR] [GHE] request failed',
      '2026-01-02T03:04:05.678Z [ERROR] [GHE] unexpected failure: boom',
      '2026-01-02T03:04:05.678Z [ERROR] [Auth] rejected: bad-token-shape',
    ]);
  });

  it('uses current system clock by default', () => {
    const lines: string[] = [];
    const logger = createOutputLogger({
      appendLine: (s) => lines.push(s),
    });

    logger.info('[Zuul] ready');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] \[Zuul\] ready$/,
    );
  });
});
