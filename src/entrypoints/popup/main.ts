import '@/shared/ui.css';
import './style.css';
import { browser } from 'wxt/browser';
import { h, mount } from '@/shared/dom';
import { checkExit } from '@/shared/exit';
import { addressOf, problemsOf, type Server } from '@/shared/model';
import { activate, load, onChange, report } from '@/shared/storage';

type ExitView =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; ip: string; place: string }
  | { kind: 'fail'; reason: string };

const app = document.getElementById('app')!;
let exit: ExitView = { kind: 'idle' };

async function render(): Promise<void> {
  const { servers, settings, active, status } = await load();
  const control = await browser.proxy.settings.get({});
  const current = servers.find((server) => server.id === active.id) ?? null;

  const notes: HTMLElement[] = [];
  if (control.levelOfControl === 'controlled_by_other_extensions') {
    notes.push(h('div', { class: 'note warn' }, 'Прокси сейчас управляет другое расширение. Отключите его, иначе Obscura не сможет переключать серверы.'));
  }
  if (control.levelOfControl === 'not_controllable') {
    notes.push(h('div', { class: 'note warn' }, 'Прокси задан политикой администратора, расширение не может его менять.'));
  }
  if (status.error !== null) {
    notes.push(
      h('div', { class: 'note error' },
        status.error, ' ',
        h('button', { class: 'link', onclick: () => void report(null) }, 'Скрыть'),
      ),
    );
  }
  if (current !== null) {
    for (const problem of problemsOf(current, settings)) {
      notes.push(h('div', { class: 'note warn' }, `${current.name}: ${problem.text}`));
    }
  }

  const list =
    servers.length === 0
      ? h('div', { class: 'empty muted' },
          'Серверов пока нет. ',
          h('button', { class: 'link', onclick: openOptions }, 'Добавить'),
        )
      : h('ul', { class: 'list' },
          h('li', {}, offRow(current === null)),
          ...servers.map((server) => h('li', {}, serverRow(server, server.id === active.id))),
        );

  mount(app,
    h('header', {},
      h('h1', {}, 'Obscura'),
      h('button', { class: 'link', onclick: openOptions }, 'Настройки'),
    ),
    list,
    notes.length > 0 ? h('div', { class: 'notes' }, ...notes) : null,
    h('footer', {},
      h('div', { class: 'exit' }, ...exitLines()),
      h('button', { onclick: () => void refreshExit(), disabled: exit.kind === 'checking' }, 'Проверить'),
    ),
  );
}

function offRow(isCurrent: boolean): HTMLElement {
  return h('button', { class: 'row', 'aria-current': String(isCurrent), onclick: () => void choose(null) },
    h('span', { class: 'chip' }, 'OFF'),
    h('span', {}, 'Выключен'),
    h('span', { class: 'address muted' }, 'напрямую'),
  );
}

function serverRow(server: Server, isCurrent: boolean): HTMLElement {
  return h('button', { class: 'row', 'aria-current': String(isCurrent), onclick: () => void choose(server.id), title: `${server.scheme}://${addressOf(server)}` },
    h('span', { class: 'chip' }, server.name),
    h('span', { class: 'address muted mono' }, server.host),
  );
}

function exitLines(): HTMLElement[] {
  switch (exit.kind) {
    case 'idle':
      return [h('div', { class: 'muted' }, 'IP не проверен')];
    case 'checking':
      return [h('div', { class: 'muted' }, 'Проверяю…')];
    case 'ok':
      return [h('div', { class: 'mono' }, exit.ip), exit.place ? h('div', { class: 'muted' }, exit.place) : h('div', {})];
    case 'fail':
      return [h('div', { class: 'muted' }, 'Нет ответа'), h('div', { class: 'muted', title: exit.reason }, exit.reason)];
  }
}

async function choose(id: string | null): Promise<void> {
  await activate(id);
  await settled(id);
  await refreshExit();
}

/** The background applies the setting after the storage write; wait until Chrome accepts it. */
async function settled(id: string | null): Promise<void> {
  const { servers } = await load();
  const target = servers.find((server) => server.id === id) ?? null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const { value } = await browser.proxy.settings.get({});
    const proxy = (value as { rules?: { singleProxy?: { host?: string; port?: number } } }).rules?.singleProxy;
    const applied =
      target === null
        ? (value as { mode?: string }).mode !== 'fixed_servers' || proxy === undefined
        : proxy?.host === target.host && proxy?.port === target.port;
    if (applied) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function refreshExit(): Promise<void> {
  exit = { kind: 'checking' };
  await render();
  try {
    exit = { kind: 'ok', ...(await checkExit()) };
  } catch (error) {
    exit = { kind: 'fail', reason: error instanceof Error ? error.message : String(error) };
  }
  await render();
}

function openOptions(): void {
  void browser.runtime.openOptionsPage();
  window.close();
}

onChange(['servers', 'settings', 'active', 'status'], () => void render());
void render();
