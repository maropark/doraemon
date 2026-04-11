const DEFAULT_RELAY_URL = 'http://127.0.0.1:1969';
const DEFAULT_RETRY_MS = 3000;
const HANDSHAKE_TIMEOUT_MS = 4000;
const AGENT_ID_KEY = 'agentId';
const KEEPALIVE_PORT_NAME = 'doraemon.keepalive';

let ws = null;
let retryTimer = null;
let handshakeTimer = null;
let helloRequestId = null;
let connectInFlight = false;
let currentSettings = {
  relayUrl: DEFAULT_RELAY_URL,
  relayToken: '',
  relayConnected: false,
  relayLastError: '',
  relayLastEvent: 'booting',
  keepalivePorts: 0,
};
const keepalivePorts = new Set();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getStorage = async (keys) => await browser.storage.local.get(keys);
const setStorage = async (patch) => await browser.storage.local.set(patch);

const normalizeRelayUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.origin;
  } catch {
    return '';
  }
};

const loadAgentId = async () => {
  const stored = await getStorage([AGENT_ID_KEY]);
  if (stored.agentId) return stored.agentId;
  const agentId = `doraemon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await setStorage({ agentId });
  return agentId;
};

const isControllableUrl = (url) => /^https?:\/\//.test(String(url || ''));

const resolveTargetTabId = async (explicitTabId) => {
  if (typeof explicitTabId === 'number') return explicitTabId;
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id && isControllableUrl(activeTab.url)) return activeTab.id;

  const tabs = await browser.tabs.query({});
  const controllableTabs = tabs.filter((tab) => tab.id && isControllableUrl(tab.url));
  const preferredTab = controllableTabs
    .sort((a, b) => {
      const aLast = Number(a.lastAccessed || 0);
      const bLast = Number(b.lastAccessed || 0);
      return bLast - aLast;
    })[0];
  if (preferredTab?.id) return preferredTab.id;
  throw new Error('No Firefox tab available');
};

const execInTab = async (tabId, func, args = []) => {
  const results = await browser.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return results?.[0]?.result;
};

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[role="button"]',
  '[contenteditable="true"]',
  '[tabindex]',
  'tp-yt-paper-button',
  'ytd-button-renderer button',
].join(',');

const YOUTUBE_HELPER_SELECTOR = [
  '#description button',
  '#description [role="button"]',
  '#description-inline-expander button',
  '#description-inline-expander [role="button"]',
  'ytd-watch-metadata button',
  'ytd-watch-metadata [role="button"]',
  'ytd-engagement-panel-section-list-renderer button',
  'ytd-engagement-panel-section-list-renderer [role="button"]',
].join(',');

const resolveElementScript = (selector) => {
  const isTextSelector = typeof selector === 'string' && selector.startsWith('text=');
  if (!isTextSelector) {
    return `document.querySelector(${JSON.stringify(selector)})`;
  }
  const text = selector.slice(5).trim().toLowerCase();
  return `([...document.querySelectorAll('a,button,input,textarea,[role="button"],[contenteditable="true"],*')].find((el)=>((el.innerText||el.value||el.getAttribute('aria-label')||'').trim().toLowerCase().includes(${JSON.stringify(text)}))) || null)`;
};

const buildDomHelpers = () => ({
  isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  },
  labelFor(el) {
    const pieces = [
      el.innerText,
      el.textContent,
      el.value,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
    ]
      .filter(Boolean)
      .map((value) => String(value).trim().replace(/\s+/g, ' '));
    return pieces.join(' ').trim();
  },
  selectorFor(el) {
    if (el.id) return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const aria = el.getAttribute('aria-label');
    if (aria) return `${tag}[aria-label=${JSON.stringify(aria)}]`;
    if (role) return `${tag}[role=${JSON.stringify(role)}]`;
    return tag;
  },
  scoreFor(label, query, rect, el) {
    const value = label.toLowerCase();
    let score = 0;
    if (value === query) score += 140;
    else if (value.startsWith(query)) score += 110;
    else if (value.includes(query)) score += 80;

    const words = query.split(/\s+/).filter(Boolean);
    const matched = words.filter((word) => value.includes(word)).length;
    score += matched * 12;

    const aria = String(el.getAttribute('aria-label') || '').toLowerCase();
    const title = String(el.getAttribute('title') || '').toLowerCase();
    if (aria === query || title === query) score += 50;
    if (aria.includes(query) || title.includes(query)) score += 24;

    const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
    if (inViewport) score += 40;
    else score -= Math.min(120, Math.floor(Math.abs(rect.top) / 80) * 8);

    if (rect.top >= 0) score += Math.max(0, 25 - Math.floor(rect.top / 120));
    if (el.closest('#description, #description-inline-expander')) score += 18;
    if (el.tagName === 'BUTTON') score += 10;

    return score;
  },
  clickLikeHuman(target) {
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    target.focus?.();
    const rect = target.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const pointed = document.elementFromPoint(centerX, centerY);
    const clickable = pointed && (pointed === target || target.contains(pointed) || pointed.contains(target)) ? pointed : target;
    for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      clickable.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: centerX,
        clientY: centerY,
      }));
    }
    if (typeof clickable.click === 'function') clickable.click();
    return clickable;
  },
});

const toolHandlers = {
  async navigate({ url, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    await browser.tabs.update(resolvedTabId, { url });
    return { ok: true, tabId: resolvedTabId, url };
  },
  async getContent({ type = 'text', selector, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    const MAX_CHARS = 50_000;
    return await execInTab(
      resolvedTabId,
      ({ type, selector, elementExpr, maxChars }) => {
        // Guard: unbounded body reads on YouTube crash the extension messaging channel.
        // YouTube's DOM is 500KB+ of innerText; serializing it through scripting.executeScript
        // overflows Firefox's IPC buffer and disconnects the agent.
        // Use youtube-state for structured YouTube page info instead.
        if (!selector && type === 'text' && location.hostname.includes('youtube.com')) {
          throw new Error(
            'Blocked: document.body.innerText on YouTube crashes the extension. ' +
            'Use youtube-state for structured page info instead.',
          );
        }
        const el = selector ? eval(elementExpr) : document.body;
        if (type === 'title') return document.title;
        if (type === 'url') return location.href;
        const raw = type === 'html' ? (el?.outerHTML || '') : (el?.innerText || '');
        return raw.length > maxChars ? raw.slice(0, maxChars) + '\n[… truncated — result exceeded 50 000 char limit]' : raw;
      },
      [{ type, selector, elementExpr: resolveElementScript(selector), maxChars: MAX_CHARS }],
    );
  },
  async evaluate({ script, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ script }) => {
        return (0, eval)(script);
      },
      [{ script }],
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
      [{ selector, elementExpr: resolveElementScript(selector) }],
    );
  },
  async find({ text, limit = 8, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ text, limit, interactiveSelector }) => {
        const helpers = ({
          isVisible(el) {
            if (!(el instanceof Element)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          labelFor(el) {
            const pieces = [
              el.innerText,
              el.textContent,
              el.value,
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              el.getAttribute('placeholder'),
            ]
              .filter(Boolean)
              .map((value) => String(value).trim().replace(/\s+/g, ' '));
            return pieces.join(' ').trim();
          },
          selectorFor(el) {
            if (el.id) return `#${el.id}`;
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role');
            const aria = el.getAttribute('aria-label');
            if (aria) return `${tag}[aria-label=${JSON.stringify(aria)}]`;
            if (role) return `${tag}[role=${JSON.stringify(role)}]`;
            return tag;
          },
          scoreFor(label, query, rect, el) {
            const value = label.toLowerCase();
            let score = 0;
            if (value === query) score += 140;
            else if (value.startsWith(query)) score += 110;
            else if (value.includes(query)) score += 80;
            const words = query.split(/\s+/).filter(Boolean);
            const matched = words.filter((word) => value.includes(word)).length;
            score += matched * 12;
            const aria = String(el.getAttribute('aria-label') || '').toLowerCase();
            const title = String(el.getAttribute('title') || '').toLowerCase();
            if (aria === query || title === query) score += 50;
            if (aria.includes(query) || title.includes(query)) score += 24;
            const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
            if (inViewport) score += 40;
            else score -= Math.min(120, Math.floor(Math.abs(rect.top) / 80) * 8);
            if (rect.top >= 0) score += Math.max(0, 25 - Math.floor(rect.top / 120));
            if (el.closest('#description, #description-inline-expander')) score += 18;
            if (el.tagName === 'BUTTON') score += 10;
            return score;
          },
        });
        const query = String(text || '').trim().toLowerCase();
        if (!query) throw new Error('Missing text query');

        return [...document.querySelectorAll(interactiveSelector)]
          .filter(helpers.isVisible)
          .map((el) => {
            const label = helpers.labelFor(el);
            const rect = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              text: label.slice(0, 160),
              ariaLabel: el.getAttribute('aria-label'),
              title: el.getAttribute('title'),
              selector: helpers.selectorFor(el),
              score: helpers.scoreFor(label, query, rect, el),
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            };
          })
          .filter((candidate) => candidate.score > 0)
          .sort((a, b) => b.score - a.score || a.rect.y - b.rect.y)
          .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)));
      },
      [{ text, limit, interactiveSelector: INTERACTIVE_SELECTOR }],
    );
  },
  async clickText({ text, limit = 24, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ text, limit, interactiveSelector }) => {
        const helpers = ({
          isVisible(el) {
            if (!(el instanceof Element)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          labelFor(el) {
            const pieces = [
              el.innerText,
              el.textContent,
              el.value,
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              el.getAttribute('placeholder'),
            ]
              .filter(Boolean)
              .map((value) => String(value).trim().replace(/\s+/g, ' '));
            return pieces.join(' ').trim();
          },
          scoreFor(label, query, rect, el) {
            const value = label.toLowerCase();
            let score = 0;
            if (value === query) score += 140;
            else if (value.startsWith(query)) score += 110;
            else if (value.includes(query)) score += 80;
            const words = query.split(/\s+/).filter(Boolean);
            const matched = words.filter((word) => value.includes(word)).length;
            score += matched * 12;
            const aria = String(el.getAttribute('aria-label') || '').toLowerCase();
            const title = String(el.getAttribute('title') || '').toLowerCase();
            if (aria === query || title === query) score += 50;
            if (aria.includes(query) || title.includes(query)) score += 24;
            const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
            if (inViewport) score += 40;
            else score -= Math.min(120, Math.floor(Math.abs(rect.top) / 80) * 8);
            if (rect.top >= 0) score += Math.max(0, 25 - Math.floor(rect.top / 120));
            if (el.closest('#description, #description-inline-expander')) score += 18;
            if (el.tagName === 'BUTTON') score += 10;
            return score;
          },
          clickLikeHuman(target) {
            target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            target.focus?.();
            const rect = target.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const pointed = document.elementFromPoint(centerX, centerY);
            const clickable = pointed && (pointed === target || target.contains(pointed) || pointed.contains(target)) ? pointed : target;
            for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              clickable.dispatchEvent(new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: centerX,
                clientY: centerY,
              }));
            }
            if (typeof clickable.click === 'function') clickable.click();
            return clickable;
          },
        });
        const query = String(text || '').trim().toLowerCase();
        if (!query) throw new Error('Missing text query');

        const candidates = [...document.querySelectorAll(interactiveSelector)]
          .filter(helpers.isVisible)
          .map((el) => {
            const label = helpers.labelFor(el);
            return { el, label, score: helpers.scoreFor(label, query, el.getBoundingClientRect(), el) };
          })
          .filter((candidate) => candidate.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(1, Math.min(Number(limit) || 24, 50)));

        const target = candidates[0]?.el;
        if (!target) throw new Error(`No visible interactive element matched "${text}"`);

        helpers.clickLikeHuman(target);

        return {
          ok: true,
          text: helpers.labelFor(target).slice(0, 160),
          tag: target.tagName.toLowerCase(),
        };
      },
      [{ text, limit, interactiveSelector: INTERACTIVE_SELECTOR }],
    );
  },
  async scroll({ direction = 'down', amount = 800, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ direction, amount }) => {
        const delta = Math.max(0, Number(amount) || 800);
        if (direction === 'top') {
          window.scrollTo({ top: 0, behavior: 'instant' });
        } else if (direction === 'bottom') {
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        } else if (direction === 'up') {
          window.scrollBy({ top: -delta, behavior: 'instant' });
        } else {
          window.scrollBy({ top: delta, behavior: 'instant' });
        }
        return {
          ok: true,
          direction,
          amount: delta,
          scrollY: Math.round(window.scrollY),
        };
      },
      [{ direction, amount }],
    );
  },
  async youtubeState({ tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ helperSelector }) => {
        const helpers = ({
          isVisible(el) {
            if (!(el instanceof Element)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          labelFor(el) {
            const pieces = [
              el.innerText,
              el.textContent,
              el.value,
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              el.getAttribute('placeholder'),
            ]
              .filter(Boolean)
              .map((value) => String(value).trim().replace(/\s+/g, ' '));
            return pieces.join(' ').trim();
          },
        });
        const candidates = [...document.querySelectorAll(helperSelector)]
          .filter(helpers.isVisible)
          .map((el) => ({
            text: helpers.labelFor(el).slice(0, 120),
            ariaLabel: el.getAttribute('aria-label'),
            tag: el.tagName.toLowerCase(),
            y: Math.round(el.getBoundingClientRect().y),
          }));
        const hasLabel = (needle) => candidates.some((candidate) => {
          const haystack = `${candidate.text} ${candidate.ariaLabel || ''}`.toLowerCase();
          return haystack.includes(needle);
        });
        return {
          ok: true,
          url: location.href,
          title: document.title,
          inDescription: hasLabel('show transcript') || hasLabel('ask') || hasLabel('ask questions'),
          transcriptOpen: Boolean(document.querySelector('textarea[aria-label="Search transcript"], ytd-transcript-search-panel-renderer')),
          askOpen: Boolean(
            // Detect expanded Ask/Gemini engagement panel via DOM — avoids body.innerText scan
            document.querySelector('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"][target-id*="clarify"]') ||
            document.querySelector('#engagement-panel-clarify-box') ||
            document.querySelector('ytd-clarify-box-renderer') ||
            // Fallback: text probe limited to small known container, not full body
            document.querySelector('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]')
              ?.querySelector?.('h2, [aria-label]')
              ?.textContent?.toLowerCase()?.includes('ask'),
          ),
          visibleButtons: candidates.filter((candidate) => candidate.text || candidate.ariaLabel).slice(0, 40),
        };
      },
      [{ helperSelector: YOUTUBE_HELPER_SELECTOR }],
    );
  },
  async youtubeOpen({ panel, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ panel, helperSelector, interactiveSelector }) => {
        const helpers = ({
          isVisible(el) {
            if (!(el instanceof Element)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          },
          labelFor(el) {
            const pieces = [
              el.innerText,
              el.textContent,
              el.value,
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              el.getAttribute('placeholder'),
            ]
              .filter(Boolean)
              .map((value) => String(value).trim().replace(/\s+/g, ' '));
            return pieces.join(' ').trim();
          },
          clickLikeHuman(target) {
            target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            target.focus?.();
            const rect = target.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const pointed = document.elementFromPoint(centerX, centerY);
            const clickable = pointed && (pointed === target || target.contains(pointed) || pointed.contains(target)) ? pointed : target;
            for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              clickable.dispatchEvent(new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: centerX,
                clientY: centerY,
              }));
            }
            if (typeof clickable.click === 'function') clickable.click();
          },
        });
        const targetLabels = panel === 'transcript'
          ? ['show transcript', 'transcript']
          : ['ask questions', 'ask'];
        const findIn = (selector) =>
          [...document.querySelectorAll(selector)]
            .filter(helpers.isVisible)
            .map((el) => ({ el, label: helpers.labelFor(el).toLowerCase() }))
            .filter((candidate) => targetLabels.some((label) => candidate.label.includes(label)))
            .sort((a, b) => a.el.getBoundingClientRect().y - b.el.getBoundingClientRect().y)[0];
        // Try YouTube-specific selectors first, fall back to all interactive elements.
        // YouTube's layout changes frequently; the broader selector catches relocated buttons.
        const match = findIn(helperSelector) || findIn(interactiveSelector);
        const target = match?.el;
        if (!target) throw new Error(`Could not find YouTube ${panel} control`);
        helpers.clickLikeHuman(target);
        return {
          ok: true,
          panel,
          text: helpers.labelFor(target).slice(0, 120),
        };
      },
      [{ panel, helperSelector: YOUTUBE_HELPER_SELECTOR, interactiveSelector: INTERACTIVE_SELECTOR }],
    );
  },
  async youtubeTranscript({ tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      () => {
        // Prefer structured segment extraction (timestamped lines, bounded size)
        const segmentList = document.querySelector('ytd-transcript-segment-list-renderer');
        if (segmentList) {
          const segments = [...segmentList.querySelectorAll('ytd-transcript-segment-renderer')];
          if (segments.length > 0) {
            const lines = segments.map((seg) => {
              const ts = seg.querySelector('.segment-timestamp')?.textContent?.trim() || '';
              const text = seg.querySelector('.segment-text')?.textContent?.trim() || '';
              return ts ? `[${ts}] ${text}` : text;
            }).filter(Boolean);
            return { ok: true, text: lines.join('\n'), segments: lines.length };
          }
          // Panel exists but no segments yet — may still be loading
          return { ok: false, text: '', segments: 0, hint: 'Transcript panel found but no segments — try again in 1-2 seconds.' };
        }
        // Fallback: check for an expanded engagement panel that looks like a transcript
        const expandedPanel = document.querySelector(
          'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]',
        );
        if (expandedPanel) {
          // Scoped innerText on a small panel element is safe — not body
          const text = expandedPanel.innerText || '';
          if (text.length > 200) return { ok: true, text, segments: null };
        }
        // No transcript panel found — fail explicitly. Returning document.body here would
        // return 500KB+ of page garbage and may crash the extension messaging channel.
        throw new Error(
          'Transcript panel is not open. Run youtube-state to check transcriptOpen: true, ' +
          'then use click-text "Show transcript" to open it before calling youtube-transcript.',
        );
      },
      [],
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
        if ('value' in el) {
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { ok: true };
      },
      [{ selector, text, elementExpr: resolveElementScript(selector) }],
    );
  },
  async pressKey({ key, selector, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    return await execInTab(
      resolvedTabId,
      ({ key, selector, elementExpr }) => {
        const target = selector ? eval(elementExpr) : document.activeElement || document.body;
        if (!target) throw new Error('No target element for key press');
        target.focus?.();
        const event = new KeyboardEvent('keydown', { key, bubbles: true });
        target.dispatchEvent(event);
        const up = new KeyboardEvent('keyup', { key, bubbles: true });
        target.dispatchEvent(up);
        if (key === 'Enter' && typeof target.click === 'function' && target.tagName === 'BUTTON') target.click();
        return { ok: true };
      },
      [{ key, selector, elementExpr: resolveElementScript(selector) }],
    );
  },
  async waitFor({ selector, timeoutMs = 10000, tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const found = await execInTab(
        resolvedTabId,
        ({ elementExpr }) => Boolean(eval(elementExpr)),
        [{ elementExpr: resolveElementScript(selector) }],
      );
      if (found) return { ok: true, selector };
      await delay(250);
    }
    throw new Error(`Timed out waiting for ${selector}`);
  },
  async screenshot({ tabId }) {
    const resolvedTabId = await resolveTargetTabId(tabId);
    const dataUrl = await browser.tabs.captureTab(resolvedTabId, { format: 'png' });
    return { ok: true, dataUrl };
  },
};

