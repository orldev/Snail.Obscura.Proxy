# Obscura

A Chrome extension for switching between your own proxy servers. Each server has a short name (also shown on the icon), and one login and password are shared by all of them — only the IP changes.

```
browser ──TLS:443──▶ stunnel ──▶ squid (login/password) ──▶ website
```

The connection to the server is encrypted (an https proxy), so the password and the addresses of the sites you visit are not visible along the way. The Let's Encrypt certificate is issued directly for the IP: no domain needed.

The extension's interface is in Russian; Russian labels are given below in parentheses.

## Quick start

Step-by-step guide with screenshots: [obscura-guide.pdf](docs/obscura-guide.pdf).

**1. Server.** Rent a VPS running Ubuntu 24.04 with a public IPv4 address. Log in over SSH and run:

```bash
curl -fsSL https://github.com/orldev/Snail.Obscura.Proxy/releases/latest/download/install-proxy.sh | sudo bash
```

After a couple of minutes the script prints a connection line:

```
https://obscura:Xk3…@203.0.113.10:443#NL
```

The script generates the login and password itself and keeps them only on the server. To show the line again, run `sudo obscura-show`.

**2. Extension.** Download [obscura-extension.zip](https://github.com/orldev/Snail.Obscura.Proxy/releases/latest/download/obscura-extension.zip) and unpack it. Open `chrome://extensions`, turn on "Developer mode", click "Load unpacked" and select the unpacked folder.

**3. Connect.** Obscura icon → Settings (Настройки) → Import (Импорт) → paste the line → "Add from list" (Добавить из списка). The login and password from the line become the shared account. Pick a server in the popup.

## Several servers with one password

On the second and every following server, pass the first server's password:

```bash
curl -fsSL https://github.com/orldev/Snail.Obscura.Proxy/releases/latest/download/install-proxy.sh | sudo env PROXY_PASS=first-server-password bash
```

If you have many servers and SSH access to them from your computer, deploying from a list is more convenient:

```bash
cp server/servers.example.txt server/servers.txt   # "NAME IP" per line; the file is not tracked by git
./server/deploy.sh
```

The script installs the proxy on every machine with one password and prints the connection lines. Running it again without `PROXY_PASS` changes the password on all servers.

## What gets installed on the server

[server/install-proxy.sh](server/install-proxy.sh):
- **squid** listens only on `127.0.0.1:8888` and requires a password. It keeps no request log and adds no `Via` or `X-Forwarded-For` headers. Tunnels are allowed only to ports 443 and 8443.
- **stunnel** terminates TLS on `:443` in front of squid.
- **certbot** (from snap, version 5.3+) issues a Let's Encrypt certificate directly for the IP: no domain needed. The certificate lives 6 days and renews itself every ~3 days. During renewal certbot briefly runs a server on port 80.
- **nftables** opens only SSH, 80 and 443 to the outside. If the machine already has other rules or ufw is enabled, the script leaves them intact.
- **The system journal** is kept in memory only (disable with `VOLATILE_LOGS=0`).
- The login and password are stored in `/etc/obscura/credentials` (mode 0600, root only). That is why a repeated run does not change the password and the line in the browser keeps working.

Variables: `PROXY_USER`, `PROXY_PASS`, `NAME` (short name, defaults to the IP's country code), `PROXY_PORT` (default 443), `STAGING=1` (test certificate), `TLS_CERT` and `TLS_KEY` (your own certificate instead of Let's Encrypt). See the top of the script for details.

If the server already hosts a website (traefik, nginx), the script checks the ports before changing anything. If 443 is taken, put the proxy on another port with `PROXY_PORT=8443`. If 80 is taken, Let's Encrypt cannot issue a certificate for the IP. In that case you need your own certificate (`TLS_CERT`, `TLS_KEY`) or a separate VPS for the proxy.

## Extension

| Where | What |
|---|---|
| Popup | server list by short name, "Off" (Выключен), exit IP and country check |
| Icon | first 4 characters of the active server's name; `!` means an error, its text is in the popup |
| `Alt+Shift+P` | last server ↔ off |
| `Alt+Shift+N` | next server in list order |

For a password-protected proxy to work in Incognito, turn on "Allow in Incognito" on the extension's card. Import accepts connection lines, `NAME IP`, `host:port:login:password` and `http://login:password@host:port#NAME`.

## Who sees what

- **Websites** see the server's IP. WebRTC is not allowed to bypass the proxy (the Network (Сеть) setting), and DNS lookups are done by the server, not your computer.
- **Your ISP** sees a TLS connection to your server's IP, but not the sites inside it.
- **The VPS host** sees site names and traffic volume, but not the contents of HTTPS pages. The host owns the machine: it holds nothing but the proxy settings, and no request log is kept.
- **Passwords in the extension** are stored unencrypted in the Chrome profile on this computer: that is how extension storage works. They are not synced to Google.

## Chrome limitations

- Chrome does not support SOCKS5 with a password. Only https and http work for password-protected proxies.
- Chrome remembers an accepted password until restart. If you change the password on the servers, restart the browser.

## Development

Requires Node.js 24.

```bash
npm run dev          # WXT build with hot reload
npm run compile      # type check
npm test             # unit tests (vitest)
npm run test:e2e     # Chromium + local password-protected proxies
```

Testing a real server with the same Chromium, using its connection line:

```bash
OBSCURA_LINE="$(ssh root@203.0.113.10 obscura-show)" npm run test:e2e
```

Releasing a version: bump `version` in package.json, then `git tag v0.2.0 && git push --tags`. GitHub Actions builds a release with `obscura-extension.zip`, `install-proxy.sh` and `obscura-guide.pdf`.

Layout:
- `src/entrypoints/background.ts` — applying the proxy, answering password prompts, errors, icon, keyboard shortcuts
- `src/entrypoints/popup`, `src/entrypoints/options` — framework-free UI
- `src/shared` — model, list parsing, storage
- `server/` — installation and deployment
- `docs/` — the PDF guide and its source

## License

[MIT](LICENSE).
