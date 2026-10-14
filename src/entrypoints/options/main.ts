import '@/shared/ui.css';
import './style.css';
import { h, mount } from '@/shared/dom';
import {
  addressOf,
  BADGE_LIMIT,
  DEFAULT_PORT,
  NAME_LIMIT,
  newId,
  problemsOf,
  SCHEMES,
  type AuthMode,
  type Scheme,
  type Server,
} from '@/shared/model';
import { formatList, parseList, sharedFor } from '@/shared/parse';
import { activate, load, onChange, save } from '@/shared/storage';

const AUTH_LABELS: Record<AuthMode, string> = {
  shared: 'Общая',
  own: 'Своя',
  none: 'Без авторизации',
};

const app = document.getElementById('app')!;
const serversBox = h('div');
const editorBox = h('div');
const sharedBox = h('div');

async function start(): Promise<void> {
  const { settings } = await load();
  mount(sharedBox, sharedSection(settings.shared.username, settings.shared.password));
  mount(app,
    h('h1', {}, 'Obscura'),
    h('p', { class: 'muted' }, 'Свои прокси-серверы: короткое имя, адрес и одна учётная запись на все.'),
    sharedBox,
    h('section', {},
      h('h2', {}, 'Серверы'),
      serversBox,
      editorBox,
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => void openEditor(null) }, 'Добавить сервер')),
    ),
    importSection(),
    exportSection(),
    networkSection(settings.bypass, settings.webrtc),
    h('p', { class: 'hint' },
      'Пароли хранятся в профиле Chrome на этом компьютере без шифрования — так устроено хранилище расширений. ',
      'В синхронизацию Google они не попадают.'),
  );
  await renderServers();
}

// ── Shared account ────────────────────────────────────────────────────

function sharedSection(username: string, password: string): HTMLElement {
  const login = h('input', { value: username, autocomplete: 'off', spellcheck: false });
  const secret = passwordInput(password);
  const saved = h('span', { class: 'saved' });

  const submit = async () => {
    const { settings } = await load();
    await save({ settings: { ...settings, shared: { username: login.value.trim(), password: secret.input.value } } });
    flash(saved, 'Сохранено');
  };

  return h('section', {},
    h('h2', {}, 'Общая учётная запись'),
    h('div', { class: 'grid' },
      h('label', {}, 'Логин', login),
      h('label', {}, 'Пароль', secret.box),
    ),
    h('p', { class: 'hint' }, 'Её используют все серверы, у которых в колонке «Учётная запись» стоит «Общая». Если она пуста, её заполнит первая вставленная в «Импорт» строка подключения.'),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => void submit() }, 'Сохранить'), saved),
  );
}

// ── Server list ───────────────────────────────────────────────────────

async function renderServers(): Promise<void> {
  const { servers, settings, active } = await load();
  if (servers.length === 0) {
    mount(serversBox, h('p', { class: 'muted' }, 'Пока пусто. Добавьте сервер вручную или вставьте список в «Импорт».'));
    return;
  }

  const rows = servers.map((server, index) => {
    const warnings = problemsOf(server, settings, servers).map((problem) => problem.text);
    return h('tr', {},
      h('td', {}, h('span', { class: 'chip' }, server.name)),
      h('td', { class: 'address mono' }, `${server.scheme}://${addressOf(server)}`),
      h('td', {}, AUTH_LABELS[server.auth], warnings.length > 0 ? h('span', { class: 'muted', title: warnings.join('\n') }, ' ⚠') : null),
      h('td', { class: 'muted' }, server.id === active.id ? 'включён' : ''),
      h('td', { class: 'tools' },
        h('button', { title: 'Выше', 'aria-label': `Поднять ${server.name}`, disabled: index === 0, onclick: () => void move(index, -1) }, '↑'),
        ' ',
        h('button', { title: 'Ниже', 'aria-label': `Опустить ${server.name}`, disabled: index === servers.length - 1, onclick: () => void move(index, 1) }, '↓'),
        ' ',
        h('button', { onclick: () => void openEditor(server) }, 'Изменить'),
        ' ',
        h('button', { class: 'danger', onclick: () => void remove(server) }, 'Удалить'),
      ),
    );
  });

  mount(serversBox,
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Имя'), h('th', { class: 'address' }, 'Адрес'), h('th', {}, 'Учётная запись'), h('th', {}, ''), h('th', {}, ''),
      )),
      h('tbody', {}, ...rows),
    ),
    h('p', { class: 'hint' }, `На значке расширения видны первые ${BADGE_LIMIT} символа имени. Порядок списка — порядок переключения горячей клавишей.`),
  );
}

