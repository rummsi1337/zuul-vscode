import * as vscode from 'vscode';
import { AuthService } from './auth/authService';
import { GhCliAuthProvider } from './auth/ghCliAuthProvider';
import { PatAuthProvider, validatePatWithGhe } from './auth/patAuthProvider';
import { readWorkspaceSettings } from './config/settings';
import { ZuulContextService } from './context/zuulContext';
import { GitContextService } from './git/gitContext';
import { normalizeHost } from './git/remoteUrl';
import { type JobNode } from './services/buildsModel';
import { PrTracker } from './services/prTracker';
import { HAS_PR_CONTEXT_KEY, TriggerService } from './services/triggerService';
import { createOutputLogger } from './util/logger';
import { pickAndAddDependsOn } from './views/addDependsOnPick';
import { BuildsTreeDataProvider, OPEN_BUILD_LOG_COMMAND } from './views/buildsTreeView';
import {
  DependsOnTreeDataProvider,
  type DownstreamDepNode,
  OPEN_DEPENDENCY_PR_COMMAND,
  type UpstreamDepNode,
} from './views/dependsOnTreeView';
import { PrGateTreeDataProvider } from './views/prGateTreeView';
import { ZuulStatusBar } from './views/statusBar';

async function resolveTargetHost(
  gitContext: GitContextService,
  hostArg?: unknown,
): Promise<string | undefined> {
  if (typeof hostArg === 'string' && hostArg.trim().length > 0) {
    return normalizeHost(hostArg);
  }
  if (gitContext.current?.host) {
    return gitContext.current.host;
  }
  const input = await vscode.window.showInputBox({
    prompt: 'Enter GitHub Enterprise hostname',
    placeHolder: 'ghe.example.com',
    ignoreFocusOut: true,
  });
  const trimmed = input ? normalizeHost(input) : undefined;
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
    (_host, signedIn) => {
      void vscode.commands.executeCommand('setContext', 'zuul.signedIn', signedIn);
    },
  );
  const zuulContext = new ZuulContextService({
    gitContext,
    auth: authService,
    logger,
    cache: context.workspaceState,
  });
  const prTracker = new PrTracker(zuulContext, logger);
  const triggerService = new TriggerService(zuulContext, prTracker, logger);
  const statusBar = new ZuulStatusBar(prTracker, triggerService);
  const buildsTree = new BuildsTreeDataProvider(prTracker);
  const gateTree = new PrGateTreeDataProvider(
    prTracker,
    zuulContext,
    () => readWorkspaceSettings().gate,
    logger,
  );
  const dependsOnTree = new DependsOnTreeDataProvider(zuulContext, prTracker, logger);

  void vscode.commands.executeCommand(
    'setContext',
    HAS_PR_CONTEXT_KEY,
    prTracker.snapshot !== undefined,
  );

  let promptedNoZuulUrl = false;
  const checkZuulContextProblem = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'zuul.contextProblem',
      zuulContext.problem ?? 'none',
    );
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
    triggerService,
    statusBar,
    buildsTree,
    dependsOnTree,
    gateTree,
    vscode.window.registerTreeDataProvider('zuul.gateReadiness', gateTree),
    vscode.window.registerTreeDataProvider('zuul.builds', buildsTree),
    vscode.window.registerTreeDataProvider('zuul.dependencies', dependsOnTree),
    vscode.commands.registerCommand(OPEN_BUILD_LOG_COMMAND, async (target?: string | JobNode) => {
      await buildsTree.openJobLog(target);
    }),
    vscode.commands.registerCommand(
      OPEN_DEPENDENCY_PR_COMMAND,
      async (target?: string | UpstreamDepNode | DownstreamDepNode) => {
        await dependsOnTree.openPr(target);
      },
    ),
    prTracker.onDidChange((snapshot) => {
      void vscode.commands.executeCommand('setContext', HAS_PR_CONTEXT_KEY, snapshot !== undefined);
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
      dependsOnTree.invalidateCache();
      gateTree.invalidateCache();
      await prTracker.refresh();
    }),
    vscode.commands.registerCommand('zuul.postTrigger', async (commentArg?: unknown) => {
      if (typeof commentArg === 'string' && commentArg.trim().length > 0) {
        await triggerService.post(commentArg.trim());
        return;
      }
      await triggerService.pickAndPostTrigger(readWorkspaceSettings().triggerComments);
    }),
    vscode.commands.registerCommand('zuul.postCustomTrigger', async () => {
      await triggerService.promptAndPostCustomTrigger();
    }),
    vscode.commands.registerCommand('zuul.addDependsOn', async (targetArg?: unknown) => {
      await pickAndAddDependsOn({
        ctx: zuulContext,
        tracker: prTracker,
        logger,
        onUpdated: () => dependsOnTree.invalidateCache(),
        targetArg,
      });
    }),
    vscode.commands.registerCommand('zuul.removeDependsOn', async (target?: unknown) => {
      await dependsOnTree.removeDependsOn(target);
    }),
    vscode.commands.registerCommand('zuul.syncViaRecheck', async () => {
      await triggerService.post('recheck');
    }),
  );

  checkZuulContextProblem();
  void zuulContext.ready.then(() => {
    checkZuulContextProblem();
  });
}

export function deactivate(): void {
  // no-op
}
