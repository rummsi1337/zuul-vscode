import * as vscode from 'vscode';
import { AuthService } from './auth/authService';
import { GhCliAuthProvider } from './auth/ghCliAuthProvider';
import { PatAuthProvider, validatePatWithGhe } from './auth/patAuthProvider';
import { ZuulTokenProvider } from './auth/zuulTokenProvider';
import { onTokenSettingsChanged, readWorkspaceSettings } from './config/settings';
import { ZuulContextService } from './context/zuulContext';
import { GitContextService } from './git/gitContext';
import { normalizeHost } from './git/remoteUrl';
import { type JobNode } from './services/buildsModel';
import { formatPrRef } from './services/dependsOnParser';
import { extractPrCoordinates } from './services/dependsOnService';
import { PrTracker } from './services/prTracker';
import { HAS_PR_CONTEXT_KEY, TriggerService } from './services/triggerService';
import { wrapCommand } from './util/commandErrors';
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
      void vscode.commands.executeCommand('setContext', 'zuul.authChecked', true);
      void vscode.commands.executeCommand('setContext', 'zuul.signedIn', signedIn);
    },
  );
  const zuulTokenProvider = new ZuulTokenProvider({
    secrets: context.secrets,
    getSettings: () => ({
      tokens: readWorkspaceSettings().tokens,
      tokenFile: readWorkspaceSettings().tokenFile,
    }),
    prompt: vscode.window,
    logger,
  });
  const zuulContext = new ZuulContextService({
    gitContext,
    auth: authService,
    zuulAuth: zuulTokenProvider,
    logger,
    cache: context.workspaceState,
  });
  const prTracker = new PrTracker(zuulContext, logger, {
    getPollIntervalMs: () => readWorkspaceSettings().pollIntervalSeconds * 1000,
  });
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

  void vscode.commands.executeCommand('setContext', 'zuul.contextProblem', 'loading');
  void vscode.commands.executeCommand('setContext', 'zuul.authChecked', false);

  const prLabel = (): string => {
    const snapshot = prTracker.snapshot;
    const coords = snapshot ? extractPrCoordinates(snapshot.pr) : undefined;
    return snapshot && coords
      ? formatPrRef({ owner: coords.owner, repo: coords.repo, number: snapshot.pr.number })
      : 'the pull request';
  };
  const guard = <A extends unknown[], R>(
    describe: (...args: A) => string,
    handler: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R | undefined>) =>
    wrapCommand(
      {
        logger,
        showErrorMessage: (message, ...actions) =>
          vscode.window.showErrorMessage(message, ...actions),
        runCommand: (command) => vscode.commands.executeCommand(command),
        signInFor: (err) => zuulContext.signInFor(err),
      },
      describe,
      handler,
    );

  let promptedNoZuulUrl = false;
  const checkZuulContextProblem = (): void => {
    const problem = zuulContext.problem ?? (zuulContext.current ? 'none' : 'loading');
    void vscode.commands.executeCommand('setContext', 'zuul.contextProblem', problem);
    void vscode.commands.executeCommand(
      'setContext',
      'zuul.zuulProblem',
      zuulContext.zuulProblem ?? 'none',
    );
    if (!promptedNoZuulUrl && zuulContext.problem === 'no-zuul-url') {
      promptedNoZuulUrl = true;
      void Promise.resolve(
        vscode.window.showInformationMessage('Set zuul.url to enable Zuul CI', 'Open Settings'),
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
    onTokenSettingsChanged(() => {
      void vscode.commands.executeCommand('zuul.refresh');
    }),
    vscode.commands.registerCommand('zuul.setGhePat', async (hostArg?: unknown) => {
      const host = await resolveTargetHost(gitContext, hostArg);
      if (!host) {
        return;
      }
      const token = await patProvider.setToken(host);
      if (token) {
        logger.info(`[Auth] Stored PAT for ${host}`);
        void vscode.window.showInformationMessage(`Saved token for ${host}`);
        await vscode.commands.executeCommand('zuul.refresh');
      }
    }),
    vscode.commands.registerCommand('zuul.clearGhePat', async (hostArg?: unknown) => {
      const host = await resolveTargetHost(gitContext, hostArg);
      if (!host) {
        return;
      }
      await patProvider.clear(host);
      logger.info(`[Auth] Cleared PAT for ${host}`);
      void vscode.window.showInformationMessage(`Removed token for ${host}`);
      await vscode.commands.executeCommand('zuul.refresh');
    }),
    vscode.commands.registerCommand('zuul.setTenantToken', async (tenantArg?: unknown) => {
      const explicit =
        typeof tenantArg === 'string' && tenantArg.trim().length > 0 ? tenantArg.trim() : undefined;
      const suggested =
        zuulContext.current?.zuul?.tenant || readWorkspaceSettings().tenant || undefined;
      const token = await zuulTokenProvider.setToken(explicit, suggested);
      if (token) {
        await vscode.commands.executeCommand('zuul.refresh');
      }
    }),
    vscode.commands.registerCommand('zuul.clearTenantToken', async (tenantArg?: unknown) => {
      const explicit =
        typeof tenantArg === 'string' && tenantArg.trim().length > 0 ? tenantArg.trim() : undefined;
      if (explicit) {
        await zuulTokenProvider.clearToken(explicit);
        logger.info(`[Auth] Cleared Zuul token for tenant "${explicit}"`);
      } else {
        const stored = await zuulTokenProvider.listStoredTenants();
        if (stored.length === 0) {
          void vscode.window.showInformationMessage('No stored Zuul tokens to clear.');
          return;
        }
        const CLEAR_ALL = 'Clear all stored tokens';
        const picked = await vscode.window.showQuickPick([...stored, CLEAR_ALL], {
          placeHolder: 'Select the Zuul tenant token to clear',
        });
        if (!picked) {
          return;
        }
        if (picked === CLEAR_ALL) {
          const choice = await vscode.window.showWarningMessage(
            'Delete all stored Zuul tokens?',
            { modal: true },
            'Delete',
          );
          if (choice !== 'Delete') {
            return;
          }
          await zuulTokenProvider.clearToken();
          logger.info('[Auth] Cleared all stored Zuul tokens');
        } else {
          await zuulTokenProvider.clearToken(picked);
          logger.info(`[Auth] Cleared Zuul token for tenant "${picked}"`);
        }
      }
      const settings = readWorkspaceSettings();
      if (Object.keys(settings.tokens).length > 0 || settings.tokenFile.trim().length > 0) {
        void vscode.window.showInformationMessage(
          'Tokens from zuul.tokens or zuul.tokenFile still apply.',
        );
      }
      await vscode.commands.executeCommand('zuul.refresh');
    }),
    vscode.commands.registerCommand(
      'zuul.refresh',
      guard(
        () => 'refresh Zuul data',
        async () => {
          zuulContext.clearClientCaches();
          await zuulContext.recompute();
          dependsOnTree.invalidateCache();
          gateTree.invalidateCache();
          await prTracker.refresh();
        },
      ),
    ),
    vscode.commands.registerCommand(
      'zuul.postTrigger',
      guard(
        (commentArg?: unknown) =>
          typeof commentArg === 'string' && commentArg.trim().length > 0
            ? `post "${commentArg.trim()}" on ${prLabel()}`
            : `post a trigger comment on ${prLabel()}`,
        async (commentArg?: unknown) => {
          if (typeof commentArg === 'string' && commentArg.trim().length > 0) {
            await triggerService.post(commentArg.trim());
            return;
          }
          await triggerService.pickAndPostTrigger(readWorkspaceSettings().triggerComments);
        },
      ),
    ),
    vscode.commands.registerCommand(
      'zuul.postCustomTrigger',
      guard(
        () => `post a trigger comment on ${prLabel()}`,
        async () => {
          await triggerService.promptAndPostCustomTrigger();
        },
      ),
    ),
    vscode.commands.registerCommand(
      'zuul.addDependsOn',
      guard(
        () => `add a Depends-On to ${prLabel()}`,
        async (targetArg?: unknown) => {
          await pickAndAddDependsOn({
            ctx: zuulContext,
            tracker: prTracker,
            logger,
            onUpdated: () => dependsOnTree.invalidateCache(),
            targetArg,
          });
        },
      ),
    ),
    vscode.commands.registerCommand(
      'zuul.removeDependsOn',
      guard(
        () => `remove a Depends-On from ${prLabel()}`,
        async (target?: unknown) => {
          await dependsOnTree.removeDependsOn(target);
        },
      ),
    ),
    vscode.commands.registerCommand(
      'zuul.syncViaRecheck',
      guard(
        () => `post "recheck" on ${prLabel()}`,
        async () => {
          await triggerService.post('recheck');
        },
      ),
    ),
  );

  checkZuulContextProblem();
  void zuulContext.ready
    .then(() => {
      checkZuulContextProblem();
    })
    .catch((err: unknown) => {
      logger.error('[Zuul] Failed to resolve the Zuul context', err);
      checkZuulContextProblem();
    });
}

export function deactivate(): void {
  // no-op
}
