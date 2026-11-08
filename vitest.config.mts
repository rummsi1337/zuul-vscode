import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve('test/mocks/vscode.ts'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/extension.ts', 'src/views/**'],
      thresholds: {
        lines: 80,
        branches: 80,
        perFile: true,
      },
    },
  },
});
