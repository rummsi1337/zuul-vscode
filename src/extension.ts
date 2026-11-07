import * as vscode from 'vscode';
import { GitContextService } from './git/gitContext';
import { createOutputLogger } from './util/logger';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Zuul');
  context.subscriptions.push(channel);
  const logger = createOutputLogger(channel);
  logger.info('[Zuul] activated');

  const gitContext = new GitContextService();
  context.subscriptions.push(
    gitContext,
    gitContext.onDidChange((ctx) => {
      if (ctx) {
        logger.info(
          `[Git] context: ${ctx.host}/${ctx.owner}/${ctx.repo}@${ctx.branch ?? ctx.headSha ?? 'HEAD'}`,
        );
      }
    }),
  );
}

export function deactivate(): void {
  // no-op
}