const scheduleRetry = (ms = DEFAULT_RETRY_MS) => {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connectRelay();
  }, ms);
};

const clearHandshake = () => {
  if (handshakeTimer) {
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }
  helloRequestId = null;
};

const clearRetry = () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
};

const applyRelayState = async ({ connected, lastError = '', relayUrl, relayToken, lastEvent, keepaliveCount }) => {
  currentSettings = {
    relayUrl: relayUrl ?? currentSettings.relayUrl,
    relayToken: relayToken ?? currentSettings.relayToken,
    relayConnected: connected,
    relayLastError: lastError,
    relayLastEvent: lastEvent ?? currentSettings.relayLastEvent,
    keepalivePorts: keepaliveCount ?? currentSettings.keepalivePorts,
  };
  await setStorage(currentSettings);
};

const autoPair = async () => {
  const saved = await getStorage(['relayUrl', 'relayToken']);
  const configuredUrl = normalizeRelayUrl(saved.relayUrl || DEFAULT_RELAY_URL) || DEFAULT_RELAY_URL;
  const configuredToken = String(saved.relayToken || '').trim();
  if (configuredToken) {
    await applyRelayState({ connected: false, relayUrl: configuredUrl, relayToken: configuredToken, lastEvent: 'paired' });
    return;
  }
  try {
    const res = await fetch(`${configuredUrl}/v1/pair`, { cache: 'no-store' });
    const payload = await res.json();
    if (payload?.token) {
      await applyRelayState({ connected: false, relayUrl: configuredUrl, relayToken: String(payload.token), lastEvent: 'paired' });
      return;
    }
  } catch {}
  await applyRelayState({ connected: false, relayUrl: configuredUrl, relayToken: '', lastEvent: 'pair-missing-token' });
};

