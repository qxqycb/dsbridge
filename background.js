// Bridges the local tool-loop server to the chat page. The page cannot fetch
// http://127.0.0.1 from an https origin (mixed content), so this worker does it.
//
// State is deliberately visible without DevTools: the toolbar badge shows what
// the worker is doing, and the popup shows the last few events.
const SERVER = 'http://127.0.0.1:8791';
const RECENT = 20;
const POLL_MS = 30000; // chrome.alarms clamps anything shorter to 30s anyway

let polling = false;

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// Storage is the single copy, so a recycled worker cannot lose the history.
async function note(line) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.push(`${new Date().toLocaleTimeString()} ${line}`);
  await chrome.storage.local.set({ log: log.slice(-RECENT) });
  console.log('[bridge]', line);
}

// A background tab is throttled, which stalls the streaming answer the content
// script is waiting on. Bring the chat tab forward instead of failing, since the
// user cannot be expected to keep it focused for the whole run.
async function chatTab() {
  const all = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  if (!all.length) throw new Error('no chat.deepseek.com tab open');
  const t = all.find((x) => x.active) ?? all[0];
  if (!t.active) {
    // Best effort. Chrome refuses tab edits while a tab is being dragged — "Tabs
    // cannot be edited right now (user may be dragging a tab)" — and this call used
    // to take the whole run down with it, for the sake of a convenience. A background
    // tab is throttled so the answer may stream slowly; that beats not answering.
    try {
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      await new Promise((r) => setTimeout(r, 400)); // let the tab take focus
    } catch (e) {
      note(`无法把标签切到前台（${e.message}）—— 继续，可能会慢`);
    }
  }
  return t;
}

const ROOT = 'https://chat.deepseek.com/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start a fresh conversation by navigating to the chat root. The page's own
// "new chat" control is an unlabelled icon that neither aria-label nor text
// matching can find, and the root URL is a blank chat by construction.
//
// The background owns this, not the content script: navigating unloads the
// content script, which would kill the message port mid-request. Doing it here,
// before anything is sent, avoids that entirely.
async function resetChat(tabId) {
  await chrome.tabs.update(tabId, { url: ROOT });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const t = await chrome.tabs.get(tabId).catch(() => null);
    // Any URL under the chat app counts. The site may rewrite the root to a
    // conversation URL immediately, and requiring exactly ROOT then never became
    // true — the loop ran out and reported "did not reach the root URL" even
    // though the page had loaded fine.
    if (t?.status === 'complete' && /^https:\/\/chat\.deepseek\.com\//.test(t.url ?? '')) break;
    if (i === 59) throw new Error('chat tab did not finish loading after the new-chat navigation');
  }
  // Loading is not the same as being on a blank conversation: the page can restore
  // the previous thread. Ask it whether the transcript is actually empty.
  for (let i = 0; i < 40; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { cmd: 'probe' });
      if (r?.ok && r.markers?.answers === 0) return;
    } catch {
      // Content script still booting after the navigation.
    }
    await sleep(250);
  }
  throw new Error('页面加载了，但对话没有清空 —— 新对话没开成');
}

// The content script may still be booting when the load event lands; a few
// retries are cheaper and less invasive than injecting a readiness probe.
async function sendToTab(tabId, job) {
  for (let i = 0; i < 5; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, job);
    } catch (e) {
      if (i === 4) throw e;
      await sleep(500);
    }
  }
}

