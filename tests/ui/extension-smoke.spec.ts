import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';

const extensionPath = path.resolve(process.cwd(), 'dist');

async function launchExtension(): Promise<{
  context: BrowserContext;
  extensionId: string;
}> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker');
  }

  const extensionId = serviceWorker.url().split('/')[2];
  return { context, extensionId };
}

test.describe('SviBlox extension UI', () => {
  test('loads popup and options pages', async () => {
    const { context, extensionId } = await launchExtension();

    try {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
      await expect(popup.getByRole('heading', { name: 'General Features' })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Options' })).toBeVisible();
      await popup.screenshot({ path: 'test-results/popup.png', fullPage: true });

      const options = await context.newPage();
      await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
      await expect(options.getByRole('heading', { name: 'SviBlox' })).toBeVisible();
      await expect(options.getByRole('button', { name: 'Playtime' })).toBeVisible();
      await options.getByRole('button', { name: 'Playtime' }).click();
      await expect(options.getByRole('heading', { name: 'Playtime' })).toBeVisible();
      await options.screenshot({ path: 'test-results/options-playtime.png', fullPage: true });
    } finally {
      await context.close();
    }
  });
});
