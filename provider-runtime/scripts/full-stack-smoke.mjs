// Explicit, isolated integration run. Requires Docker images postgres:18-alpine,
// redis:7-alpine, Bun, and a freshly built Sub2API binary. Only a public free
// provider is used. Temporary database containers are labelled and removed.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.SUB2API_TEST_SERVER;
const bun = process.env.SUB2API_TEST_BUN ?? 'bun';
const deployedBase = process.env.SUB2API_TEST_BASE_URL;
if (deployedBase) {
  if (process.env.SUB2API_TEST_ALLOW_EXISTING !== 'true') throw new Error('Deployed smoke creates fixtures and adds synthetic balance; set SUB2API_TEST_ALLOW_EXISTING=true for an isolated test deployment');
  const url = new URL(deployedBase);
  if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid test deployment URL');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Remote smoke requires HTTPS');
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) throw new Error('Deployed smoke requires ADMIN_EMAIL and ADMIN_PASSWORD in the environment');
} else if (!binary) throw new Error('Set SUB2API_TEST_SERVER to a freshly built server binary');
const suffix = randomBytes(5).toString('hex');
const label = `sub2api-runtime-smoke-${suffix}`;
const containers = [], children = [], secrets = [];
const directory = await mkdtemp(join(tmpdir(), 'sub2api-provider-smoke-'));
const logs = {};
function secret() { const value = randomBytes(32).toString('hex'); secrets.push(value); return value; }
const password = secret(), runtimeToken = secret(), adminPassword = deployedBase ? process.env.ADMIN_PASSWORD : secret();
secrets.push(adminPassword);
const stateKey = randomBytes(32).toString('base64'); secrets.push(stateKey);

