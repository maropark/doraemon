# Doraemon

Firefox-first MVP for controlling the browser from any CLI that can make HTTP requests or shell out to a small wrapper.

## Goal

Make Firefox controllable with minimal ceremony:

1. Start a local relay
2. Load the Firefox extension
3. Drive the browser from a CLI over JSON-RPC

No LLM provider setup. No sidepanel chat. No account model. Just browser control.

## What it includes

- Local managed relay on `127.0.0.1:19699`
- Firefox extension that auto-pairs with the local relay and only reports connected after agent registration succeeds
- JSON-RPC HTTP API for CLI-agnostic control
- Small CLI wrapper for convenience

## Commands

From a standalone checkout:

```bash
cd /home/maro/Projects/doraemon
npm install
npm run build
node dist/cli.js start
node dist/cli.js status
node dist/cli.js tools
node dist/cli.js navigate "https://example.com"
node dist/cli.js click "text=More information"
node dist/cli.js text "body"
```

## Firefox setup

1. Build:

```bash
cd /home/maro/Projects/parchi/doraemon
npm run build
```

2. Start relay:

```bash
node dist/cli.js start
```

Use:

```bash
node dist/cli.js start
```

3. Open Firefox:

```text
about:debugging#/runtime/this-firefox
```

4. Click `Load Temporary Add-on`

5. Select:

```text
/home/maro/Projects/doraemon/dist-firefox/manifest.json
```

6. The extension will retry pairing automatically. Open the Doraemon toolbar button if you want to inspect relay state.

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
curl -s http://127.0.0.1:19699/v1/rpc \
  -H "Authorization: Bearer $(jq -r .token ~/.doraemon/relay.json)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tool.call","params":{"tool":"navigate","args":{"url":"https://example.com"}}}'
```

## MVP tools

- `navigate`
- `click`
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
