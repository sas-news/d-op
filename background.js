// Load the cross-browser API polyfill in service workers (both Chrome and Firefox).
if (typeof browser === 'undefined' && typeof importScripts === 'function') {
  importScripts('browser-polyfill.js');
}

// ---------------------------------------------------------------------------
// Player state — single source of truth for the player window/tab
// ---------------------------------------------------------------------------
let playerState = null;

function isDAnimeUrl(url) {
  return /^https?:\/\/(animestore\.docomo\.ne\.jp|anime\.dmkt-sp\.jp)\/animestore\/sc_d_pc\?/.test(url);
}

async function validatePlayerState() {
  if (!playerState) return false;
  try {
    const tab = await browser.tabs.get(playerState.tabId);
    if (!tab || !tab.url) return false;
    if (!isDAnimeUrl(tab.url)) {
      playerState = null;
      return false;
    }
    await browser.windows.get(playerState.windowId);
    return true;
  } catch (_) {
    playerState = null;
    return false;
  }
}

// ---------------------------------------------------------------------------
// onInstalled — first-run onboarding
// ---------------------------------------------------------------------------
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    browser.runtime.openOptionsPage();
  }
});

// ---------------------------------------------------------------------------
// Recover player state on service worker restart
// ---------------------------------------------------------------------------
(async function recoverPlayerState() {
  const result = await browser.storage.local.get('dop_playback');
  const playback = result.dop_playback;
  if (playback?.windowId && playback.windowId > 0) {
    try {
      await browser.windows.get(playback.windowId);
      const tabs = await browser.tabs.query({ windowId: playback.windowId });
      const tab = tabs.find((t) => isDAnimeUrl(t.url));
      if (tab) {
        playerState = { windowId: playback.windowId, tabId: tab.id };
      } else if (tabs[0]) {
        playerState = { windowId: playback.windowId, tabId: tabs[0].id };
      }
    } catch (_) {
      playerState = null;
      await browser.storage.local.remove('dop_playback');
      await browser.storage.local.remove('dop_pending');
    }
  }
})();

// ---------------------------------------------------------------------------
// Clean up playback when a tab/window is closed by the user
// ---------------------------------------------------------------------------
browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (playerState && playerState.tabId === tabId) {
    playerState = null;
    await browser.storage.local.remove('dop_playback');
    await browser.storage.local.remove('dop_pending');
    return;
  }
  if (removeInfo.isWindowClosing) return;
  const result = await browser.storage.local.get('dop_playback');
  const ps = result.dop_playback;
  if (ps?.windowId) {
    try {
      const tabs = await browser.tabs.query({ windowId: ps.windowId });
      if (tabs.length === 0 || !tabs.some((t) => t.id === tabId)) {
        const w = await browser.windows.get(ps.windowId);
        if (!w) throw new Error('gone');
      }
    } catch (_) {
      await browser.storage.local.remove('dop_playback');
      await browser.storage.local.remove('dop_pending');
    }
  }
});

browser.windows.onRemoved.addListener(async (windowId) => {
  if (playerState && playerState.windowId === windowId) {
    playerState = null;
  }
  const result = await browser.storage.local.get('dop_playback');
  const ps = result.dop_playback;
  if (ps?.windowId === windowId) {
    await browser.storage.local.remove('dop_playback');
    await browser.storage.local.remove('dop_pending');
  }
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'REQUEST_PLAYER') {
    handleRequestPlayer(message.url);
    return;
  }

  if (message.type === 'RELEASE_PLAYER') {
    handleReleasePlayer();
    return;
  }

  if (message.type === 'FORWARD_TO_PLAYER') {
    handleForwardToPlayer(message.command, message.payload);
    return;
  }

  if (message.type === 'OPEN_PLAYER') {
    handleRequestPlayer(message.url);
    return;
  }
});

// ---------------------------------------------------------------------------
// REQUEST_PLAYER — reuse existing player window, or create one
// ---------------------------------------------------------------------------
async function handleRequestPlayer(url) {
  if (!playerState) {
    const result = await browser.storage.local.get('dop_playback');
    const pb = result.dop_playback;
    if (pb?.windowId && pb.windowId > 0) {
      try {
        await browser.windows.get(pb.windowId);
        const tabs = await browser.tabs.query({ windowId: pb.windowId });
        const tab = tabs.find((t) => isDAnimeUrl(t.url));
        if (tab) {
          playerState = { windowId: pb.windowId, tabId: tab.id };
        }
      } catch (_) {}
    }
  }

  if (playerState && await validatePlayerState()) {
    try {
      await browser.tabs.update(playerState.tabId, { url, active: true });
      return;
    } catch (_) {
      playerState = null;
      await browser.storage.local.remove('dop_playback');
      await browser.storage.local.remove('dop_pending');
    }
  }

  const mode = await getWindowMode();
  if (mode === 'tab') {
    const tab = await browser.tabs.create({ url, active: true });
    playerState = { windowId: tab.windowId, tabId: tab.id };
  } else {
    const win = await browser.windows.create({ url, type: 'popup', width: 1280, height: 800 });
    const tabs = await browser.tabs.query({ windowId: win.id });
    playerState = { windowId: win.id, tabId: tabs[0].id };
  }
}

// ---------------------------------------------------------------------------
// RELEASE_PLAYER — close player window, clear state
// ---------------------------------------------------------------------------
async function handleReleasePlayer() {
  if (playerState) {
    try {
      const tab = await browser.tabs.get(playerState.tabId).catch(() => null);
      if (tab && tab.url && isDAnimeUrl(tab.url)) {
        browser.tabs.sendMessage(playerState.tabId, { type: 'PLAYLIST_STOP' }).catch(() => {});
        const win = await browser.windows.get(playerState.windowId);
        if (win && win.type === 'popup') {
          browser.windows.remove(playerState.windowId).catch(() => {});
        } else {
          browser.tabs.remove(playerState.tabId).catch(() => {});
        }
      }
    } catch (_) {}
    playerState = null;
  }
  await browser.storage.local.remove('dop_playback');
  await browser.storage.local.remove('dop_pending');
}

// ---------------------------------------------------------------------------
// FORWARD_TO_PLAYER — send a command to the player tab
// ---------------------------------------------------------------------------
async function handleForwardToPlayer(command, payload) {
  if (playerState?.tabId) {
    browser.tabs.sendMessage(playerState.tabId, { type: command, payload }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Window mode preference
// ---------------------------------------------------------------------------
async function getWindowMode() {
  try {
    const result = await browser.storage.local.get('dop_window_mode');
    return result.dop_window_mode || 'window';
  } catch (_) {
    return 'window';
  }
}
