import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: '1.129.1',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
