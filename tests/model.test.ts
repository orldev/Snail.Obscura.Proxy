import { describe, expect, it } from 'vitest';
import { badgeOf, DEFAULT_SETTINGS, problemsOf, type Server, type Settings } from '../src/shared/model';
import { badgeFor, decideAuth, findByChallenger, fixedConfig, shouldReport } from '../src/shared/proxy';

const settings: Settings = { ...DEFAULT_SETTINGS, shared: { username: 'me', password: 'secret' } };

function server(patch: Partial<Server> = {}): Server {
  return { id: 'a', name: 'NL', scheme: 'https', host: '203.0.113.10', port: 443, auth: 'shared', ...patch };
}

describe('problemsOf', () => {
  it('a valid server has no problems', () => {
    expect(problemsOf(server(), settings)).toEqual([]);
  });

  it('SOCKS with a password is blocked', () => {
    expect(problemsOf(server({ scheme: 'socks5' }), settings).some((problem) => problem.blocking)).toBe(true);
    expect(problemsOf(server({ scheme: 'socks5', auth: 'none' }), settings)).toEqual([]);
  });

  it('a duplicate name or address is blocked', () => {
    const other = server({ id: 'b', host: '198.51.100.7' });
    expect(problemsOf(server(), settings, [other]).map((problem) => problem.text)).toEqual(['Имя «NL» уже занято']);
    const twin = server({ id: 'c', name: 'DE' });
    expect(problemsOf(server(), settings, [twin])[0]!.text).toContain('уже есть у «DE»');
  });

  it('an empty shared account is a warning, not a block', () => {
    const problems = problemsOf(server(), DEFAULT_SETTINGS);
    expect(problems).toEqual([{ text: 'Общая учётная запись не заполнена', blocking: false }]);
  });
});

describe('badge', () => {
  it('first four characters of the name in upper case', () => {
    expect(badgeOf('nl-amsterdam')).toBe('NL-A');
  });

  it('an error takes precedence over the server', () => {
    expect(badgeFor(server(), 'net::ERR_PROXY_CONNECTION_FAILED').text).toBe('!');
    expect(badgeFor(null, null).text).toBe('');
    expect(badgeFor(server(), null).title).toContain('203.0.113.10:443');
  });
});

describe('authentication', () => {
  const servers = [server(), server({ id: 'b', name: 'DE', host: '198.51.100.7', auth: 'own', own: { username: 'bob', password: 'x' } })];

  it('finds the server by the address that asked for a password', () => {
    expect(findByChallenger(servers, { host: '198.51.100.7', port: 443 })?.name).toBe('DE');
    expect(findByChallenger(servers, { host: '198.51.100.7', port: 444 })).toBeNull();
  });

  it('shared account on the first attempt, cancel on the second', () => {
    expect(decideAuth(servers[0]!, settings, 1)).toEqual({ kind: 'credentials', username: 'me', password: 'secret' });
    expect(decideAuth(servers[0]!, settings, 2).kind).toBe('cancel');
  });

  it('own account takes precedence over the shared one', () => {
    expect(decideAuth(servers[1]!, settings, 1)).toMatchObject({ username: 'bob', password: 'x' });
  });

  it('someone else\'s proxy — do not interfere', () => {
    expect(decideAuth(null, settings, 1)).toEqual({ kind: 'pass' });
  });

  it('password requested but no account — cancel with an explanation', () => {
    const decision = decideAuth(servers[0]!, DEFAULT_SETTINGS, 1);
    expect(decision).toMatchObject({ kind: 'cancel' });
  });
});

describe('fixedConfig', () => {
  it('one server and the bypass list', () => {
    expect(fixedConfig(server(), settings)).toEqual({
      mode: 'fixed_servers',
      rules: { singleProxy: { scheme: 'https', host: '203.0.113.10', port: 443 }, bypassList: DEFAULT_SETTINGS.bypass },
    });
  });
});

describe('shouldReport', () => {
  const clean = { error: null, at: 0 };
  const auth = { error: 'NL: сервер не принял логин или пароль', source: 'auth' as const, at: 0 };
  const net = { error: 'net::ERR_PROXY_CONNECTION_FAILED', source: 'proxy' as const, at: 0 };

  it('the first error is always written', () => {
    expect(shouldReport(clean, 'x', 'proxy')).toBe(true);
  });

  it('a network error does not overwrite an auth error', () => {
    expect(shouldReport(auth, 'net::ERR_TUNNEL_CONNECTION_FAILED', 'proxy')).toBe(false);
  });

  it('an auth error overwrites a network error', () => {
    expect(shouldReport(net, auth.error, 'auth')).toBe(true);
  });

  it('the same error is not written twice', () => {
    expect(shouldReport(net, net.error, 'proxy')).toBe(false);
  });
});
