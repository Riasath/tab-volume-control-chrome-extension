/*
 * background.js — owns the per-tab volume state.
 *
 * Tab state lives in chrome.storage.session so it survives the service worker
 * being torn down but disappears when Chrome closes. Site rules live in
 * storage.local and outlive the browser session.
 */

const DEFAULT = { gain: 1, muted: false };
const MAX_GAIN = 5; // 500%
const STEPS = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 1, 1.25, 1.5, 2, 3, 4, 5];

const tabKey = (id) => `tab:${id}`;
const siteKey = (host) => `site:${host}`;

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : '';
  } catch (e) {
    return '';
  }
}

function clampGain(g) {
  const n = Number(g);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_GAIN, Math.max(0, n));
}

// ------------------------------------------------------------------- state
async function getTabState(tabId, url) {
  const key = tabKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  if (stored) return stored;

  const host = hostOf(url || '');
  if (host) {
    const rule = (await chrome.storage.local.get(siteKey(host)))[siteKey(host)];
    if (rule) return { ...rule, host };
  }
  return { ...DEFAULT, host };
}

async function setTabState(tabId, patch, url) {
  const current = await getTabState(tabId, url);
  const next = {
    gain: patch.gain === undefined ? current.gain : clampGain(patch.gain),
    muted: patch.muted === undefined ? current.muted : !!patch.muted,
    host: patch.host === undefined ? current.host : patch.host,
  };
  await chrome.storage.session.set({ [tabKey(tabId)]: next });
  await setNativeMute(tabId, next.muted);
  await pushToTab(tabId, next);
  await updateBadge(tabId, next);
  return next;
}

// Chrome's own tab mute is absolute — it silences DRM video, PDFs and pages
// where a content script can't reach. We mirror our mute onto it.
async function setNativeMute(tabId, muted) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.mutedInfo && tab.mutedInfo.muted === muted) return;
    await chrome.tabs.update(tabId, { muted });
  } catch (e) {}
}

async function pushToTab(tabId, state) {
  try {
    // No frameId -> delivered to every frame in the tab.
    await chrome.tabs.sendMessage(tabId, {
      type: 'tvc:apply',
      gain: state.gain,
      muted: state.muted,
    });
  } catch (e) {
    // Tab has no content script (chrome://, Web Store, a discarded tab, ...).
  }
}

async function updateBadge(tabId, state) {
  const s = state || (await getTabState(tabId));
  let text = '';
  let color = '#3b82f6';

  if (s.muted) {
    text = 'off';
    color = '#ef4444';
  } else if (Math.abs(s.gain - 1) > 0.001) {
    text = String(Math.round(s.gain * 100));
    color = s.gain > 1 ? '#f59e0b' : '#3b82f6';
  }

  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (e) {}
}

// -------------------------------------------------------------- navigation
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // Keep in step when the user mutes a tab from the tab strip themselves.
  if (info.mutedInfo && info.mutedInfo.reason === 'user') {
    const key = tabKey(tabId);
    const stored = (await chrome.storage.session.get(key))[key];
    const next = { ...(stored || DEFAULT), muted: info.mutedInfo.muted };
    await chrome.storage.session.set({ [key]: next });
    await pushToTab(tabId, next);
    await updateBadge(tabId, next);
    return;
  }

  if (!info.url && info.status !== 'loading' && info.status !== 'complete') return;
  const url = info.url || tab.url;
  const host = hostOf(url);
  const key = tabKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];

  // A saved rule for the site we just landed on wins over whatever the tab
  // was set to for the previous site.
  if (host && (!stored || stored.host !== host)) {
    const rule = (await chrome.storage.local.get(siteKey(host)))[siteKey(host)];
    if (rule) {
      await chrome.storage.session.set({ [key]: { ...rule, host } });
    } else if (stored) {
      await chrome.storage.session.set({ [key]: { ...stored, host } });
    }
  }

  const state = await getTabState(tabId, url);
  await updateBadge(tabId, state);
  if (info.status === 'complete') {
    await setNativeMute(tabId, state.muted);
    await pushToTab(tabId, state);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const key = tabKey(removedTabId);
  const stored = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  if (stored) await chrome.storage.session.set({ [tabKey(addedTabId)]: stored });
});