async function move(index: number, delta: number): Promise<void> {
  const { servers } = await load();
  const target = index + delta;
  if (target < 0 || target >= servers.length) return;
  [servers[index], servers[target]] = [servers[target]!, servers[index]!];
  await save({ servers });
}

async function remove(server: Server): Promise<void> {
  if (!confirm(`Удалить сервер «${server.name}»?`)) return;
  const { servers, active } = await load();
  if (active.id === server.id) await activate(null);
  await save({ servers: servers.filter((candidate) => candidate.id !== server.id) });
}

// ── Server editor ─────────────────────────────────────────────────────

async function openEditor(existing: Server | null): Promise<void> {
  const draft: Server = existing
    ? structuredClone(existing)
    : { id: newId(), name: '', scheme: 'https', host: '', port: DEFAULT_PORT.https, auth: 'shared' };

  const name = h('input', { value: draft.name, maxLength: NAME_LIMIT, placeholder: 'NL', spellcheck: false });
  const scheme = h('select', {}, ...SCHEMES.map((value) => h('option', { value, selected: value === draft.scheme }, value)));
  const host = h('input', { value: draft.host, placeholder: '203.0.113.10', spellcheck: false });
  const port = h('input', { type: 'number', min: 1, max: 65535, value: String(draft.port) });
  const auth = h('select', {}, ...(Object.keys(AUTH_LABELS) as AuthMode[]).map((value) => h('option', { value, selected: value === draft.auth }, AUTH_LABELS[value])));
  const ownLogin = h('input', { value: draft.own?.username ?? '', autocomplete: 'off', spellcheck: false });
  const ownSecret = passwordInput(draft.own?.password ?? '');
  const ownBox = h('div', { class: 'grid' }, h('label', {}, 'Свой логин', ownLogin), h('label', {}, 'Свой пароль', ownSecret.box));
  const problemsBox = h('div', { class: 'problems' });

  let previousScheme = draft.scheme;
  scheme.addEventListener('change', () => {
    const next = scheme.value as Scheme;
    if (Number(port.value) === DEFAULT_PORT[previousScheme]) port.value = String(DEFAULT_PORT[next]);
    previousScheme = next;
  });
  const syncOwn = () => { ownBox.hidden = auth.value !== 'own'; };
  auth.addEventListener('change', syncOwn);
  syncOwn();

  const submit = async () => {
    const server: Server = {
      id: draft.id,
      name: name.value.trim(),
      scheme: scheme.value as Scheme,
      host: host.value.trim().replace(/^\[|\]$/g, ''),
      port: Number(port.value),
      auth: auth.value as AuthMode,
    };
    if (server.auth === 'own') server.own = { username: ownLogin.value.trim(), password: ownSecret.input.value };

    const { servers, settings } = await load();
    const blocking = problemsOf(server, settings, servers).filter((problem) => problem.blocking);
    if (blocking.length > 0) {
      mount(problemsBox, ...blocking.map((problem) => h('div', { class: 'note error' }, problem.text)));
      return;
    }
    const index = servers.findIndex((candidate) => candidate.id === server.id);
    if (index >= 0) servers[index] = server;
    else servers.push(server);
    await save({ servers });
    mount(editorBox);
  };

  mount(editorBox,
    h('div', { class: 'editor' },
      h('h2', {}, existing ? `Сервер «${existing.name}»` : 'Новый сервер'),
      h('div', { class: 'grid' },
        h('label', {}, `Короткое имя (до ${NAME_LIMIT})`, name),
        h('label', {}, 'Протокол', scheme),
        h('label', {}, 'IP-адрес или домен', host),
        h('label', {}, 'Порт', port),
        h('label', {}, 'Учётная запись', auth),
      ),
      ownBox,
      h('p', { class: 'hint' }, 'https — соединение до сервера зашифровано, пароль не виден по дороге. http передаёт пароль открытым текстом. SOCKS в Chrome работает только без пароля.'),
      problemsBox,
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => void submit() }, 'Сохранить'),
        h('button', { onclick: () => mount(editorBox) }, 'Отмена'),
      ),
    ),
  );
  name.focus();
}

// ── Import and export ─────────────────────────────────────────────────

