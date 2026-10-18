// Explicit opt-in live smoke test. Uses only Zen Free's public credential;
// no saved subscriptions, personal API keys or desktop auth files are read.
import { randomBytes } from 'node:crypto';
import { createRuntime } from '../src/runtime.mjs';
import { providers } from '../src/providers.mjs';

const token = randomBytes(32).toString('hex');
const store = { accounts: {}, async save() {} };
const handle = createRuntime({ token, store, providers: { 'opencode-zen-free': providers['opencode-zen-free'] } });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle });
const base = `http://127.0.0.1:${server.port}`;
async function call(path, body) {
  return fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000) });
}
try {
  const added = await call('/admin/accounts', { name: 'Live free smoke', provider: 'opencode-zen-free' });
  if (!added.ok) throw new Error(`Account creation HTTP ${added.status}`);
  const account = await added.json();
  const listing = await call(`/admin/accounts/${account.id}/models`, {});
  const models = await listing.json();
  if (!listing.ok || !Array.isArray(models)) throw new Error(`Model discovery HTTP ${listing.status}`);
  console.log(JSON.stringify({ phase: 'models', http_status: listing.status, count: models.length, models: models.map(model => ({ id: model.id, protocol: model.protocol })) }));
  if (process.argv.includes('--infer')) {
    const model = process.env.PROVIDER_SMOKE_MODEL
      ? models.find(model => model.id === process.env.PROVIDER_SMOKE_MODEL && model.protocol === 'chat_completions')
      : models.find(model => model.protocol === 'chat_completions');
    if (!model) throw new Error('No free Chat Completions model is available');
    const response = await call(`/v1/accounts/${account.id}/chat/completions`, {
      model: model.id, stream: true, max_tokens: 128,
      messages: [{ role: 'user', content: 'Reply with exactly SUB2API_RUNTIME_OK. Do not call any tools.' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'Unavailable fixture tool. Never call.',
        parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'], additionalProperties: false } } }],
    });
    const text = await response.text();
    let output = '';
    for (const line of text.split('\n')) if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      try { output += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? ''; } catch {}
    }
    const completed = text.includes('data: [DONE]');
    console.log(JSON.stringify({ phase: 'inference', model: model.id, http_status: response.status,
      content_type: response.headers.get('content-type'), completed, text: output.slice(0, 200),
      ...(!response.ok ? { error: text.slice(0, 600) } : {}) }));
    if (!response.ok || !completed || !output.trim()) process.exitCode = 1;
  }
} finally { await server.stop(true); }
