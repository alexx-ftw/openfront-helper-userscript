// chrome.storage.local backed by localStorage.
//
// Mirrors the subset of chrome.storage.local the engine uses (get / set / remove
// + onChanged). onChanged is delivered two ways so the popup and content stay in
// sync: same-tab writes fire listeners directly (the DOM `storage` event does
// NOT fire in the tab that made the change); other-tab writes arrive via it.

const PREFIX = "ofh:";

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}
type ChangeListener = (changes: Record<string, StorageChange>, areaName: string) => void;

const listeners = new Set<ChangeListener>();

const rawKey = (key: string) => PREFIX + key;

function readKey(key: string): unknown {
  const raw = localStorage.getItem(rawKey(key));
  if (raw === null) return undefined;
  {
    return JSON.parse(raw);
  }
}

function writeKey(key: string, value: unknown): void {
  localStorage.setItem(rawKey(key), JSON.stringify(value));
}

function emit(changes: Record<string, StorageChange>): void {
  for (const listener of listeners) {
    {
      listener(changes, "local");
    }
  }
}

function normalizeGetKeys(keys: string | string[] | Record<string, unknown> | null | undefined): {
  names: string[];
  defaults: Record<string, unknown>;
} {
  if (keys == null) {
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) names.push(k.slice(PREFIX.length));
    }
    return { names, defaults: {} };
  }
  if (typeof keys === "string") return { names: [keys], defaults: {} };
  if (Array.isArray(keys)) return { names: keys, defaults: {} };
  return { names: Object.keys(keys), defaults: keys };
}

export const storageLocal = {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const { names, defaults } = normalizeGetKeys(keys);
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const value = readKey(name);
      if (value !== undefined) out[name] = value;
      else if (name in defaults) out[name] = defaults[name];
    }
    return Promise.resolve(out);
  },

  set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, StorageChange> = {};
    for (const [key, newValue] of Object.entries(items)) {
      const oldValue = readKey(key);
      writeKey(key, newValue);
      changes[key] = { oldValue, newValue };
    }
    emit(changes);
    return Promise.resolve();
  },

  remove(keys: string | string[]): Promise<void> {
    const names = Array.isArray(keys) ? keys : [keys];
    const changes: Record<string, StorageChange> = {};
    for (const key of names) {
      const oldValue = readKey(key);
      localStorage.removeItem(rawKey(key));
      changes[key] = { oldValue, newValue: undefined };
    }
    emit(changes);
    return Promise.resolve();
  },
};

export const storageOnChanged = {
  addListener: (cb: ChangeListener) => {
    listeners.add(cb);
  },
  removeListener: (cb: ChangeListener) => {
    listeners.delete(cb);
  },
  hasListener: (cb: ChangeListener) => listeners.has(cb),
};

export function installCrossTabSync(): void {
  window.addEventListener("storage", (event) => {
    if (!event.key || !event.key.startsWith(PREFIX) || event.storageArea !== localStorage) {
      return;
    }
    const parse = (raw: string | null): unknown => {
      if (raw === null) return undefined;
      {
        return JSON.parse(raw);
      }
    };
    emit({
      [event.key.slice(PREFIX.length)]: {
        oldValue: parse(event.oldValue),
        newValue: parse(event.newValue),
      },
    });
  });
}
