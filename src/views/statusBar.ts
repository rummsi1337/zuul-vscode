import * as vscode from 'vscode';
import { type PollError, type PrSnapshot } from '../services/prTracker';
import { offlineStatusText, statusBarText } from '../services/statusBarText';

export interface StatusBarTrackerSource {
  readonly snapshot: PrSnapshot | undefined;
  readonly onDidChange: vscode.Event<PrSnapshot | undefined>;
  readonly pollError?: PollError;
  readonly onDidChangePollError?: vscode.Event<void>;
}

export interface WaitingStateSource {
  readonly waiting: boolean;
  readonly onDidChangeWaiting?: vscode.Event<boolean>;
}

export class ZuulStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tracker: StatusBarTrackerSource;
  private readonly waitingSource?: WaitingStateSource;
  private isWaiting = false;

  constructor(
    tracker: StatusBarTrackerSource,
    waitingSource?: WaitingStateSource,
    createItem: () => vscode.StatusBarItem = () =>
      vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100),
  ) {
    this.tracker = tracker;
    this.waitingSource = waitingSource;
    this.isWaiting = waitingSource?.waiting ?? false;

    this.item = createItem();
    this.item.command = 'workbench.view.extension.zuul-explorer';

    this.disposables.push(
      this.item,
      this.tracker.onDidChange(() => {
        this.update();
      }),
    );

    if (this.tracker.onDidChangePollError) {
      this.disposables.push(
        this.tracker.onDidChangePollError(() => {
          this.update();
        }),
      );
    }

    if (this.waitingSource?.onDidChangeWaiting) {
      this.disposables.push(
        this.waitingSource.onDidChangeWaiting((waiting) => {
          this.isWaiting = waiting;
          this.update();
        }),
      );
    }

    this.update();
  }

  setWaiting(waiting: boolean): void {
    this.isWaiting = waiting;
    this.update();
  }

  update(): void {
    const pollError = this.tracker.pollError;
    if (pollError) {
      this.item.command = 'zuul.refresh';
      this.item.text = offlineStatusText(pollError.lastSuccessAt);
      this.item.tooltip = `Could not update from Zuul or GitHub: ${pollError.message}\nClick to refresh.`;
      this.item.show();
      return;
    }
    this.item.command = 'workbench.view.extension.zuul-explorer';
    const waiting = this.waitingSource ? this.waitingSource.waiting : this.isWaiting;
    const info = statusBarText(this.tracker.snapshot, waiting);
    if (!info) {
      this.item.hide();
      return;
    }
    this.item.text = info.text;
    this.item.tooltip = info.tooltip;
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
