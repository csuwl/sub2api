import { resolve } from 'node:path';
import { EncryptedStore } from './store.mjs';
import { providers } from './providers.mjs';
import { createRuntime } from './runtime.mjs';

const key = Buffer.from(process.env.PROVIDER_RUNTIME_STATE_KEY ?? '', 'base64');
const store = new EncryptedStore(resolve(process.env.PROVIDER_RUNTIME_STATE_FILE ?? 'state/accounts.enc'), key);
await store.load();
const fetch = createRuntime({ token: process.env.PROVIDER_RUNTIME_TOKEN, store, providers });
const server = Bun.serve({
  hostname: process.env.PROVIDER_RUNTIME_HOST ?? '127.0.0.1',
  port: Number(process.env.PROVIDER_RUNTIME_PORT ?? 3426),
  maxRequestBodySize: 64 * 1024 * 1024,
  idleTimeout: 255,
  fetch,
});
console.log(`Provider runtime listening on ${server.hostname}:${server.port}`);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  await server.stop();
  await store.writes;
  process.exit(0);
});
