import { randomUUID, timingSafeEqual } from 'node:crypto';
import { collapseResponse } from '@magpie-community/opencode-zen-free-auth/stream.mjs';
import { modelList } from './providers.mjs';

const PATH_PROTOCOL = { '/chat/completions': 'chat_completions', '/responses': 'responses', '/messages': 'anthropic' };
const ID = '[a-zA-Z0-9_-]{1,80}';
const MAX_BODY = 64 * 1024 * 1024;

class HTTPError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function jsonBody(request, limit = 1024 * 1024) {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HTTPError(413, 'Request body is too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HTTPError(400, 'Expected a JSON object'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HTTPError(400, 'Expected a JSON object');
  return body;
}

function responseHeaders(headers) {
  const safe = new Headers();
  for (const [name, value] of headers) {
    if (['content-type', 'retry-after', 'x-request-id'].includes(name) || name.startsWith('x-ratelimit-')) safe.set(name, value);
  }
  safe.set('cache-control', 'no-store');
  return safe;
}

function streamBody(body, signal, release) {
  if (!body) { release(); return null; }
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); finish(); };
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    release();
  }
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { controller.close(); finish(); }
        else controller.enqueue(value);
      } catch (error) { controller.error(error); finish(); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
  });
}

export function createRuntime({ token, store, providers }) {
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw new Error('Runtime token must contain at least 32 characters');
  const bindings = new Map();
  const activities = new Map();
  const logins = new Map();
  const expectedToken = Buffer.from(`Bearer ${token}`);

  function authorized(request) {
    const actual = Buffer.from(request.headers.get('authorization') ?? '');
    return actual.length === expectedToken.length && timingSafeEqual(actual, expectedToken);
  }

  function record(id) {
    const account = store.accounts[id];
    if (!account) throw new HTTPError(404, 'Provider account was not found');
    if (!providers[account.provider]) throw new HTTPError(503, 'Provider is not installed');
    return account;
  }

  async function bindingFor(id) {
    const account = record(id);
    if (!bindings.has(id)) {
      const pending = (async () => {
        const activity = activities.get(id) ?? { active: 0 };
        activities.set(id, activity);
        const binding = { account, authEpoch: account.auth_epoch ?? 0, persistError: false,
          get active() { return activity.active; }, set active(value) { activity.active = value; } };
        const client = {
          auth: { async set({ path, body }) {
            if (path?.id !== account.provider || store.accounts[id] !== account || (account.auth_epoch ?? 0) !== binding.authEpoch) throw new Error('Account authorization scope changed');
            account.auth = structuredClone(body);
            try { await store.save(); binding.persistError = false; }
            catch (error) { binding.persistError = true; throw error; }
          } },
          config: { async get() { return { data: {} }; } },
          app: { async log() { return { data: undefined }; } },
          tui: { async showToast() { return { data: undefined }; } },
        };
        binding.hooks = await providers[account.provider].factory({ client, directory: '', worktree: '', project: { id: 'global' } });
        const config = {};
        await binding.hooks.config?.(config);
        binding.config = config.provider?.[account.provider];
        if (!binding.config || binding.hooks.auth?.provider !== account.provider) throw new Error('Provider registration mismatch');
        return binding;
      })();
      bindings.set(id, pending);
      pending.catch(() => bindings.delete(id));
    }
    return bindings.get(id);
  }

  function summary(account) {
    return { id: account.id, name: account.name, provider: account.provider, connected: !!account.auth,
      created_at: account.created_at, models: account.models ?? [] };
  }

  async function saveLogin(id, result) {
    const account = record(id);
    if (result?.type !== 'success') throw new HTTPError(400, result?.error || 'Provider authorization failed');
    const { type: _, ...auth } = result;
    const previous = account.auth;
    const previousEpoch = account.auth_epoch ?? 0;
    account.auth = { ...auth, type: auth.key !== undefined ? 'api' : 'oauth' };
    account.auth_epoch = previousEpoch + 1;
    bindings.delete(id);
    try { await store.save(); }
    catch (error) { account.auth = previous; account.auth_epoch = previousEpoch; throw error; }
  }

  async function ensurePersisted(binding) {
    if (!binding.persistError) return;
    try { await store.save(); binding.persistError = false; }
    catch { throw new HTTPError(503, 'Could not persist refreshed authorization'); }
  }

  async function management(request, path) {
    const method = request.method;
    if (path === '/providers' && method === 'GET') {
      return Response.json(Object.entries(providers).map(([id, provider]) => ({ id, name: provider.name })));
    }
    if (path === '/accounts' && method === 'GET') return Response.json(Object.values(store.accounts).map(summary));
    if (path === '/accounts' && method === 'POST') {
      const body = await jsonBody(request);
      if (!Object.hasOwn(providers, body.provider)) throw new HTTPError(400, 'Unknown provider');
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
      if (!name) throw new HTTPError(400, 'Account name is required');
      const account = { id: randomUUID(), name, provider: body.provider, created_at: new Date().toISOString() };
      store.accounts[account.id] = account;
      try {
        if (providers[account.provider].publicAuth) {
          const binding = await bindingFor(account.id);
          const result = await binding.hooks.auth.methods.find(method => method.type === 'api').authorize();
          await saveLogin(account.id, result);
        } else await store.save();
      } catch (error) {
        delete store.accounts[account.id];
        bindings.delete(account.id);
        activities.delete(account.id);
        throw error;
      }
      return Response.json(summary(account), { status: 201 });
    }
    const match = new RegExp(`^/accounts/(${ID})(?:/(authorize|poll|models|usage))?$`).exec(path);
    if (!match) throw new HTTPError(404, 'Unknown management operation');
    const [, id, action] = match;
    const account = record(id);
    if (!action && method === 'DELETE') {
      if ((await bindingFor(id)).active) throw new HTTPError(409, 'Account has active requests');
      delete store.accounts[id];
      try { await store.save(); }
      catch (error) { store.accounts[id] = account; throw error; }
      bindings.delete(id);
      activities.delete(id);
      logins.delete(id);
      return Response.json({ deleted: true });
    }
    if (action === 'poll' && method === 'GET') return Response.json(logins.get(id)?.public ?? { status: account.auth ? 'connected' : 'disconnected' });
    if (action === 'authorize' && method === 'POST') {
      if (logins.get(id)?.public.status === 'pending') throw new HTTPError(409, 'Authorization is already in progress');
      const binding = await bindingFor(id);
      // Server hosting offers browser authorization, never reads desktop files.
      const authMethod = binding.hooks.auth.methods.find(method => method.type === 'api' || !/desktop/i.test(method.label ?? ''));
      if (!authMethod) throw new HTTPError(400, 'Provider has no server authorization method');
      const authorization = await authMethod.authorize();
      if (authorization.type === 'success') {
        await saveLogin(id, authorization);
        return Response.json({ status: 'connected' });
      }
      const authURL = new URL(authorization.url);
      if (authURL.protocol !== 'https:') throw new HTTPError(400, 'Provider authorization URL must use HTTPS');
      if (typeof authorization.callback !== 'function') throw new HTTPError(400, 'Unsupported authorization flow');
      const session = { public: { status: 'pending', url: authURL.href, instructions: authorization.instructions ?? '' } };
      logins.set(id, session);
      void (async () => {
        try {
          const result = await authorization.callback();
          if (store.accounts[id] !== account || logins.get(id) !== session) return;
          await saveLogin(id, result);
          session.public = { status: 'connected' };
        } catch (error) { session.public = { status: 'error', message: safeMessage(error) }; }
      })();
      return Response.json(session.public);
    }
    if (!account.auth) throw new HTTPError(409, 'Authorize this provider account first');
    const binding = await bindingFor(id);
    await ensurePersisted(binding);
    if (action === 'models' && method === 'POST') {
      const models = await binding.hooks.provider?.models?.(binding.config, { auth: structuredClone(account.auth) });
      if (models) binding.config.models = models;
      if (binding.persistError) throw new HTTPError(503, 'Could not persist refreshed authorization');
      account.models = modelList(binding.config, providers[account.provider].protocol);
      await store.save();
      return Response.json(account.models);
    }
    if (action === 'usage' && method === 'GET') {
      const usage = await binding.hooks.auth.usage?.(async () => structuredClone(account.auth));
      if (binding.persistError) throw new HTTPError(503, 'Could not persist refreshed authorization');
      return Response.json(usage ?? { windows: [], unknown: true });
    }
    throw new HTTPError(405, 'Unsupported method');
  }

  async function inference(request, id, endpoint) {
    const account = record(id);
    if (!account.auth) throw new HTTPError(401, 'Provider account is not authorized');
    const definition = providers[account.provider];
    const binding = await bindingFor(id);
    await ensurePersisted(binding);
    const protocol = PATH_PROTOCOL[endpoint];
    const payload = await jsonBody(request, MAX_BODY);
    if (typeof payload.model !== 'string' || (payload.stream !== undefined && typeof payload.stream !== 'boolean')) throw new HTTPError(400, 'Expected a model string and a boolean stream field');
    const models = account.models ?? modelList(binding.config, definition.protocol);
    const model = models.find(model => model.id === payload.model);
    if (!model) throw new HTTPError(404, 'Model is not available on this provider account');
    if (model.protocol !== protocol) throw new HTTPError(400, 'Model requires a different native protocol');
    const maxConcurrency = binding.hooks.auth.maxConcurrency ?? 8;
    if (store.accounts[id] !== account) throw new HTTPError(404, 'Provider account was removed');
    if (binding.active >= maxConcurrency) return Response.json({ error: { type: 'rate_limit_error', message: 'Provider account is busy' } }, { status: 429, headers: { 'retry-after': '1' } });
    binding.active++;
    let released = false;
    const release = () => { if (!released) { released = true; binding.active--; } };
    try {
      const loader = await binding.hooks.auth.loader(async () => structuredClone(account.auth), binding.config);
      if (typeof loader.fetch !== 'function') throw new HTTPError(503, 'Provider has no request transport');
      const headers = new Headers({ 'content-type': 'application/json' });
      const sessionID = request.headers.get('x-session-id') ?? request.headers.get('session-id');
      // chat.headers uses a plain mutable object, as OpenCode does.
      const output = { headers: {} };
      if (sessionID) await binding.hooks['chat.headers']?.({ model: { providerID: account.provider }, sessionID }, output);
      for (const [key, value] of Object.entries(output.headers)) headers.set(key, value);
      const streaming = payload.stream === true;
      if (definition.streamOnly) payload.stream = true;
      const base = String(loader.baseURL ?? binding.config.api ?? '').replace(/\/+$/, '');
      const raw = await loader.fetch(`${base}${endpoint}`, { method: 'POST', headers,
        body: JSON.stringify(payload), signal: request.signal, redirect: 'error' });
      if (binding.persistError) { await raw.body?.cancel(); throw new HTTPError(503, 'Could not persist refreshed authorization'); }
      const native = definition.streamOnly && !streaming
        ? await collapseResponse(raw, protocol === 'chat_completions' ? 'chat' : protocol) : raw;
      return new Response(streamBody(native.body, request.signal, release), { status: native.status, headers: responseHeaders(native.headers) });
    } catch (error) { release(); throw error; }
  }

  function safeMessage(error) {
    let message = String(error?.message ?? 'Provider operation failed').slice(0, 2000);
    for (const account of Object.values(store.accounts)) {
      for (const [key, value] of Object.entries(account.auth ?? {})) {
        if (/access|refresh|token|key|cookie/i.test(key) && typeof value === 'string' && value.length > 6) message = message.replaceAll(value, '[redacted]');
      }
    }
    return message.replaceAll(token, '[redacted]');
  }

  return async function handle(request) {
    try {
      const path = new URL(request.url).pathname;
      if (!authorized(request)) return Response.json({ error: { message: 'Unauthorized', type: 'authentication_error' } }, { status: 401 });
      if (path === '/healthz' && request.method === 'GET') return Response.json({ ready: true });
      if (path.startsWith('/admin/')) return await management(request, path.slice(6));
      const match = new RegExp(`^/v1/accounts/(${ID})(/chat/completions|/responses|/messages)$`).exec(path);
      if (!match || request.method !== 'POST') throw new HTTPError(404, 'Unknown inference endpoint');
      return await inference(request, match[1], match[2]);
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      return Response.json({ error: { message: safeMessage(error), type: 'provider_runtime_error' } }, { status: error.status ?? 502 });
    }
  };
}
