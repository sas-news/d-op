// ---------------------------------------------------------------------------
// Player state — single source of truth for the player window/tab
// ---------------------------------------------------------------------------
let playerState = null;

// ---------------------------------------------------------------------------
// onInstalled — first-run onboarding
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

// ---------------------------------------------------------------------------
// Recover player state on service worker restart
// ---------------------------------------------------------------------------
(async function recoverPlayerState() {
  const result = await chrome.storage.local.get('dop_playback');
  const playback = result.dop_playback;
  if (playback?.windowId) {
    const wId = parseInt(playback.windowId.substring(1), 10);
    if (!isNaN(wId)) {
      try {
        const win = await chrome.windows.get(wId);
        if (win.type === 'popup') {
          const tabs = await chrome.tabs.query({ windowId: wId });
          if (tabs[0]) {
            playerState = { windowId: wId, tabId: tabs[0].id };
          }
        }
      } catch (_) {
        playerState = null;
        await chrome.storage.local.remove('dop_playback');
        await chrome.storage.local.remove('dop_pending');
      }
    }
  }
})();

// ---------------------------------------------------------------------------
// Clean up playback when a tab/window is closed by the user
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (removeInfo.isWindowClosing) return;
  if (playerState && playerState.tabId === tabId) {
    playerState = null;
    await chrome.storage.local.remove('dop_playback');
    await chrome.storage.local.remove('dop_pending');
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  if (playerState && playerState.windowId === windowId) {
    playerState = null;
    await chrome.storage.local.remove('dop_playback');
    await chrome.storage.local.remove('dop_pending');
  }
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'INJECT_SCRIPT' && sender.tab?.id) {
    chrome.scripting
      .executeScript({ target: { tabId: sender.tab.id }, files: ['injected.js'], world: 'MAIN' })
      .catch((err) => console.error('[d-op bg] injection failed:', err));
    return;
  }

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
  if (playerState) {
    try {
      await chrome.windows.get(playerState.windowId);
      await chrome.tabs.update(playerState.tabId, { url, active: true });
      return;
    } catch (_) {
      playerState = null;
      await chrome.storage.local.remove('dop_playback');
      await chrome.storage.local.remove('dop_pending');
    }
  }

  const mode = await getWindowMode();
  if (mode === 'tab') {
    const tab = await chrome.tabs.create({ url, active: true });
    playerState = { windowId: tab.windowId, tabId: tab.id };
  } else {
    const win = await chrome.windows.create({ url, type: 'popup', width: 1280, height: 800 });
    const tabs = await chrome.tabs.query({ windowId: win.id });
    if (tabs[0]) {
      playerState = { windowId: win.id, tabId: tabs[0].id };
    }
  }
}

// ---------------------------------------------------------------------------
// RELEASE_PLAYER — close player window, clear state
// ---------------------------------------------------------------------------
async function handleReleasePlayer() {
  if (playerState) {
    try {
      const tabs = await chrome.tabs.query({ windowId: playerState.windowId });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'PLAYLIST_STOP' }).catch(() => {});
      }
      const win = await chrome.windows.get(playerState.windowId);
      if (win && win.type === 'popup') {
        chrome.windows.remove(playerState.windowId).catch(() => {});
      } else {
        chrome.tabs.remove(playerState.tabId).catch(() => {});
      }
    } catch (_) {}
    playerState = null;
  }
  await chrome.storage.local.remove('dop_playback');
  await chrome.storage.local.remove('dop_pending');
}

// ---------------------------------------------------------------------------
// FORWARD_TO_PLAYER — send a command to the player tab
// ---------------------------------------------------------------------------
async function handleForwardToPlayer(command, payload) {
  if (playerState?.tabId) {
    chrome.tabs.sendMessage(playerState.tabId, { type: command, payload }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Window mode preference
// ---------------------------------------------------------------------------
async function getWindowMode() {
  try {
    const result = await chrome.storage.local.get('dop_window_mode');
    return result.dop_window_mode || 'window';
  } catch (_) {
    return 'window';
  }
}
