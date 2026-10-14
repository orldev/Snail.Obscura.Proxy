import { browser } from 'wxt/browser';
import { badgeFor, decideAuth, findByChallenger, fixedConfig, shouldReport } from '@/shared/proxy';
import { activate, load, onChange, report } from '@/shared/storage';
import type { ErrorSource, Server } from '@/shared/model';

export default defineBackground(() => {
  // Listeners are registered synchronously: the service worker wakes up for an event
  // and must find its handler right away, otherwise the event is lost.
  const attempts = new Map<string, number>();

  browser.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      // In asyncBlocking mode Chrome waits for an answer to EVERY call, even ones we don't care about.
      const answer = callback ?? (() => {});
      if (!details.isProxy || details.challenger === undefined) {
        answer({});
        return undefined;
      }
      const challenger = details.challenger;
      const attempt = (attempts.get(details.requestId) ?? 0) + 1;
      attempts.set(details.requestId, attempt);

      load()
        .then(({ servers, settings }) => {
          const decision = decideAuth(findByChallenger(servers, challenger), settings, attempt);
          if (decision.kind === 'credentials') {
            answer({ authCredentials: { username: decision.username, password: decision.password } });
          } else if (decision.kind === 'cancel') {
            // Queue first, answer second: the cancel immediately triggers onProxyError.
            reportError(decision.reason, 'auth');
            answer({ cancel: true });
          } else {
            answer({});
          }
        })
        .catch(() => answer({}));
      return undefined;
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking'],
  );

  const forget = (details: { requestId: string }) => attempts.delete(details.requestId);
  browser.webRequest.onCompleted.addListener(forget, { urls: ['<all_urls>'] });
  browser.webRequest.onErrorOccurred.addListener(forget, { urls: ['<all_urls>'] });

  browser.proxy.onProxyError.addListener((details) => {
    reportError(details.error, 'proxy');
  });

  browser.commands.onCommand.addListener((command) => {
    void handleCommand(command);
  });

  browser.runtime.onInstalled.addListener(() => void apply());
  browser.runtime.onStartup.addListener(() => void apply());

  onChange(['servers', 'settings', 'active'], () => void apply());
  onChange(['status'], () => void paint());
});

async function apply(): Promise<void> {
  const { servers, settings, active } = await load();
  const server = servers.find((candidate) => candidate.id === active.id) ?? null;

  if (server === null) {
    await browser.proxy.settings.clear({ scope: 'regular' });
  } else {
    await browser.proxy.settings.set({ value: fixedConfig(server, settings), scope: 'regular' });
  }

  const webrtc = browser.privacy.network.webRTCIPHandlingPolicy;
  if (server !== null && settings.webrtc) {
    await webrtc.set({ value: 'disable_non_proxied_udp' });
  } else {
    await webrtc.clear({});
  }

  await paint();
}

async function paint(): Promise<void> {
  const { servers, active, status } = await load();
  const server: Server | null = servers.find((candidate) => candidate.id === active.id) ?? null;
  const badge = badgeFor(server, status.error);
  await browser.action.setBadgeText({ text: badge.text });
  await browser.action.setBadgeBackgroundColor({ color: badge.color });
  await browser.action.setTitle({ title: badge.title });
}

let reports: Promise<void> = Promise.resolve();

/**
 * Errors arrive in bursts — one per request. The queue keeps them from overwriting
 * each other in a read-write race; shouldReport decides what gets written.
 */
function reportError(error: string, source: ErrorSource): void {
  reports = reports
    .then(async () => {
      const { active, status } = await load();
      if (active.id !== null && shouldReport(status, error, source)) await report(error, source);
    })
    .catch(() => {});
}

async function handleCommand(command: string): Promise<void> {
  const { servers, active } = await load();
  if (servers.length === 0) return;

  if (command === 'toggle') {
    if (active.id !== null) {
      await activate(null);
      return;
    }
    const last = servers.find((server) => server.id === active.lastId);
    await activate((last ?? servers[0]!).id);
  }

  if (command === 'next') {
    const index = servers.findIndex((server) => server.id === active.id);
    await activate(servers[(index + 1) % servers.length]!.id);
  }
}
