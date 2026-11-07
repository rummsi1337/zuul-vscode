import * as vscode from 'vscode';

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
}

export interface RepositoryState {
  readonly HEAD?: Branch;
  readonly remotes: Remote[];
  readonly onDidChange: vscode.Event<void>;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
}

export interface API {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

export interface GitExtension {
  readonly enabled?: boolean;
  getAPI(version: 1): API;
}

export async function getGitApi(): Promise<API | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    return undefined;
  }
  const gitExtension = extension.isActive ? extension.exports : await extension.activate();
  if (!gitExtension || gitExtension.enabled === false) {
    return undefined;
  }
  return gitExtension.getAPI(1);
}
