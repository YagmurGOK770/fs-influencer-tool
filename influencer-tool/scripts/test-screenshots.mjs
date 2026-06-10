import { chromium } from 'playwright-core';
import path from 'path';
import fs from 'fs';

const urls = [
  { url: 'https://www.tiktok.com/@kalanighosthunter', name: 'tiktok_kalanighosthunter' },
  { url: 'https://www.youtube.com/@MattDoesFitness', name: 'youtube_mattdoesfitness' },
  { url: 'https://www.instagram.com/loveandlondon/', name: 'instagram_loveandlondon' },
  { url: 'https://x.com/VinnieSull1van', name: 'x_vinniesull1van' },
];

const outDir = path.join(process.cwd(), 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

for (const { url, name } of urls) {
  console.log(`Capturing: ${url}`);
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  try {
    const waitUntil = url.includes('x.com') || url.includes('twitter.com') ? 'domcontentloaded' : 'networkidle';
    await page.goto(url, { waitUntil, timeout: 30000 });
    await page.waitForTimeout(2000); // let lazy content load
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`  Saved: ${file}`);
  } catch (err) {
    console.error(`  Failed: ${err.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log('\nDone. Screenshots in:', outDir);
