// Regenerate docs/screenshots from the synthetic preview fixture.
// Run after: node tools/preview.mjs > output/playwright/preview.html
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
const packagePath = process.env.PLAYWRIGHT_CORE;
if (!packagePath) throw new Error('Set PLAYWRIGHT_CORE to the installed playwright-core index.mjs path');
const { chromium } = await import(pathToFileURL(resolve(packagePath)).href);
const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9333');
const page = await browser.contexts()[0].newPage();
await mkdir('docs/screenshots', { recursive: true });
try {
	await page.setViewportSize({ width: 1600, height: 1000 });
	await page.goto(pathToFileURL(resolve('output/playwright/preview.html')).href);
	await page.waitForLoadState('networkidle');

	// Open the pane from the turn card; every file is flattened into one column.
	await page.locator('.ld-turnrow').first().click();
	await page.locator('.ld-pane .ld-flatfile').first().waitFor();
	await page.screenshot({ path: 'docs/screenshots/overview.png', fullPage: true });
	await page.locator('.ld-pane').screenshot({ path: 'docs/screenshots/expanded.png' });

	// One unchanged run opened, so the bar's effect is visible.
	await page.locator('.ld-pane .ld-gap').first().click();
	await page.locator('.ld-pane .ld-gap.open').first().waitFor();
	await page.locator('.ld-pane').screenshot({ path: 'docs/screenshots/unchanged.png' });

	// The turn boundary row: checkpoint restore and fork.
	await page.locator('.ld-turnfoot').screenshot({ path: 'docs/screenshots/boundary.png' });

	// Chat side: the edit row at its real tool call, expanded in place.
	await page.locator('.pv-rows .ld-toggle').first().click();
	await page.locator('.ld-diff .ld-difflines').first().waitFor();
	await page.locator('.ld-diff').first().screenshot({ path: 'docs/screenshots/inline.png' });

	// Side-by-side split applies to every flattened section at once.
	await page.getByRole('button', { name: /^(Side by side|并排)$/ }).click();
	await page.locator('.ld-pane .ld-split').first().waitFor();
	await page.locator('.ld-pane').screenshot({ path: 'docs/screenshots/split.png' });
	console.log(JSON.stringify({ ok: true }));
} finally {
	await page.close();
	await browser.close();
}
