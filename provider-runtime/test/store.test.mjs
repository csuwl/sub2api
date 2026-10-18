import { test, expect } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EncryptedStore } from '../src/store.mjs';

test('encrypted accounts survive restart; a wrong key fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub2api-runtime-store-'));
  const path = join(directory, 'accounts.enc');
  const key = randomBytes(32);
  const first = new EncryptedStore(path, key);
  await first.load();
  first.accounts.a = { provider: 'fixture', auth: { access: 'fixture-sensitive-access', refresh: 'fixture-sensitive-refresh' } };
  await first.save();
  const disk = await readFile(path, 'utf8');
  expect(disk).not.toContain('fixture-sensitive');
  const next = new EncryptedStore(path, key);
  await next.load();
  expect(next.accounts).toEqual(first.accounts);
  await expect(new EncryptedStore(path, randomBytes(32)).load()).rejects.toThrow();
});

test('concurrent saves preserve the latest snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub2api-runtime-store-'));
  const path = join(directory, 'accounts.enc');
  const key = randomBytes(32);
  const store = new EncryptedStore(path, key);
  store.accounts.a = { revision: 1 };
  const one = store.save();
  store.accounts.a.revision = 2;
  const two = store.save();
  await Promise.all([one, two]);
  const restored = new EncryptedStore(path, key);
  await restored.load();
  expect(restored.accounts.a.revision).toBe(2);
});
