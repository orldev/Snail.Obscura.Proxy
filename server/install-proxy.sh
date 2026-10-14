#!/usr/bin/env bash
# Installs the Obscura https proxy on a clean VPS (Ubuntu 22.04+ / Debian 12), as root.
#
#   curl -fsSL https://github.com/orldev/Snail.Obscura.Proxy/releases/latest/download/install-proxy.sh | sudo bash
#
# Without parameters the script generates a login and password itself, stores them on the server
# and finally prints the connection line for the extension. A repeated run reuses the stored
# ones, so the line in the browser keeps working. Print it again: sudo obscura-show
#
#   browser ──TLS:443──▶ stunnel ──▶ squid 127.0.0.1:8888 (Basic auth) ──▶ website
#
# The certificate is issued by Let's Encrypt for the IP address itself (shortlived profile, 6 days,
# certbot >= 5.3 renews it). No domain needed. The password travels inside TLS.
#
# Variables:
#   PROXY_USER, PROXY_PASS  your own login and password; the same on every server = one shared account
#                           in the extension. When unset, the stored ones are used; on the first install
#                           they are generated (login obscura, 24-character password)
#   NAME                    the server's short name in the extension; defaults to the IP's country code ("NL")
#   PROXY_PORT              external proxy port, 443 by default (when 443 is taken, e.g. by traefik)
#   PUBLIC_IP               external IP; detected automatically by default
#   STAGING=1               Let's Encrypt staging certificate (not trusted by browsers)
#   VOLATILE_LOGS=0         keep the system journal on disk (by default it is moved to memory)
#   TLS_CERT, TLS_KEY       your own certificate instead of Let's Encrypt
#   CONFIG_ONLY=1           packages and configs only, no firewall, certificate or start (for container tests)
#
# Why squid and not tinyproxy: tinyproxy 1.11 answers a wrong password with 401 instead of 407
# (Chrome then drops the tunnel instead of asking for the password again) and does not fall back
# from IPv6 to IPv4 when the server has no IPv6 route.
#
# All code lives in functions and main is called on the last line: when run via
# "ssh … bash -s" or "curl … | bash" the whole script is read from stdin before anything executes.

set -euo pipefail
# Configs and unit files must not be writable by others, whatever umask we inherited.
umask 022

# Where this script is downloaded from: the file is attached to every GitHub release.
INSTALL_URL=https://github.com/orldev/Snail.Obscura.Proxy/releases/latest/download/install-proxy.sh

PROXY_PORT=${PROXY_PORT:-443}
INNER_PORT=8888
CERT_NAME=obscura
CERTBOT=/snap/bin/certbot
CERTBOT_MIN=5.3.0
CONF_DIR=/etc/obscura
CRED_FILE=$CONF_DIR/credentials
LINE_FILE=$CONF_DIR/connection.txt
UNIT=obscura-stunnel

say()  { printf '\033[1m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

check_input() {
  [[ $(id -u) -eq 0 ]] || die "Нужен root (или sudo)"
  command -v apt-get >/dev/null || die "Скрипт рассчитан на Ubuntu/Debian (apt)"
  resolve_credentials
  [[ $PROXY_USER =~ ^[A-Za-z0-9._-]+$ ]] || die "PROXY_USER: только латиница, цифры, точка, дефис, подчёркивание"
  [[ $PROXY_PASS =~ ^[A-Za-z0-9._~+=-]{12,}$ ]] || die "PROXY_PASS: от 12 символов, латиница, цифры и ._~+=-"
  [[ $PROXY_PORT =~ ^[0-9]+$ && $PROXY_PORT -ge 1 && $PROXY_PORT -le 65535 && $PROXY_PORT != 80 && $PROXY_PORT != 8888 ]] \
    || die "PROXY_PORT: число от 1 до 65535, кроме 80 и 8888"
  if [[ -n ${TLS_CERT:-} || -n ${TLS_KEY:-} ]]; then
    [[ -r ${TLS_CERT:-} && -r ${TLS_KEY:-} ]] || die "TLS_CERT и TLS_KEY должны указывать на читаемые файлы"
  fi
}

# Login and password: explicitly given > stored by a previous run > new ones.
# Kept in $CRED_FILE with mode 0600: printing the connection line again needs
# the plain password, while squid only keeps its hash.
resolve_credentials() {
  local saved_user='' saved_pass=''
  if [[ -r $CRED_FILE ]]; then
    saved_user=$(sed -n 's/^PROXY_USER=//p' "$CRED_FILE")
    saved_pass=$(sed -n 's/^PROXY_PASS=//p' "$CRED_FILE")
  fi
  PROXY_USER=${PROXY_USER:-${saved_user:-obscura}}
  if [[ -z ${PROXY_PASS:-} ]]; then
    if [[ -n $saved_pass ]]; then
      PROXY_PASS=$saved_pass
    else
      # head reads a finite chunk: tr | head on /dev/urandom would die of SIGPIPE under pipefail.
      PROXY_PASS=$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-24)
      CREDENTIALS_NEW=1
    fi
  fi
}

