// src/extension/background.js
var DEFAULT_RELAY_URL = "http://127.0.0.1:1969";
var DEFAULT_RETRY_MS = 3e3;
var HANDSHAKE_TIMEOUT_MS = 4e3;
var AGENT_ID_KEY = "agentId";
var ws = null;
var retryTimer = null;
var handshakeTimer = null;
var helloRequestId = null;
var connectInFlight = false;
var currentSettings = { relayUrl: DEFAULT_RELAY_URL, relayToken: "", relayConnected: false, relayLastError: "" };
var delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var getStorage = async (keys) => await browser.storage.local.get(keys);
var setStorage = async (patch) => await browser.storage.local.set(patch);
var normalizeRelayUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return "";
  }
};
var loadAgentId = async () => {
  const stored = await getStorage([AGENT_ID_KEY]);
  if (stored.agentId) return stored.agentId;
  const agentId = `doraemon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await setStorage({ agentId });
  return agentId;
};
var resolveTargetTabId = async (explicitTabId) => {
  if (typeof explicitTabId === "number") return explicitTabId;
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) return activeTab.id;
  const [firstTab] = await browser.tabs.query({});
  if (firstTab?.id) return firstTab.id;
  throw new Error("No Firefox tab available");
};
var execInTab = async (tabId2, func, args = []) => {
  const results = await browser.scripting.executeScript({
    target: { tabId: tabId2 },
    func,
    args
  });
  return results?.[0]?.result;
};
var resolveElementScript = (selector2) => {
  const isTextSelector = typeof selector2 === "string" && selector2.startsWith("text=");
  if (!isTextSelector) {
    return `document.querySelector(${JSON.stringify(selector2)})`;
  }
  const text2 = selector2.slice(5).trim().toLowerCase();
  return `([...document.querySelectorAll('a,button,input,textarea,[role="button"],[contenteditable="true"],*')].find((el)=>((el.innerText||el.value||el.getAttribute('aria-label')||'').trim().toLowerCase().includes(${JSON.stringify(text2)}))) || null)`;
};
var toolHandlers = {
  async navigate({ url, tabId: tabId2 }) {
    const resolvedTabId2 = await resolveTargetTabId(tabId2);
    await browser.tabs.update(resolvedTabId2, { url });
    return { ok: true, tabId: resolvedTabId2, url };
  },
  async getContent({ type = "text", selector, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ type, selector, elementExpr }) => {
        const el = selector ? eval(elementExpr) : document.body;
        if (type === "title") return document.title;
        if (type === "url") return location.href;
        if (type === "html") return el?.outerHTML || "";
        return el?.innerText || "";
      },
      [{ type, selector, elementExpr: resolveElementScript(selector) }]
    );
  },
  async evaluate({ script, tabId: tabId2 }) {
    const resolvedTabId2 = await resolveTargetTabId(tabId2);
    return await execInTab(
      resolvedTabId2,
      ({ script: script2 }) => {
        return (0, eval)(script2);
      },
      [{ script }]
    );
  },
  async click({ selector, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ selector, elementExpr }) => {
        const el = eval(elementExpr);
        if (!el) throw new Error(`Element not found: ${selector}`);
        el.click();
        return { ok: true };
      },
      [{ selector, elementExpr: resolveElementScript(selector) }]
    );
  },
  async type({ selector, text, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ selector, text, elementExpr }) => {
        const el = eval(elementExpr);
        if (!el) throw new Error(`Element not found: ${selector}`);
        el.focus();
        if ("value" in el) {
          el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.textContent = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return { ok: true };
      },
      [{ selector, text, elementExpr: resolveElementScript(selector) }]
    );
  },
  async pressKey({ key, selector, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ key, selector, elementExpr }) => {
        const target = selector ? eval(elementExpr) : document.activeElement || document.body;
        if (!target) throw new Error("No target element for key press");
        target.focus?.();
        const event = new KeyboardEvent("keydown", { key, bubbles: true });
        target.dispatchEvent(event);
        const up = new KeyboardEvent("keyup", { key, bubbles: true });
        target.dispatchEvent(up);
        if (key === "Enter" && typeof target.click === "function" && target.tagName === "BUTTON") target.click();
        return { ok: true };
      },
      [{ key, selector, elementExpr: resolveElementScript(selector) }]
    );
  },
  async waitFor({ selector, timeoutMs = 1e4, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const found = await execInTab(
        resolvedTabId,
        ({ elementExpr }) => Boolean(eval(elementExpr)),
        [{ elementExpr: resolveElementScript(selector) }]
      );
      if (found) return { ok: true, selector };
      await delay(250);
    }
    throw new Error(`Timed out waiting for ${selector}`);
  },
  async screenshot({ tabId: tabId2 }) {
    const resolvedTabId2 = await resolveTargetTabId(tabId2);
    const dataUrl = await browser.tabs.captureTab(resolvedTabId2, { format: "png" });
    return { ok: true, dataUrl };
  }
};
var scheduleRetry = (ms = DEFAULT_RETRY_MS) => {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connectRelay();
  }, ms);
};
var clearHandshake = () => {
  if (handshakeTimer) {
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }
  helloRequestId = null;
};
var clearRetry = () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
};
var applyRelayState = async ({ connected, lastError = "", relayUrl, relayToken }) => {
  currentSettings = {
    relayUrl: relayUrl ?? currentSettings.relayUrl,
    relayToken: relayToken ?? currentSettings.relayToken,
    relayConnected: connected,
    relayLastError: lastError
  };
  await setStorage(currentSettings);
};
var autoPair = async () => {
  const saved = await getStorage(["relayUrl", "relayToken"]);
  const configuredUrl = normalizeRelayUrl(saved.relayUrl || DEFAULT_RELAY_URL) || DEFAULT_RELAY_URL;
  const configuredToken = String(saved.relayToken || "").trim();
  if (configuredToken) {
    await applyRelayState({ connected: false, relayUrl: configuredUrl, relayToken: configuredToken });
    return;
  }
  try {
    const res = await fetch(`${configuredUrl}/v1/pair`, { cache: "no-store" });
    const payload = await res.json();
    if (payload?.token) {
      await applyRelayState({ connected: false, relayUrl: configuredUrl, relayToken: String(payload.token) });
      return;
    }
  } catch {
  }
  await applyRelayState({ connected: false, relayUrl: configuredUrl, relayToken: "" });
};
var connectRelay = async () => {
  if (connectInFlight) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connectInFlight = true;
  clearRetry();
  try {
    await autoPair();
    if (!currentSettings.relayToken) {
      await applyRelayState({ connected: false, lastError: "No relay token yet" });
      scheduleRetry();
      return;
    }
    const wsUrl = currentSettings.relayUrl.replace(/^http/, "ws") + `/v1/extension?token=${encodeURIComponent(currentSettings.relayToken)}`;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      await applyRelayState({ connected: false, lastError: error instanceof Error ? error.message : "WebSocket failed" });
      scheduleRetry();
      return;
    }
    ws.onopen = async () => {
      const agentId = await loadAgentId();
      helloRequestId = `hello-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await applyRelayState({ connected: false, lastError: "Waiting for relay handshake..." });
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: helloRequestId,
        method: "agent.hello",
        params: {
          agentId,
          name: "doraemon-firefox",
          version: "0.1.0",
          browser: "firefox",
          capabilities: { tools: true }
        }
      }));
      handshakeTimer = setTimeout(() => {
        if (ws?.readyState === WebSocket.OPEN && helloRequestId) {
          void applyRelayState({ connected: false, lastError: "Relay handshake timed out" });
          ws.close();
        }
      }, HANDSHAKE_TIMEOUT_MS);
    };
    ws.onclose = async () => {
      clearHandshake();
      ws = null;
      await applyRelayState({ connected: false, lastError: "Disconnected" });
      scheduleRetry();
    };
    ws.onerror = async () => {
      if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        await applyRelayState({ connected: false, lastError: "WebSocket error" });
        return;
      }
      if (helloRequestId) {
        await applyRelayState({ connected: false, lastError: "WebSocket error during handshake" });
        return;
      }
      await applyRelayState({ connected: true, lastError: "WebSocket warning" });
    };
    ws.onmessage = async (event2) => {
      let message;
      try {
        message = JSON.parse(String(event2.data || ""));
      } catch {
        return;
      }
      if (message?.id && helloRequestId && message.id === helloRequestId) {
        clearHandshake();
        clearRetry();
        await applyRelayState({ connected: true, lastError: "" });
        return;
      }
      if (message?.method !== "tool.call") return;
      const id = message.id;
      try {
        const tool = String(message.params?.tool || "");
        const args = message.params?.args || {};
        const handler = toolHandlers[tool];
        if (!handler) throw new Error(`Unknown tool: ${tool}`);
        const result = await handler(args);
        ws?.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (error) {
        ws?.send(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32e3, message: error instanceof Error ? error.message : String(error ?? "error") }
        }));
      }
    };
  } finally {
    connectInFlight = false;
  }
};
browser.runtime.onInstalled.addListener(() => void connectRelay());
browser.runtime.onStartup.addListener(() => void connectRelay());
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.relayUrl || changes.relayToken) {
    void connectRelay();
  }
});
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "doraemon.retryRelay") {
    void connectRelay();
  }
});
void connectRelay();
//# sourceMappingURL=background.js.map
