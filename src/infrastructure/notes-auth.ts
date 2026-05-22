import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME || process.env.USERPROFILE || '';
export const AUTH_PATH = join(home, '.notes', 'auth.json');

type AuthStore = Partial<Record<string, string>>;

function read(): AuthStore {
  if (!existsSync(AUTH_PATH)) return {};
  try {
    return JSON.parse(readFileSync(AUTH_PATH, 'utf-8')) as AuthStore;
  } catch {
    return {};
  }
}

export function getStoredKey(provider: string): string {
  return read()[provider] ?? '';
}

export function saveKey(provider: string, key: string): void {
  mkdirSync(join(home, '.notes'), { recursive: true });
  const store = read();
  store[provider] = key;
  writeFileSync(AUTH_PATH, JSON.stringify(store, null, 2));
  chmodSync(AUTH_PATH, 0o600);
}

export function listStoredProviders(): string[] {
  const store = read();
  return Object.keys(store).filter((k) => !!store[k]);
}
