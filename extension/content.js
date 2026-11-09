// TweetWiper content script. Runs inside your signed-in x.com tab and does the
// actual work: scanning your profile for post IDs and deleting them one by one
// through the same internal calls the X website itself uses.
(() => {
  if (window.__tweetWiperLoaded) return;
  window.__tweetWiperLoaded = true;

  const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const FALLBACK_QIDS = { DeleteTweet: 'VaenaVgh5q5ih7kvyVjgtg', DeleteRetweet: 'iQtK4dl5hBmXewYZuEOKVw' };

  const S = {
    queue: [],            // [{ id, kind: 'tweet' | 'repost' }]
    done: new Set(),      // ids confirmed gone
    failed: {},           // id -> reason
    opts: { delayMs: 900, dryRun: true, includeReposts: true },
    running: false,
    stop: false,
    qids: { ...FALLBACK_QIDS },
    log: [],
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function sleepStoppable(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && !S.stop) await sleep(Math.min(1000, end - Date.now()));
  }

  function log(msg) {
    const line = new Date().toLocaleTimeString() + '  ' + msg;
    S.log.push(line);
    if (S.log.length > 200) S.log.shift();
    console.log('[TweetWiper]', msg);
    publish();
  }

  let publishTimer = null;
  function publish(force) {
    if (publishTimer && !force) return;
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      publishTimer = null;
      const doneInQueue = S.queue.filter((q) => S.done.has(q.id)).length;
      const failedCount = Object.keys(S.failed).length;
      chrome.storage.local.set({
        status: {
          running: S.running,
          queued: S.queue.length,
          done: doneInQueue,
          failed: failedCount,
          remaining: S.queue.length - doneInQueue - failedCount,
          log: S.log.slice(-40),
          dryRun: S.opts.dryRun,
          updated: Date.now(),
        },
      });
    }, force ? 0 : 300);
  }

  async function loadState() {
    const d = await chrome.storage.local.get(['queue', 'done', 'failed', 'opts']);
    S.queue = Array.isArray(d.queue) ? d.queue : [];
    S.done = new Set(Array.isArray(d.done) ? d.done : []);
    S.failed = d.failed && typeof d.failed === 'object' ? d.failed : {};
    S.opts = { ...S.opts, ...(d.opts || {}) };
  }

  async function saveState() {
    await chrome.storage.local.set({
      queue: S.queue,
      done: [...S.done],
      failed: S.failed,
      opts: S.opts,
    });
    publish(true);
  }

  function ct0() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // The X site ships the query ids inside its main JS bundle. Read them from
  // there so the tool keeps working when X rotates them; fall back to the
  // long-stable known ids if that fails.
  async function discoverQueryIds() {
    try {
      const srcs = [...document.scripts].map((s) => s.src).filter((s) => /\/main\.[^/]*\.js/.test(s));
      for (const src of srcs) {
        const txt = await (await fetch(src)).text();
        for (const op of Object.keys(FALLBACK_QIDS)) {
          const m = txt.match(new RegExp('queryId:"([^"]+)",operationName:"' + op + '"'));
          if (m) S.qids[op] = m[1];
        }
      }
    } catch (e) {
      log('could not read query ids from the page bundle, using known ones (' + e.message + ')');
    }
  }

  async function gql(op, variables) {
    const token = ct0();
    if (!token) throw new Error('no ct0 cookie: are you signed in to x.com in this tab?');
    return fetch('https://x.com/i/api/graphql/' + S.qids[op] + '/' + op, {
      method: 'POST',
      credentials: 'include',
      headers: {
        authorization: BEARER,
        'content-type': 'application/json',
        'x-csrf-token': token,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
      },
      body: JSON.stringify({ variables, queryId: S.qids[op] }),
    });
  }

  async function deleteOne({ id, kind }) {
    const op = kind === 'repost' ? 'DeleteRetweet' : 'DeleteTweet';
    const vars = kind === 'repost'
      ? { source_tweet_id: id, dark_request: false }
      : { tweet_id: id, dark_request: false };

    for (let attempt = 0; attempt < 5 && !S.stop; attempt++) {
      let r;
      try {
        r = await gql(op, vars);
      } catch (e) {
        if (/ct0/.test(e.message)) return { ok: false, err: e.message, fatal: true };
        await sleepStoppable(3000);
        continue;
      }
      if (r.status === 429) {
        const reset = Number(r.headers.get('x-rate-limit-reset')) * 1000;
        let wait = reset ? reset - Date.now() : 15 * 60 * 1000;
        wait = Math.min(Math.max(wait, 30 * 1000), 16 * 60 * 1000);
        log('X asked us to slow down. Waiting ' + Math.ceil(wait / 60000) + ' min, then continuing.');
        await sleepStoppable(wait);
        continue;
      }
      if (r.status === 401 || r.status === 403) {
        return { ok: false, err: 'HTTP ' + r.status + ': signed out or session expired. Reload x.com and press Start again.', fatal: true };
      }
      if (r.status >= 500) {
        await sleepStoppable(5000);
        continue;
      }
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j.errors) && j.errors.length) {
        const msg = j.errors.map((e) => e.message || '').join('; ');
        const codes = j.errors.map((e) => e.code);
        if (/not found|no status|already|does not exist|doesn.t exist|deleted/i.test(msg) || codes.some((c) => [34, 144, 327].includes(c))) {
          return { ok: true, note: 'already gone' };
        }
        return { ok: false, err: msg || 'unknown error' };
      }
      if (r.ok) return { ok: true };
      return { ok: false, err: 'HTTP ' + r.status };
    }
    return { ok: false, err: S.stop ? 'stopped' : 'gave up after retries' };
  }

  function pendingItems() {
    return S.queue.filter((q) => !S.done.has(q.id) && !(q.id in S.failed));
  }

  async function run() {
    if (S.running) return;
    S.running = true;
    S.stop = false;
    publish(true);
    try {
      const pending = pendingItems();
      if (!pending.length) {
        log('Nothing left to do. Load archive files or scan your profile to find more.');
        return;
      }
      if (S.opts.dryRun) {
        log('DRY RUN: would delete ' + pending.length + ' item(s). Nothing is being deleted.');
        const sample = pending.slice(0, 10).map((q) => q.kind + ' ' + q.id).join(', ');
        log('First few: ' + sample + (pending.length > 10 ? ', ...' : ''));
        log('Untick "Dry run", type DELETE, and press Start to really delete them.');
        return;
      }
      const mins = Math.ceil((pending.length * S.opts.delayMs) / 60000);
      log('Deleting ' + pending.length + ' item(s), about ' + mins + ' min at the current pace. Keep this tab open.');
      await discoverQueryIds();
      let n = 0;
      for (const item of pending) {
        if (S.stop) { log('Stopped.'); break; }
        const res = await deleteOne(item);
        if (res.ok) {
          S.done.add(item.id);
          delete S.failed[item.id];
        } else {
          S.failed[item.id] = res.err;
          log('failed ' + item.kind + ' ' + item.id + ': ' + res.err);
          if (res.fatal) { log('Stopping: fix the problem above, then press Start to resume.'); break; }
        }
        n++;
        if (n % 20 === 0) {
          await saveState();
          log(S.queue.filter((q) => S.done.has(q.id)).length + ' of ' + S.queue.length + ' gone');
        } else {
          publish();
        }
        await sleepStoppable(S.opts.delayMs + Math.floor(Math.random() * 300));
      }
      await saveState();
      const gone = S.queue.filter((q) => S.done.has(q.id)).length;
      log('Done this pass. ' + gone + ' gone, ' + Object.keys(S.failed).length + ' failed, ' + pendingItems().length + ' not yet tried.');
    } finally {
      S.running = false;
      publish(true);
    }
  }

  // Scroll the profile page that is open in this tab and collect every post id
  // that belongs to this profile (plus reposts if enabled).
  async function scanProfile() {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/with_replies)?\/?$/);
    const notProfiles = ['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search', 'compose'];
    if (!m || notProfiles.includes(m[1].toLowerCase())) {
      throw new Error('Open your own profile first: x.com/YOURNAME/with_replies (the "Replies" tab).');
    }
    const handle = m[1].toLowerCase();
    const found = new Map();
    let idle = 0;
    S.running = true;
    S.stop = false;
    publish(true);
    log('Scanning @' + handle + '. Scrolling the page; leave it alone until this finishes.');
    try {
      while (idle < 6 && !S.stop) {
        const before = found.size;
        document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
          const hrefs = [...a.querySelectorAll('a[href*="/status/"]')].map((x) => x.getAttribute('href') || '');
          const link = hrefs.find((h) => /^\/[A-Za-z0-9_]{1,15}\/status\/\d+$/.test(h));
          if (!link) return;
          const parts = link.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)$/);
          const who = parts[1];
          const id = parts[2];
          const socialEl = a.querySelector('[data-testid="socialContext"]');
          const social = socialEl ? socialEl.textContent : '';
          const reposted = /\b(reposted|retweeted)\b/i.test(social);
          if (reposted) {
            if (S.opts.includeReposts) found.set(id, 'repost');
          } else if (who.toLowerCase() === handle) {
            found.set(id, 'tweet');
          }
        });
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleepStoppable(1500);
        idle = found.size === before ? idle + 1 : 0;
      }
      const known = new Set(S.queue.map((q) => q.id));
      let added = 0;
      for (const [id, kind] of found) {
        if (!known.has(id) && !S.done.has(id)) { S.queue.push({ id, kind }); added++; }
      }
      await saveState();
      window.scrollTo(0, 0);
      log('Scan found ' + found.size + ' item(s) on the page, ' + added + ' new. Queue is now ' + S.queue.length + '.');
      if (found.size === 0) log('Nothing found. If posts are visible on the page, X may have changed its layout.');
    } finally {
      S.running = false;
      publish(true);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (!S.running) await loadState();
      switch (msg.cmd) {
        case 'ping':
          return { ok: true, running: S.running, signedIn: !!ct0(), path: location.pathname };
        case 'start':
          if (S.running) return { ok: false, err: 'already running' };
          run();
          return { ok: true };
        case 'stop':
          S.stop = true;
          log('Stop requested, finishing the current item.');
          return { ok: true };
        case 'scan':
          if (S.running) return { ok: false, err: 'already running' };
          try { await scanProfile(); return { ok: true }; }
          catch (e) { log(e.message); return { ok: false, err: e.message }; }
        case 'retryFailed': {
          const n = Object.keys(S.failed).length;
          S.failed = {};
          await saveState();
          log('Cleared ' + n + ' failure(s); they will be tried again on the next Start.');
          return { ok: true };
        }
        case 'refresh':
          publish(true);
          return { ok: true };
        default:
          return { ok: false, err: 'unknown command' };
      }
    })().then(sendResponse, (e) => sendResponse({ ok: false, err: String(e) }));
    return true;
  });

  loadState().then(() => publish(true));
})();
