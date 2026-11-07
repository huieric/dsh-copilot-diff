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
  await page.locator('.ld-turnrow').first().click();

  // Changes view: every changed file is flattened into one scroll column, each
  // section carrying its own header and its own inline diff.
  await page.locator('.ld-pane .ld-flatfile').first().waitFor();
  const files = await page.locator('.ld-pane .ld-flatfile').count();
  assert.ok(files > 1, `every changed file gets a section (saw ${files})`);
  assert.equal(await page.locator('.ld-pane .ld-flathead').count(), files, 'each section keeps its own header');
  await page.getByRole('button', { name: /Keep (?:Turn 1|第 1 轮)/ }).waitFor();
  const text = await page.locator('.ld-pane').innerText();
  assert.ok(text.length > 100, 'review pane must contain actual code');
  assert.match(text, /Turn 1|第 1 轮/, 'footer must select this turn rather than entire session');
  assert.match(text, /unchanged lines|行未改动/, 'inline bodies fold untouched regions');
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/copilot-review.png', fullPage: true });

  // The unchanged bar is a real control: pressing it reveals the hidden lines.
  const folded = text.length;
  await page.locator('.ld-pane .ld-gap').first().click();
  await page.locator('.ld-pane .ld-gap.open').first().waitFor();
  assert.ok((await page.locator('.ld-pane').innerText()).length > folded, 'opening a bar reveals hidden lines');
  await page.screenshot({ path: 'output/playwright/copilot-review-context.png', fullPage: true });

  // A section folds to its header without disturbing the other files.
  const before = await page.locator('.ld-pane .ld-file-inline').count();
  await page.locator('.ld-pane .ld-flatfold').first().click();
  await page.waitForFunction((previous) => document.querySelectorAll('.ld-pane .ld-file-inline').length === previous - 1, before);
  await page.locator('.ld-pane .ld-flatfold').first().click();
  await page.waitForFunction((previous) => document.querySelectorAll('.ld-pane .ld-file-inline').length === previous, before);

  // Side-by-side mode applies to every flattened section at once.
  await page.getByRole('button', { name: /^(Side by side|并排)$/ }).click();
  await page.locator('.ld-pane .ld-split').first().waitFor();
  const splits = await page.locator('.ld-pane .ld-split').count();
  assert.ok(splits >= 2, `every section switches together (saw ${splits} split bodies)`);
  await page.screenshot({ path: 'output/playwright/copilot-review-split.png', fullPage: true });

  // The turn header must not grow a detached list of edits: the real edit row
  // renders at its tool call, in the order the host produced it.
  assert.equal(await page.locator('.ld-trow').count(), 0, 'no aggregated edit list in the turn header');
  await page.locator('.pv-rows .ld-toggle').first().click();
  await page.locator('.ld-diff .ld-difflines').first().waitFor();
  assert.ok((await page.locator('.ld-diff').first().innerText()).includes('SlotRotator'), 'inline row keeps file context');
  await page.screenshot({ path: 'output/playwright/copilot-inline.png', fullPage: true });

  // Inline bodies stay bounded: a long file caps its rows and offers the rest.
  await page.getByRole('button', { name: /^(Inline|统一)$/ }).click();
  const rows = await page.locator('.ld-pane .ld-file-inline .ld-line').count();
  assert.ok(rows <= 1200, 'inline bodies render a bounded number of rows');
  const more = page.locator('.ld-pane .ld-file-inline .ld-more').first();
  if (await more.count() > 0) {
    await more.click();
    await page.waitForTimeout(120);
    assert.ok(await page.locator('.ld-pane .ld-file-inline .ld-line').count() > rows, 'Show more reveals the rest');
  }
  await page.screenshot({ path: 'output/playwright/copilot-review-virtual.png', fullPage: true });

  // The turn boundary row carries the checkpoint link and the fork control.
  const boundary = page.locator('.ld-turnfoot');
  await boundary.waitFor();
  assert.equal(await page.locator('.ld-turnfoot .ld-cplink').count(), 2, 'restore and fork share the boundary row');
  // Checkpoint stays a quiet link until pressed, then asks for confirmation.
  await page.getByRole('button', { name: 'Restore checkpoint before turn 1', exact: true }).click();
  await page.locator('.ld-confirm').waitFor();
  assert.match(await page.locator('.ld-confirm').innerText(), /conversation|对话/);
  await page.screenshot({ path: 'output/playwright/copilot-checkpoint.png', fullPage: true });
  assert.deepEqual(errors, [], 'fixture must not throw browser errors');
  console.log(JSON.stringify({ fixture: 'synthetic', files, splits, codeVisible: true, inlineDiff: true, pageErrors: errors, screenshot: 'output/playwright/copilot-review.png' }));
} finally {
  await page.close();
  await browser.close();
}
