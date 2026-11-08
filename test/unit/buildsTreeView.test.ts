import { describe, expect, it } from 'vitest';
import { type PrSnapshot } from '../../src/services/prTracker';
import { BuildsTreeDataProvider, type BuildsTreeNode } from '../../src/views/buildsTreeView';
import { EventEmitter } from '../mocks/vscode';

describe('BuildsTreeDataProvider ids', () => {
  it('gives two same-named pipelines different ids and leaves jobs without ids', () => {
    const status = { pipeline: 'check', queue: 'q', live: true, jobs: [{ name: 'j' }] };
    const snapshot = {
      pr: { number: 1 },
      statuses: [status, status],
      builds: [],
      fetchedAt: 0,
    } as unknown as PrSnapshot;
    const provider = new BuildsTreeDataProvider({
      snapshot,
      onDidChange: new EventEmitter<PrSnapshot | undefined>().event,
    });

    const roots = provider.getChildren() as BuildsTreeNode[];
    const ids = roots.map((n) => provider.getTreeItem(n).id);

    expect(roots).toHaveLength(2);
    expect(ids).toEqual(['builds/check', 'builds/check~2']);
    const job = provider.getChildren(roots[0])[0];
    expect(provider.getTreeItem(job).id).toBeUndefined();
    provider.dispose();
  });
});
