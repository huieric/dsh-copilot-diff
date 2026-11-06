// Run after: node tools/preview.mjs > output/playwright/preview.html
// Requires an existing Chromium CDP endpoint and installed playwright-core.
// This tests the labelled synthetic component fixture, not an authenticated DSH host.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
const packagePath = process.env.PLAYWRIGHT_CORE;
if (!packagePath) throw new Error('Set PLAYWRIGHT_CORE to the installed playwright-core index.mjs path');
const { chromium } = await import(pathToFileURL(resolve(packagePath)).href);
const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9333');
const page = await browser.contexts()[0].newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(pathToFileURL(resolve('output/playwright/preview.html')).href);
  await page.waitForLoadState('networkidle');
  await page.locator('.ld-fileitem').first().click();
  await page.locator('.ld-pane .ld-text').first().waitFor();
  const text = await page.locator('.ld-pane').innerText();
  assert.ok(text.length > 100, 'review pane must contain actual code');
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/copilot-review.png', fullPage: true });
  await page.getByRole('button', { name: /^(Side by side|并排视图)$/ }).click();
  await page.locator('.ld-side-diff').waitFor();
  const initial = await page.getByRole('combobox', { name: 'Changed file' }).inputValue();
  await page.getByRole('button', { name: 'Next file', exact: true }).click();
  assert.notEqual(await page.getByRole('combobox', { name: 'Changed file' }).inputValue(), initial);
  await page.getByRole('button', { name: 'Restore checkpoint before turn 1', exact: true }).click();
  await page.locator('.ld-confirm').waitFor();
  assert.match(await page.locator('.ld-confirm').innerText(), /conversation|对话/);
  await page.screenshot({ path: 'output/playwright/copilot-review-split.png', fullPage: true });
  assert.deepEqual(errors, [], 'fixture must not throw browser errors');
  console.log(JSON.stringify({ fixture: 'synthetic', codeVisible: true, pageErrors: errors, screenshot: 'output/playwright/copilot-review.png' }));
} finally {
  await page.close();
  await browser.close();
}
