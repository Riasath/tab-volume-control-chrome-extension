/*
 * bridge.js — isolated world. Passes state between the service worker and the
 * page-world engine, which is the only side that can touch the page's own
 * media elements.
 */
(() => {
  let last = null;

  function push(gain, muted) {
    last = { gain, muted };
    window.postMessage({ __tvc: 'set', gain, muted }, '*');
  }

  function requestState() {
    chrome.runtime.sendMessage({ type: 'tvc:getState' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      push(res.gain, res.muted);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'tvc:apply') {
      push(msg.gain, msg.muted);
      sendResponse(true); // answer so the sender's port doesn't error out
    }
  });

  // The engine announces itself once its listener is installed; re-send the
  // last known state in case we beat it to the punch.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.__tvc !== 'ready') return;
    if (last) push(last.gain, last.muted);
    else requestState();
  });

  requestState();
})();