save_credentials() {
  mkdir -p "$CONF_DIR"
  install -m 0600 -o root -g root /dev/null "$CRED_FILE"
  printf 'PROXY_USER=%s\nPROXY_PASS=%s\n' "$PROXY_USER" "$PROXY_PASS" >"$CRED_FILE"
}

install_packages() {
  say "Пакеты"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq </dev/null
  apt-get install -y -qq --no-install-recommends squid stunnel4 nftables curl ca-certificates iproute2 openssl </dev/null >/dev/null
  # The package starts squid with its default config — stop it before writing ours.
  systemctl stop squid 2>/dev/null || true
}

# Who listens on a TCP port, apart from our stunnel: empty means the port is free.
port_owner() {
  ss -Hlntp "( sport = :$1 )" 2>/dev/null | grep -v '"stunnel' | grep -o 'users:(("[^"]*"' | cut -d'"' -f2 | sort -u | paste -sd, - || true
}

# Before writing any config: on a machine with traefik, nginx or apache ports 80 and 443 are usually
# taken, and the install would fail halfway.
check_ports() {
  local owner
  owner=$(port_owner "$PROXY_PORT")
  if [[ -n $owner ]]; then
    die "Порт $PROXY_PORT занят: $owner. Поставьте прокси на другой порт: PROXY_PORT=8443"
  fi
  if [[ -z ${TLS_CERT:-} ]]; then
    owner=$(port_owner 80)
    if [[ -n $owner ]]; then
      warn "Порт 80 занят: $owner. Он нужен Let's Encrypt, чтобы выдать и раз в несколько дней"
      warn "продлевать сертификат на IP. Варианты: освободить порт 80 или дать свой сертификат"
      warn "через TLS_CERT и TLS_KEY (например выпущенный traefik или nginx для домена этого сервера)."
      die "Порт 80 занят"
    fi
  fi
}

