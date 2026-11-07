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

  // Footer file selection scopes the pane to this turn, like Copilot's request row.
  await page.locator('.ld-fileitem').first().click();
  // Changes view: pick a file from the compact list, render whole-file diff.
  await page.locator('.ld-frow').first().click();
  await page.locator('.ld-pane .ld-editorbody .ld-text').first().waitFor();
  await page.getByRole('button', { name: /Keep (?:Turn 1|第 1 轮)/ }).waitFor();
  const text = await page.locator('.ld-pane').innerText();
  assert.ok(text.length > 100, 'review pane must contain actual code');
  assert.match(text, /Turn 1|第 1 轮/, 'footer must select this turn rather than entire session');
  assert.match(text, /unchanged lines|行未改动/, 'whole-file view folds untouched regions');
  const folded = text.length;
  await page.locator('.ld-pane .ld-gap').first().click();
  await page.locator('.ld-pane .ld-gap.open').first().waitFor();
  assert.ok((await page.locator('.ld-pane').innerText()).length > folded, 'opening a gap reveals hidden lines');
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/copilot-review.png', fullPage: true });

  // Side-by-side mode and file switching.
  await page.getByRole('button', { name: /^(Side by side|并排)$/ }).click();
  await page.locator('.ld-pane .ld-split').waitFor();
  const firstPath = await page.locator('.ld-editorpath').innerText();
  await page.locator('.ld-frow').nth(1).click();
  await page.waitForFunction((previous) => document.querySelector('.ld-editorpath')?.innerText !== previous, firstPath);
  assert.notEqual(await page.locator('.ld-editorpath').innerText(), firstPath, 'file list switches the diff');

  // An expanded turn shows the diff where the edit happened, not a detached list.
  await page.locator('.ld-inline .ld-difflines').first().waitFor();
  assert.ok((await page.locator('.ld-inline').first().innerText()).includes('SlotRotator'), 'inline row keeps file context');
  const inlineCount = await page.locator('.ld-inline').count();
  await page.locator('.ld-trow').first().click({ position: { x: 8, y: 12 } });
  await page.waitForFunction((count) => document.querySelectorAll('.ld-inline').length === count - 1, inlineCount);
  await page.locator('.ld-trow').first().click({ position: { x: 8, y: 12 } });
  await page.waitForFunction((count) => document.querySelectorAll('.ld-inline').length === count, inlineCount);
  await page.locator('.ld-inline .ld-difflines').first().waitFor();

  // Checkpoint stays a quiet link until pressed, then asks for confirmation.
  await page.getByRole('button', { name: 'Restore checkpoint before turn 1', exact: true }).click();
  await page.locator('.ld-confirm').waitFor();
  assert.match(await page.locator('.ld-confirm').innerText(), /conversation|对话/);
  await page.screenshot({ path: 'output/playwright/copilot-review-split.png', fullPage: true });
  assert.deepEqual(errors, [], 'fixture must not throw browser errors');
  console.log(JSON.stringify({ fixture: 'synthetic', codeVisible: true, inlineDiff: true, pageErrors: errors, screenshot: 'output/playwright/copilot-review.png' }));
} finally {
  await page.close();
  await browser.close();
}
