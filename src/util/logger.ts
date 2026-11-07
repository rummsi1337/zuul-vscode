export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface OutputChannelLike {
  appendLine(value: string): void;
}

export function createOutputLogger(
  channel: OutputChannelLike,
  now: () => Date = () => new Date(),
): Logger {
  const write = (level: 'INFO' | 'WARN' | 'ERROR', message: string): void => {
    channel.appendLine(`${now().toISOString()} [${level}] ${message}`);
  };

  return {
    info(message: string): void {
      write('INFO', message);
    },
    warn(message: string): void {
      write('WARN', message);
    },
    error(message: string, err?: unknown): void {
      if (err === undefined) {
        write('ERROR', message);
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      write('ERROR', `${message}: ${detail}`);
    },
  };
}
