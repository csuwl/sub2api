# Subscription provider runtime

This optional service connects OpenCode provider plugins to Sub2API's existing gateway. It runs separately under Bun; Sub2API retains client authentication, account selection, protocol conversion, usage accounting and billing. It is disabled by default.

Included providers are WorkBuddy China, WorkBuddy AI and OpenCode Zen Free. Existing OpenCode Zen/Go paid accounts and ordinary compatible API accounts continue to use their existing integrations. Ollama/LM Studio can continue to be configured as ordinary compatible HTTP upstreams.

## Start locally

Requirements: Bun 1.3.6 or later (1.3.6 is the tested baseline), the modified Sub2API backend/frontend, PostgreSQL and Redis for the main application.

1. In this directory, run `bun install --frozen-lockfile --ignore-scripts`.
2. Copy `.env.example` to `.env`. Generate two independent secrets:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   The first is `PROVIDER_RUNTIME_TOKEN`. The second is `PROVIDER_RUNTIME_STATE_KEY`. Keep the state key: a different key cannot decrypt existing accounts. Bun reads the local `.env`; never commit it.
3. Run `bun run start`. By default, only `127.0.0.1:3426` listens. Account auth is stored in `state/accounts.enc` with AES-256-GCM, atomic writes and a fresh nonce per save.
4. Configure the main Sub2API process:

   ```yaml
   provider_runtime:
     enabled: true
     base_url: http://127.0.0.1:3426
     token: "the same deployment token"
   ```

   Equivalent environment variables are `PROVIDER_RUNTIME_ENABLED`, `PROVIDER_RUNTIME_BASE_URL`, `PROVIDER_RUNTIME_TOKEN`. An HTTP endpoint outside loopback requires the explicit `PROVIDER_RUNTIME_ALLOW_INSECURE_HTTP=true` setting for a trusted private network; otherwise use HTTPS.
5. Open **Account Management / 账号管理 → Add account / 添加账号** and choose WorkBuddy, WorkBuddy AI or OpenCode Zen Free. Add the account in the same dialog. For WorkBuddy, complete the provider's official browser login yourself; the dialog polls for completion. Zen Free uses its public credential and needs no personal API key.
6. Load models, choose models and an OpenAI API group, then add them to Sub2API. Models are split into one Sub2API account per native protocol. Existing protocol connections are retained when importing again; newly selected model IDs are added to their mappings. An unassigned account must be attached to a group before its API key can route requests.
7. Use your existing Sub2API API key and public gateway base URL from Codex, Claude Code or another supported client. Set the client model to an imported model ID. For Claude Code and other Messages clients, enable **Messages dispatch** on the chosen OpenAI group; if keeping default Claude model aliases, map those aliases to imported model IDs in the group settings. The `.invalid` base URL visible in imported account credentials is a reserved placeholder: bound requests are intercepted and sent to the configured runtime. A missing runtime fails closed.

Existing provider connections appear in the ordinary account list with their provider name. Use **Manage authorization and models / 管理授权与模型** on that account to reauthorize, discover additional models or check allowance. There is no additional sidebar section. Old `/admin/provider-runtime` bookmarks redirect to account management.

The runtime deployment token is never returned to the browser or placed in a downstream API key. Sub2API holds opaque runtime account IDs. Provider sign-ins stay in the host; browser management is proxied through Sub2API's existing admin authentication, rate limit, audit and compliance middleware.

Provider credits and downstream billing are separate. Configure model prices in the selected group if downstream usage should be charged. Model discovery does not create retail prices, and Sub2API can record unknown-priced models at zero cost. Never treat a provider's credit balance as a USD/token conversion.

## Docker Compose

From `deploy/`, populate the usual main application `.env` plus the two provider secrets, then run:

```sh
docker compose -f docker-compose.yml -f docker-compose.provider-runtime.yml up -d --build
```

The overlay builds the modified main application and the runtime. The runtime is reachable only on the internal Compose network and has no published host port. Preserve the named `provider-runtime-data` volume and its encryption key. This initial implementation uses one runtime process as the owner of that state volume; do not run multiple runtime writers against the same file. Multiple Sub2API instances can point to the same runtime service.

