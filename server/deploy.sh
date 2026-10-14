#!/usr/bin/env bash
# Installs the proxy on every server in the list, with one shared account for all of them.
# Runs from your computer; needs SSH access as root (or a user with passwordless sudo).
#
#   cp server/servers.example.txt server/servers.txt   # then fill in your servers
#   ./server/deploy.sh
#
# Variables:
#   PROXY_USER   login (obscura by default)
#   PROXY_PASS   password; when unset, one is generated for all servers and printed at the end.
#                Running again without PROXY_PASS changes the password on every listed server.
#   SSH_USER     root by default
#   STAGING=1    Let's Encrypt staging certificates
#
# servers.txt lines: "NAME IP", e.g. "NL 203.0.113.10". The extension's import understands the same format.
# Written for macOS bash 3.2: no associative arrays or mapfile, and variables in braces:
# bash 3.2 treats UTF-8 bytes right after $name as part of the name ("$name»" breaks).

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
list=${1:-${here}/servers.txt}
[[ -r ${list} ]] || { echo "Нет списка серверов: ${list} (образец — servers.example.txt)" >&2; exit 1; }

PROXY_USER=${PROXY_USER:-obscura}
generated=0
if [[ -z ${PROXY_PASS:-} ]]; then
  PROXY_PASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-24)
  generated=1
fi
SSH_USER=${SSH_USER:-root}
sudo=''
[[ ${SSH_USER} == root ]] || sudo='sudo'

done_lines=''
failed=''

while read -r name ip _ || [[ -n ${name:-} ]]; do
  [[ -z ${name:-} || ${name} == \#* ]] && continue
  if [[ -z ${ip:-} ]]; then
    echo "Пропускаю строку «${name}»: нужен формат «ИМЯ IP»" >&2
    continue
  fi
  echo
  echo "════ ${name} (${ip})"
  # The password travels in stdin together with the script: it is not on the ssh command line,
  # and therefore not in the process list on either machine.
  if {
    printf 'export PROXY_USER=%q PROXY_PASS=%q NAME=%q PUBLIC_IP=%q STAGING=%q\n' \
      "${PROXY_USER}" "${PROXY_PASS}" "${name}" "${ip}" "${STAGING:-0}"
    cat "${here}/install-proxy.sh"
  } | ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "${SSH_USER}@${ip}" "${sudo} bash -s"; then
    done_lines="${done_lines}https://${PROXY_USER}:${PROXY_PASS}@${ip}:443#${name}"$'\n'
  else
    failed="${failed} ${name}"
  fi
done <"${list}"

echo
echo "════ Итог"
if [[ -n ${done_lines} ]]; then
  echo "Вставьте в Obscura → Настройки → Импорт (логин и пароль станут общей учётной записью):"
  echo
  printf '%s' "${done_lines}" | sed 's/^/  /'
  echo
fi
if [[ ${generated} == 1 ]]; then
  echo "Пароль сгенерирован сейчас: ${PROXY_PASS}"
  echo "На компьютере он не сохранён (на серверах лежит в /etc/obscura). Чтобы добавить сервер"
  echo "с тем же паролем: PROXY_PASS='${PROXY_PASS}' ./server/deploy.sh новый-список.txt"
fi
if [[ -n ${failed} ]]; then
  echo
  echo "Не получилось:${failed} — вывод выше." >&2
  exit 1
fi
