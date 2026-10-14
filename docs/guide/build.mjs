// Builds docs/obscura-guide.pdf: takes fresh screenshots of the extension in Chromium,
// puts them into guide.html and prints it to PDF. Run: npm run guide
import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');
const EXTENSION = path.join(ROOT, '.output/chrome-mv3');
const GUIDE = path.join(ROOT, 'docs/guide');
const SHOTS = path.join(GUIDE, 'shots');
const OUTPUT = path.join(ROOT, 'docs/obscura-guide.pdf');

const LINE = 'https://obscura:Xk3f9QmZ2wLp7Rt4Vb8Nc1Jd@203.0.113.10:443#NL';
const SERVERS = [
  { id: 'nl', name: 'NL', scheme: 'https', host: '203.0.113.10', port: 443, auth: 'shared' },
  { id: 'de', name: 'DE', scheme: 'https', host: '198.51.100.7', port: 443, auth: 'shared' },
  { id: 'fi', name: 'FI', scheme: 'https', host: '192.0.2.44', port: 443, auth: 'shared' },
];

await mkdir(SHOTS, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'obscura-guide-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  locale: 'ru-RU',
  deviceScaleFactor: 2,
  args: ['--lang=ru', `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const id = new URL(worker.url()).host;
const boxes = {};

/**
 * A frame around an element, as fractions of the captured area (area is what the screenshot covers):
 * guide.html draws it over the image, so it stays sharp at any zoom.
 */
async function mark(shot, locator, area) {
  const box = await locator.boundingBox();
  boxes[shot] ??= [];
  boxes[shot].push({
    left: (box.x - area.x) / area.width, top: (box.y - area.y) / area.height,
    width: box.width / area.width, height: box.height / area.height,
  });
}

/** A rectangle enclosing several elements, with padding. */
async function around(locators, pad) {
  const list = await Promise.all(locators.map((locator) => locator.boundingBox()));
  const x = Math.min(...list.map((box) => box.x)) - pad;
  const y = Math.min(...list.map((box) => box.y)) - pad;
  const right = Math.max(...list.map((box) => box.x + box.width)) + pad;
  const bottom = Math.max(...list.map((box) => box.y + box.height)) + pad;
  return { x: Math.max(0, x), y: Math.max(0, y), width: right - Math.max(0, x), height: bottom - Math.max(0, y) };
}

// 1. The extensions page with developer mode on.
{
  const size = { width: 1000, height: 430 };
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.goto('chrome://extensions');
  await page.getByRole('button', { name: 'Режим разработчика' }).click();
  const load = page.getByRole('button', { name: /Загрузить распакованное/ });
  await load.waitFor();
  await page.waitForTimeout(500);
  const area = { x: 0, y: 0, ...size };
  await mark('extensions', page.getByRole('button', { name: 'Режим разработчика' }), area);
  await mark('extensions', load, area);
  await page.screenshot({ path: path.join(SHOTS, 'extensions.png') });
  await page.close();
}

// 2. Importing a connection line on the settings page.
{
  const page = await context.newPage();
  await page.setViewportSize({ width: 760, height: 1400 });
  await page.goto(`chrome-extension://${id}/options.html`);
  const section = (title) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const importSection = section('Импорт');
  await importSection.locator('textarea').fill(LINE);
  await page.waitForTimeout(300);
  const importArea = await around([importSection], 12);
  await mark('import', importSection.locator('textarea'), importArea);
  await mark('import', page.getByRole('button', { name: 'Добавить из списка' }), importArea);
  await page.screenshot({ path: path.join(SHOTS, 'import.png'), clip: importArea });

  await page.getByRole('button', { name: 'Добавить из списка' }).click();
  await page.getByText('стали общей учётной записью').waitFor();
  await page.waitForTimeout(300);
  const resultArea = await around([section('Общая учётная запись'), section('Серверы')], 12);
  await page.screenshot({ path: path.join(SHOTS, 'imported.png'), clip: resultArea });
  await page.close();
}

// 3. Popup: three servers, NL enabled, exit IP checked.
{
  await worker.evaluate((servers) => chrome.storage.local.set({ servers }), SERVERS);
  await context.route('https://ipinfo.io/json', (route) =>
    route.fulfill({ json: { ip: '203.0.113.10', country: 'NL', city: 'Amsterdam' } }));
  const page = await context.newPage();
  await page.setViewportSize({ width: 300, height: 330 });
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.getByRole('button', { name: /NL/ }).click();
  await page.getByText('NL, Amsterdam').waitFor({ timeout: 10000 });
  await page.locator('#app').screenshot({ path: path.join(SHOTS, 'popup.png') });
  await page.close();
}

await writeFile(path.join(SHOTS, 'boxes.json'), JSON.stringify(boxes, null, 2));

// 4. Printing the guide.
{
  const page = await context.newPage();
  await page.goto(`file://${path.join(GUIDE, 'guide.html')}`);
  await page.addStyleTag({ content: await fontFaces() });
  await page.evaluate((boxes) => {
    for (const figure of document.querySelectorAll('[data-shot]')) {
      const frame = figure.querySelector('.frame');
      for (const [index, box] of (boxes[figure.dataset.shot] ?? []).entries()) {
        const ring = document.createElement('span');
        ring.className = 'ring';
        ring.dataset.n = String(index + 1);
        Object.assign(ring.style, {
          left: `calc(${box.left * 100}% - 5px)`, top: `calc(${box.top * 100}% - 5px)`,
          width: `calc(${box.width * 100}% + 10px)`, height: `calc(${box.height * 100}% + 10px)`,
        });
        frame.append(ring);
      }
    }
  }, boxes);
  // Fonts are local (docs/guide/fonts) but load lazily — load every face before printing.
  await page.evaluate(async () => {
    const faces = [
      ...['400', '500', '600', '700'].map((weight) => `${weight} 12px "Golos Text"`),
      ...['400', '600'].map((weight) => `${weight} 12px "Roboto Mono"`),
    ];
    await Promise.all(faces.map((face) => document.fonts.load(face, 'Пакеты abc')));
    await document.fonts.ready;
  });
  await page.waitForTimeout(500);
  await page.pdf({
    path: OUTPUT,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;font:8px -apple-system,'Helvetica Neue','Segoe UI',Arial,sans-serif;color:#8a929e;padding:0 15mm;display:flex;justify-content:space-between">
      <span>Obscura · инструкция по установке</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    margin: { top: '14mm', bottom: '16mm', left: '15mm', right: '15mm' },
  });
  await page.close();
}

await context.close();
await rm(profile, { recursive: true, force: true });

/** @font-face for every TTF in fonts/ (file name: Family-weight.ttf) with the data inlined. */
async function fontFaces() {
  const dir = path.join(GUIDE, 'fonts');
  const families = { GolosText: 'Golos Text', RobotoMono: 'Roboto Mono' };
  let css = '';
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.ttf'))) {
    const [key, weight] = file.replace('.ttf', '').split('-');
    const data = (await readFile(path.join(dir, file))).toString('base64');
    css += `@font-face { font-family: '${families[key]}'; font-weight: ${weight}; font-style: normal; src: url(data:font/ttf;base64,${data}) format('truetype'); }\n`;
  }
  return css;
}
console.log(`Готово: ${path.relative(ROOT, OUTPUT)}`);
