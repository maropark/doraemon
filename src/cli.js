import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR = path.join(os.homedir(), '.doraemon');
const STATE_PATH = path.join(STATE_DIR, 'relay.json');
const PID_PATH = path.join(STATE_DIR, 'relay.pid');
const LOG_PATH = path.join(STATE_DIR, 'relay.log');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 19699;

const ensureStateDir = () => fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const readJson = (target) => {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
};
const readPid = () => {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};
const isPidRunning = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const loadRelayConfig = () => {
  const envUrl = String(process.env.DORAEMON_RELAY_URL || '').trim();
  const envToken = String(process.env.DORAEMON_RELAY_TOKEN || '').trim();
  if (envUrl && envToken) {
    return { url: envUrl, token: envToken, host: new URL(envUrl).hostname, port: Number(new URL(envUrl).port || 80) };
  }
  const saved = readJson(STATE_PATH);
  if (saved?.token) {
    return {
      url: `http://${saved.host || DEFAULT_HOST}:${saved.port || DEFAULT_PORT}`,
      token: saved.token,
      host: saved.host || DEFAULT_HOST,
      port: saved.port || DEFAULT_PORT,
    };
  }
  throw new Error('No doraemon relay config found. Run `node dist/cli.js start` first.');
};

const fetchRpc = async (method, params = {}) => {
  const relay = loadRelayConfig();
  const res = await fetch(`${relay.url}/v1/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${relay.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  const payload = await res.json();
  if (payload.error) throw new Error(payload.error.message || 'RPC error');
  return payload.result;
};

const startManagedDaemon = async () => {
  ensureStateDir();
  const existing = readJson(STATE_PATH) || {};
  const host = existing.host || DEFAULT_HOST;
  const port =
    existing.port === 17373 && host === DEFAULT_HOST
      ? DEFAULT_PORT
      : existing.port || DEFAULT_PORT;
  const token = existing.token || crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(STATE_PATH, `${JSON.stringify({ host, port, token }, null, 2)}\n`, { mode: 0o600 });
  const currentPid = readPid();
  if (isPidRunning(currentPid)) {
    console.log(`doraemon relay already running on http://${host}:${port}`);
    return;
  }
  const out = fs.openSync(LOG_PATH, 'a', 0o600);
  const child = spawn(process.execPath, [path.join(path.dirname(process.argv[1]), 'daemon.js'), `--host=${host}`, `--port=${port}`, `--token=${token}`], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(PID_PATH, `${child.pid}\n`);
  console.log(`doraemon relay started on http://${host}:${port}`);
  console.log(`Load ${path.join(process.cwd(), 'dist-firefox', 'manifest.json')} in Firefox`);
};

const stopManagedDaemon = () => {
  const pid = readPid();
  if (!isPidRunning(pid)) {
    console.log('doraemon relay is not running');
    return;
  }
  process.kill(pid, 'SIGTERM');
  fs.rmSync(PID_PATH, { force: true });
  console.log(`stopped doraemon relay pid ${pid}`);
};

const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === 'start') {
    await startManagedDaemon();
  } else if (cmd === 'stop') {
    stopManagedDaemon();
  } else if (cmd === 'status') {
    const state = readJson(STATE_PATH);
    const pid = readPid();
    const running = isPidRunning(pid);
    let relay = null;
    if (running) {
      try {
        relay = await fetchRpc('relay.ping');
      } catch (error) {
        relay = { error: error instanceof Error ? error.message : String(error ?? 'error') };
      }
    }
    print({
      configured: Boolean(state),
      daemon: running ? 'running' : 'stopped',
      pid: running ? pid : null,
      relay,
    });
  } else if (cmd === 'tools') {
    print(await fetchRpc('tools.list'));
  } else if (cmd === 'tool') {
    const tool = rest[0];
    const argsFlag = rest.find((part) => part.startsWith('--args='));
    if (!tool) throw new Error('Usage: tool <name> --args=\'{}\'');
    const args = argsFlag ? JSON.parse(argsFlag.slice('--args='.length)) : {};
    print(await fetchRpc('tool.call', { tool, args }));
  } else if (cmd === 'relay' && rest[0] === 'agents') {
    print(await fetchRpc('agents.list'));
  } else if (cmd === 'navigate') {
    print(await fetchRpc('tool.call', { tool: 'navigate', args: { url: rest[0] } }));
  } else if (cmd === 'click') {
    print(await fetchRpc('tool.call', { tool: 'click', args: { selector: rest[0] } }));
  } else if (cmd === 'type') {
    print(await fetchRpc('tool.call', { tool: 'type', args: { selector: rest[0], text: rest.slice(1).join(' ') } }));
  } else if (cmd === 'pressKey') {
    print(await fetchRpc('tool.call', { tool: 'pressKey', args: { key: rest[0] } }));
  } else if (cmd === 'text') {
    print(await fetchRpc('tool.call', { tool: 'getContent', args: { type: 'text', selector: rest[0] } }));
  } else {
    print(`doraemon commands:
  start
  stop
  status
  tools
  relay agents
  tool <name> --args='{}'
  navigate <url>
  click <selector>
  type <selector> <text>
  pressKey <key>
  text [selector]`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error ?? 'error'));
  process.exit(1);
}
