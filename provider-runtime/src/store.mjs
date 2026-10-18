import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// A single host owns this file. Each record has an independent opaque account
// handle; the shared encryption key is supplied by the deployment, not the UI.
export class EncryptedStore {
  constructor(path, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('State key must be 32 bytes');
    this.path = path;
    this.key = key;
    this.accounts = {};
    this.writes = Promise.resolve();
  }

  async load() {
    let raw;
    try { raw = await readFile(this.path); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const envelope = JSON.parse(raw);
    if (envelope.version !== 1) throw new Error('Unsupported state format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const data = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    const state = JSON.parse(data);
    if (!state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) throw new Error('Invalid account state');
    this.accounts = state.accounts;
  }

  save() {
    const snapshot = JSON.stringify({ accounts: this.accounts });
    const operation = this.writes.then(async () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      const data = Buffer.concat([cipher.update(snapshot), cipher.final()]);
      const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(temporary, envelope, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}
