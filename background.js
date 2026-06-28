chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'INJECT_SCRIPT' && sender.tab && sender.tab.id) {
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id },
        files: ['injected.js'],
        world: 'MAIN'
      })
      .catch((err) => {
        console.error('[d-op background] injection failed:', err);
      });
  }
});
