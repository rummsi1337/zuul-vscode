import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Manifest {
  contributes: {
    commands: { command: string }[];
    menus: Record<string, { command: string }[]>;
    viewsWelcome: { contents: string }[];
  };
}

// Only tree items run these, so they are deliberately not contributed.
const UNDECLARED_COMMANDS = ['zuul.openBuildLog', 'zuul.openDependencyPr'];

const manifest = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as Manifest;

const source = readdirSync(path.resolve('src'), { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => readFileSync(path.resolve('src', file), 'utf8'))
  .join('\n');

function findRegisteredCommands(): string[] {
  const constants = new Map(
    [...source.matchAll(/\bconst\s+(\w+)\s*=\s*'(zuul\.[\w.]+)'/g)].map((m) => [m[1], m[2]]),
  );
  return [...source.matchAll(/registerCommand\(\s*(?:'([^']+)'|(\w+))/g)].map(
    (m) => m[1] ?? constants.get(m[2]) ?? m[2],
  );
}

describe('package.json commands', () => {
  const registered = findRegisteredCommands();
  const declared = manifest.contributes.commands.map((c) => c.command);

  it('finds the registered commands in the source', () => {
    expect(registered).toContain('zuul.refresh');
    expect(registered).toEqual(expect.arrayContaining(UNDECLARED_COMMANDS));
  });

  it('resolves every registerCommand call to a command id', () => {
    expect(registered.filter((id) => !id.includes('.'))).toEqual([]);
  });

  it('registers every contributed command', () => {
    expect(declared.filter((id) => !registered.includes(id))).toEqual([]);
  });

  it('registers every command used in a menu', () => {
    const inMenus = Object.values(manifest.contributes.menus)
      .flat()
      .map((entry) => entry.command);

    expect(inMenus.length).toBeGreaterThan(0);
    expect(inMenus.filter((id) => !registered.includes(id))).toEqual([]);
  });

  it('registers every command linked from a welcome view', () => {
    const linked = manifest.contributes.viewsWelcome.flatMap((view) =>
      [...view.contents.matchAll(/command:(zuul\.[\w.]+)/g)].map((m) => m[1]),
    );

    expect(linked.length).toBeGreaterThan(0);
    expect(linked.filter((id) => !registered.includes(id))).toEqual([]);
  });

  it('declares every registered command except the tree-only ones', () => {
    const undeclared = registered.filter(
      (id) => id.startsWith('zuul.') && !declared.includes(id) && !UNDECLARED_COMMANDS.includes(id),
    );

    expect(undeclared).toEqual([]);
  });
});
