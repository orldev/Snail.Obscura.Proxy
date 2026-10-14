export type Scheme = 'https' | 'http' | 'socks5' | 'socks4';

export const SCHEMES: Scheme[] = ['https', 'http', 'socks5', 'socks4'];

export const DEFAULT_PORT: Record<Scheme, number> = {
  https: 443,
  http: 3128,
  socks5: 1080,
  socks4: 1080,
};

export interface Credentials {
  username: string;
  password: string;
}

/**
 * Where a server takes its login and password from:
 * shared — the shared account from settings (the usual case: only the IP differs),
 * own — the server's own account, none — no authentication.
 */
export type AuthMode = 'shared' | 'own' | 'none';

export interface Server {
  id: string;
  /** Short name: "NL", "DE-2". Its first characters are shown on the badge. */
  name: string;
  scheme: Scheme;
  host: string;
  port: number;
  auth: AuthMode;
  own?: Credentials;
}

export interface Settings {
  shared: Credentials;
  bypass: string[];
  webrtc: boolean;
}

export interface Active {
  id: string | null;
  /** The last enabled server: the keyboard shortcut switches back to it. */
  lastId: string | null;
}

/**
 * auth — the server rejected the password or there is none; proxy — a network error of the proxy.
 * An auth error explains more, so a network error never overwrites it.
 */
export type ErrorSource = 'auth' | 'proxy';

export interface Status {
  error: string | null;
  source?: ErrorSource;
  at: number;
}

export const DEFAULT_SETTINGS: Settings = {
  shared: { username: '', password: '' },
  bypass: ['<local>', 'localhost', '127.0.0.1', '::1'],
  webrtc: true,
};

export const NAME_LIMIT = 12;
export const BADGE_LIMIT = 4;

export function credentialsOf(server: Server, settings: Settings): Credentials | null {
  if (server.auth === 'none') return null;
  const credentials = server.auth === 'own' ? server.own : settings.shared;
  if (!credentials || credentials.username === '') return null;
  return credentials;
}

export function badgeOf(name: string): string {
  return name.trim().slice(0, BADGE_LIMIT).toUpperCase();
}

export function addressOf(server: Server): string {
  const host = server.host.includes(':') ? `[${server.host}]` : server.host;
  return `${host}:${server.port}`;
}

export interface Problem {
  text: string;
  /** A blocking problem prevents saving the server; the others are only warnings. */
  blocking: boolean;
}

/** Server problems as user-facing text (in Russian); an empty list means the server is valid. */
export function problemsOf(server: Server, settings: Settings, others: Server[] = []): Problem[] {
  const problems: Problem[] = [];
  const block = (text: string) => problems.push({ text, blocking: true });

  if (server.name.trim() === '') block('Нужно короткое имя');
  if (server.name.length > NAME_LIMIT) block(`Имя длиннее ${NAME_LIMIT} символов`);
  if (server.host.trim() === '') block('Нужен адрес сервера');
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    block('Порт должен быть от 1 до 65535');
  }
  if (server.auth === 'own' && (server.own?.username ?? '') === '') block('Нужен логин своей учётной записи');
  if (server.scheme.startsWith('socks') && server.auth !== 'none') {
    block('Chrome не умеет SOCKS с паролем: выберите https или http, либо «без авторизации»');
  }

  for (const other of others) {
    if (other.id === server.id) continue;
    if (other.name.trim().toLowerCase() === server.name.trim().toLowerCase()) {
      block(`Имя «${server.name}» уже занято`);
    }
    if (other.host.toLowerCase() === server.host.toLowerCase() && other.port === server.port) {
      block(`Этот адрес уже есть у «${other.name}»`);
    }
  }

  if (server.auth === 'shared' && settings.shared.username === '') {
    problems.push({ text: 'Общая учётная запись не заполнена', blocking: false });
  }
  return problems;
}

export function newId(): string {
  return crypto.randomUUID();
}
