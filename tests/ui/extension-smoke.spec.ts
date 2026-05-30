import { test, expect, chromium, type BrowserContext, type TestInfo } from '@playwright/test';
import path from 'node:path';

const extensionPath = path.resolve(process.cwd(), 'dist');

async function launchExtension(userDataDir: string): Promise<{
  context: BrowserContext;
  extensionId: string;
}> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    timeout: 30_000,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  }

  const extensionId = serviceWorker.url().split('/')[2];
  return { context, extensionId };
}

test.describe('SviBlox extension UI', () => {
  test('loads popup and options pages', async ({}, testInfo: TestInfo) => {
    const { context, extensionId } = await launchExtension(testInfo.outputPath('profile'));

    try {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
      await expect(popup.getByRole('heading', { name: 'General Features' })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Advanced options' })).toBeVisible();
      await popup.screenshot({ path: testInfo.outputPath('popup.png'), fullPage: true });

      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await expect(options.getByRole('heading', { name: 'Advanced Options' })).toBeVisible();
      await expect(options.getByRole('button', { name: 'Playtime manager' })).toBeVisible();
      await options.getByRole('button', { name: 'Playtime manager' }).click();
      await expect(options.getByRole('heading', { name: 'Playtime manager' })).toBeVisible();
      await options.screenshot({ path: testInfo.outputPath('options-playtime.png'), fullPage: true });
    } finally {
      await context.close();
    }
  });
});
