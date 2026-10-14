import { DEFAULT_PORT, newId, SCHEMES, type Credentials, type Scheme, type Server } from './model';

export interface ParsedLine {
  line: number;
  server?: Server;
  error?: string;
}

interface Address {
  scheme: Scheme;
  host: string;
  port: number;
  credentials?: Credentials;
}

/**
 * Parses a list of servers, one per line. Understands:
 *   1.2.3.4                              — https:443, shared account
 *   NL 1.2.3.4   or   1.2.3.4 NL         — the same with a short name
 *   https://1.2.3.4:443#NL               — scheme, port, name after #
 *   http://user:pass@1.2.3.4:3128        — the server's own account
 *   1.2.3.4:8080:user:pass               — proxy vendors' format (http)
 * Empty lines and lines starting with # are skipped.
 */
export function parseList(text: string, shared: Credentials): ParsedLine[] {
  const result: ParsedLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    result.push({ line: index + 1, ...parseLine(raw, shared) });
  }
  return result;
}

function parseLine(raw: string, shared: Credentials): Omit<ParsedLine, 'line'> {
  let text = raw;
  let name = '';

  const hash = text.indexOf('#');
  if (hash > 0) {
    name = text.slice(hash + 1).trim();
    text = text.slice(0, hash).trim();
  }

  const tokens = text.split(/\s+/);
  if (tokens.length > 2) return { error: 'Слишком много частей в строке' };

  let address: Address | null = null;
  for (const token of tokens) {
    const parsed: Address | null = address === null ? parseAddress(token) : null;
    if (parsed !== null) {
      address = parsed;
    } else if (name === '') {
      name = token;
    } else {
      return { error: `Не понимаю «${token}»` };
    }
  }
  if (address === null) return { error: 'Не нашёл адрес сервера' };

  const server: Server = {
    id: newId(),
    name: name === '' ? address.host : name,
    scheme: address.scheme,
    host: address.host,
    port: address.port,
    auth: 'shared',
  };
  const credentials = address.credentials;
  if (credentials !== undefined && !sameCredentials(credentials, shared)) {
    server.auth = 'own';
    server.own = credentials;
  }
  return { server };
}

function parseAddress(token: string): Address | null {
  const seller = parseSeller(token);
  if (seller !== null) return seller;

  const hasScheme = /^[a-z0-9]+:\/\//i.test(token);
  const scheme = hasScheme ? token.slice(0, token.indexOf(':')).toLowerCase() : 'https';
  if (!SCHEMES.includes(scheme as Scheme)) return null;

  let url: URL;
  try {
    // URL parses only schemes it knows predictably, so we substitute http
    url = new URL(`http://${hasScheme ? token.slice(token.indexOf('://') + 3) : token}`);
  } catch {
    return null;
  }
  if (url.pathname !== '/' || url.search !== '') return null;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!looksLikeHost(host)) return null;

  const explicitPort = /:(\d+)\/?$/.test(token);
  const port = explicitPort ? Number(url.port || 80) : DEFAULT_PORT[scheme as Scheme];

  const address: Address = { scheme: scheme as Scheme, host, port };
  if (url.username !== '') {
    address.credentials = {
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }
  return address;
}

/** host:port:user:pass — exactly three colons, no IPv6. */
function parseSeller(token: string): Address | null {
  const parts = token.split(':');
  if (parts.length !== 4 || token.includes('[') || token.includes('/')) return null;
  const [host, port, username, password] = parts as [string, string, string, string];
  if (!looksLikeHost(host) || !/^\d+$/.test(port)) return null;
  return { scheme: 'http', host, port: Number(port), credentials: { username, password } };
}

function looksLikeHost(host: string): boolean {
  if (host.includes(':')) return true;
  return host.includes('.') && /^[a-z0-9.-]+$/i.test(host);
}

function sameCredentials(a: Credentials, b: Credentials): boolean {
  return a.username === b.username && a.password === b.password;
}

/**
 * The account to parse the list with. If the shared one is not set yet, the first account
 * found in the lines becomes it: the server prints a connection line with login and password,
 * and pasting that line fills in the shared account right away.
 */
export function sharedFor(text: string, shared: Credentials): Credentials {
  if (shared.username !== '') return shared;
  for (const parsed of parseList(text, shared)) {
    if (parsed.server?.auth === 'own' && parsed.server.own) return parsed.server.own;
  }
  return shared;
}

/** The inverse of parseList: lines that can later be pasted into the import. */
export function formatList(servers: Server[], withPasswords: boolean): string {
  const lines: string[] = [];
  for (const server of servers) {
    const host = server.host.includes(':') ? `[${server.host}]` : server.host;
    let userinfo = '';
    if (withPasswords && server.auth === 'own' && server.own) {
      userinfo = `${encodeURIComponent(server.own.username)}:${encodeURIComponent(server.own.password)}@`;
    }
    lines.push(`${server.scheme}://${userinfo}${host}:${server.port}#${server.name}`);
  }
  return lines.join('\n');
}
