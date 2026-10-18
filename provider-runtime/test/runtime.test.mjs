import { describe, test, expect } from 'bun:test';
import { createRuntime } from '../src/runtime.mjs';

const token = 'fixture-runtime-deployment-key-at-least-32';
function sse(text = 'ok') {
  return new Response(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

function fixture(options = {}) {
  const seen = [];
  const store = { accounts: {}, saves: 0, async save() { this.saves++; } };
  for (const id of ['account-a', 'account-b']) store.accounts[id] = {
    id, name: id, provider: 'fixture', auth: { type: 'oauth', access: `secret-${id}` },
  };
  const provider = {
    name: 'Fixture', protocol: options.protocol ?? 'chat_completions', streamOnly: options.streamOnly ?? false,
    factory: async ({ client }) => ({
      config: async config => { config.provider = { fixture: { api: 'https://fixture.invalid/v1', models: { model: { name: 'Fixture' } } } }; },
      provider: { async models(config) { return config.models; } },
      'chat.headers': async (input, output) => { output.headers['x-fixture-session'] = input.sessionID; },
      auth: {
        provider: 'fixture', maxConcurrency: options.maxConcurrency ?? 8,
        methods: [{ type: 'oauth', label: 'Browser', async authorize() {
          if (options.authorize) return options.authorize();
          return { url: 'https://fixture.invalid/login', instructions: 'Sign in', callback: async () => ({ type: 'success', access: 'authorized-secret' }) };
        } }],
        async usage(getAuth) { return { plan: 'Fixture', windows: [], unknown: true, ...(options.echoAuth ? { echoed: (await getAuth()).access } : {}) }; },
        async loader(getAuth) {
          return { baseURL: 'https://fixture.invalid/v1', async fetch(url, init) {
            let auth = await getAuth();
            if (options.refresh && auth.access.startsWith('secret-')) {
              await options.beforeRefresh?.();
              auth = { ...auth, access: `renewed-${auth.access}` };
              await client.auth.set({ path: { id: 'fixture' }, body: auth });
            }
            seen.push({ auth, url, init, body: JSON.parse(init.body) });
            return options.transport ? options.transport(init) : sse();
          } };
        },
      },
    }),
  };
  const handle = createRuntime({ token, store, providers: { fixture: provider } });
  async function call(path, method = 'GET', body, signal, authenticated = true) {
    return handle(new Request(`http://runtime${path}`, { method, signal,
      headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json',
        'x-session-id': 'fixture-session', cookie: 'never-forward', 'x-api-key': 'never-forward' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  }
  return { call, store, seen, handle };
}

describe('provider host contract', () => {
  test('requires deployment authentication on health, management and inference', async () => {
    const f = fixture();
    for (const [path, method] of [['/healthz', 'GET'], ['/admin/accounts', 'GET'], ['/v1/accounts/account-a/chat/completions', 'POST']]) {
      expect((await f.call(path, method, method === 'POST' ? { model: 'model' } : undefined, undefined, false)).status).toBe(401);
    }
    expect((await f.call('/healthz')).status).toBe(200);
  });

  test('management summaries never expose account credentials', async () => {
    const f = fixture();
    const response = await f.call('/admin/accounts');
    const text = await response.text();
    expect(text).not.toContain('secret-');
    expect(text).not.toContain('auth');
    expect(JSON.parse(text)[0].connected).toBe(true);
  });

  for (const [protocol, endpoint] of [['chat_completions', 'chat/completions'], ['responses', 'responses'], ['anthropic', 'messages']]) {
    test(`${protocol} forwards only its native endpoint`, async () => {
      const f = fixture({ protocol });
      const response = await f.call(`/v1/accounts/account-a/${endpoint}`, 'POST', { model: 'model', stream: true });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('[DONE]');
      expect(f.seen[0].init.headers.has('cookie')).toBe(false);
      expect(f.seen[0].init.headers.has('x-api-key')).toBe(false);
      expect(f.seen[0].init.headers.get('x-fixture-session')).toBe('fixture-session');
      const wrong = endpoint === 'responses' ? 'messages' : 'responses';
      expect((await f.call(`/v1/accounts/account-a/${wrong}`, 'POST', { model: 'model' })).status).toBe(400);
    });
  }

  test('unknown account/model and traversal fail before invoking the provider', async () => {
    const f = fixture();
    expect((await f.call('/v1/accounts/missing/chat/completions', 'POST', { model: 'model' })).status).toBe(404);
    expect((await f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'missing' })).status).toBe(404);
    expect((await f.call('/admin/%2e%2e/anything')).status).toBe(404);
    expect(f.seen).toHaveLength(0);
  });

  test('stream-only providers support JSON clients through aggregation', async () => {
    const f = fixture({ streamOnly: true });
    const response = await f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'model', stream: false });
    expect(f.seen[0].body.stream).toBe(true);
    const body = await response.json();
    expect(body.choices[0].message.content).toBe('ok');
    expect(body.usage.prompt_tokens).toBe(3);
  });

  test('two accounts refresh and persist in their own scopes', async () => {
    const f = fixture({ refresh: true });
    const responses = await Promise.all(['account-a', 'account-b'].map(id => f.call(`/v1/accounts/${id}/chat/completions`, 'POST', { model: 'model', stream: true })));
    await Promise.all(responses.map(response => response.text()));
    expect(f.store.accounts['account-a'].auth.access).toBe('renewed-secret-account-a');
    expect(f.store.accounts['account-b'].auth.access).toBe('renewed-secret-account-b');
    expect(f.store.saves).toBe(2);
  });

  test('an active stream holds a concurrency slot until cancelled', async () => {
    let cancelled = false;
    const f = fixture({ maxConcurrency: 1, transport: () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } }) });
    const first = await f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'model', stream: true });
    expect((await f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'model', stream: true })).status).toBe(429);
    await first.body.cancel();
    expect(cancelled).toBe(true);
    const next = await f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'model', stream: true });
    expect(next.status).toBe(200);
    await next.body.cancel();
  });

  test('caller cancellation cancels the provider stream', async () => {
    let cancelled = false;
    const f = fixture({ transport: () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    const abort = new AbortController();
    const response = await f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'model', stream: true }, abort.signal);
    abort.abort();
    await response.text();
    expect(cancelled).toBe(true);
  });

  test('upstream HTTP failures remain failures and never expose cookies', async () => {
    const f = fixture({ transport: () => Response.json({ error: { type: 'insufficient_quota', code: 14018 } }, {
      status: 403, headers: { 'set-cookie': 'private', 'x-sub2api-secret': 'private', 'retry-after': '30' },
    }) });
    const response = await f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'model' });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe(14018);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('x-sub2api-secret')).toBe(false);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  test('browser authorization runs asynchronously and returns no tokens', async () => {
    let complete;
    const f = fixture({ authorize: () => ({ url: 'https://fixture.invalid/login', callback: () => new Promise(resolve => { complete = resolve; }) }) });
    const result = await (await f.call('/admin/accounts/account-a/authorize', 'POST', {})).json();
    expect(result.status).toBe('pending');
    expect((await f.call('/admin/accounts/account-a/authorize', 'POST', {})).status).toBe(409);
    complete({ type: 'success', access: 'new-browser-secret' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const poll = await (await f.call('/admin/accounts/account-a/poll')).json();
    expect(poll).toEqual({ status: 'connected' });
    expect(f.store.accounts['account-a'].auth.access).toBe('new-browser-secret');
  });

  test('provider exceptions redact known credentials and the runtime token', async () => {
    const f = fixture({ transport: () => { throw new Error(`secret-account-a ${token}`); } });
    const response = await f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'model' });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toContain('secret-account-a');
    expect(text).not.toContain(token);
  });

  test('failed state writes roll back account creation and deletion', async () => {
    const f = fixture();
    f.store.save = async () => { throw new Error('Disk unavailable'); };
    expect((await f.call('/admin/accounts', 'POST', { provider: 'fixture', name: 'New account' })).status).toBe(502);
    expect(Object.keys(f.store.accounts)).toHaveLength(2);
    expect((await f.call('/admin/accounts/account-a', 'DELETE')).status).toBe(502);
    expect(f.store.accounts['account-a'].auth.access).toBe('secret-account-a');
  });

  test('refresh persistence failure blocks inference until storage recovers', async () => {
    const f = fixture({ refresh: true });
    let unavailable = true;
    f.store.save = async () => { if (unavailable) throw new Error('Disk unavailable'); };
    const path = '/v1/accounts/account-a/chat/completions';
    expect((await f.call(path, 'POST', { model: 'model' })).status).toBe(502);
    expect((await f.call(path, 'POST', { model: 'model' })).status).toBe(503);
    expect(f.seen).toHaveLength(0);
    unavailable = false;
    const recovered = await f.call(path, 'POST', { model: 'model' });
    expect(recovered.status).toBe(200);
    await recovered.text();
    expect(f.seen[0].auth.access).toBe('renewed-secret-account-a');
  });

  test('rejects malformed inference fields before invoking the provider', async () => {
    const f = fixture();
    for (const payload of [{}, { model: 42 }, { model: 'model', stream: 'true' }]) {
      expect((await f.call('/v1/accounts/account-a/chat/completions', 'POST', payload)).status).toBe(400);
    }
    expect(f.seen).toHaveLength(0);
  });

  test('an old in-flight refresh cannot overwrite a newer browser authorization', async () => {
    let refreshing, release;
    const started = new Promise(resolve => { refreshing = resolve; });
    const f = fixture({ refresh: true, maxConcurrency: 1,
      beforeRefresh: async () => { refreshing(); await new Promise(resolve => { release = resolve; }); },
      authorize: () => ({ type: 'success', access: 'new-browser-authorization' }),
    });
    const stale = f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'model' });
    await started;
    expect((await f.call('/admin/accounts/account-a/authorize', 'POST', {})).status).toBe(200);
    expect((await f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'model' })).status).toBe(429);
    release();
    expect((await stale).status).toBe(502);
    expect(f.store.accounts['account-a'].auth.access).toBe('new-browser-authorization');
    const next = await f.call('/v1/accounts/account-a/chat/completions', 'POST', { model: 'model' });
    expect(next.status).toBe(200);
    await next.text();
  });
});
