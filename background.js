// ---------------------------------------------------------------------------
// onInstalled — first-run onboarding
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender) => {
  // content.js → inject injected.js into MAIN world
  if (message.type === 'INJECT_SCRIPT' && sender.tab && sender.tab.id) {
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id },
        files: ['injected.js'],
        world: 'MAIN'
      })
      .catch((err) => {
        console.error('[d-op bg] injection failed:', err);
      });
    return;
  }

  // content/store/popup/options → open player in window or tab
  if (message.type === 'OPEN_PLAYER') {
    openPlayer(message.url, message.closeCurrentWindow, sender);
    return;
  }

  // content.js → close the window (for playlist cross-episode advancement)
  if (message.type === 'CLOSE_CURRENT_WINDOW' && sender.tab && sender.tab.id) {
    chrome.tabs.get(sender.tab.id)
      .then((tab) => chrome.windows.remove(tab.windowId))
      .catch(() => {});
    return;
  }
});

// ---------------------------------------------------------------------------
// OPEN_PLAYER — respects user's window/tab preference
// ---------------------------------------------------------------------------
async function openPlayer(url, closeCurrentWindow, sender) {
  const mode = await getWindowMode();

  if (mode === 'tab') {
    await chrome.tabs.create({ url, active: true });
  } else {
    // Default: popup window (matches dAnime native behavior)
    await chrome.windows.create({
      url,
      type: 'popup',
      width: 1280,
      height: 800
    });
  }

  // For playlist cross-episode advancement, close the old window
  if (closeCurrentWindow && sender && sender.tab && sender.tab.id) {
    try {
      const tab = await chrome.tabs.get(sender.tab.id);
      await chrome.windows.remove(tab.windowId);
    } catch (_) {
      // Window may already be closed
    }
  }
}

// ---------------------------------------------------------------------------
// Window mode preference (read from storage)
// ---------------------------------------------------------------------------
async function getWindowMode() {
  try {
    const result = await chrome.storage.local.get('dop_window_mode');
    return result.dop_window_mode || 'window';
  } catch (_) {
    return 'window';
  }
}
