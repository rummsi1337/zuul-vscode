import * as vscode from 'vscode';
import { createOutputLogger } from './util/logger';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Zuul');
  context.subscriptions.push(channel);
  const logger = createOutputLogger(channel);
  logger.info('[Zuul] activated');
}

export function deactivate(): void {
  // no-op
}
