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

	// Open the pane from the turn's compact chip row; the index starts folded.
	await page.locator('.ld-fileitem').first().click();
	await page.locator('.ld-pane .ld-editorbody .ld-text').first().waitFor();
	await page.screenshot({ path: 'docs/screenshots/overview.png', fullPage: true });

	await page.locator('.ld-pane .ld-fileshead').click();
	await page.locator('.ld-pane .ld-frow').first().waitFor();
	await page.locator('.ld-pane').screenshot({ path: 'docs/screenshots/expanded.png' });
	await page.locator('.ld-pane .ld-frow').first().click();

	// Chat side: the edit row at its real tool call, expanded in place.
	await page.locator('.pv-rows .ld-toggle').first().click();
	await page.locator('.ld-diff .ld-difflines').first().waitFor();
	await page.locator('.ld-diff').first().screenshot({ path: 'docs/screenshots/inline.png' });

	// Side-by-side split of the whole file.
	await page.getByRole('button', { name: /^(Side by side|并排)$/ }).click();
	await page.locator('.ld-pane .ld-split').waitFor();
	await page.locator('.ld-pane .ld-editorbody').screenshot({ path: 'docs/screenshots/split.png' });
	console.log(JSON.stringify({ ok: true }));
} finally {
	await page.close();
	await browser.close();
}
