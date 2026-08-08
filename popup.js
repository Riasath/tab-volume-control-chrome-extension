const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let tab = null;
let state = { gain: 1, muted: false };
let host = '';

// --------------------------------------------------------------- rendering
function paint() {
  const pct = Math.round(state.gain * 100);
  $('slider').value = pct;
  $('value').textContent = state.muted ? 0 : pct;
  $('boostWarn').hidden = state.muted || pct <= 100;
  $('muteIcon').textContent = state.muted ? '🔇' : '🔊';
  $('mute').classList.toggle('on', state.muted);
}

async function apply(patch) {
  state = await send({
    type: 'tvc:setTabState',
    tabId: tab.id,
    url: tab.url,
    host,
    ...patch,
  });
  paint();
  if ($('remember').checked && host) {
    send({ type: 'tvc:setSiteRule', host, gain: state.gain, muted: state.muted });
  }
  refreshTabs();
}

// ------------------------------------------------------------- other tabs
async function refreshTabs() {
  const tabs = await send({ type: 'tvc:listTabs' });
  const list = $('tabList');
  list.textContent = '';

  const others = tabs.filter((t) => t.id !== tab.id);
  if (!others.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No other tabs open in this window.';
    list.append(p);
    return;
  }

  for (const t of others) {
    const row = document.createElement('div');
    row.className = 'row' + (t.audible ? ' audible' : '');

    const icon = document.createElement('img');
    icon.src = t.favIconUrl || 'icons/icon16.png';
    icon.onerror = () => (icon.src = 'icons/icon16.png');

    const name = document.createElement('div');
    name.className = 'name';
    const t1 = document.createElement('div');
    t1.className = 't';
    t1.textContent = t.title || t.host || 'Tab';
    const t2 = document.createElement('div');
    t2.className = 'h';
    t2.textContent = t.host || t.url;
    name.append(t1, t2);

    const ctl = document.createElement('div');
    ctl.className = 'ctl';

    const range = document.createElement('input');
    range.type = 'range';
    range.min = 0;
    range.max = 200;
    range.step = 5;
    range.value = Math.min(200, Math.round(t.gain * 100));

    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = (t.muted ? 0 : Math.round(t.gain * 100)) + '%';

    const mute = document.createElement('button');
    mute.className = 'm' + (t.muted ? ' on' : '');
    mute.textContent = t.muted ? '🔇' : '🔊';
    mute.title = 'Mute this tab';

    range.oninput = () => {
      val.textContent = range.value + '%';
    };
    range.onchange = async () => {
      await send({
        type: 'tvc:setTabState',
        tabId: t.id,
        url: t.url,
        host: t.host,
        gain: Number(range.value) / 100,
        muted: false,
      });
      mute.className = 'm';
      mute.textContent = '🔊';
    };
    mute.onclick = async () => {
      const next = await send({
        type: 'tvc:setTabState',
        tabId: t.id,
        url: t.url,
        host: t.host,
        muted: !t.muted,
      });
      t.muted = next.muted;
      mute.className = 'm' + (t.muted ? ' on' : '');
      mute.textContent = t.muted ? '🔇' : '🔊';
      val.textContent = (t.muted ? 0 : Math.round(next.gain * 100)) + '%';
    };

    ctl.append(range, val, mute);
    row.append(icon, name, ctl);
    list.append(row);
  }
}

// ------------------------------------------------------------------- init
(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  try {
    const u = new URL(tab.url);
    host = /^https?:$/.test(u.protocol) ? u.hostname : '';
  } catch (e) {}

  $('title').textContent = tab.title || 'This tab';
  $('host').textContent = host || tab.url || '';
  $('rememberHost').textContent = host || 'this site';
  if (tab.favIconUrl) $('favicon').src = tab.favIconUrl;
  else $('favicon').src = 'icons/icon16.png';

  state = await send({ type: 'tvc:getTabState', tabId: tab.id, url: tab.url });
  paint();

  if (host) {
    const rule = await send({ type: 'tvc:getSiteRule', host });
    $('remember').checked = !!rule;
  } else {
    $('remember').disabled = true;
  }

  $('slider').oninput = () => {
    state.gain = Number($('slider').value) / 100;
    state.muted = false;
    paint();
  };
  $('slider').onchange = () =>
    apply({ gain: Number($('slider').value) / 100, muted: false });

  $('mute').onclick = () => apply({ muted: !state.muted });

  document.querySelectorAll('.presets button').forEach((b) => {
    b.onclick = () => {
      const v = Number(b.dataset.v);
      if (v === 0) apply({ muted: true });
      else apply({ gain: v / 100, muted: false });
    };
  });

  $('remember').onchange = () => {
    if (!host) return;
    send({
      type: 'tvc:setSiteRule',
      host,
      gain: state.gain,
      muted: state.muted,
      clear: !$('remember').checked,
    });
  };

  $('reset').onclick = async () => {
    await send({ type: 'tvc:resetAll' });
    state = { gain: 1, muted: false };
    $('remember').checked = false;
    paint();
    refreshTabs();
  };

  refreshTabs();
})();
