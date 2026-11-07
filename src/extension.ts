import * as vscode from 'vscode';
import { AuthService } from './auth/authService';
import { GhCliAuthProvider } from './auth/ghCliAuthProvider';
import { PatAuthProvider, validatePatWithGhe } from './auth/patAuthProvider';
import { readWorkspaceSettings } from './config/settings';
import { ZuulContextService } from './context/zuulContext';
import { GitContextService } from './git/gitContext';
import { type JobNode } from './services/buildsModel';
import { PrTracker } from './services/prTracker';
import { createOutputLogger } from './util/logger';
import { BuildsTreeDataProvider, OPEN_BUILD_LOG_COMMAND } from './views/buildsTreeView';
import { ZuulStatusBar } from './views/statusBar';

async function resolveTargetHost(
  gitContext: GitContextService,
  hostArg?: unknown,
): Promise<string | undefined> {
  if (typeof hostArg === 'string' && hostArg.trim().length > 0) {
    return hostArg.trim().toLowerCase();
  }
  if (gitContext.current?.host) {
    return gitContext.current.host;
  }
  const input = await vscode.window.showInputBox({
    prompt: 'Enter GitHub Enterprise hostname',
    placeHolder: 'ghe.example.com',
    ignoreFocusOut: true,
  });
  const trimmed = input?.trim().toLowerCase();
  return trimmed || undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Zuul');
  context.subscriptions.push(channel);
  const logger = createOutputLogger(channel);
  logger.info('[Zuul] activated');

  const gitContext = new GitContextService();
  const patProvider = new PatAuthProvider(context.secrets, validatePatWithGhe, vscode.window);
  const ghCliProvider = new GhCliAuthProvider();
  const authService = new AuthService(
    [patProvider, ghCliProvider],
    () => readWorkspaceSettings().authMethod,
    logger,
  );
  const zuulContext = new ZuulContextService({
    gitContext,
    auth: authService,
    logger,
    cache: context.workspaceState,
  });
  const prTracker = new PrTracker(zuulContext, logger);
  const statusBar = new ZuulStatusBar(prTracker);
  const buildsTree = new BuildsTreeDataProvider(prTracker);

  let promptedNoZuulUrl = false;
  const checkZuulContextProblem = (): void => {
    if (!promptedNoZuulUrl && zuulContext.problem === 'no-zuul-url') {
      promptedNoZuulUrl = true;
      void Promise.resolve(
        vscode.window.showInformationMessage('Set `zuul.url` to enable Zuul CI', 'Open Settings'),
      ).then((action) => {
        if (action === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'zuul.url');
        }
      });
    }
  };

  context.subscriptions.push(
    gitContext,
    zuulContext,
    prTracker,
    statusBar,
    buildsTree,
    vscode.window.registerTreeDataProvider('zuul.builds', buildsTree),
    vscode.commands.registerCommand(OPEN_BUILD_LOG_COMMAND, async (target?: string | JobNode) => {
      await buildsTree.openJobLog(target);
    }),
    gitContext.onDidChange((ctx) => {
      if (ctx) {
        logger.info(
          `[Git] context: ${ctx.host}/${ctx.owner}/${ctx.repo}@${ctx.branch ?? ctx.headSha ?? 'HEAD'}`,
        );
      }
    }),
    zuulContext.onDidChange(() => {
      checkZuulContextProblem();
    }),
    vscode.commands.registerCommand('zuul.setGhePat', async (hostArg?: unknown) => {
      const host = await resolveTargetHost(gitContext, hostArg);
      if (!host) {
        return;
      }
      const token = await patProvider.setToken(host);
      if (token) {
        logger.info(`[Auth] Stored PAT for ${host}`);
      }
    }),
    vscode.commands.registerCommand('zuul.clearGhePat', async (hostArg?: unknown) => {
      const host = await resolveTargetHost(gitContext, hostArg);
      if (!host) {
        return;
      }
      await patProvider.clear(host);
      logger.info(`[Auth] Cleared PAT for ${host}`);
    }),
    vscode.commands.registerCommand('zuul.refresh', async () => {
      await prTracker.refresh();
    }),
  );

  checkZuulContextProblem();
}

export function deactivate(): void {
  // no-op
}
