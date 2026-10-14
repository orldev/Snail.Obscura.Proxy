import { describe, expect, it } from 'vitest';
import { formatList, parseList, sharedFor } from '../src/shared/parse';

const shared = { username: 'me', password: 'secret' };

function only(text: string) {
  const [first, ...rest] = parseList(text, shared);
  expect(rest).toHaveLength(0);
  return first!;
}

describe('parseList', () => {
  it('bare IP — https:443 with the shared account, named after the address', () => {
    const { server } = only('203.0.113.10');
    expect(server).toMatchObject({ scheme: 'https', host: '203.0.113.10', port: 443, auth: 'shared', name: '203.0.113.10' });
  });

  it('short name before and after the address', () => {
    expect(only('NL 203.0.113.10').server).toMatchObject({ name: 'NL', host: '203.0.113.10' });
    expect(only('203.0.113.10 DE-2').server).toMatchObject({ name: 'DE-2', host: '203.0.113.10' });
  });

  it('scheme, port and name after #', () => {
    expect(only('http://198.51.100.7:3128#FI').server).toMatchObject({ scheme: 'http', port: 3128, name: 'FI', auth: 'shared' });
  });

  it('an explicit port 80 is kept', () => {
    expect(only('http://198.51.100.7:80').server).toMatchObject({ port: 80 });
  });

  it('an account in the address that differs from the shared one becomes the server\'s own', () => {
    const { server } = only('https://bob:p%40ss@192.0.2.44:8443#X');
    expect(server).toMatchObject({ auth: 'own', own: { username: 'bob', password: 'p@ss' }, port: 8443 });
  });

  it('an account equal to the shared one stays shared', () => {
    expect(only('https://me:secret@192.0.2.44').server).toMatchObject({ auth: 'shared' });
    expect(only('https://me:secret@192.0.2.44').server?.own).toBeUndefined();
  });

  it('vendor format host:port:user:pass', () => {
    expect(only('192.0.2.5:8000:alice:pw').server).toMatchObject({
      scheme: 'http', host: '192.0.2.5', port: 8000, auth: 'own', own: { username: 'alice', password: 'pw' },
    });
  });

  it('IPv6 in brackets', () => {
    expect(only('https://[2001:db8::1]:443#V6').server).toMatchObject({ host: '2001:db8::1', port: 443, name: 'V6' });
  });

  it('domain name', () => {
    expect(only('nl.example.com NL').server).toMatchObject({ host: 'nl.example.com', name: 'NL' });
  });

  it('skips empty lines and comments, keeps real line numbers', () => {
    const parsed = parseList('# мои серверы\n\nNL 203.0.113.10\n  \nчепуха', shared);
    expect(parsed.map((item) => item.line)).toEqual([3, 5]);
    expect(parsed[1]!.error).toBeDefined();
  });

  it('an unknown scheme is an error, not a server', () => {
    expect(only('ftp://203.0.113.10').error).toBeDefined();
  });

  it('formatList and parseList round-trip', () => {
    const servers = parseList('NL 203.0.113.10\nhttp://bob:x@198.51.100.7:3128#DE', shared).map((item) => item.server!);
    const back = parseList(formatList(servers, true), shared).map((item) => item.server!);
    expect(back.map(({ id: _, ...rest }) => rest)).toEqual(servers.map(({ id: _, ...rest }) => rest));
  });

  it('export without passwords omits own credentials', () => {
    const servers = parseList('http://bob:x@198.51.100.7:3128#DE', shared).map((item) => item.server!);
    expect(formatList(servers, false)).toBe('http://198.51.100.7:3128#DE');
  });
});

describe('sharedFor', () => {
  const empty = { username: '', password: '' };

  it('an empty shared account is taken from the first line with a login', () => {
    const text = 'https://obscura:Abc123@203.0.113.10:443#NL\nhttps://obscura:Abc123@198.51.100.7:443#DE';
    const shared = sharedFor(text, empty);
    expect(shared).toEqual({ username: 'obscura', password: 'Abc123' });
    expect(parseList(text, shared).map((item) => item.server?.auth)).toEqual(['shared', 'shared']);
  });

  it('an existing shared account is not changed', () => {
    expect(sharedFor('https://x:y@203.0.113.10', shared)).toBe(shared);
  });

  it('lines without a login change nothing', () => {
    expect(sharedFor('NL 203.0.113.10', empty)).toBe(empty);
  });
});