function importSection(): HTMLElement {
  const text = h('textarea', { placeholder: 'https://obscura:пароль@203.0.113.10:443#NL\nDE 198.51.100.7', spellcheck: false });
  const result = h('div', { class: 'problems' });

  const submit = async () => {
    const { servers, settings: stored } = await load();
    const shared = sharedFor(text.value, stored.shared);
    const adopted = shared !== stored.shared;
    const settings = { ...stored, shared };
    const messages: HTMLElement[] = [];
    let added = 0;
    for (const parsed of parseList(text.value, settings.shared)) {
      if (parsed.server === undefined) {
        messages.push(h('div', { class: 'note error' }, `Строка ${parsed.line}: ${parsed.error}`));
        continue;
      }
      const blocking = problemsOf(parsed.server, settings, servers).filter((problem) => problem.blocking);
      if (blocking.length > 0) {
        messages.push(h('div', { class: 'note error' }, `Строка ${parsed.line}: ${blocking.map((problem) => problem.text).join('; ')}`));
        continue;
      }
      servers.push(parsed.server);
      added++;
    }
    await save(adopted && added > 0 ? { servers, settings } : { servers });
    if (adopted && added > 0) {
      messages.unshift(h('div', { class: 'note' }, `Логин «${shared.username}» и пароль из строки стали общей учётной записью.`));
      mount(sharedBox, sharedSection(shared.username, shared.password));
    }
    messages.unshift(h('div', { class: 'note' }, `Добавлено серверов: ${added}`));
    mount(result, ...messages);
    if (added > 0 && messages.length === 1) text.value = '';
  };

  return h('section', {},
    h('h2', {}, 'Импорт'),
    text,
    h('p', { class: 'hint' },
      'Проще всего вставить строку подключения, которую напечатал сервер после установки. ',
      'По одному серверу на строку. Без логина и пароля сервер берёт общую учётную запись. ',
      'Понимает «ИМЯ адрес», «https://адрес:порт#ИМЯ», «http://логин:пароль@адрес:порт» и «адрес:порт:логин:пароль». ',
      'Без схемы — https на порту 443.'),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => void submit() }, 'Добавить из списка')),
    result,
  );
}

function exportSection(): HTMLElement {
  const withPasswords = h('input', { type: 'checkbox' });
  const output = h('textarea', { readOnly: true, hidden: true, spellcheck: false });
  const copied = h('span', { class: 'saved' });

  const fill = async () => {
    const { servers } = await load();
    output.value = formatList(servers, withPasswords.checked);
    output.hidden = false;
    output.select();
    await navigator.clipboard.writeText(output.value).then(() => flash(copied, 'Скопировано'), () => {});
  };

  return h('section', {},
    h('h2', {}, 'Экспорт'),
    h('label', { class: 'check' }, withPasswords, 'Включить пароли своих учётных записей'),
    h('p', { class: 'hint' }, 'Общая учётная запись в экспорт не попадает никогда — её вводят отдельно.'),
    h('div', { class: 'actions' }, h('button', { onclick: () => void fill() }, 'Показать и скопировать'), copied),
    output,
  );
}

// ── Network ───────────────────────────────────────────────────────────

function networkSection(bypass: string[], webrtc: boolean): HTMLElement {
  const list = h('textarea', { value: bypass.join('\n'), spellcheck: false });
  const rtc = h('input', { type: 'checkbox', checked: webrtc });
  const saved = h('span', { class: 'saved' });

  const submit = async () => {
    const { settings } = await load();
    const entries = list.value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    await save({ settings: { ...settings, bypass: entries, webrtc: rtc.checked } });
    flash(saved, 'Сохранено');
  };

  return h('section', {},
    h('h2', {}, 'Сеть'),
    h('label', {}, 'Напрямую, мимо прокси (по одному на строку)', list),
    h('p', { class: 'hint' }, 'Например *.local, 192.168.0.0/16. <local> — имена без точки.'),
    h('label', { class: 'check' }, rtc, 'Не пускать WebRTC мимо прокси'),
    h('p', { class: 'hint' }, 'Без этого сайты могут узнать настоящий IP через видеозвонки и WebRTC, даже когда прокси включён.'),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => void submit() }, 'Сохранить'), saved),
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function passwordInput(value: string): { box: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type: 'password', value, autocomplete: 'new-password', spellcheck: false });
  const toggle = h('button', { type: 'button', 'aria-label': 'Показать пароль' }, 'Показать');
  toggle.addEventListener('click', () => {
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    toggle.textContent = hidden ? 'Скрыть' : 'Показать';
  });
  return { box: h('div', { class: 'password' }, input, toggle), input };
}

function flash(target: HTMLElement, text: string): void {
  target.textContent = text;
  setTimeout(() => { target.textContent = ''; }, 2000);
}

onChange(['servers', 'settings', 'active'], () => void renderServers());
void start();
