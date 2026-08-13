import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // Pinned: @vscode/test-electron 2.4.1 can't spawn VS Code 1.133+ macOS binaries.
  version: '1.129.1',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
