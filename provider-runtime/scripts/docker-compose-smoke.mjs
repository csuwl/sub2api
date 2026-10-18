// Isolated provider-service deployment check using the documented Compose files.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../../deploy');
const project = `sub2api-provider-smoke-${randomBytes(5).toString('hex')}`;
const token = randomBytes(32).toString('hex');
const environment = { ...process.env, POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
  PROVIDER_RUNTIME_TOKEN: token, PROVIDER_RUNTIME_STATE_KEY: randomBytes(32).toString('base64') };
const compose = ['compose', '-p', project, '-f', 'docker-compose.yml', '-f', 'docker-compose.provider-runtime.yml'];
function docker(args, quiet = false) {
  const result = spawnSync('docker', args, { cwd: directory, env: environment, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || 'Docker failed').replaceAll(token, '[redacted]'));
  if (!quiet && result.stderr) process.stderr.write(result.stderr.replaceAll(token, '[redacted]'));
  return result.stdout.trim();
}
let created = false;
try {
  const config = JSON.parse(docker([...compose, 'config', '--format', 'json'], true));
  const service = config.services['provider-runtime'];
  assert.equal(service.ports, undefined);
  assert.ok(Object.keys(service.networks).some(network => Object.hasOwn(config.services.sub2api.networks, network)));
  created = true;
  docker([...compose, 'up', '-d', '--build', '--wait', 'provider-runtime']);
  const network = config.networks['sub2api-network'].name;
  const container = docker([...compose, 'ps', '-q', 'provider-runtime'], true);
  const inspection = JSON.parse(docker(['inspect', container], true))[0];
  assert.equal(inspection.Config.User, 'bun');
  assert.equal(inspection.Config.Labels['com.docker.compose.project'], project);
  assert.equal(inspection.NetworkSettings.Ports['3426/tcp'], null);
  const probe = `
    const base='http://provider-runtime:3426';
    const assert=(condition)=>{if(!condition)throw new Error('Deployment assertion failed')};
    assert((await fetch(base+'/healthz')).status===401);
    const headers={authorization:'Bearer '+process.env.PROVIDER_RUNTIME_TOKEN,'content-type':'application/json'};
    assert((await fetch(base+'/healthz',{headers})).status===200);
    if(process.env.CREATE_ACCOUNT==='true') {
      const response=await fetch(base+'/admin/accounts',{method:'POST',headers,body:JSON.stringify({provider:'opencode-zen-free',name:'Compose persistence fixture'})});
      assert(response.status===201);
    }
    const response=await fetch(base+'/admin/accounts',{headers});
    const text=await response.text(); const accounts=JSON.parse(text);
    assert(accounts.length===1 && accounts[0].connected);
    assert(!text.includes('Bearer ') && !text.includes('"auth"'));
    console.log(JSON.stringify({authenticated_health:200,unauthorized_health:401,connected_accounts:accounts.length}));
  `;
  for (const create of [true, false]) {
    if (!create) docker([...compose, 'restart', '--no-deps', 'provider-runtime']);
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        console.log(docker(['run', '--rm', '--network', network, '--env', 'PROVIDER_RUNTIME_TOKEN', '--env', `CREATE_ACCOUNT=${create}`,
          inspection.Config.Image, 'bun', '-e', probe], true));
        break;
      } catch (error) {
        if (create || Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  }
  console.log(JSON.stringify({ passed: true, non_root: true, published_ports: false, persisted_across_restart: true }));
} finally {
  if (created) docker([...compose, 'down', '--volumes', '--remove-orphans']);
}
