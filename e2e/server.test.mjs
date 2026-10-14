// Checks a real server installed by server/install-proxy.sh the way a user goes:
// paste the connection line in the settings, pick the server in the popup, open a website.
// Skipped when no line is given:
//   OBSCURA_LINE='https://obscura:password@203.0.113.10:443#NL' npm run test:e2e
// For a server with a self-signed certificate (container tests) add OBSCURA_INSECURE=1.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const LINE = process.env.OBSCURA_LINE;
const EXTENSION = path.resolve('.output/chrome-mv3');
const NAME = LINE ? decodeURIComponent(new URL(LINE).hash.slice(1)) : '';

describe('Obscura through a real server', { skip: LINE ? false : 'OBSCURA_LINE is not set' }, () => {
  let context;
  let worker;
  let extensionId;
  let profile;

  async function launch() {
    const args = [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`];
    if (process.env.OBSCURA_INSECURE === '1') args.push('--ignore-certificate-errors');
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args });
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(worker.url()).host;
  }

  before(async () => {
    profile = await mkdtemp(path.join(tmpdir(), 'obscura-server-'));
    await launch();
  });

  after(async () => {
    await context?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  // A unique URL every time: the profile survives restarts, and Chrome would serve a fresh page
  // from a previous test out of its disk cache without touching the proxy at all.
  async function open(url) {
    const page = await context.newPage();
    try {
      const response = await page.goto(`${url}?t=${Date.now()}${Math.random()}`, { timeout: 20000 });
      return { status: response.status() };
    } catch (error) {
      return { error: error.message };
    } finally {
      await page.close();
    }
  }

  it('connection line from the server output: import, pick in popup, websites open', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('textarea').first().fill(LINE);
    await options.getByRole('button', { name: 'Добавить из списка' }).click();
    await options.getByText('Добавлено серверов: 1').waitFor();
    await options.getByText('стали общей учётной записью').waitFor();
    await options.close();

    const { servers, settings } = await worker.evaluate(() => chrome.storage.local.get(['servers', 'settings']));
    assert.equal(servers[0].auth, 'shared');
    assert.equal(settings.shared.username, decodeURIComponent(new URL(LINE).username));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByRole('button', { name: new RegExp(NAME) }).click();
    await popup.waitForFunction((name) => document.querySelector('[aria-current="true"]')?.textContent?.includes(name), NAME);
    await popup.close();

    assert.equal((await open('https://example.com/')).status, 200);
    assert.equal((await open('http://example.com/')).status, 200);
    const { status } = await worker.evaluate(() => chrome.storage.local.get('status'));
    assert.equal(status.error, null);
  });

  it('a wrong password gives a clear error', async () => {
    // Chrome remembers an accepted password until restart and sends it without asking the extension.
    // So: turn the proxy off and break the password, restart the browser, turn it back on.
    await worker.evaluate(async () => {
      const { settings, active } = await chrome.storage.local.get(['settings', 'active']);
      settings.shared.password += '-неверный';
      await chrome.storage.local.set({ settings, active: { id: null, lastId: active.id } });
    });
    await context.close();
    await launch();
    await worker.evaluate(async () => {
      const { active } = await chrome.storage.local.get('active');
      await chrome.storage.local.set({ active: { id: active.lastId, lastId: active.lastId }, status: { error: null, at: Date.now() } });
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await open('https://example.com/');
    assert.ok(result.error, 'the page must not open');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { status } = await worker.evaluate(() => chrome.storage.local.get('status'));
    assert.match(status.error ?? '', new RegExp(`${NAME}: сервер не принял логин или пароль`));
  });
});
