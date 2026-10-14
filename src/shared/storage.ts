import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Active, type ErrorSource, type Server, type Settings, type Status } from './model';

/**
 * Everything lives in this profile's storage.local. Passwords are stored there in plain text:
 * Chrome does not encrypt extension storage. They are deliberately kept out of storage.sync.
 */
export interface Stored {
  servers: Server[];
  settings: Settings;
  active: Active;
  status: Status;
}

const DEFAULTS: Stored = {
  servers: [],
  settings: DEFAULT_SETTINGS,
  active: { id: null, lastId: null },
  status: { error: null, at: 0 },
};

export type Key = keyof Stored;

export async function load(): Promise<Stored> {
  const raw = (await browser.storage.local.get<Partial<Stored>>(Object.keys(DEFAULTS) as Key[]));
  return {
    servers: raw.servers ?? DEFAULTS.servers,
    settings: { ...DEFAULTS.settings, ...raw.settings },
    active: raw.active ?? DEFAULTS.active,
    status: raw.status ?? DEFAULTS.status,
  };
}

export async function save(patch: Partial<Stored>): Promise<void> {
  await browser.storage.local.set(patch);
}

export function onChange(keys: Key[], listener: () => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (keys.some((key) => key in changes)) listener();
  });
}

export async function activate(id: string | null): Promise<void> {
  const { active } = await load();
  const lastId = active.id ?? active.lastId;
  await save({ active: { id, lastId: id ?? lastId }, status: { error: null, at: Date.now() } });
}

export async function report(error: string | null, source?: ErrorSource): Promise<void> {
  await save({ status: source ? { error, source, at: Date.now() } : { error, at: Date.now() } });
}
