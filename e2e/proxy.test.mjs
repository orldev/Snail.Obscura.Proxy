// End-to-end check: real Chromium with the built extension and local proxies
// with Basic auth. Run: npm run test:e2e (builds .output first).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const EXTENSION = path.resolve('.output/chrome-mv3');
const TARGET = 'http://target.test/';
const SHARED = { username: 'me', password: 'secret' };

function startProxy(name, credentials) {
  const expected = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  const stats = { challenges: 0, rejected: 0, served: 0 };
  const challenge = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="obscura-test"\r\nContent-Length: 0\r\n\r\n';

  const server = http.createServer((request, response) => {
    const given = request.headers['proxy-authorization'];
    if (given !== expected) {
      if (given === undefined) stats.challenges++;
      else stats.rejected++;
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="obscura-test"', 'Content-Length': 0 });
      response.end();
      return;
    }
    stats.served++;
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    response.end(`via ${name}`);
  });
  server.on('connect', (request, socket) => {
    if (request.headers['proxy-authorization'] !== expected) socket.end(challenge);
    else socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ name, server, stats, port: server.address().port }));
  });
}

describe('Obscura in Chromium', () => {
  let context;
  let worker;
  let extensionId;
  let profile;
  const proxies = {};

  before(async () => {
    proxies.T1 = await startProxy('T1', SHARED);
    proxies.T2 = await startProxy('T2', SHARED);
    proxies.BAD = await startProxy('BAD', { username: 'me', password: 'другой' });

    profile = await mkdtemp(path.join(tmpdir(), 'obscura-e2e-'));
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(worker.url()).host;

    const servers = Object.values(proxies).map((proxy) => ({
      id: proxy.name, name: proxy.name, scheme: 'http', host: '127.0.0.1', port: proxy.port, auth: 'shared',
    }));
    await worker.evaluate(
      (data) => chrome.storage.local.set(data),
      { servers, settings: { shared: SHARED, bypass: ['<local>'], webrtc: true } },
    );
  });

  after(async () => {
    await context?.close();
    for (const proxy of Object.values(proxies)) proxy.server.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  async function activate(id) {
    await worker.evaluate((id) => chrome.storage.local.set({ active: { id, lastId: id }, status: { error: null, at: Date.now() } }), id);
    const port = id === null ? null : proxies[id].port;
    for (let attempt = 0; attempt < 50; attempt++) {
      const { value } = await worker.evaluate(() => chrome.proxy.settings.get({}));
      const applied = port === null ? value.mode !== 'fixed_servers' : value.rules?.singleProxy?.port === port;
      if (applied) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`proxy ${id} was not applied`);
  }

  async function open(url) {
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { timeout: 8000 });
      return { text: await response.text(), status: response.status() };
    } catch (error) {
      return { error: error.message };
    } finally {
      await page.close();
    }
  }

  it('supplies the shared account and shows the short name on the badge', async () => {
    await activate('T1');
    const result = await open(TARGET);
    assert.equal(result.text, 'via T1');
    assert.equal(proxies.T1.stats.rejected, 0);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), 'T1');
    const rtc = await worker.evaluate(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({}));
    assert.equal(rtc.value, 'disable_non_proxied_udp');
  });

  it('switches to another server with the same account', async () => {
    await activate('T2');
    assert.equal((await open(TARGET)).text, 'via T2');
    assert.equal(proxies.T2.stats.rejected, 0);
  });

  it('a wrong password does not loop and ends up as an error', async () => {
    await activate('BAD');
    const result = await open(TARGET);
    assert.notEqual(result.text, 'via BAD');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.ok(proxies.BAD.stats.rejected <= 2, `отказов: ${proxies.BAD.stats.rejected}`);
    const { status } = await worker.evaluate(() => chrome.storage.local.get('status'));
    assert.match(status.error, /BAD: сервер не принял логин или пароль/);
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '!');
  });

  it('"Off" hands the proxy back to the system', async () => {
    await activate(null);
    const setting = await worker.evaluate(() => chrome.proxy.settings.get({}));
    assert.equal(setting.levelOfControl, 'controllable_by_this_extension');
    assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '');
    const rtc = await worker.evaluate(() => chrome.privacy.network.webRTCIPHandlingPolicy.get({}));
    assert.equal(rtc.levelOfControl, 'controllable_by_this_extension');
  });

  it('popup switches the server by short name and checks the exit through it', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.getByRole('button', { name: /T2/ }).click();
    await page.waitForFunction(() => document.querySelector('[aria-current="true"]')?.textContent?.includes('T2'));
    const { active } = await worker.evaluate(() => chrome.storage.local.get('active'));
    assert.equal(active.id, 'T2');
    // The test proxy doesn't open HTTPS tunnels, so the exit IP check must fail:
    // that proves it really went through T2.
    await page.getByText('Нет ответа').waitFor({ timeout: 20000 });
    const title = await worker.evaluate(() => chrome.action.getTitle({}));
    assert.match(title, /T2|ERR_TUNNEL_CONNECTION_FAILED/);
    await page.close();
  });

  it('import in settings adds a server with the shared account', async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.locator('textarea').first().fill('NL 203.0.113.10\nчепуха');
    await page.getByRole('button', { name: 'Добавить из списка' }).click();
    await page.getByText('Добавлено серверов: 1').waitFor();
    await page.getByText('Строка 2').waitFor();
    const { servers } = await worker.evaluate(() => chrome.storage.local.get('servers'));
    const added = servers.find((server) => server.name === 'NL');
    assert.deepEqual(
      { scheme: added.scheme, host: added.host, port: added.port, auth: added.auth },
      { scheme: 'https', host: '203.0.113.10', port: 443, auth: 'shared' },
    );
    await page.close();
  });
});
