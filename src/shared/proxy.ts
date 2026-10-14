import { addressOf, badgeOf, credentialsOf, type ErrorSource, type Server, type Settings, type Status } from './model';

/** Config for chrome.proxy.settings: one server for all traffic except the bypass list. */
export function fixedConfig(server: Server, settings: Settings) {
  return {
    mode: 'fixed_servers' as const,
    rules: {
      singleProxy: { scheme: server.scheme, host: server.host, port: server.port },
      bypassList: settings.bypass,
    },
  };
}

export interface Badge {
  text: string;
  color: string;
  title: string;
}

export const COLORS = {
  on: '#1f7a4d',
  error: '#b3261e',
};

export function badgeFor(server: Server | null, error: string | null): Badge {
  if (error !== null) {
    return { text: '!', color: COLORS.error, title: `Obscura — ошибка: ${error}` };
  }
  if (server === null) {
    return { text: '', color: COLORS.on, title: 'Obscura — напрямую' };
  }
  return {
    text: badgeOf(server.name),
    color: COLORS.on,
    title: `Obscura — ${server.name} (${addressOf(server)})`,
  };
}

/**
 * Decision on a proxy authentication challenge. Attempts are counted per requestId:
 * a repeated challenge for the same requestId means Chrome already sent our password
 * and was refused — we answer with cancel, otherwise Chrome keeps asking forever.
 */
export type AuthDecision =
  | { kind: 'credentials'; username: string; password: string }
  | { kind: 'cancel'; reason: string }
  | { kind: 'pass' };

export function findByChallenger(
  servers: Server[],
  challenger: { host: string; port: number },
): Server | null {
  const host = challenger.host.replace(/^\[|\]$/g, '').toLowerCase();
  return servers.find((server) => server.host.toLowerCase() === host && server.port === challenger.port) ?? null;
}

export function decideAuth(server: Server | null, settings: Settings, attempt: number): AuthDecision {
  if (server === null) return { kind: 'pass' };
  const credentials = credentialsOf(server, settings);
  if (credentials === null) {
    return { kind: 'cancel', reason: `${server.name}: сервер просит пароль, а учётная запись не задана` };
  }
  if (attempt > 1) {
    return { kind: 'cancel', reason: `${server.name}: сервер не принял логин или пароль` };
  }
  return { kind: 'credentials', ...credentials };
}

/** Whether to write a new error over the current one. */
export function shouldReport(current: Status, error: string, source: ErrorSource): boolean {
  if (current.error === null) return true;
  if (current.error === error) return false;
  return source === 'auth' || current.source !== 'auth';
}
