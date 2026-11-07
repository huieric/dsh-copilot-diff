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
  // Changes view: the file index starts folded; open it, then pick a file and
  // watch it fold away again so the diff owns the pane.
  assert.equal(await page.locator('.ld-frow').count(), 0, 'the file index must start folded');
  assert.equal(await page.locator('.ld-pane .ld-fileschevron').innerText(), '›', 'the folded index keeps a chevron affordance');
  await page.locator('.ld-fileshead').click();
  await page.locator('.ld-pane .ld-fileschevron[data-open]').waitFor();
  await page.locator('.ld-frow').first().click();
  assert.equal(await page.locator('.ld-frow').count(), 0, 'choosing a file folds the index');
  await page.locator('.ld-pane .ld-editorbody .ld-text').first().waitFor();
  await page.getByRole('button', { name: /Keep (?:Turn 1|第 1 轮)/ }).waitFor();
  const text = await page.locator('.ld-pane').innerText();
  assert.ok(text.length > 100, 'review pane must contain actual code');
  assert.match(text, /Turn 1|第 1 轮/, 'footer must select this turn rather than entire session');
  assert.match(text, /unchanged lines|行未改动/, 'whole-file view folds untouched regions');
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/copilot-review.png', fullPage: true });
  const folded = text.length;
  await page.locator('.ld-pane .ld-gap').first().click();
  await page.locator('.ld-pane .ld-gap.open').first().waitFor();
  assert.ok((await page.locator('.ld-pane').innerText()).length > folded, 'opening a gap reveals hidden lines');
  await page.screenshot({ path: 'output/playwright/copilot-review-context.png', fullPage: true });

  // Side-by-side mode and file switching.
  await page.getByRole('button', { name: /^(Side by side|并排)$/ }).click();
  await page.locator('.ld-pane .ld-split').waitFor();
  const firstPath = await page.locator('.ld-editorpath').innerText();
  await page.locator('.ld-fileshead').click();
  await page.locator('.ld-frow').nth(1).click();
  await page.waitForFunction((previous) => document.querySelector('.ld-editorpath')?.innerText !== previous, firstPath);
  assert.notEqual(await page.locator('.ld-editorpath').innerText(), firstPath, 'file list switches the diff');
  await page.screenshot({ path: 'output/playwright/copilot-review-split.png', fullPage: true });

  // The turn header must not grow a detached list of edits: the real edit row
  // renders at its tool call, in the order the host produced it.
  assert.equal(await page.locator('.ld-trow').count(), 0, 'no aggregated edit list in the turn header');
  await page.locator('.pv-rows .ld-toggle').first().click();
  await page.locator('.ld-diff .ld-difflines').first().waitFor();
  assert.ok((await page.locator('.ld-diff').first().innerText()).includes('SlotRotator'), 'inline row keeps file context');
  await page.screenshot({ path: 'output/playwright/copilot-inline.png', fullPage: true });

  // Whole-file virtualization: expanding every gap mounts a 1200-line file but
  // only the visible window exists in the DOM.
  await page.locator('.ld-fileshead').click();
  await page.locator('.ld-frow').nth(3).click();
  await page.getByRole('button', { name: /^(Inline|统一)$/ }).click();
  await page.getByRole('button', { name: /^(Expand unchanged|展开未改动)$/ }).click();
  const scroller = page.locator('.ld-pane .ld-difflines.ld-vscroll').first();
  await page.waitForFunction(() => {
    const el = document.querySelector('.ld-pane .ld-difflines.ld-vscroll');
    return el !== null && el.querySelectorAll('.ld-line').length > 0;
  });
  const metrics = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, rows: el.querySelectorAll('.ld-line').length, cls: el.className, text: el.innerText.slice(0, 80) }));
  assert.ok(metrics.scrollHeight > 15000, 'the whole 1200-line file is scrollable');
  assert.ok(metrics.rows < 300, `virtualized DOM stays bounded (saw ${metrics.rows} rows)`);
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(150);
  assert.match(await scroller.innerText(), /line 1200/, 'scrolling reaches the untouched tail');
  await page.screenshot({ path: 'output/playwright/copilot-review-virtual.png', fullPage: true });

  // Checkpoint stays a quiet link until pressed, then asks for confirmation.
  await page.getByRole('button', { name: 'Restore checkpoint before turn 1', exact: true }).click();
  await page.locator('.ld-confirm').waitFor();
  assert.match(await page.locator('.ld-confirm').innerText(), /conversation|对话/);
  await page.screenshot({ path: 'output/playwright/copilot-checkpoint.png', fullPage: true });
  assert.deepEqual(errors, [], 'fixture must not throw browser errors');
  console.log(JSON.stringify({ fixture: 'synthetic', codeVisible: true, inlineDiff: true, pageErrors: errors, screenshot: 'output/playwright/copilot-review.png' }));
} finally {
  await page.close();
  await browser.close();
}