const connectRelay = async () => {
  if (connectInFlight) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connectInFlight = true;
  clearRetry();
  try {
    await autoPair();
    if (!currentSettings.relayToken) {
      await applyRelayState({ connected: false, lastError: 'No relay token yet', lastEvent: 'waiting-for-token' });
      scheduleRetry();
      return;
    }
    const wsUrl = currentSettings.relayUrl.replace(/^http/, 'ws') + `/v1/extension?token=${encodeURIComponent(currentSettings.relayToken)}`;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      await applyRelayState({ connected: false, lastError: error instanceof Error ? error.message : 'WebSocket failed', lastEvent: 'ws-create-failed' });
      scheduleRetry();
      return;
    }
    ws.onopen = async () => {
      const agentId = await loadAgentId();
      helloRequestId = `hello-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await applyRelayState({ connected: false, lastError: 'Waiting for relay handshake...', lastEvent: 'ws-open' });
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: helloRequestId,
        method: 'agent.hello',
        params: {
          agentId,
          name: 'doraemon-firefox',
          version: __DORAEMON_VERSION__,
          browser: 'firefox',
          capabilities: { tools: true }
        }
      }));
      handshakeTimer = setTimeout(() => {
        if (ws?.readyState === WebSocket.OPEN && helloRequestId) {
          void applyRelayState({ connected: false, lastError: 'Relay handshake timed out', lastEvent: 'handshake-timeout' });
          ws.close();
        }
      }, HANDSHAKE_TIMEOUT_MS);
    };
    ws.onclose = async () => {
      clearHandshake();
      ws = null;
      await applyRelayState({ connected: false, lastError: 'Disconnected', lastEvent: 'ws-closed' });
      scheduleRetry();
    };
    ws.onerror = async () => {
      if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        await applyRelayState({ connected: false, lastError: 'WebSocket error', lastEvent: 'ws-error-closed' });
        return;
      }
      if (helloRequestId) {
        await applyRelayState({ connected: false, lastError: 'WebSocket error during handshake', lastEvent: 'ws-error-handshake' });
        return;
      }
      await applyRelayState({ connected: true, lastError: 'WebSocket warning', lastEvent: 'ws-warning' });
    };
    ws.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data || ''));
      } catch {
        return;
      }
      if (message?.id && helloRequestId && message.id === helloRequestId) {
        clearHandshake();
        clearRetry();
        await applyRelayState({ connected: true, lastError: '', lastEvent: 'connected' });
        return;
      }
      if (message?.method !== 'tool.call') return;
      const id = message.id;
      try {
        const tool = String(message.params?.tool || '');
        const args = message.params?.args || {};
        const handler = toolHandlers[tool];
        if (!handler) throw new Error(`Unknown tool: ${tool}`);
        const result = await handler(args);
        ws?.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
      } catch (error) {
        ws?.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error ?? 'error') },
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
    lastEvent: 'keepalive-port-open',
    keepaliveCount: keepalivePorts.size,
  });
  port.onDisconnect.addListener(() => {
    keepalivePorts.delete(port);
    void applyRelayState({
      connected: currentSettings.relayConnected,
      lastError: currentSettings.relayLastError,
      lastEvent: 'keepalive-port-closed',
      keepaliveCount: keepalivePorts.size,
    });
  });
});

browser.runtime.onInstalled.addListener(() => void connectRelay());
browser.runtime.onStartup.addListener(() => void connectRelay());
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.relayUrl || changes.relayToken) {
    void connectRelay();
  }
});
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === 'doraemon.retryRelay') {
    void connectRelay();
  }
});

void connectRelay();
