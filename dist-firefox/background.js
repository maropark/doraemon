// src/extension/background.js
var DEFAULT_RELAY_URL = "http://127.0.0.1:1969";
var DEFAULT_RETRY_MS = 3e3;
var HANDSHAKE_TIMEOUT_MS = 4e3;
var AGENT_ID_KEY = "agentId";
var KEEPALIVE_PORT_NAME = "doraemon.keepalive";
var ws = null;
var retryTimer = null;
var handshakeTimer = null;
var helloRequestId = null;
var connectInFlight = false;
var currentSettings = {
  relayUrl: DEFAULT_RELAY_URL,
  relayToken: "",
  relayConnected: false,
  relayLastError: "",
  relayLastEvent: "booting",
  keepalivePorts: 0
};
var keepalivePorts = /* @__PURE__ */ new Set();
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
var isControllableUrl = (url) => /^https?:\/\//.test(String(url || ""));
var resolveTargetTabId = async (explicitTabId) => {
  if (typeof explicitTabId === "number") return explicitTabId;
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id && isControllableUrl(activeTab.url)) return activeTab.id;
  const tabs = await browser.tabs.query({});
  const controllableTabs = tabs.filter((tab) => tab.id && isControllableUrl(tab.url));
  const preferredTab = controllableTabs.sort((a, b) => {
    const aLast = Number(a.lastAccessed || 0);
    const bLast = Number(b.lastAccessed || 0);
    return bLast - aLast;
  })[0];
  if (preferredTab?.id) return preferredTab.id;
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
var INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  'input:not([type="hidden"])',
  "textarea",
  "select",
  '[role="button"]',
  '[contenteditable="true"]',
  "[tabindex]",
  "tp-yt-paper-button",
  "ytd-button-renderer button"
].join(",");
var YOUTUBE_HELPER_SELECTOR = [
  "#description button",
  '#description [role="button"]',
  "#description-inline-expander button",
  '#description-inline-expander [role="button"]',
  "ytd-watch-metadata button",
  'ytd-watch-metadata [role="button"]',
  "ytd-engagement-panel-section-list-renderer button",
  'ytd-engagement-panel-section-list-renderer [role="button"]'
].join(",");
var resolveElementScript = (selector2) => {
  const isTextSelector = typeof selector2 === "string" && selector2.startsWith("text=");
  if (!isTextSelector) {
    return `document.querySelector(${JSON.stringify(selector2)})`;
  }
  const text2 = selector2.slice(5).trim().toLowerCase();
  return `([...document.querySelectorAll('a,button,input,textarea,[role="button"],[contenteditable="true"],*')].find((el)=>((el.innerText||el.value||el.getAttribute('aria-label')||'').trim().toLowerCase().includes(${JSON.stringify(text2)}))) || null)`;
};
var buildDomHelpers = () => ({
  isVisible(el2) {
    if (!(el2 instanceof Element)) return false;
    const style = window.getComputedStyle(el2);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el2.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  },
  labelFor(el2) {
    const pieces = [
      el2.innerText,
      el2.textContent,
      el2.value,
      el2.getAttribute("aria-label"),
      el2.getAttribute("title"),
      el2.getAttribute("placeholder")
    ].filter(Boolean).map((value) => String(value).trim().replace(/\s+/g, " "));
    return pieces.join(" ").trim();
  },
  selectorFor(el2) {
    if (el2.id) return `#${el2.id}`;
    const tag = el2.tagName.toLowerCase();
    const role = el2.getAttribute("role");
    const aria = el2.getAttribute("aria-label");
    if (aria) return `${tag}[aria-label=${JSON.stringify(aria)}]`;
    if (role) return `${tag}[role=${JSON.stringify(role)}]`;
    return tag;
  },
  scoreFor(label, query, rect, el2) {
    const value = label.toLowerCase();
    let score = 0;
    if (value === query) score += 140;
    else if (value.startsWith(query)) score += 110;
    else if (value.includes(query)) score += 80;
    const words = query.split(/\s+/).filter(Boolean);
    const matched = words.filter((word) => value.includes(word)).length;
    score += matched * 12;
    const aria = String(el2.getAttribute("aria-label") || "").toLowerCase();
    const title = String(el2.getAttribute("title") || "").toLowerCase();
    if (aria === query || title === query) score += 50;
    if (aria.includes(query) || title.includes(query)) score += 24;
    const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
    if (inViewport) score += 40;
    else score -= Math.min(120, Math.floor(Math.abs(rect.top) / 80) * 8);
    if (rect.top >= 0) score += Math.max(0, 25 - Math.floor(rect.top / 120));
    if (el2.closest("#description, #description-inline-expander")) score += 18;
    if (el2.tagName === "BUTTON") score += 10;
    return score;
  },
  clickLikeHuman(target2) {
    target2.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    target2.focus?.();
    const rect = target2.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const pointed = document.elementFromPoint(centerX, centerY);
    const clickable = pointed && (pointed === target2 || target2.contains(pointed) || pointed.contains(target2)) ? pointed : target2;
    for (const type2 of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      clickable.dispatchEvent(new MouseEvent(type2, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: centerX,
        clientY: centerY
      }));
    }
    if (typeof clickable.click === "function") clickable.click();
    return clickable;
  }
});
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
  async find({ text: text2, limit = 8, tabId: tabId2 }) {
    const resolvedTabId2 = await resolveTargetTabId(tabId2);
    return await execInTab(
      resolvedTabId2,
      ({ text: text3, limit: limit2, interactiveSelector }) => {
        const helpers = {
          isVisible(el2) {
            if (!(el2 instanceof Element)) return false;
            const style = window.getComputedStyle(el2);
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
            const rect = el2.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          labelFor(el2) {
            const pieces = [
              el2.innerText,
              el2.textContent,
              el2.value,
              el2.getAttribute("aria-label"),
              el2.getAttribute("title"),
              el2.getAttribute("placeholder")
            ].filter(Boolean).map((value) => String(value).trim().replace(/\s+/g, " "));
            return pieces.join(" ").trim();
          },
          selectorFor(el2) {
            if (el2.id) return `#${el2.id}`;
            const tag = el2.tagName.toLowerCase();
            const role = el2.getAttribute("role");
            const aria = el2.getAttribute("aria-label");
            if (aria) return `${tag}[aria-label=${JSON.stringify(aria)}]`;
            if (role) return `${tag}[role=${JSON.stringify(role)}]`;
            return tag;
          },
          scoreFor(label, query2, rect, el2) {
            const value = label.toLowerCase();
            let score = 0;
            if (value === query2) score += 140;
            else if (value.startsWith(query2)) score += 110;
            else if (value.includes(query2)) score += 80;
            const words = query2.split(/\s+/).filter(Boolean);
            const matched = words.filter((word) => value.includes(word)).length;
            score += matched * 12;
            const aria = String(el2.getAttribute("aria-label") || "").toLowerCase();
            const title = String(el2.getAttribute("title") || "").toLowerCase();
            if (aria === query2 || title === query2) score += 50;
            if (aria.includes(query2) || title.includes(query2)) score += 24;
            const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
            if (inViewport) score += 40;
            else score -= Math.min(120, Math.floor(Math.abs(rect.top) / 80) * 8);
            if (rect.top >= 0) score += Math.max(0, 25 - Math.floor(rect.top / 120));
            if (el2.closest("#description, #description-inline-expander")) score += 18;
            if (el2.tagName === "BUTTON") score += 10;
            return score;
          }
        };
        const query = String(text3 || "").trim().toLowerCase();
        if (!query) throw new Error("Missing text query");
        return [...document.querySelectorAll(interactiveSelector)].filter(helpers.isVisible).map((el2) => {
          const label = helpers.labelFor(el2);
          const rect = el2.getBoundingClientRect();
          return {
            tag: el2.tagName.toLowerCase(),
            text: label.slice(0, 160),
            ariaLabel: el2.getAttribute("aria-label"),
            title: el2.getAttribute("title"),
            selector: helpers.selectorFor(el2),
            score: helpers.scoreFor(label, query, rect, el2),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          };
        }).filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score || a.rect.y - b.rect.y).slice(0, Math.max(1, Math.min(Number(limit2) || 8, 20)));
      },
      [{ text: text2, limit, interactiveSelector: INTERACTIVE_SELECTOR }]
    );
  },
  async clickText({ text: text2, limit = 24, tabId: tabId2 }) {
    const resolvedTabId2 = await resolveTargetTabId(tabId2);
    return await execInTab(
      resolvedTabId2,
      ({ text: text3, limit: limit2, interactiveSelector }) => {
        const helpers = {
          isVisible(el2) {
            if (!(el2 instanceof Element)) return false;
            const style = window.getComputedStyle(el2);
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
            const rect = el2.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          labelFor(el2) {
            const pieces = [
              el2.innerText,
              el2.textContent,
              el2.value,
              el2.getAttribute("aria-label"),
              el2.getAttribute("title"),
              el2.getAttribute("placeholder")
            ].filter(Boolean).map((value) => String(value).trim().replace(/\s+/g, " "));
            return pieces.join(" ").trim();
          },
          scoreFor(label, query2, rect, el2) {
            const value = label.toLowerCase();
            let score = 0;
            if (value === query2) score += 140;
            else if (value.startsWith(query2)) score += 110;
            else if (value.includes(query2)) score += 80;
            const words = query2.split(/\s+/).filter(Boolean);
            const matched = words.filter((word) => value.includes(word)).length;
            score += matched * 12;
            const aria = String(el2.getAttribute("aria-label") || "").toLowerCase();
            const title = String(el2.getAttribute("title") || "").toLowerCase();
            if (aria === query2 || title === query2) score += 50;
            if (aria.includes(query2) || title.includes(query2)) score += 24;
            const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
            if (inViewport) score += 40;
            else score -= Math.min(120, Math.floor(Math.abs(rect.top) / 80) * 8);
            if (rect.top >= 0) score += Math.max(0, 25 - Math.floor(rect.top / 120));
            if (el2.closest("#description, #description-inline-expander")) score += 18;
            if (el2.tagName === "BUTTON") score += 10;
            return score;
          },
          clickLikeHuman(target3) {
            target3.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            target3.focus?.();
            const rect = target3.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const pointed = document.elementFromPoint(centerX, centerY);
            const clickable = pointed && (pointed === target3 || target3.contains(pointed) || pointed.contains(target3)) ? pointed : target3;
            for (const type2 of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
              clickable.dispatchEvent(new MouseEvent(type2, {
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: centerX,
                clientY: centerY
              }));
            }
            if (typeof clickable.click === "function") clickable.click();
            return clickable;
          }
        };
        const query = String(text3 || "").trim().toLowerCase();
        if (!query) throw new Error("Missing text query");
        const candidates = [...document.querySelectorAll(interactiveSelector)].filter(helpers.isVisible).map((el2) => {
          const label = helpers.labelFor(el2);
          return { el: el2, label, score: helpers.scoreFor(label, query, el2.getBoundingClientRect(), el2) };
        }).filter((candidate) => candidate.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(Number(limit2) || 24, 50)));
        const target2 = candidates[0]?.el;
        if (!target2) throw new Error(`No visible interactive element matched "${text3}"`);
        helpers.clickLikeHuman(target2);
        return {
          ok: true,
          text: helpers.labelFor(target2).slice(0, 160),
          tag: target2.tagName.toLowerCase()
        };
      },
      [{ text: text2, limit, interactiveSelector: INTERACTIVE_SELECTOR }]
    );
  },
  async scroll({ direction = "down", amount = 800, tabId: tabId2 }) {
    const resolvedTabId2 = await resolveTargetTabId(tabId2);
    return await execInTab(
      resolvedTabId2,
      ({ direction: direction2, amount: amount2 }) => {
        const delta = Math.max(0, Number(amount2) || 800);
        if (direction2 === "top") {
          window.scrollTo({ top: 0, behavior: "instant" });
        } else if (direction2 === "bottom") {
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
        } else if (direction2 === "up") {
          window.scrollBy({ top: -delta, behavior: "instant" });
        } else {
          window.scrollBy({ top: delta, behavior: "instant" });
        }
        return {
          ok: true,
          direction: direction2,
          amount: delta,
          scrollY: Math.round(window.scrollY)
        };
      },
      [{ direction, amount }]
    );
  },
  async youtubeState({ tabId: tabId2 }) {
    const resolvedTabId2 = await resolveTargetTabId(tabId2);
    return await execInTab(
      resolvedTabId2,
      ({ helperSelector }) => {
        const helpers = {
          isVisible(el2) {
            if (!(el2 instanceof Element)) return false;
            const style = window.getComputedStyle(el2);
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
            const rect = el2.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          labelFor(el2) {
            const pieces = [
              el2.innerText,
              el2.textContent,
              el2.value,
              el2.getAttribute("aria-label"),
              el2.getAttribute("title"),
              el2.getAttribute("placeholder")
            ].filter(Boolean).map((value) => String(value).trim().replace(/\s+/g, " "));
            return pieces.join(" ").trim();
          }
        };
        const candidates = [...document.querySelectorAll(helperSelector)].filter(helpers.isVisible).map((el2) => ({
          text: helpers.labelFor(el2).slice(0, 120),
          ariaLabel: el2.getAttribute("aria-label"),
          tag: el2.tagName.toLowerCase(),
          y: Math.round(el2.getBoundingClientRect().y)
        }));
        const hasLabel = (needle) => candidates.some((candidate) => {
          const haystack = `${candidate.text} ${candidate.ariaLabel || ""}`.toLowerCase();
          return haystack.includes(needle);
        });
        return {
          ok: true,
          url: location.href,
          title: document.title,
          inDescription: hasLabel("show transcript") || hasLabel("ask") || hasLabel("ask questions"),
          transcriptOpen: Boolean(document.querySelector('textarea[aria-label="Search transcript"], ytd-transcript-search-panel-renderer')),
          askOpen: Boolean(document.body.innerText.includes("Ask about this video") || document.body.innerText.includes("Made with Gemini")),
          visibleButtons: candidates.filter((candidate) => candidate.text || candidate.ariaLabel).slice(0, 40)
        };
      },
      [{ helperSelector: YOUTUBE_HELPER_SELECTOR }]
    );
  },
  async youtubeOpen({ panel, tabId: tabId2 }) {
    const resolvedTabId2 = await resolveTargetTabId(tabId2);
    return await execInTab(
      resolvedTabId2,
      ({ panel: panel2, helperSelector }) => {
        const helpers = {
          isVisible(el2) {
            if (!(el2 instanceof Element)) return false;
            const style = window.getComputedStyle(el2);
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
            const rect = el2.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          labelFor(el2) {
            const pieces = [
              el2.innerText,
              el2.textContent,
              el2.value,
              el2.getAttribute("aria-label"),
              el2.getAttribute("title"),
              el2.getAttribute("placeholder")
            ].filter(Boolean).map((value) => String(value).trim().replace(/\s+/g, " "));
            return pieces.join(" ").trim();
          },
          clickLikeHuman(target3) {
            target3.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            target3.focus?.();
            const rect = target3.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const pointed = document.elementFromPoint(centerX, centerY);
            const clickable = pointed && (pointed === target3 || target3.contains(pointed) || pointed.contains(target3)) ? pointed : target3;
            for (const type2 of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
              clickable.dispatchEvent(new MouseEvent(type2, {
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: centerX,
                clientY: centerY
              }));
            }
            if (typeof clickable.click === "function") clickable.click();
          }
        };
        const targetLabels = panel2 === "transcript" ? ["show transcript", "transcript"] : ["ask questions", "ask"];
        const candidates = [...document.querySelectorAll(helperSelector)].filter(helpers.isVisible).map((el2) => ({ el: el2, label: helpers.labelFor(el2).toLowerCase() })).filter((candidate) => targetLabels.some((label) => candidate.label.includes(label))).sort((a, b) => a.el.getBoundingClientRect().y - b.el.getBoundingClientRect().y);
        const target2 = candidates[0]?.el;
        if (!target2) throw new Error(`Could not find YouTube ${panel2} control`);
        helpers.clickLikeHuman(target2);
        return {
          ok: true,
          panel: panel2,
          text: helpers.labelFor(target2).slice(0, 120)
        };
      },
      [{ panel, helperSelector: YOUTUBE_HELPER_SELECTOR }]
    );
  },
  async youtubeTranscript({ tabId: tabId2 }) {
    const resolvedTabId2 = await resolveTargetTabId(tabId2);
    return await execInTab(
      resolvedTabId2,
      () => {
        const transcriptRoot = document.querySelector("ytd-transcript-segment-list-renderer") || document.querySelector('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]') || document.body;
        const transcriptText = transcriptRoot.innerText || "";
        return {
          ok: transcriptText.includes("Search transcript") || transcriptText.includes("Transcript"),
          text: transcriptText
        };
      },
      []
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
var applyRelayState = async ({ connected, lastError = "", relayUrl, relayToken, lastEvent, keepaliveCount }) => {
  currentSettings = {
    relayUrl: relayUrl ?? currentSettings.relayUrl,
    relayToken: relayToken ?? currentSettings.relayToken,
    relayConnected: connected,
    relayLastError: lastError,
    relayLastEvent: lastEvent ?? currentSettings.relayLastEvent,
    keepalivePorts: keepaliveCount ?? currentSettings.keepalivePorts
  };
  await setStorage(currentSettings);
};
var autoPair = async () => {
  const saved = await getStorage(["relayUrl", "relayToken"]);
  const configuredUrl = normalizeRelayUrl(saved.relayUrl || DEFAULT_RELAY_URL) || DEFAULT_RELAY_URL;
  const configuredToken = String(saved.relayToken || "").trim();
  if (configuredToken) {
    await applyRelayState({ connected: false, relayUrl: configuredUrl, relayToken: configuredToken, lastEvent: "paired" });
    return;
  }
  try {
    const res = await fetch(`${configuredUrl}/v1/pair`, { cache: "no-store" });
    const payload = await res.json();
    if (payload?.token) {
      await applyRelayState({ connected: false, relayUrl: configuredUrl, relayToken: String(payload.token), lastEvent: "paired" });
      return;
    }
  } catch {
  }
  await applyRelayState({ connected: false, relayUrl: configuredUrl, relayToken: "", lastEvent: "pair-missing-token" });
};
var connectRelay = async () => {
  if (connectInFlight) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connectInFlight = true;
  clearRetry();
  try {
    await autoPair();
    if (!currentSettings.relayToken) {
      await applyRelayState({ connected: false, lastError: "No relay token yet", lastEvent: "waiting-for-token" });
      scheduleRetry();
      return;
    }
    const wsUrl = currentSettings.relayUrl.replace(/^http/, "ws") + `/v1/extension?token=${encodeURIComponent(currentSettings.relayToken)}`;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      await applyRelayState({ connected: false, lastError: error instanceof Error ? error.message : "WebSocket failed", lastEvent: "ws-create-failed" });
      scheduleRetry();
      return;
    }
    ws.onopen = async () => {
      const agentId = await loadAgentId();
      helloRequestId = `hello-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await applyRelayState({ connected: false, lastError: "Waiting for relay handshake...", lastEvent: "ws-open" });
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
          void applyRelayState({ connected: false, lastError: "Relay handshake timed out", lastEvent: "handshake-timeout" });
          ws.close();
        }
      }, HANDSHAKE_TIMEOUT_MS);
    };
    ws.onclose = async () => {
      clearHandshake();
      ws = null;
      await applyRelayState({ connected: false, lastError: "Disconnected", lastEvent: "ws-closed" });
      scheduleRetry();
    };
    ws.onerror = async () => {
      if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        await applyRelayState({ connected: false, lastError: "WebSocket error", lastEvent: "ws-error-closed" });
        return;
      }
      if (helloRequestId) {
        await applyRelayState({ connected: false, lastError: "WebSocket error during handshake", lastEvent: "ws-error-handshake" });
        return;
      }
      await applyRelayState({ connected: true, lastError: "WebSocket warning", lastEvent: "ws-warning" });
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
        await applyRelayState({ connected: true, lastError: "", lastEvent: "connected" });
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
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE_PORT_NAME) return;
  keepalivePorts.add(port);
  void applyRelayState({
    connected: currentSettings.relayConnected,
    lastError: currentSettings.relayLastError,
    lastEvent: "keepalive-port-open",
    keepaliveCount: keepalivePorts.size
  });
  port.onDisconnect.addListener(() => {
    keepalivePorts.delete(port);
    void applyRelayState({
      connected: currentSettings.relayConnected,
      lastError: currentSettings.relayLastError,
      lastEvent: "keepalive-port-closed",
      keepaliveCount: keepalivePorts.size
    });
  });
});
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