// ---------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      // From a content script starting up in some frame.
      case 'tvc:getState': {
        const tabId = sender.tab && sender.tab.id;
        if (tabId === undefined) return sendResponse(DEFAULT);
        const state = await getTabState(tabId, sender.tab.url);
        await updateBadge(tabId, state);
        return sendResponse({ gain: state.gain, muted: state.muted });
      }

      case 'tvc:getTabState': {
        return sendResponse(await getTabState(msg.tabId, msg.url));
      }

      case 'tvc:setTabState': {
        return sendResponse(await setTabState(msg.tabId, msg, msg.url));
      }

      case 'tvc:listTabs': {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const out = [];
        for (const t of tabs) {
          const s = await getTabState(t.id, t.url);
          out.push({
            id: t.id,
            title: t.title || t.url || '',
            url: t.url || '',
            host: hostOf(t.url || ''),
            favIconUrl: t.favIconUrl || '',
            audible: !!t.audible,
            active: !!t.active,
            gain: s.gain,
            muted: s.muted,
          });
        }
        return sendResponse(out);
      }

      case 'tvc:getSiteRule': {
        const key = siteKey(msg.host);
        return sendResponse((await chrome.storage.local.get(key))[key] || null);
      }

      case 'tvc:setSiteRule': {
        const key = siteKey(msg.host);
        if (msg.clear) await chrome.storage.local.remove(key);
        else await chrome.storage.local.set({ [key]: { gain: clampGain(msg.gain), muted: !!msg.muted } });
        return sendResponse(true);
      }

      case 'tvc:listSiteRules': {
        const all = await chrome.storage.local.get(null);
        const rules = Object.entries(all)
          .filter(([k]) => k.startsWith('site:'))
          .map(([k, v]) => ({ host: k.slice(5), ...v }));
        return sendResponse(rules);
      }

      case 'tvc:resetAll': {
        const tabs = await chrome.tabs.query({});
        await chrome.storage.session.clear();
        for (const t of tabs) {
          await setNativeMute(t.id, false);
          await pushToTab(t.id, DEFAULT);
          await updateBadge(t.id, DEFAULT);
        }
        return sendResponse(true);
      }

      default:
        return sendResponse(null);
    }
  })();
  return true; // keep the message channel open for the async work above
});

// -------------------------------------------------------------- shortcuts
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const s = await getTabState(tab.id, tab.url);

  if (command === 'toggle-mute') {
    await setTabState(tab.id, { muted: !s.muted }, tab.url);
    return;
  }

  const dir = command === 'volume-up' ? 1 : -1;
  let idx = STEPS.findIndex((v) => Math.abs(v - s.gain) < 0.001);
  if (idx === -1) {
    idx = STEPS.findIndex((v) => v > s.gain);
    if (idx === -1) idx = STEPS.length - 1;
    if (dir < 0) idx -= 1;
  } else {
    idx += dir;
  }
  const gain = STEPS[Math.min(STEPS.length - 1, Math.max(0, idx))];
  await setTabState(tab.id, { gain, muted: false }, tab.url);
});

// ------------------------------------------------- inject into open tabs
async function injectExistingTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!/^https?:/.test(tab.url || '')) continue;
    for (const [file, world] of [
      ['engine.js', 'MAIN'],
      ['bridge.js', 'ISOLATED'],
    ]) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: [file],
          world,
        });
      } catch (e) {}
    }
  }
}

chrome.runtime.onInstalled.addListener(injectExistingTabs);
chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.query({}, (tabs) => tabs.forEach((t) => updateBadge(t.id)));
});
