/**
 * 由 public/icon.svg、public/icon-maskable.svg 生成 PNG 圖示（iOS 主畫面一定要 PNG）。
 * 需要 playwright（唔係專案依賴）：npx playwright install chromium && node scripts/make-icons.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'public');

const jobs = [
  // iOS 會自己加圓角，所以用 full-bleed 版（冇透明位）
  { svg: 'icon-maskable.svg', out: 'apple-touch-icon.png', size: 180, transparent: false },
  { svg: 'icon.svg', out: 'icon-192.png', size: 192, transparent: true },
  { svg: 'icon.svg', out: 'icon-512.png', size: 512, transparent: true },
  { svg: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512, transparent: false },
];

(async () => {
  const browser = await chromium.launch();
  for (const j of jobs) {
    const page = await browser.newPage({ viewport: { width: j.size, height: j.size } });
    const svg = fs.readFileSync(path.join(pub, j.svg), 'utf8');
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${j.size}px;height:${j.size}px;display:block}</style>${svg}`);
    await page.screenshot({ path: path.join(pub, j.out), omitBackground: j.transparent });
    await page.close();
    console.log('wrote', j.out);
  }
  await browser.close();
})();