function docker(args, env = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, timeout: 120000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}
function redact(value) { for (const key of secrets) value = value.replaceAll(key, '[redacted]'); return value; }
async function freePort() {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function delay(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(action, timeout = 120000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    if (children.some(child => child.exitCode !== null || child.signalCode)) throw new Error('A test service exited before becoming ready; inspect the isolated logs');
    try { return await action(); } catch (error) { last = error; await delay(300); }
  }
  throw last ?? new Error('Timed out');
}
function start(name, program, args, env, cwd) {
  const child = spawn(program, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  logs[name] = '';
  const append = chunk => { logs[name] = (logs[name] + chunk).slice(-2 * 1024 * 1024); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.on('error', error => append(error.message));
  children.push(child); return child;
}
let base, adminJWT, smokeKeyID;
async function request(path, body, authorization = adminJWT, method) {
  const response = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', 'x-admin-ui-request': '1', ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000) });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${text.slice(0, 1500)}`);
  return { status: response.status, contentType: response.headers.get('content-type'), data: json?.data ?? json, text };
}

try {
  if (!deployedBase) {
  for (const [kind, image, port, env] of [
    ['pg', 'postgres:18-alpine', 5432, { POSTGRES_PASSWORD: password, POSTGRES_USER: 'sub2api', POSTGRES_DB: 'sub2api' }],
    ['redis', 'redis:7-alpine', 6379, {}],
  ]) {
    const name = `${label}-${kind}`;
    docker(['run', '-d', '--name', name, '--label', `com.codex.test=${label}`, '-p', `127.0.0.1::${port}`,
      ...Object.keys(env).flatMap(key => ['--env', key]), image], env);
    containers.push(name);
  }
  const pgPort = JSON.parse(docker(['inspect', containers[0]]))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const redisPort = JSON.parse(docker(['inspect', containers[1]]))[0].NetworkSettings.Ports['6379/tcp'][0].HostPort;
  await waitFor(async () => docker(['exec', containers[0], 'pg_isready', '-U', 'sub2api']));
  const runtimePort = await freePort(), appPort = await freePort();
  start('runtime', bun, ['src/server.mjs'], { PROVIDER_RUNTIME_TOKEN: runtimeToken, PROVIDER_RUNTIME_STATE_KEY: stateKey,
    PROVIDER_RUNTIME_STATE_FILE: join(directory, 'accounts.enc'), PROVIDER_RUNTIME_HOST: '127.0.0.1', PROVIDER_RUNTIME_PORT: String(runtimePort) }, here);
  await waitFor(async () => { const result = await fetch(`http://127.0.0.1:${runtimePort}/healthz`, { headers: { authorization: `Bearer ${runtimeToken}` } }); assert.equal(result.status, 200); });
  const dataDir = join(directory, 'main'); await mkdir(dataDir);
  start('sub2api', binary, [], { AUTO_SETUP: 'true', DATA_DIR: dataDir,
    SERVER_HOST: '127.0.0.1', SERVER_PORT: String(appPort), SERVER_MODE: 'release', RUN_MODE: 'standard',
    DATABASE_HOST: '127.0.0.1', DATABASE_PORT: String(pgPort), DATABASE_USER: 'sub2api', DATABASE_PASSWORD: password, DATABASE_DBNAME: 'sub2api', DATABASE_SSLMODE: 'disable',
    REDIS_HOST: '127.0.0.1', REDIS_PORT: String(redisPort), ADMIN_EMAIL: 'runtime-smoke@example.invalid', ADMIN_PASSWORD: adminPassword,
    JWT_SECRET: secret(), TOTP_ENCRYPTION_KEY: secret(), TZ: 'UTC', TIMEZONE: 'UTC', PROVIDER_RUNTIME_ENABLED: 'true',
    GATEWAY_LOG_UPSTREAM_ERROR_BODY: 'true', GATEWAY_LOG_UPSTREAM_ERROR_BODY_MAX_BYTES: '4096',
    PROVIDER_RUNTIME_BASE_URL: `http://127.0.0.1:${runtimePort}`, PROVIDER_RUNTIME_TOKEN: runtimeToken,
  }, directory);
  base = `http://127.0.0.1:${appPort}`;
  } else base = deployedBase.replace(/\/$/, '');
  await waitFor(async () => { const response = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); });
  console.log(JSON.stringify({ phase: 'startup', health: 200 }));
  const signin = await request('/api/v1/auth/login', { email: deployedBase ? process.env.ADMIN_EMAIL : 'runtime-smoke@example.invalid', password: adminPassword }, null);
  adminJWT = signin.data.access_token; assert.ok(adminJWT); secrets.push(adminJWT);
  const userId = signin.data.user.id;
  const compliance = (await request('/api/v1/admin/compliance')).data;
  if (compliance.required) {
    if (deployedBase) throw new Error('Deployment is ready; an administrator must review and accept the compliance notice in the web UI before management smoke can continue');
    await request('/api/v1/admin/compliance/accept', { phrase: compliance.ack_phrase_en, language: 'en' });
  }
  if (!deployedBase) await request(`/api/v1/admin/users/${userId}`, { concurrency: 8 }, adminJWT, 'PUT');
  const before = (await request(`/api/v1/admin/users/${userId}`)).data;
  const funded = (await request(`/api/v1/admin/users/${userId}/balance`, { balance: deployedBase ? 1 : 100, operation: deployedBase ? 'add' : 'set', notes: 'Isolated test balance; no real payment' })).data;
  const startingBalance = funded.balance;
  assert.ok(Math.abs(startingBalance - (deployedBase ? before.balance + 1 : 100)) < 0.000001);
  const unauthorized = await fetch(base + '/api/v1/admin/provider-runtime/accounts'); assert.equal(unauthorized.status, 401);
  const runtimeStatus = (await request('/api/v1/admin/provider-runtime/status')).data; assert.equal(runtimeStatus.enabled, true);
  const account = (await request('/api/v1/admin/provider-runtime/accounts', { provider: 'opencode-zen-free', name: 'Public free smoke' })).data;
  assert.equal(account.connected, true);
  const modelList = (await request(`/api/v1/admin/provider-runtime/accounts/${account.id}/models`, {})).data;
  const model = modelList.find(model => model.protocol === 'chat_completions' && (!process.env.PROVIDER_SMOKE_MODEL || model.id === process.env.PROVIDER_SMOKE_MODEL)); assert.ok(model);
  // Explicit synthetic retail prices test local billing without spending money
  // upstream. These rates are test fixtures, not the provider's credit prices.
  const group = (await request('/api/v1/admin/groups', { name: `Runtime ${suffix}`, platform: 'openai', rate_multiplier: 1, allow_messages_dispatch: true,
    model_pricing: [{ platform: 'openai', models: [model.id], billing_mode: 'token', input_price: 0.000001, output_price: 0.000002, cache_read_price: 0, cache_write_price: 0 }] })).data;
  const linked = (await request('/api/v1/admin/accounts', { name: `Runtime account ${suffix}`, platform: 'openai', type: 'apikey', concurrency: 2,
    group_ids: [group.id], credentials: { base_url: 'https://provider-runtime.invalid', api_key: 'provider-runtime', provider_runtime_account: account.id,
      provider_runtime_provider: account.provider, provider_runtime_protocol: 'chat_completions', model_mapping: { [model.id]: model.id } } })).data;
  const key = (await request('/api/v1/keys', { name: 'Runtime smoke', group_id: group.id })).data;
  const apiKey = key.key; assert.ok(apiKey); secrets.push(apiKey);
  smokeKeyID = key.id;
  console.log(JSON.stringify({ phase: 'management', login: 200, unauthorized_admin: 401, runtime_account: account.id, model: model.id, group: group.id, account: linked.id }));
  for (const protocol of ['responses', 'messages']) {
    const body = protocol === 'responses'
      ? { model: model.id, stream: true, input: 'Reply with exactly SUB2API_FULL_STACK_OK. Do not call any tools.' }
      : { model: model.id, stream: true, max_tokens: 128, messages: [{ role: 'user', content: 'Reply with exactly SUB2API_FULL_STACK_OK. Do not call any tools.' }] };
    const result = await request(`/v1/${protocol}`, body, apiKey);
    assert.ok(result.contentType?.includes('text/event-stream'));
    assert.ok(result.text.includes(protocol === 'responses' ? 'response.completed' : 'message_stop'));
    let output = '';
    for (const line of result.text.split('\n')) if (line.startsWith('data: ')) {
      let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
      if (event.type === 'response.output_text.delta') output += event.delta;
      if (event.type === 'content_block_delta') output += event.delta?.text ?? '';
    }
    assert.ok(output.includes('SUB2API_FULL_STACK_OK'), `Unexpected ${protocol} answer: ${output}`);
    console.log(JSON.stringify({ phase: 'gateway', protocol, http_status: result.status, completed: true, output }));
  }
  const chat = await request('/v1/chat/completions', { model: model.id, stream: true, max_tokens: 128,
    messages: [{ role: 'user', content: 'Reply with exactly SUB2API_FULL_STACK_OK. Do not call any tools.' }] }, apiKey);
  assert.ok(chat.contentType?.includes('text/event-stream'));
  assert.ok(chat.text.includes('data: [DONE]'));
  let chatOutput = '';
  for (const line of chat.text.split('\n')) if (line.startsWith('data: ')) {
    try { chatOutput += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? ''; } catch {}
  }
  assert.ok(chatOutput.includes('SUB2API_FULL_STACK_OK'), `Unexpected Chat Completions answer: ${chatOutput}`);
  console.log(JSON.stringify({ phase: 'gateway', protocol: 'chat_completions', http_status: chat.status, completed: true, output: chatOutput }));
  for (const protocol of ['responses', 'messages']) {
    const prompt = 'Call smoke_echo with value "fixture". After its result, repeat the tool result exactly.';
    const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
    const tools = protocol === 'responses'
      ? [{ type: 'function', name: 'smoke_echo', description: 'Return a test string', parameters: schema }]
      : [{ name: 'smoke_echo', description: 'Return a test string', input_schema: schema }];
    const first = (await request(`/v1/${protocol}`, protocol === 'responses'
      ? { model: model.id, stream: false, max_output_tokens: 1024, input: prompt, tools, tool_choice: { type: 'function', name: 'smoke_echo' } }
      : { model: model.id, stream: false, max_tokens: 1024, messages: [{ role: 'user', content: prompt }], tools, tool_choice: { type: 'tool', name: 'smoke_echo' } }, apiKey)).data;
    const call = protocol === 'responses' ? first.output.find(item => item.type === 'function_call') : first.content.find(item => item.type === 'tool_use');
    assert.equal(call?.name, 'smoke_echo', `Expected a native tool call: ${JSON.stringify(first).slice(0, 2500)}`);
    const args = protocol === 'responses' ? JSON.parse(call.arguments) : call.input;
    assert.equal(args.value, 'fixture');
    const toolResult = 'SUB2API_REAL_TOOL_ROUNDTRIP_OK';
    const followup = (await request(`/v1/${protocol}`, protocol === 'responses'
      ? { model: model.id, stream: false, max_output_tokens: 256, tools, tool_choice: 'none', input: [{ role: 'user', content: prompt }, call,
        { type: 'function_call_output', call_id: call.call_id, output: toolResult }] }
      : { model: model.id, stream: false, max_tokens: 256, tools, tool_choice: { type: 'none' }, messages: [{ role: 'user', content: prompt },
        { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: toolResult }] }] }, apiKey)).data;
    const text = protocol === 'responses'
      ? followup.output.flatMap(item => item.content ?? []).map(item => item.text ?? '').join('')
      : followup.content.map(item => item.text ?? '').join('');
    assert.ok(text.includes(toolResult), `Unexpected ${protocol} tool continuation: ${text}`);
    console.log(JSON.stringify({ phase: 'tools', protocol, native_tool_call: true, arguments: args, continuation: text }));
  }
  const rows = await waitFor(async () => {
    const usage = (await request('/api/v1/usage?page=1&page_size=20')).data;
    const items = usage.items?.filter(row => row.api_key_id === key.id) ?? [];
    assert.ok(items.length >= 7); return items;
  }, 15000);
  assert.ok(rows.every(row => (row.input_tokens ?? 0) + (row.output_tokens ?? 0) > 0));
  assert.ok(rows.every(row => row.actual_cost > 0));
  const charged = rows.reduce((sum, row) => sum + row.actual_cost, 0);
  const user = (await request(`/api/v1/admin/users/${userId}`)).data;
  assert.ok(Math.abs((startingBalance - user.balance) - charged) < 0.00001, 'Usage costs must reconcile with the isolated user balance');
  console.log(JSON.stringify({ phase: 'accounting', records: rows.length, tokens_recorded: true, test_balance_charged: charged, reconciled: true }));
  const ui = await fetch(base + '/admin/provider-runtime'); assert.equal(ui.status, 200);
  assert.ok((await ui.text()).includes('<html'));
  console.log(JSON.stringify({ phase: 'result', passed: true, embedded_frontend: true }));
} catch (error) {
  await writeFile(join(directory, 'failure.log'), redact(JSON.stringify(logs, null, 2)));
  console.error(redact(String(error.stack ?? error)));
  console.error(`Isolated application logs: ${join(directory, 'failure.log')}`);
  process.exitCode = 1;
} finally {
  if (deployedBase && smokeKeyID) {
    try { await request(`/api/v1/keys/${smokeKeyID}`, undefined, adminJWT, 'DELETE'); console.log(JSON.stringify({ phase: 'cleanup', smoke_key_revoked: true })); }
    catch (error) { console.error(`Smoke key cleanup: ${redact(error.message)}`); process.exitCode = 1; }
  }
  for (const child of children.reverse()) {
    child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  }
  for (const name of containers.reverse()) {
    try {
      const inspection = JSON.parse(docker(['inspect', name]))[0];
      assert.equal(inspection.Config.Labels['com.codex.test'], label);
      docker(['rm', '-f', '-v', name]);
    } catch (error) { console.error(`Test container cleanup: ${redact(error.message)}`); }
  }
}