detect_ip() {
  if [[ -z ${PUBLIC_IP:-} ]]; then
    PUBLIC_IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)
  fi
  if [[ -z ${PUBLIC_IP:-} ]]; then
    PUBLIC_IP=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  fi
  [[ $PUBLIC_IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "Не удалось определить внешний IPv4, задайте PUBLIC_IP"
  say "Внешний адрес: $PUBLIC_IP"

  if [[ -z ${NAME:-} ]]; then
    NAME=$(curl -fsS --max-time 10 "https://ipinfo.io/$PUBLIC_IP/country" 2>/dev/null | LC_ALL=C tr -dc '[:upper:]' | cut -c1-2 || true)
    NAME=${NAME:-SRV}
  fi
  [[ $NAME =~ ^[A-Za-z0-9._-]{1,12}$ ]] || die "NAME: до 12 символов, латиница, цифры, точка, дефис"
}

write_squid() {
  say "squid: 127.0.0.1:$INNER_PORT, вход по паролю"
  local passwd=/etc/squid/obscura.passwd
  local helper='' candidate
  for candidate in /usr/lib/squid/basic_ncsa_auth /usr/lib/squid3/basic_ncsa_auth; do
    [[ -x $candidate ]] && helper=$candidate && break
  done
  [[ -n $helper ]] || die "Не найден basic_ncsa_auth из пакета squid"

  install -m 0640 -o root -g proxy /dev/null "$passwd"
  printf '%s:%s\n' "$PROXY_USER" "$(printf '%s' "$PROXY_PASS" | openssl passwd -apr1 -stdin)" >"$passwd"

  cat >/etc/squid/squid.conf <<CONF
# Written by install-proxy.sh (Obscura). Not reachable from outside: only through stunnel.
http_port 127.0.0.1:$INNER_PORT
visible_hostname obscura
httpd_suppress_version_string on
shutdown_lifetime 3 seconds

auth_param basic program $helper $passwd
auth_param basic children 3
auth_param basic realm Obscura
auth_param basic credentialsttl 2 hours
acl authenticated proxy_auth REQUIRED

# Tunnels to HTTPS ports only: a stolen password can't be used to send mail from the server's address.
acl SSL_ports port 443 8443
acl Safe_ports port 80 443 8443
acl CONNECT method CONNECT
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access allow authenticated
http_access deny all

# Don't tell websites the request came through a proxy, and don't reveal the client's address.
via off
forwarded_for delete

# Store and record nothing: no cache, no request log.
cache deny all
cache_mem 8 MB
# Without this squid adds Cache-Control: max-age=259200 to plain http requests and gives itself away;
# max-age=0 is exactly what the browser itself sends on a page reload.
refresh_pattern . 0 0% 0
access_log none
cache_store_log none
CONF
}

write_stunnel() {
  say "stunnel: TLS на :$PROXY_PORT"
  local binary user cert key
  binary=$(command -v stunnel4 || command -v stunnel) || die "stunnel не установлен"
  user=stunnel4
  id -u "$user" >/dev/null 2>&1 || user=nobody
  cert=${TLS_CERT:-/etc/letsencrypt/live/$CERT_NAME/fullchain.pem}
  key=${TLS_KEY:-/etc/letsencrypt/live/$CERT_NAME/privkey.pem}

  mkdir -p "$CONF_DIR"
  cat >"$CONF_DIR/stunnel.conf" <<CONF
; Written by install-proxy.sh (Obscura).
; The certificate is read as root at startup, then privileges are dropped.
foreground = yes
pid =
setuid = $user
setgid = $(id -gn "$user")
debug = err

[proxy]
accept = 0.0.0.0:$PROXY_PORT
connect = 127.0.0.1:$INNER_PORT
cert = $cert
key = $key
sslVersionMin = TLSv1.2
CONF

  cat >/etc/systemd/system/$UNIT.service <<UNITFILE
[Unit]
Description=Obscura: TLS на :$PROXY_PORT перед squid
After=network-online.target squid.service
Wants=network-online.target

[Service]
ExecStart=$binary $CONF_DIR/stunnel.conf
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITFILE
}

open_firewall() {
  local ssh_ports
  ssh_ports=$( (sshd -T 2>/dev/null || true) | awk '$1 == "port" {print $2}' | sort -u | paste -sd, -)
  ssh_ports=${ssh_ports:-22}

  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
    say "Файрвол: ufw уже включён — открываю 80 и $PROXY_PORT"
    ufw allow 80/tcp >/dev/null
    ufw allow "$PROXY_PORT"/tcp >/dev/null
    return
  fi

  local existing
  existing=$(nft list tables 2>/dev/null | grep -v '^table inet obscura$' || true)
  if [[ -n $existing ]]; then
    warn "В nftables уже есть чужие таблицы — файрвол не трогаю:"
    warn "$existing"
    warn "Откройте снаружи TCP 80 (продление сертификата) и $PROXY_PORT (прокси), SSH: $ssh_ports"
    return
  fi

  say "Файрвол: снаружи открыты только SSH ($ssh_ports), 80 и $PROXY_PORT"
  cat >/etc/nftables.conf <<CONF
#!/usr/sbin/nft -f
# Written by install-proxy.sh (Obscura).
flush ruleset

table inet obscura {
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    ct state invalid drop
    meta l4proto { icmp, ipv6-icmp } accept
    # 80 is only for certificate renewal: certbot runs a server there for a minute every few days.
    tcp dport { $ssh_ports, 80, $PROXY_PORT } accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
  }
}
CONF
  nft -f /etc/nftables.conf
  systemctl enable --now nftables >/dev/null 2>&1
}

install_certbot() {
  if [[ -x $CERTBOT ]] && version_at_least "$("$CERTBOT" --version 2>&1 | awk '{print $2}')" "$CERTBOT_MIN"; then
    return
  fi
  say "certbot из snap (в apt он слишком старый для сертификатов на IP)"
  apt-get install -y -qq --no-install-recommends snapd </dev/null >/dev/null
  snap wait system seed.loaded </dev/null >/dev/null 2>&1 || true
  snap install core </dev/null >/dev/null 2>&1 || true
  snap install --classic certbot </dev/null >/dev/null || snap refresh certbot </dev/null >/dev/null
  local version
  version=$("$CERTBOT" --version 2>&1 | awk '{print $2}')
  version_at_least "$version" "$CERTBOT_MIN" || die "certbot $version, а для сертификата на IP нужен $CERTBOT_MIN+"
  if dpkg -s certbot >/dev/null 2>&1; then
    warn "Стоит ещё certbot из apt — его таймер не умеет продлевать сертификат на IP. Удалите: apt-get remove certbot"
  fi
}

