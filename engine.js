/*
 * engine.js — runs in the page's MAIN world.
 *
 * Why the MAIN world: sites like YouTube and Google Meet own the `volume`
 * property of their media elements and rewrite it constantly. Instead of
 * fighting them, we intercept `HTMLMediaElement.prototype.volume` so the site
 * keeps its own idea of volume while the real output is scaled by ours.
 *
 * Two paths:
 *   gain <= 1  -> plain element volume (no Web Audio, so no CORS risk)
 *   gain >  1  -> Web Audio GainNode, created lazily only when boosting
 */
(() => {
  const TAG = '__tabVolumeControl__';
  if (window[TAG]) return;
  window[TAG] = true;

  const state = { gain: 1, muted: false };

  // ---------------------------------------------------------------- helpers
  const MediaProto = HTMLMediaElement.prototype;
  const nativeVolume = Object.getOwnPropertyDescriptor(MediaProto, 'volume');
  const nativePlay = MediaProto.play;

  // The site's requested volume, kept separate from the real output volume.
  const siteVolume = new WeakMap();
  // Elements we have routed through Web Audio, plus their gain node.
  const boosted = new WeakMap();
  const known = new Set();

  let audioCtx = null;
  let realDestination = null; // captured before we patch BaseAudioContext

  if (typeof BaseAudioContext !== 'undefined') {
    realDestination = Object.getOwnPropertyDescriptor(
      BaseAudioContext.prototype,
      'destination'
    );
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function readSiteVolume(el) {
    return siteVolume.has(el) ? siteVolume.get(el) : nativeVolume.get.call(el);
  }

  // ------------------------------------------------------- element handling
  function ensureContext() {
    if (audioCtx) return audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      resumeContext();
    } catch (e) {
      audioCtx = null;
    }
    return audioCtx;
  }

  function resumeContext() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }

  // Route an element through a GainNode. Irreversible for that element, so we
  // only do it when the user actually asks for more than 100%.
  function ensureBoost(el) {
    if (boosted.has(el)) return boosted.get(el);
    const ctx = ensureContext();
    if (!ctx) return null;
    try {
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      source.connect(gain);
      gain.connect(realDestination ? realDestination.get.call(ctx) : ctx.destination);
      const entry = { source, gain };
      boosted.set(el, entry);
      return entry;
    } catch (e) {
      // Already connected elsewhere, or a cross-origin resource. Give up
      // quietly and fall back to plain element volume.
      boosted.set(el, null);
      return null;
    }
  }

  function apply(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    known.add(el);

    // Record the site's own volume before we overwrite the real one. Without
    // this, a player that reads `el.volume` and writes it straight back would
    // multiply our scaling into its own value on every pass.
    if (!siteVolume.has(el)) siteVolume.set(el, nativeVolume.get.call(el));

    const site = clamp(readSiteVolume(el), 0, 1);
    let entry = boosted.get(el) || null;

    if (state.gain > 1 && !boosted.has(el)) entry = ensureBoost(el);

    if (entry) {
      resumeContext();
      nativeVolume.set.call(el, site);
      const target = state.muted ? 0 : state.gain;
      try {
        entry.gain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.01);
      } catch (e) {
        entry.gain.gain.value = target;
      }
    } else {
      const target = state.muted ? 0 : site * clamp(state.gain, 0, 1);
      nativeVolume.set.call(el, target);
    }
  }

  function applyAll() {
    for (const el of known) {
      if (el.isConnected || el.src || el.srcObject) apply(el);
      else known.delete(el);
    }
    scan(document);
  }

  function scan(root) {
    let list;
    try {
      list = root.querySelectorAll ? root.querySelectorAll('video, audio') : [];
    } catch (e) {
      return;
    }
    for (const el of list) if (!known.has(el)) apply(el);
  }

  // ------------------------------------------------------------- patch time
  Object.defineProperty(MediaProto, 'volume', {
    configurable: true,
    enumerable: true,
    get() {
      return siteVolume.has(this) ? siteVolume.get(this) : nativeVolume.get.call(this);
    },
    set(v) {
      const n = Number(v);
      siteVolume.set(this, Number.isFinite(n) ? clamp(n, 0, 1) : 1);
      apply(this);
    },
  });

  MediaProto.play = function (...args) {
    apply(this);
    return nativePlay.apply(this, args);
  };

  // Sites that render audio purely through the Web Audio API (games, some
  // players) never touch a media element. Hand them a master GainNode instead
  // of the real destination so our multiplier still applies.
  const masterNodes = [];

  function applyMasters() {
    const v = state.muted ? 0 : state.gain;
    for (let i = masterNodes.length - 1; i >= 0; i--) {
      const node = masterNodes[i].deref();
      if (!node) masterNodes.splice(i, 1);
      else node.gain.value = v;
    }
  }

  if (realDestination && realDestination.get) {
    const masters = new WeakMap();
    Object.defineProperty(BaseAudioContext.prototype, 'destination', {
      configurable: true,
      enumerable: true,
      get() {
        const real = realDestination.get.call(this);
        if (this === audioCtx) return real; // our own graph, never scaled twice
        let master = masters.get(this);
        if (!master) {
          try {
            master = this.createGain();
            master.connect(real);
            master.maxChannelCount = real.maxChannelCount;
            masters.set(this, master);
            masterNodes.push(new WeakRef(master));
          } catch (e) {
            return real;
          }
        }
        master.gain.value = state.muted ? 0 : state.gain;
        return master;
      },
    });
  }

  // -------------------------------------------------------------- discovery
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node instanceof HTMLMediaElement) apply(node);
        else if (node && node.querySelectorAll) scan(node);
      }
    }
  }).observe(document.documentElement || document, { childList: true, subtree: true });

  document.addEventListener('loadedmetadata', (e) => apply(e.target), true);
  document.addEventListener('playing', (e) => apply(e.target), true);
  ['pointerdown', 'keydown'].forEach((t) =>
    window.addEventListener(t, resumeContext, { capture: true, passive: true })
  );

  // Cheap safety net for players that swap elements around after load.
  let sweeps = 0;
  const sweep = setInterval(() => {
    scan(document);
    if (++sweeps > 20) clearInterval(sweep);
  }, 1000);

  // ----------------------------------------------------------- bridge (page)
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__tvc !== 'set') return;
    state.gain = clamp(Number(msg.gain) || 0, 0, 10);
    state.muted = !!msg.muted;
    applyAll();
    applyMasters();
  });

  // Tell the isolated-world bridge we are ready for state.
  window.postMessage({ __tvc: 'ready' }, '*');
})();
