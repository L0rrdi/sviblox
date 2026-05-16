import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  outputDir: './test-results',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
