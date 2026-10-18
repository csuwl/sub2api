// This process is started explicitly by the Go gateway integration test.
// It uses the original WorkBuddy plugin and synthetic auth. All outbound fetches
// are intercepted, so no real platform, login file or paid request is involved.
import { WorkBuddyAuthPlugin } from '@magpie-community/opencode-workbuddy-auth';
import { createRuntime } from '../src/runtime.mjs';

globalThis.fetch = async (url, init) => {
  if (new URL(url).hostname !== 'copilot.tencent.com' || new URL(url).pathname !== '/v2/chat/completions') throw new Error('Unexpected outbound fixture request');
  const body = JSON.parse(init.body);
  const finished = body.messages.some(message => message.role === 'tool');
  const delta = finished ? { content: 'fixture completed' } : { tool_calls: [{ index: 0, id: 'fixture-call', type: 'function',
    function: { name: body.tools[0].function.name, arguments: '{"path":"fixture.txt"}' } }] };
  const chunks = [
    { id: 'fixture-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'fixture-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finished ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};

const store = { accounts: { 'fixture-account': { id: 'fixture-account', name: 'Fixture', provider: 'workbuddy',
  auth: { type: 'oauth', access: 'fixture-only-access', uid: 'fixture-user', expires: Date.now() + 3600000 } } }, async save() {} };
const handle = createRuntime({ token: process.env.FIXTURE_RUNTIME_TOKEN, store,
  providers: { workbuddy: { name: 'WorkBuddy', factory: WorkBuddyAuthPlugin, streamOnly: true, protocol: 'chat_completions' } } });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle });
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
