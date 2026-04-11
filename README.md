# Doraemon

Firefox-first MVP for controlling the browser from any CLI that can make HTTP requests or shell out to a small wrapper.

## Goal

Make Firefox controllable with minimal ceremony:

1. Start a local relay
2. Load the Firefox extension
3. Drive the browser from a CLI over JSON-RPC

No LLM provider setup. No sidepanel chat. No account model. Just browser control.

## What it includes

- Local managed relay on `127.0.0.1:1969`
- Firefox extension that auto-pairs with the local relay and only reports connected after agent registration succeeds
- JSON-RPC HTTP API for CLI-agnostic control
- Small CLI wrapper for convenience

## Commands

After cloning this repository and entering its root directory:

```bash
npm install
npm run build
node dist/cli.js start
node dist/cli.js status
node dist/cli.js tools
node dist/cli.js navigate "https://example.com"
node dist/cli.js find "Ask"
node dist/cli.js click-text "Ask"
node dist/cli.js scroll down 800
node dist/cli.js youtube-state
node dist/cli.js youtube-open transcript
node dist/cli.js youtube-transcript
node dist/cli.js click "text=More information"
node dist/cli.js text "body"
```

## Firefox setup

1. Build the extension:

```bash
npm run build
```

2. Start the relay:

```bash
node dist/cli.js start
```

3. Open Firefox to `about:debugging#/runtime/this-firefox`

4. Click `Load Temporary Add-on`

5. Select the manifest at `dist-firefox/manifest.json` from the repository root

6. The extension will retry pairing automatically. Open the Doraemon toolbar button if you want to inspect relay state.

## Health check

Verify the Doraemon agent connection is healthy at three levels:

### Daemon alive

Check that the relay server is running:

```bash
curl -s http://127.0.0.1:1969/healthz
# → {"ok":true}
```

### Extension paired

Check that the Firefox extension has connected and registered:

```bash
curl -s http://127.0.0.1:1969/v1/pair
# → {"ok":true,"paired":true,"token":"..."}
```

If `paired` is `false`, the extension hasn't connected yet. Check the Firefox Doraemon toolbar button for error details, or verify the extension is loaded in `about:debugging`.

### Full relay status

Get daemon PID, relay health, and connected agent count via the CLI:

```bash
node dist/cli.js status
```

Returns:
```json
{
  "configured": true,
  "daemon": { "ok": true, "now": "..." },
  "pid": 12345,
  "relay": { "ok": true, "now": "...", "agents": 1, "defaultAgentId": "..." }
}
```

## CLI-agnostic API

The relay exposes:

- `GET /healthz`
- `GET /v1/pair`
- `POST /v1/rpc`

JSON-RPC methods:

- `relay.ping`
- `agents.list`
- `tools.list`
- `tool.call`

Example:

```bash
curl -s http://127.0.0.1:1969/v1/rpc \
  -H "Authorization: Bearer $(jq -r .token ~/.doraemon/relay.json)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tool.call","params":{"tool":"navigate","args":{"url":"https://example.com"}}}'
```

## MVP tools

- `navigate`
- `find`
- `click`
- `clickText`
- `scroll`
- `youtubeState`
- `youtubeOpen`
- `youtubeTranscript`
- `type`
- `pressKey`
- `getContent`
- `evaluate`
- `waitFor`
- `screenshot`

## Intentional omissions

- No chat UI
- No model integration
- No multi-agent orchestration
- No provider settings
- No native messaging dependency

This is the smallest useful base for making Firefox controllable from a CLI.