get_certificate() {
  if [[ -n ${TLS_CERT:-} ]]; then
    say "Сертификат: свой ($TLS_CERT)"
    return
  fi
  install_certbot
  say "Сертификат Let's Encrypt на $PUBLIC_IP"

  # Renewal happens every few days: stunnel re-reads the certificate only on restart.
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat >/etc/letsencrypt/renewal-hooks/deploy/$UNIT.sh <<HOOK
#!/bin/sh
systemctl restart $UNIT
HOOK
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/$UNIT.sh

  local staging=()
  [[ ${STAGING:-0} == 1 ]] && staging=(--staging)
  if ! "$CERTBOT" certonly "${staging[@]}" \
    --standalone \
    --preferred-profile shortlived \
    --ip-address "$PUBLIC_IP" \
    --cert-name "$CERT_NAME" \
    --keep-until-expiring \
    --non-interactive --agree-tos --register-unsafely-without-email \
    </dev/null; then
    warn "Let's Encrypt не выдал сертификат на $PUBLIC_IP. Частые причины:"
    warn "  • порт 80 закрыт в панели хостинга (файрвол, группы безопасности) — откройте TCP 80 и 443;"
    warn "  • порт 80 занят другой программой (nginx, traefik, apache): ss -lntp | grep ':80 ';"
    warn "  • адрес частный или за NAT (10.x, 172.16–31.x, 192.168.x) — нужен публичный IPv4."
    die "Исправьте и запустите установку ещё раз: уже работающий прокси не тронут"
  fi
}

start_services() {
  say "Запуск"
  systemctl daemon-reload
  systemctl enable squid >/dev/null 2>&1
  systemctl restart squid
  systemctl enable "$UNIT" >/dev/null 2>&1
  systemctl restart "$UNIT"
}

quiet_logs() {
  [[ ${VOLATILE_LOGS:-1} == 1 ]] || return 0
  say "Системный журнал — только в памяти"
  mkdir -p /etc/systemd/journald.conf.d
  printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=32M\n' >/etc/systemd/journald.conf.d/obscura.conf
  systemctl restart systemd-journald
}

verify() {
  say "Проверка снаружи внутрь: https://$PUBLIC_IP:$PROXY_PORT"
  local insecure=()
  [[ ${STAGING:-0} == 1 || -n ${TLS_CERT:-} ]] && insecure=(--proxy-insecure)
  sleep 1

  local denied allowed
  denied=$(curl -sS -o /dev/null -w '%{http_connect}' --max-time 15 "${insecure[@]}" \
    --proxy "https://$PUBLIC_IP:$PROXY_PORT" https://www.google.com/generate_204 2>/dev/null || true)
  # The password goes through stdin, not an argument, so it never shows up in the process list.
  allowed=$(printf 'proxy-user = "%s:%s"\n' "$PROXY_USER" "$PROXY_PASS" | curl -sS -K - -o /dev/null -w '%{http_code}' \
    --max-time 15 "${insecure[@]}" --proxy "https://$PUBLIC_IP:$PROXY_PORT" https://www.google.com/generate_204 2>/dev/null || true)

  [[ $denied == 407 ]] || warn "Без пароля ждал 407, получил «$denied»"
  [[ $allowed == 204 ]] || die "С паролем ждал 204, получил «$allowed». Смотрите: journalctl -u $UNIT -u squid"
  say "Работает: без пароля 407, с паролем 204"
}

print_result() {
  local line="https://$PROXY_USER:$PROXY_PASS@$PUBLIC_IP:$PROXY_PORT#$NAME"
  install -m 0600 -o root -g root /dev/null "$LINE_FILE"
  printf '%s\n' "$line" >"$LINE_FILE"

  cat >/usr/local/sbin/obscura-show <<SHOW
#!/bin/sh
# Prints this server's Obscura connection line.
cat $LINE_FILE
SHOW
  chmod 0700 /usr/local/sbin/obscura-show

  echo
  echo "════════════════════════════════════════════════════════════════"
  echo " Готово. Строка подключения для Obscura:"
  echo
  echo "   $line"
  echo
  echo " Вставьте её в расширение: значок Obscura → Настройки → Импорт."
  echo " Это как пароль: не публикуйте и не пересылайте открыто."
  echo " Показать ещё раз: sudo obscura-show"
  if [[ ${CREDENTIALS_NEW:-0} == 1 ]]; then
    echo
    echo " Чтобы следующий сервер принимал тот же пароль, ставьте его так:"
    echo "   curl -fsSL $INSTALL_URL | sudo env PROXY_PASS=$PROXY_PASS bash"
  fi
  echo "════════════════════════════════════════════════════════════════"
}

main() {
  check_input
  install_packages
  check_ports
  save_credentials
  if [[ ${CONFIG_ONLY:-0} == 1 ]]; then
    PUBLIC_IP=${PUBLIC_IP:-127.0.0.1}
    NAME=${NAME:-TEST}
    write_squid
    write_stunnel
    say "Только конфиги (CONFIG_ONLY=1)"
    print_result
    return
  fi
  detect_ip
  write_squid
  open_firewall
  # Certificate before the stunnel config: a failed attempt must not leave stunnel pointing
  # at a missing file, or the proxy won't come back after a reboot.
  get_certificate
  write_stunnel
  start_services
  quiet_logs
  verify
  print_result
}

version_at_least() {
  local lowest
  lowest=$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)
  [[ $lowest == "$2" ]]
}

main "$@"
