// TweetWiper popup. Talks to the content script in the active x.com tab and
// shows progress that the content script writes into chrome.storage.local.
const $ = (id) => document.getElementById(id);

let tabId = null;
let armed = false;

async function findTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(x|twitter)\.com\//.test(tab.url || '')) {
    tabId = null;
    $('conn').innerHTML = '<span class="warn">Open x.com in this tab first, signed in.</span>';
    return;
  }
  tabId = tab.id;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { cmd: 'ping' });
    if (!r || !r.ok) throw new Error('no reply');
    if (!r.signedIn) {
      $('conn').innerHTML = '<span class="warn">This tab is not signed in to X. Sign in (Google button is fine), then reopen this popup.</span>';
    } else {
      $('conn').innerHTML = '<span class="good">Connected to x.com' + (r.running ? ' (working...)' : '') + '</span>';
    }
  } catch (e) {
    tabId = null;
    $('conn').innerHTML = '<span class="warn">Reload the x.com tab once, then reopen this popup.</span>';
  }
}

async function send(cmd) {
  if (!tabId) { await findTab(); if (!tabId) return null; }
  try {
    return await chrome.tabs.sendMessage(tabId, { cmd });
  } catch (e) {
    $('conn').innerHTML = '<span class="warn">Lost the x.com tab. Reload it and reopen this popup.</span>';
    return null;
  }
}

function render(status) {
  if (!status) return;
  $('sQueued').textContent = status.queued;
  $('sRemaining').textContent = status.remaining;
  $('sDone').textContent = status.done;
  $('sFailed').textContent = status.failed;
  $('log').textContent = (status.log || []).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
  $('start').disabled = !!status.running;
  $('scan').disabled = !!status.running;
  $('stop').disabled = !status.running;
}

async function loadOpts() {
  const d = await chrome.storage.local.get(['opts', 'status']);
  const opts = { delayMs: 900, dryRun: true, includeReposts: true, auto: true, ...(d.opts || {}) };
  $('dryRun').checked = opts.dryRun;
  $('includeReposts').checked = opts.includeReposts;
  $('auto').checked = opts.auto;
  $('delay').value = opts.delayMs;
  updateArmRow();
  render(d.status);
}

async function saveOpts() {
  const d = await chrome.storage.local.get(['opts']);
  const opts = {
    ...(d.opts || {}),
    dryRun: $('dryRun').checked,
    includeReposts: $('includeReposts').checked,
    auto: $('auto').checked,
    delayMs: Math.max(300, Number($('delay').value) || 900),
  };
  await chrome.storage.local.set({ opts });
}

function updateArmRow() {
  const real = !$('dryRun').checked;
  $('armRow').style.display = real ? 'flex' : 'none';
  if (!real) { armed = false; $('arm').value = ''; }
}

// Archive files look like: window.YTD.tweets.part0 = [ { "tweet": { "id_str": "...", ... } }, ... ]
function parseArchive(text) {
  const start = text.indexOf('[');
  if (start < 0) throw new Error('not an archive file');
  const arr = JSON.parse(text.slice(start));
  const out = [];
  for (const e of arr) {
    const t = e.tweet || e.community_tweet || e.noteTweet || e;
    const id = t.id_str || t.id || (t.noteTweetId);
    if (!id) continue;
    const text = t.full_text || '';
    const isRepost = /^RT @/.test(text);
    out.push({ id: String(id), kind: 'tweet', isRepost });
  }
  return out;
}

$('archive').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  if (!files.length) return;
  const includeReposts = $('includeReposts').checked;
  const d = await chrome.storage.local.get(['queue', 'done']);
  const queue = Array.isArray(d.queue) ? d.queue : [];
  const done = new Set(Array.isArray(d.done) ? d.done : []);
  const known = new Set(queue.map((q) => q.id));
  let total = 0, added = 0, skippedReposts = 0;
  for (const f of files) {
    try {
      const items = parseArchive(await f.text());
      for (const it of items) {
        total++;
        if (it.isRepost && !includeReposts) { skippedReposts++; continue; }
        if (known.has(it.id) || done.has(it.id)) continue;
        queue.push({ id: it.id, kind: it.kind });
        known.add(it.id);
        added++;
      }
    } catch (e) {
      alert(f.name + ': could not read this file (' + e.message + '). Pick data/tweets.js from the archive.');
    }
  }
  await chrome.storage.local.set({ queue });
  const r = await send('refresh');
  const line = 'Loaded ' + files.length + ' file(s): ' + total + ' posts found, ' + added + ' new in queue' + (skippedReposts ? ', ' + skippedReposts + ' reposts skipped' : '') + '.';
  if (!r) {
    const s = (await chrome.storage.local.get('status')).status || {};
    s.queued = queue.length; s.remaining = queue.length - (s.done || 0) - (s.failed || 0);
    s.log = [...(s.log || []), line];
    await chrome.storage.local.set({ status: s });
  }
  ev.target.value = '';
});

$('scan').addEventListener('click', async () => {
  await saveOpts();
  const r = await send('scan');
  if (r && !r.ok && r.err) $('conn').innerHTML = '<span class="warn">' + r.err + '</span>';
});

$('start').addEventListener('click', async () => {
  await saveOpts();
  if (!$('dryRun').checked && !armed) {
    $('arm').focus();
    $('conn').innerHTML = '<span class="warn">Type DELETE in the box first. This cannot be undone.</span>';
    return;
  }
  const r = await send('start');
  if (r && !r.ok && r.err) $('conn').innerHTML = '<span class="warn">' + r.err + '</span>';
});

$('stop').addEventListener('click', () => send('stop'));
$('retry').addEventListener('click', () => send('retryFailed'));

$('reset').addEventListener('click', async () => {
  if (!confirm('Forget the queue and all progress? (Nothing on X is changed by this.)')) return;
  await chrome.storage.local.set({ queue: [], done: [], failed: {}, status: { queued: 0, remaining: 0, done: 0, failed: 0, log: ['Progress reset.'] } });
  await send('refresh');
});

$('dryRun').addEventListener('change', () => { updateArmRow(); saveOpts(); });
$('includeReposts').addEventListener('change', saveOpts);
$('auto').addEventListener('change', saveOpts);
$('delay').addEventListener('change', saveOpts);
$('arm').addEventListener('input', () => {
  armed = $('arm').value.trim() === 'DELETE';
  if (armed) $('conn').innerHTML = '<span class="bad">Armed. Start will really delete.</span>';
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.status) render(changes.status.newValue);
});

loadOpts().then(findTab);
