import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';

const json = (res, code, payload) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
};

export class DoraemonDaemon {
  constructor({ host, port, token }) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.agents = new Map();
    this.defaultAgentId = null;
    this.server = http.createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname !== '/v1/extension' || url.searchParams.get('token') !== this.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.attachAgent(ws);
      });
    });
  }

  async start() {
    await new Promise((resolve) => this.server.listen(this.port, this.host, resolve));
    console.log(`[doraemon] relay listening on http://${this.host}:${this.port}`);
    console.log(`[doraemon] extension websocket ws://${this.host}:${this.port}/v1/extension?token=...`);
  }

  attachAgent(ws) {
    let agentId = null;
    console.log('[doraemon] extension connected');
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message?.method === 'agent.hello' && message.params?.agentId) {
        agentId = String(message.params.agentId);
        this.agents.set(agentId, {
          ws,
          hello: message.params,
          pending: new Map(),
        });
        if (!this.defaultAgentId) this.defaultAgentId = agentId;
        console.log(`[doraemon] agent registered ${agentId}`);
        if (message.id) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              ok: true,
              agentId,
              defaultAgentId: this.defaultAgentId,
            },
          }));
        }
        return;
      }
      if (message?.id && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        const agent = agentId ? this.agents.get(agentId) : null;
        if (!agent) return;
        const pending = agent.pending.get(String(message.id));
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        agent.pending.delete(String(message.id));
        if (message.error) pending.reject(new Error(message.error.message || 'Agent error'));
        else pending.resolve(message.result);
      }
    });

    ws.on('close', () => {
      console.log(`[doraemon] extension disconnected${agentId ? ` ${agentId}` : ''}`);
      if (!agentId) return;
      const existing = this.agents.get(agentId);
      if (!existing || existing.ws !== ws) return;
      for (const pending of existing.pending.values()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('Agent disconnected'));
      }
      this.agents.delete(agentId);
      if (this.defaultAgentId === agentId) {
        this.defaultAgentId = this.agents.keys().next().value || null;
      }
    });
  }

  isAuthorized(req) {
    const header = String(req.headers.authorization || '');
    return header === `Bearer ${this.token}`;
  }

  async callAgent(method, params, agentId) {
    const resolvedAgentId = agentId || this.defaultAgentId;
    if (!resolvedAgentId) throw new Error('No Firefox agent connected');
    const agent = this.agents.get(resolvedAgentId);
    if (!agent) throw new Error(`Unknown agent: ${resolvedAgentId}`);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        agent.pending.delete(id);
        reject(new Error('Agent call timed out'));
      }, 20_000);
      agent.pending.set(id, { resolve, reject, timeoutId });
      agent.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async handleRpc(method, params) {
    if (method === 'relay.ping') {
      return {
        ok: true,
        now: new Date().toISOString(),
        agents: this.agents.size,
        defaultAgentId: this.defaultAgentId,
      };
    }
    if (method === 'agents.list') {
      return [...this.agents.entries()].map(([agentId, agent]) => ({
        agentId,
        ...agent.hello,
      }));
    }
    if (method === 'tools.list') {
      return [
        'navigate',
        'find',
        'click',
        'clickText',
        'scroll',
        'youtubeState',
        'youtubeOpen',
        'youtubeTranscript',
        'type',
        'pressKey',
        'getContent',
        'evaluate',
        'waitFor',
        'screenshot',
      ];
    }
    if (method === 'tool.call') {
      const tool = String(params?.tool || '');
      return await this.callAgent('tool.call', { tool, args: params?.args || {} }, params?.agentId || null);
    }
    throw new Error(`Unknown method: ${method}`);
  }

  async handleHttp(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/v1/pair') return json(res, 200, { ok: true, paired: this.agents.size > 0, token: this.token });
    if (url.pathname !== '/v1/rpc' || req.method !== 'POST') return json(res, 404, { error: 'not_found' });
    if (!this.isAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const result = await this.handleRpc(String(body.method || ''), body.params || {});
      return json(res, 200, { jsonrpc: '2.0', id: body.id ?? null, result });
    } catch (error) {
      return json(res, 200, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error ?? 'error') },
      });
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = Object.fromEntries(
    process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
      const [key, value] = arg.slice(2).split('=');
      return [key, value ?? 'true'];
    }),
  );
  const daemon = new DoraemonDaemon({
    host: args.host || '127.0.0.1',
    port: Number(args.port || 1969),
    token: args.token || '',
  });
  if (!daemon.token) {
    console.error('Missing --token');
    process.exit(1);
  }
  await daemon.start();
}