For a separate VPS trial alongside existing services, use the [isolated deployment instructions](../deploy/README.test.zh-CN.md) and `deploy/docker-compose.test.yml`. They publish only a loopback origin, cap resources, rotate logs and retain separate database/state volumes. Close registration before adding the public HTTPS route.

## Provider ownership and limits

- Each runtime account owns its plugin hooks, auth accessor, credential writes, model cache and active stream limit. Several Sub2API protocol accounts can refer to the same runtime account; they share its concurrency limit.
- WorkBuddy's stream-only upstream is aggregated for non-streaming clients. Streaming responses retain backpressure; cancellation closes the provider body. Errors, quota codes and Retry-After retain their upstream meaning.
- Models are checked against the selected account's model list and native protocol before invoking a plugin. New plugins require an operator code/dependency change and a pinned version; the admin API cannot install arbitrary npm packages or execute module paths.
- The browser sign-in flow runs asynchronously. A host restart loses an unfinished authorization flow; authorize again. Completed auth survives restart in encrypted storage. Desktop credential discovery is intentionally outside the server-hosted interface.
- Quota display uses the provider's own units. Unknown allowance is displayed as unknown and is not converted into token balance. Existing Sub2API error/cooldown scheduling still handles failed upstream calls; proactive routing by plugin credit-expiry windows is a later extension.
- Gateway API compatibility cannot override platform entitlement or channel restrictions, nor add tools or image understanding a model does not support. WorkBuddy's plugin explicitly recognizes channel refusal, restricted accounts and exhausted credit packages. Real-account acceptance must be tested for each intended downstream/model combination.

## Tests

```sh
cd provider-runtime
bun test
cd ../backend
SUB2API_TEST_BUN=bun go test -tags=unit ./internal/config ./internal/service ./internal/handler/admin -run ProviderRuntime -count=1 -timeout=180s
```

On Windows PowerShell, set `$env:SUB2API_TEST_BUN` to the full `bun.exe` path before running the Go command. The cross-process gateway test is explicit and skips if this variable is missing. It starts a real Bun HTTP host with the original WorkBuddy plugin, intercepts every external provider request, and tests both Responses and Messages clients through a tool call and its result, streaming and non-streaming. It does not use a real platform account or spend credits.

Explicit network and deployment checks are also available (these do not run in CI):

```sh
bun scripts/live-free-smoke.mjs --infer
SUB2API_TEST_SERVER=/absolute/path/to/built/sub2api SUB2API_TEST_BUN=bun \
  PROVIDER_SMOKE_MODEL=mimo-v2.6-flash-free node scripts/full-stack-smoke.mjs
node scripts/docker-compose-smoke.mjs
```

The full-stack check requires the `postgres:18-alpine` and `redis:7-alpine` images locally. It starts temporary labelled database containers, the built main application and the provider host; tests admin access, discovery, streaming Responses/Chat Completions/Messages, tool-call/result rounds on Responses and Messages, usage and balance reconciliation; then removes only its own containers. It uses public free access and synthetic local retail prices, with no personal subscription credentials or real payment. The selected model must still be free and support tools when the check runs. See [the dated test report](TEST_REPORT.zh-CN.md) for observed results and limitations.

An existing isolated test deployment can be checked with `SUB2API_TEST_BASE_URL`, `SUB2API_TEST_ALLOW_EXISTING=true`, `ADMIN_EMAIL` and `ADMIN_PASSWORD`. This mode requires the deployment administrator to accept the compliance notice first, creates test accounts/groups, adds one synthetic balance unit and revokes its temporary API key afterwards. It does not start or remove deployment containers. See the VPS instructions before running it.

The Compose check builds only the provider service from the documented overlay. It verifies shared networking, authentication, no published ports and persistence across restart in a random temporary Compose project, then removes its own project and volumes.

## Third-party code

Pinned dependencies `@magpie-community/opencode-workbuddy-auth@0.1.24` and `@magpie-community/opencode-zen-free-auth@0.1.11` come from [magpie-community/plugins](https://github.com/magpie-community/plugins), copyright 2026 magpie-community contributors, under MIT. The stream aggregation helper is imported from the pinned Zen Free package. Dependency notices and licenses remain with those packages; this extension does not change Sub2API's LGPL-3.0 license. Magpie's desktop or Go gateway code is not embedded in this implementation.
