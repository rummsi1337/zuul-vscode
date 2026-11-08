import { describe, expect, it, vi } from 'vitest';
import { openDependencyPrExternally } from '../../src/views/dependsOnTreeView';

describe('openDependencyPrExternally URL schemes', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x/y'])(
    'does not open %s',
    async (url) => {
      const openExternal = vi.fn(async () => true);
      await openDependencyPrExternally(url, openExternal);
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it('opens https URLs', async () => {
    const openExternal = vi.fn(async () => true);
    await openDependencyPrExternally('https://ghe.example.com/acme/service/pull/1', openExternal);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