async function serveJob(job) {
  note(`job ${job.cmd ? 'probe' : `"${job.text.split('\n').pop().slice(0, 40)}"`}`);
  badge('run', '#1a7f37');
  let result;
  try {
    const t = await chatTab();
    // The first job of a run says so itself. This used to hang off a storage flag
    // that was set only when polling was switched on, so the first task after arming
    // got a fresh chat and every task after that shared one conversation. The page's
    // history IS the model's context, and a run reported seeing the previous task's
    // messages and its tool round-trips still in it.
    if (job.fresh) {
      note('opening a fresh conversation');
      await resetChat(t.id);
    }
    try {
      result = await sendToTab(t.id, job);
    } catch (e) {
      // Chrome says "Receiving end does not exist" here. The real cause is
      // always the same: the tab predates the last extension reload, so the
      // content script is gone until the page is loaded again.
      result = {
        ok: false,
        error: `${e.message} — reload the chat tab (F5); an extension reload drops its content script`,
      };
    }
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  await fetch(`${SERVER}/done`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
  note(
    result.ok === false
      ? `failed: ${result.error}`
      : `replied ${String(result.reply ?? '').length} chars${result.sent ? ` (sent: ${result.sent})` : ''}`,
  );
}

async function loop() {
  if (polling) return;
  polling = true;
  try {
    // `wanted` is the user's intent, kept in storage so a recycled worker
    // resumes polling instead of silently stopping.
    if ((await chrome.storage.local.get('wanted')).wanted !== true) {
      badge('', null);
      return; // no reschedule: a stopped bridge stays stopped
    }
    // Poll in a loop rather than rescheduling one alarm per job. chrome.alarms
    // clamps to 30s, so alarm-driven polling added up to half a minute of dead
    // time before a queued task was picked up. The pending fetch holds this
    // worker open, so the loop is bounded and hands back to the alarm: a worker
    // that never exits would sit awake forever burning battery.
    let rounds = 0;
    while (rounds++ < 20 && (await chrome.storage.local.get('wanted')).wanted === true) {
      badge('...', '#888888');
      let job;
      try {
        job = await (await fetch(`${SERVER}/job`)).json();
      } catch (e) {
        // Server gone: report, then fall back to the alarm so that starting the
        // server later still gets picked up without another click.
        badge('off', '#b00020');
        note(`server not reachable at ${SERVER}`);
        chrome.alarms.create('tick', { delayInMinutes: POLL_MS / 60000 });
        return;
      }
      if (job.text || job.cmd) {
        // Started, not awaited: while the content script works, this loop keeps
        // watching /status so a stop request can be forwarded immediately. Awaited
        // here, the stop would sit unseen until the turn it is meant to cancel had
        // already finished.
        const running = serveJob(job).then(() => badge('idle', '#1a7f37'));
        await watchForStop(running);
      }
    }
    chrome.alarms.create('tick', { delayInMinutes: POLL_MS / 60000 });
  } catch (e) {
    badge('!', '#b00020');
    note(`error: ${e.message}`);
    chrome.alarms.create('tick', { delayInMinutes: POLL_MS / 60000 });
  } finally {
    polling = false;
  }
}

// Poll /status while a job runs, and forward a stop to the page the moment it is
// asked for. Resolves when the job finishes, so the outer loop stays serial.
async function watchForStop(running) {
  let done = false;
  running.then(() => {
    done = true;
  });
  while (!done) {
    await new Promise((r) => setTimeout(r, 700));
    if (done) break;
    try {
      const s = await (await fetch(`${SERVER}/status`)).json();
      if (!s.stop) continue;
      note('停止请求：通知页面停止生成');
      try {
        const t = await chatTab();
        const r = await chrome.tabs.sendMessage(t.id, { cmd: 'stop' });
        // A stop that did not land leaves the page generating. The run can still end
        // by other means, which frees the turn slot while the page is busy — the one
        // state that makes the next send fail — and dropping the reply made that
        // invisible. The content script already says why it could not stop.
        note(r?.stopped ? '页面已停止生成' : `停止没有生效: ${r?.reason ?? 'no reply'}`);
      } catch (e) {
        note(`无法通知页面停止: ${e.message}`);
      }
      await running;
      return;
    } catch {
      // Server gone; the job's own error path will report it.
    }
  }
  await running;
}

chrome.alarms.onAlarm.addListener(loop);
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('tick', { delayInMinutes: 0.1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('tick', { delayInMinutes: 0.1 }));

// The popup reads state instead of guessing it, and owns the on/off switch.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.want === 'toggle') {
    chrome.storage.local.get('wanted').then(async ({ wanted }) => {
      const next = wanted !== true;
      // The run that opens a fresh chat is decided per job by the server now, so
      // there is no `fresh` flag to keep here.
      await chrome.storage.local.set({ wanted: next });
      await note(next ? 'polling ON' : 'polling OFF');
      if (next) chrome.alarms.create('tick', { delayInMinutes: 0.1 });
      reply({ wanted: next });
    });
    return true; // async reply
  }
  if (msg?.want === 'clear') {
    chrome.storage.local.set({ log: [] }).then(() => reply({ ok: true }));
    return true;
  }
});
