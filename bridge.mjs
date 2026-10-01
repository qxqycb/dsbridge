// Tool loop for a browser-extension bridge. Your own Edge stays untouched:
// the extension talks to this server, this server never touches the browser.
//
//   node bridge.mjs --selftest        logic check, no browser needed
//   node bridge.mjs --probe           check the extension + its DOM selectors
//   node bridge.mjs "task..."         run the agent loop
//
// Setup: edge://extensions -> load unpacked -> D:\xmkf\web-bridge\ext.
// Keep a chat.deepseek.com tab open and active, then click the toolbar icon.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { closeSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.BRIDGE_PORT ?? 8791);
// Two different places, and mixing them is what makes "point it at my project" awkward. HERE is
// where the bridge keeps its own things — sessions, spills, skills, this file's siblings — and it
// never moves. ROOT is the folder the tools may touch: the workspace, chosen by the person, and it
// defaults to the bridge's own directory so nothing changes for anyone who does not choose one.
const HERE = process.cwd();
const WORKSPACE_FILE = path.join(HERE, 'workspace.txt');
// A saved choice first: retyping a path on every launch is not a feature. The environment variable
// stays an override, so a script can point one process somewhere without rewriting the file.
function savedWorkspace() {
  try {
    const saved = readFileSync(WORKSPACE_FILE, 'utf8').trim();
    if (saved) return path.resolve(saved);
  } catch {
    // No saved choice: the fallbacks below decide.
  }
  return path.resolve(process.env.BRIDGE_WORKSPACE ?? HERE);
}
let ROOT = savedWorkspace();
// Deep Think can think for a long while. Overridable so the timeout path can be
// exercised in a test instead of only in production.
const TURN_TIMEOUT = Number(process.env.BRIDGE_TURN_TIMEOUT ?? 600000);
// Turns allowed in one run. Overridable so a run that hits the cap can be tested in
// seconds instead of by making twenty-four model calls.
const MAX_STEPS = Number(process.env.BRIDGE_MAX_STEPS ?? 24);
// Unparseable tool replies allowed in one run. The repair round used to be unbounded,
// so a reply the model could not fix burned the whole step budget and the run ended on
// the step cap — which reads as "it ran out of room" rather than "it never produced
// valid JSON". Counted per run and never reset: a run that produces four bad replies
// is not one bad step.
const MAX_REPAIRS = Number(process.env.BRIDGE_MAX_REPAIRS ?? 3);

// Exported so a check can assert a turn carries the system prompt by comparing against
// this value, instead of matching a phrase copied out of it — the copy goes stale the
// first time the prompt is reworded, and then the check fails for the wrong reason.
export const SYS = [
  'You are an assistant with file tools, working in one conversation.',
  'Talk normally and use tools as needed. A sentence and its tool call may share one reply.',
  'Explain what you are doing in the user\'s language, then call a tool, or just answer.',
  'To call a tool, put the JSON object on its own and nothing else needs to surround it:',
  '  {"tool":"ls","arg":"dir"}                  list one directory',
  '  {"tool":"glob","arg":"**/*.mjs"}           find paths by pattern',
  '  {"tool":"grep","arg":"regex"}              search file contents; hits as path:line:text',
  '  {"tool":"grep","arg":"regex","context":2,"glob":"src/**/*.ts"}   match plus 2 lines each side,',
  '      only in files matching glob; "i":false for case-sensitive; "max" raises the hit cap',
  '  {"tool":"read","arg":"path"}               read a file (truncated reads say how to continue)',
  '  {"tool":"read","arg":"path","offset":600,"limit":80}   read lines 600-679, numbered',
  '  {"tool":"fs","verb":"mkdir","arg":"dir"}   make a folder ("args":[..] for several); write',
  '      already makes the folders a new file needs',
  '  {"tool":"fs","verb":"move","arg":"a","to":"b"}      rename or move; read it first',
  '  {"tool":"fs","verb":"delete","arg":"a"}    delete; it goes to a trash folder, not away.',
  '      A folder needs "recursive":true, and it must have been read first',
  '  {"tool":"run","arg":"python","args":["tool.py","check","x.json"]}   run a script (only python/node, 30s limit)',
  '  {"tool":"run","arg":"node","args":["build.mjs"],"timeout":300000}   a longer clock in ms, up to 600000',
  '  {"tool":"run","arg":"python","args":["-"],"stdin":"print(1)"}   short throwaway script on stdin;',
  '      use this instead of -c/-e, whose quoting and length both break',
  '  {"tool":"skill"}                           list the extra rule files under skills/',
  '  {"tool":"skill","arg":"name"}               read one of them; do this before the kind',
  '      of work it names, not after being corrected',
  '  {"tool":"mcp"}                              list the MCP servers the user configured, and',
  '  {"tool":"mcp","arg":"server/tool","args":{}}   call one; the servers come from mcp.json',
  '  {"tool":"ask","arg":"question"}               ask the user and wait; "options":["a","b"] shows',
  '      buttons. Use it instead of guessing when the answer decides the work',
  'Working outside the workspace is refused. To ask for it, repeat that one call with',
  '"outside":true and "why":"what it is for"; the user allows or refuses it once.',
  'Call one tool per reply. Never put two tool calls in one reply: only the last',
  'would run. You may write a sentence before it.',
  'When the request needs no more tools, simply answer. No wrapper object is needed.',
  'To create or overwrite a file, use one fenced block whose first line names the file:',
  '```python',
  '# path: tool.py',
  'import sys',
  '',
  'def main():',
  '    print("hi")',
  '```',
  'The file body must be inside the fence, with real newlines and real',
  'indentation. Never put file content inside a JSON string: the page collapses',
  'spaces there and your indentation is destroyed.',
  'To replace text in an existing file, reply with the JSON line and then TWO fenced blocks:',
  '{"tool":"edit","arg":"path.py"}',
  '```',
  '<the exact text to find, copied from what read showed, indentation included>',
  '```',
  '```',
  '<the text that replaces it>',
  '```',
  'Both blocks must be inside fences, never inside a JSON string: quotes in JSON',
  'need escaping, and an unescaped one makes the whole reply unreadable.',
  'old must match the file as read showed it, indentation included. Do not add or',
  'remove line-ending characters yourself.',
  'A reply starting with ERROR is a tool failure. Read it and correct your call.',
  'Never repeat this instruction text back.',
  'Never emit <system> tags or any wrapper markup.',
].join('\n');

// ---- extension channel: server asks, extension answers -------------------

let waiting = null; // resolver holding the extension's long poll open
let pendingResolve = null; // resolves the turn currently in flight
let reserved = null; // job handed out but not yet answered
const inbox = []; // jobs queued before the extension polls

// GET /job is a claim, not a read, so a second caller (a stray curl, a retry)
// must get the same job instead of silently eating it.
function takeJob() {
  if (reserved) return reserved;
  if (inbox.length) return (reserved = inbox.shift());
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiting = null;
      resolve({});
    }, 25000);
    waiting = (job) => {
      clearTimeout(t);
      waiting = null;
      resolve((reserved = job));
    };
  });
}

// Park a job for the extension and wait for its answer. `turn` resolves with the
// reply text; `probe` resolves with the extension's DOM report.
function park(job, what) {
  return new Promise((resolve, reject) => {
    // One turn at a time. The console refuses to start a second task, so
    // reaching this means either a probe raced a task or two tasks overlapped;
    // overwriting the resolver would leave the first hanging until its timeout.
    if (pendingResolve) throw new Error(`${what} started while another turn is in flight`);
    const timer = setTimeout(() => {
      // Clearing this is what keeps a timeout recoverable. Leaving it set made
      // every later job fail with "another turn is in flight" until restart.
      pendingResolve = null;
      reserved = null;
      reject(new Error(`${what} timed out after ${TURN_TIMEOUT}ms — the extension stopped answering`));
    }, TURN_TIMEOUT);
    pendingResolve = {
      resolve: (v) => {
        clearTimeout(timer);
        pendingResolve = null;
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        pendingResolve = null;
        reject(e);
      },
    };
    if (waiting) waiting(job);
    else inbox.push(job);
  });
}

// A verb for finishing, under any name. Exported so the self-check can pin it:
// the list is a guess, and its only job is to decide whether to spend a corrective
// round instead of accepting the reply as the answer.
export const isFinishName = (name) => /^(done|finish|finished|final|answer|complete|stop|end)$/i.test(String(name));

/** Send one prompt and resolve with the model's answer text. `fresh` marks the turn
 * that opens a run, which is the one the extension must start a new conversation
 * for. It rides on the job because the server is what knows a run has begun: the
 * extension's own storage flag was set only when polling was switched on, so every
 * task after the first silently shared one conversation and inherited the previous
 * task's messages and tool output as context. */
export const turn = (text, fresh = false) => {
  // Record what leaves the server, not only what comes back. Only the reply was
  // logged, so a turn the page never answered left nothing to compare against —
  // and a prompt that was empty or cut short produces exactly that silence. The
  // failure that gets reported is now readable next to what was actually asked.
  const s = String(text ?? '');
  record(`[req] ${s.length}c ${promptDigest(s)}${fresh ? ' fresh' : ''} ${JSON.stringify(s.slice(-200))}`, 'request');
  return park(fresh ? { text, fresh: true } : { text }, 'turn');
};

/** Short digest of one outbound prompt, so the same request can be recognised
 * across two turns and across two runs. A length plus a tail cannot: every step
 * after the first sends a `RESULT:` wrapper of similar size around a different
 * payload. */
export const promptDigest = (text) =>
  createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12);

/** Ask the extension to report the DOM nodes it found, to tune its selectors. */
export const probe = () => park({ cmd: 'probe' }, 'probe');

/** Stop the in-flight generation. Deliberately out of band: the run being
 * stopped owns the single turn slot, so a queued job would sit behind it and
 * never be seen. /status carries the flag and the extension pushes it to the
 * page instead. */
function stopGeneration() {
  return Promise.resolve('signalled via /status');
}

// The content script's scraping version. A page still running an older copy
// behaves differently with no other symptom, which cost several debugging
// rounds; the probe reports its own and /status compares them.
export const CONTENT_VERSION = 14;

// The web console is the primary interface: start the server once, leave it
// running, and drive everything from a browser tab. No terminal per task.
const UI = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>deepseek web bridge</title><style>
body{max-width:760px;margin:24px auto;padding:0 16px;font:14px/1.6 ui-monospace,Consolas,monospace}
h1{font-size:16px;margin:0 0 4px}
#state{color:#666;margin-bottom:12px}
textarea{width:100%;height:70px;font:inherit;padding:8px;box-sizing:border-box}
.row{display:flex;gap:8px;align-items:center;margin:8px 0}
button{font:inherit;padding:6px 18px;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
#log{white-space:pre-wrap;border-top:1px solid #ddd;margin-top:16px;padding-top:12px;color:#333}
#log .step{color:#777}
#log .err{color:#b00020}
#log .final{color:#000;font-weight:600}
</style></head><body>
<h1>deepseek web bridge</h1>
<div id="state">连接中…</div>
<textarea id="task" placeholder="给 agent 一个任务，比如：找出所有 mjs 文件并总结"></textarea>
<div class="row"><button id="run">运行</button><button id="ask">提问</button><button id="probe">检查页面</button><button id="reset">重置</button><span id="hint"></span></div>
<div id="log"></div>
<script>
const $ = (id) => document.getElementById(id);
$('task').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('run').click();
});
$('run').addEventListener('click', async () => {
  const text = $('task').value.trim();
  if (!text) return;
  $('run').disabled = true;
  const r = await (await fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).json();
  $('hint').textContent = r.ok ? '' : r.error;
  setTimeout(() => { $('run').disabled = false; }, 1500);
});
// The same DOM report the CLI prints, so selector rot can be diagnosed without
// a terminal. Result lands in the console log like any other run.
$('probe').addEventListener('click', async () => {
  $('probe').disabled = true;
  await (await fetch('/probe', { method: 'POST' })).json();
  setTimeout(() => { $('probe').disabled = false; }, 1500);
});
// Same textarea, no protocol: asks the model directly and returns the raw answer.
$('ask').addEventListener('click', async () => {
  const text = $('task').value.trim();
  if (!text) return;
  $('ask').disabled = true;
  await (await fetch('/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).json();
  setTimeout(() => { $('ask').disabled = false; }, 1500);
});
// Clears a stuck run and any half-consumed job, without restarting the server.
$('reset').addEventListener('click', async () => {
  await (await fetch('/reset', { method: 'POST' })).json();
});
// Which long entries the user has expanded, by index. Rebuilding the log every
// tick snapped them shut after half a second, which made them impossible to read
// or select; the state is restored on each repaint.
const opened = new Set();
let logKey = null;

// Poll the server's own state; no need to keep the POST request open.
async function tick() {
  try {
    const s = await (await fetch('/status')).json();
    $('state').textContent = s.running
      ? '运行中…'
      : s.staleExtension
        ? '插件是旧版：重载插件并刷新页面'
        : s.extensionReady
          ? '就绪'
          : '等待浏览器插件（点一下插件图标）';
    $('state').style.color = s.running ? '#888' : s.staleExtension ? '#b00020' : s.extensionReady ? '#1a7f37' : '#b00020';

    // Only repaint when the log actually changed: a rebuild on every tick would
    // drop text selection as well as the expanded state.
    const key = s.log.map((l) => l.kind + l.text).join('\u0000');
    if (key === logKey) return;
    logKey = key;

    $('log').innerHTML = '';
    s.log.forEach((l, i) => {
      if (l.text.length > 300) {
        // Long entries (a DOM dump, a scraped reply) are collapsed rather than
        // cut: the tail is usually the part being diagnosed, and truncating it
        // hid exactly the evidence the console exists to show.
        const d = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = l.text.slice(0, 120) + '… (' + l.text.length + ' 字符，点击展开)';
        d.append(sum, Object.assign(document.createElement('pre'), { className: l.kind, textContent: l.text }));
        d.open = opened.has(i);
        d.addEventListener('toggle', () => (d.open ? opened.add(i) : opened.delete(i)));
        $('log').append(d);
      } else {
        $('log').append(Object.assign(document.createElement('div'), { className: l.kind, textContent: l.text }));
      }
    });
    if (!s.log.length) $('log').textContent = '(还没有运行记录)';
  } catch { $('state').textContent = '本地服务已断开'; }
}
setInterval(tick, 800); tick();
</script></body></html>`;

// The console's own state. Kept on the server rather than in the browser so
// closing the tab cannot lose a run that is still going.
const consoleState = { running: false, stop: false, mode: 'workspace' };
// The tools that change something. `read-only` blocks exactly these, by name, in one place —
// a per-tool check would eventually miss one.
const WRITERS = new Set(['write', 'edit', 'run', 'fs']);
// No `full` mode on purpose: a standing "yes to everything" is one click away from a mistake
// nobody sees, and the approval card already covers the real need one call at a time.
const MODES = ['read-only', 'workspace'];
// Set only while one human-approved call runs, and cleared right after it. A flag rather than
// a parameter because every path check funnels through `safe()`, which has no access to the
// call it belongs to; threading an `outside` argument through nine tools is how one of them
// ends up forgotten.
let approvedCall = false;
const LOG = [];
let lastPoll = 0;
// Set by the last probe that reported a version; -1 means no probe has run.
let extensionVersion = -1;
const staleExtension = () => extensionVersion >= 0 && extensionVersion !== CONTENT_VERSION;

// Sessions live on disk so a run can be read back after a restart. One JSONL per
// run, appended as it goes: a crash mid-run still leaves everything up to the
// crash, which a single rewritten JSON file would not.
const SESSIONS = path.join(HERE, '.sessions');
let currentSession = null;
// Subscribers to the live event stream, filled by the SSE endpoint.
const streamClients = new Set();

// Session writes go through one chain, and the chain is the flush point. Two reasons:
// `appendFile` calls that race can land out of order, and the log's order IS the replay's
// order; and the loop can wait for the chain before a model request or a tool that changes
// files, so a crash cannot leave the log missing a call that already ran. Fire-and-forget
// writes gave neither, and neither failure is visible — the transcript just quietly differs
// from what happened.
let writes = Promise.resolve();
const flushLog = () => writes;

// One log per conversation, not per message. A new segment opens only when the user
// asks for a new chat (`fresh`) or when there is none yet (the first task after a
// restart); every other task appends to the current segment, so a run of follow-ups is
// one history entry instead of one per send. Each task still writes its own `task` line,
// so where each began is on disk; the segment's title is its first task (listSessions
// reads line one), and later tasks deliberately do not rewrite it.
async function openSession(task, fresh = false) {
  await mkdir(SESSIONS, { recursive: true });
  const startedAt = new Date().toISOString();
  if (!fresh && currentSession) {
    await appendFile(currentSession.file, `${JSON.stringify({ type: 'task', task, at: startedAt })}\n`, 'utf8');
    return currentSession;
  }
  const id = startedAt.replace(/[:.]/g, '-');
  currentSession = { id, task, startedAt, file: path.join(SESSIONS, `${id}.jsonl`) };
  await appendFile(currentSession.file, `${JSON.stringify({ type: 'task', task, at: startedAt })}\n`, 'utf8');
  return currentSession;
}

// Every event goes to any attached stream and, while a run's session is open, to its file —
// so the console and the saved history agree for everything the run produces. Events
// emitted outside a run (the console's pre-run task line, /ask, a probe) are stream-only by
// construction: there is no session to write them to. `check-events.mjs` compares the two
// from `start` onward.
const emit = (event) => {
  for (const send of streamClients) {
    try {
      send(event);
    } catch {
      // A dead stream is dropped by its own close handler.
    }
  }
  // The file is captured now: a later run switches `currentSession`, and its events must
  // not be appended to this run's log.
  const file = currentSession?.file;
  if (file) {
    writes = writes
      .then(() => appendFile(file, `${JSON.stringify(event)}\n`, 'utf8'))
      .catch(() => {
        // A failed history write must not break the run; the live log still has it.
      });
  }
};

const record = (text, kind = 'step') => {
  // Only the number of entries is bounded. Cutting each entry to a fixed length
  // hid the tail of DOM dumps and scraped replies, which is where the evidence
  // is; the console collapses long entries instead.
  LOG.push({ text, kind });
  if (LOG.length > 200) LOG.shift();
  emit({ type: 'log', text, kind, at: new Date().toISOString() });
};
// A queued task with nobody polling would look identical to a hang, so the
// console says whether a browser has attached recently.
const polledRecently = () => Date.now() - lastPoll < 60000;

// ---- asking the human, mid-run ------------------------------------------------------
//
// The model asks; the console shows a card; the POST that answers it resolves this promise and
// the answer becomes the tool result. No protocol change is needed for that: the turn slot is
// free while the loop is inside a tool, so nothing else is blocked.
//
// The same channel carries a one-shot approval, which is the only reason it exists as a
// separate thing: a question wants text, an approval wants a yes or no.
const ASK_TIMEOUT = Number(process.env.BRIDGE_ASK_TIMEOUT ?? 600000);
const pendingAsks = new Map();
let askSeq = 0;

/**
 * Put a question in front of the human and wait.
 *
 * @param {{kind: 'question'|'approval', question: string, options?: string[], why?: string, detail?: string}} payload - what the console renders.
 * @returns {Promise<{text: string, allow: boolean}|null>} the answer, or null when nobody answered in time.
 */
function askHuman(payload) {
  const id = `ask-${++askSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAsks.delete(id);
      resolve(null);
    }, ASK_TIMEOUT);
    pendingAsks.set(id, {
      resolve: (answer) => {
        clearTimeout(timer);
        pendingAsks.delete(id);
        resolve(answer);
      },
      kind: payload.kind,
      question: payload.question,
    });
    emit({ type: 'ask', id, at: new Date().toISOString(), ...payload });
  });
}

/** Release everyone waiting on the human: a stop or a reset must not leave a question open. */
function dropAsks(reason) {
  for (const pending of [...pendingAsks.values()]) pending.resolve({ text: reason, allow: false, dropped: true });
  pendingAsks.clear();
}

/**
 * The one refusal a human can lift: ask about it, and if they allow, run the very same call
 * once with the fence open.
 *
 * @param {(call: object) => Promise<unknown>} run - the tool to retry.
 * @param {number} step - loop step, for the log line.
 * @param {object} msg - the model's call, carrying `outside` and `why`.
 * @param {string} refusal - the fence's own message, shown to the human as the detail.
 * @returns {Promise<unknown>} the tool result, or why it did not run.
 */
async function askToLeave(run, step, msg, refusal) {
  const answer = await askHuman({
    kind: 'approval',
    question: `模型要访问工作区外：${String(msg.arg ?? '(没有说路径)')}`,
    why: String(msg.why ?? '（没有说明理由）'),
    detail: refusal,
  });
  if (answer === null) return 'ERROR: 用户没有回应，这次调用没有执行。';
  if (answer.dropped) return `ERROR: 批准请求被中止：${answer.text}`;
  if (!answer.allow) return `ERROR: 用户拒绝了这一次工作区外访问。${answer.text ? `他的话：${answer.text}` : ''}`;
  record(`批准了工作区外的一次调用：${msg.tool} ${msg.arg ?? ''}`);
  approvedCall = true;
  try {
    return await run(msg);
  } catch (e) {
    return `ERROR: ${e.message}`;
  } finally {
    // One-shot: the next call meets the fence again, approved or not.
    approvedCall = false;
  }
}

async function listSessions() {
  try {
    // Sorted by name descending, which is newest-first because an id starts with its timestamp.
    // `readdir` order is not a promise on any platform, and both the console and the checks read
    // the first entry as "the newest" — an arbitrary order put the wrong session on top.
    const files = (await readdir(SESSIONS)).sort().reverse();
    const out = [];
    for (const f of files.filter((n) => n.endsWith('.jsonl'))) {
      let task = '';
      let steps = 0;
      try {
        const lines = (await readFile(path.join(SESSIONS, f), 'utf8')).trim().split('\n');
        steps = lines.length;
        task = JSON.parse(lines[0]).task ?? '';
      } catch {
        // A half-written file still lists; its task text is simply unknown.
      }
      out.push({ id: f.replace(/\.jsonl$/, ''), task, steps });
    }
    // Already newest-first from the sort above.
    return out;
  } catch {
    return [];
  }
}

async function readSession(id) {
  // The id arrives over HTTP, so it must not be able to name a file elsewhere.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('bad session id');
  const text = await readFile(path.join(SESSIONS, `${id}.jsonl`), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function runTask(text, fresh = false) {
  // Fresh run, fresh flags. A stop that was requested but never consumed (the
  // page was wedged, so the turn never came back) would otherwise abort this run
  // on its first loop.
  consoleState.stop = false;
  await openSession(text, fresh);
  emit({ type: 'start', task: text, at: new Date().toISOString() });
  try {
    const answer = await agent(text, record, fresh);
    // The final reply was already emitted as an assistant turn. The step cap is
    // the exception: it returns a note instead of the model's words, and dropping
    // it made a run that ran out of turns look exactly like a finished one — the
    // user got no answer and no reason why.
    if (!answer) record('（没有输出）', 'err');
    else if (answer.startsWith('(step cap')) emit({ type: 'assistant', text: `⚠ ${answer}`, at: new Date().toISOString() });
    emit({ type: 'end', ok: true, at: new Date().toISOString() });
  } catch (e) {
    record(`失败: ${e.message}`, 'err');
    emit({ type: 'end', ok: false, error: e.message, at: new Date().toISOString() });
  } finally {
    consoleState.running = false;
    consoleState.stop = false;
    // The stream carries no clock of its own, so it says when the run is over.
    emit({ type: 'idle', at: new Date().toISOString() });
  }
}

const server = createServer(async (req, res) => {
  const json = (code, body) => {
    // charset is load-bearing: the console shows the task and answer, and
    // without it the browser decodes the UTF-8 bytes as latin-1 (mojibake).
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  try {
    // The client lives in ui.html so it can be read and edited like any other
    // file; the inline copy below stays reachable at /legacy until the new one has
    // been used in anger.
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html' || req.url === '/ui')) {
      try {
        const page = await readFile(path.join(HERE, 'ui.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(`cannot read ui.html: ${e.message}`);
      }
    }

    // Served as a module the page imports. Without this route the browser gets a 404 and
    // the whole client script fails to load, so a missing file is a blank page rather than
    // a missing feature.
    if (req.method === 'GET' && req.url === '/md.js') {
      try {
        const mod = await readFile(path.join(HERE, 'md.js'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(mod);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(`cannot read md.js: ${e.message}`);
      }
    }

    if (req.method === 'GET' && req.url === '/legacy') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(UI);
    }

    // Reports everything the console needs, including whether a browser is
    // attached. A task in the queue with nobody polling would otherwise look
    // like a hang.
    if (req.method === 'GET' && req.url === '/status') {
      return json(200, {
        running: consoleState.running,
        // The extension polls this endpoint anyway, so the stop flag rides along
        // instead of competing for the single turn slot the run already owns.
        stop: consoleState.stop,
        extensionReady: polledRecently(),
        extensionVersion,
        contentVersion: CONTENT_VERSION,
        staleExtension: staleExtension(),
        mode: consoleState.mode,
        // The folder the tools may change. The console shows it, and a check asserts the fence
        // follows it.
        workspace: workspaceOf(),
        // Non-zero means the run is waiting on a person, which is otherwise indistinguishable
        // from a hang in the console.
        asking: pendingAsks.size,
        // Which segment the run is writing into. A task appends to the current one, so its id is
        // the only reliable answer to "where did that go" — a title is not an identity, and a
        // check that deletes by title can delete a real session.
        sessionId: currentSession?.id ?? null,
        log: LOG,
      });
    }

    // The answer to a question or an approval the run is waiting on. One endpoint for both:
    // what comes back is text, a yes/no, or both.
    if (req.method === 'POST' && req.url === '/answer') {
      const body = JSON.parse(await read(req));
      const pending = pendingAsks.get(String(body?.id ?? ''));
      // A stale click from a page that was reloaded mid-question must not look like a success.
      if (!pending) return json(409, { error: '没有在等这个回答（可能已经答过，或者页面刷新过）' });
      pending.resolve({ text: String(body.text ?? ''), allow: body.allow === true });
      return json(200, { ok: true });
    }

    // The human's standing permission. Deliberately not settable by the model: it is a POST
    // the console makes, and the model has no tool that reaches it.
    if (req.method === 'POST' && req.url === '/mode') {
      const body = JSON.parse(await read(req));
      const mode = String(body?.mode ?? '');
      if (!MODES.includes(mode)) return json(400, { error: `mode 只能是 ${MODES.join(' / ')}` });
      consoleState.mode = mode;
      record(`权限模式：${mode}`);
      return json(200, { ok: true, mode });
    }

    // The workspace: the one folder the tools may change. Refused mid-run on purpose — every path
    // already in flight was resolved against the old one, and half a run in each folder is worse
    // than waiting a few seconds.
    if (req.method === 'POST' && req.url === '/workspace') {
      if (consoleState.running) return json(409, { ok: false, error: '任务运行中，跑完再换工作区' });
      const body = JSON.parse(await read(req));
      try {
        return json(200, { ok: true, workspace: await setWorkspace(body?.dir) });
      } catch (e) {
        return json(400, { ok: false, error: e.message });
      }
    }

    // Recovery hatch. When the extension hangs mid-turn the bridge is otherwise
    // stuck until restart, and a half-consumed job can be handed out again.
    if (req.method === 'POST' && req.url === '/reset') {
      const killed = pendingResolve;
      pendingResolve = null;
      reserved = null;
      inbox.length = 0;
      consoleState.running = false;
      consoleState.stop = false;
      // A question left open would hold the loop until its timeout, and a reset is exactly the
      // gesture for "I am done waiting".
      dropAsks('用户重置了桥');
      // And a long `run` is stopped the same way, rather than keeping the process busy until its
      // own clock runs out. Reset is the button for "this is over now", build included.
      killRunningRun();
      if (killed) killed.reject(new Error('reset by the console'));
      record('已重置');
      // The client keeps its buttons disabled until a run ends, and a reset ends
      // one without going through runTask, so it has to say so itself.
      emit({ type: 'end', ok: false, error: '已重置', at: new Date().toISOString() });
      emit({ type: 'idle', at: new Date().toISOString() });
      return json(200, { ok: true });
    }

    // The CLI escape hatch, on the console: one prompt, no JSON protocol, the
    // raw answer back. This is also the only way to measure what the scrape does
    // to plain multi-line text, since the agent protocol always answers in JSON.
    if (req.method === 'POST' && req.url === '/ask') {
      const body = JSON.parse(await read(req));
      const text = String(body?.text ?? '').trim();
      if (!text) return json(400, { ok: false, error: '内容为空' });
      if (consoleState.running) return json(409, { ok: false, error: '上一个任务还在跑' });
      consoleState.running = true;
      LOG.length = 0;
      record(`提问: ${text}`);
      ask(text)
        .then((r) => {
          const reply = cleanReply(r);
          record(reply, 'final');
          record(
            `[诊断] 行数=${reply.split('\n').length} 前导空格=${JSON.stringify(
              reply.split('\n').slice(0, 6).map((l) => (l.match(/^ */) ?? [''])[0].length),
            )}`,
            'step',
          );
          emit({ type: 'end', ok: true, at: new Date().toISOString() });
        })
        .catch((e) => {
          record(`失败: ${e.message}`, 'err');
          emit({ type: 'end', ok: false, error: e.message, at: new Date().toISOString() });
        })
        .finally(() => {
          consoleState.running = false;
          // Without this the client keeps its buttons disabled after a question:
          // /ask does not go through runTask, which is what usually says idle.
          emit({ type: 'idle', at: new Date().toISOString() });
        });
      return json(200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/task') {
      const body = JSON.parse(await read(req));
      const text = String(body?.text ?? '').trim();
      if (!text) return json(400, { ok: false, error: '任务为空' });
      if (consoleState.running) return json(409, { ok: false, error: '上一个任务还在跑' });
      // Claimed here, synchronously, so two rapid clicks cannot both pass the
      // check above and start overlapping runs.
      consoleState.running = true;
      LOG.length = 0;
      record(`任务: ${text}`);
      // Detached on purpose: answering the request immediately means closing the
      // tab cannot abort a run, and the console polls /status for progress.
      // Continuing the previous conversation is the default, the way an editor keeps
      // its context between requests; `fresh: true` asks for a new one.
      runTask(text, body?.fresh === true);
      return json(200, { ok: true });
    }

    // Live event stream. The console subscribes once and repaints as events
    // arrive, instead of polling /status and diffing a log array.
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      streamClients.add(send);
      send({ type: 'hello', at: new Date().toISOString() });
      // Heartbeat so a sleeping tab or a proxy notices the stream is alive.
      const beat = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(beat);
        streamClients.delete(send);
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/sessions') {
      return json(200, await listSessions());
    }

    if (req.method === 'GET' && req.url.startsWith('/session/')) {
      const id = decodeURIComponent(req.url.slice('/session/'.length));
      try {
        return json(200, await readSession(id));
      } catch (e) {
        return json(404, { error: e.message });
      }
    }

    // Stop the run in flight. Two parts: the loop checks the flag between turns,
    // and the extension is asked to stop generating so the model does not keep
    // writing to a chat nobody is reading.
    if (req.method === 'POST' && req.url === '/stop') {
      if (!consoleState.running) return json(200, { ok: true, stopped: false });
      consoleState.stop = true;
      record('已请求停止', 'err');
      // A run waiting on a question is stopped the only way it can be: by releasing the
      // question. The loop then sees the flag on its next round and abandons the task.
      dropAsks('用户停止了这次运行');
      // The flag alone was a promise the loop could not keep while a long script was in flight:
      // the script kept running (and writing) while the console already showed "stopping".
      if (killRunningRun()) record('已结束正在跑的脚本', 'err');
      stopGeneration()
        .then((r) => record(`停止信号: ${r}`))
        .catch((e) => record(`停止失败: ${e.message}`, 'err'));
      return json(200, { ok: true, stopped: true });
    }

    if (req.method === 'POST' && req.url === '/probe') {
      if (consoleState.running) return json(409, { ok: false, error: '任务运行中，无法同时检查页面' });
      // A probe is a run: it holds the single turn slot, so the client must see
      // running=true while it is in flight. Leaving it false made the run button
      // look available and the stop button look irrelevant during a probe.
      consoleState.running = true;
      LOG.length = 0;
      emit({ type: 'start', task: '检查页面', at: new Date().toISOString() });
      record('检查页面…');
      probe()
        .then((r) => {
          record(JSON.stringify(r, null, 1));
          emit({ type: 'end', ok: true, at: new Date().toISOString() });
        })
        .catch((e) => {
          record(`检查失败: ${e.message}`, 'err');
          emit({ type: 'end', ok: false, error: e.message, at: new Date().toISOString() });
        })
        .finally(() => {
          consoleState.running = false;
          emit({ type: 'idle', at: new Date().toISOString() });
        });
      return json(200, { ok: true });
    }

    if (req.method === 'GET' && req.url === '/job') {
      lastPoll = Date.now();
      return json(200, await takeJob());
    }

    if (req.method === 'POST' && req.url === '/done') {
      const body = JSON.parse(await read(req));
      // Trust boundary: the reply arrives over HTTP from a browser extension.
      if (typeof body !== 'object' || body === null) throw new Error('body must be an object');
      // Every answered job carries the content script's version, which is how a
      // stale page gets noticed before its behaviour is misread as a bug.
      if (typeof body.contentVersion === 'number') {
        if (body.contentVersion !== extensionVersion && extensionVersion >= 0) {
          record(`插件版本变了 (${extensionVersion} → ${body.contentVersion})`, 'step');
        }
        extensionVersion = body.contentVersion;
        if (staleExtension()) {
          record(`警告: 页面里跑的是旧版抓取脚本 v${body.contentVersion}，服务端期望 v${CONTENT_VERSION} → 重载插件并刷新页面`, 'err');
        }
      }
      if (!pendingResolve) return json(409, { error: 'no turn in flight' });
      const r = pendingResolve;
      pendingResolve = null;
      reserved = null; // the job is answered; the next poll may claim a new one
      // The wait the console cannot see: how long the page held on after the answer stopped
      // changing, and which rule let it go. Eight seconds of this per step looks exactly like a
      // slow model from here, so it goes in the log next to the request it belongs to.
      if (body.settle && typeof body.settle.ms === 'number') {
        record(
          `[页面] 回复收尾等了 ${(body.settle.ms / 1000).toFixed(1)}s（${body.settle.how}，${body.settle.chars ?? 0} 字符）`,
        );
      }
      if (body.ok === false) r.reject(new Error(String(body.error ?? 'unknown')));
      else if (body.cmd === 'probe') r.resolve(body);
      else r.resolve(String(body.reply ?? ''));
      return json(200, { ok: true });
    }

    json(404, { error: `no route ${req.method} ${req.url}` });
  } catch (e) {
    json(500, { error: String(e.message ?? e) });
  }
});

const read = (req) =>
  new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });

// The page can wrap the answer in harness markup ("<system>Tool ran without
// output or errors</system>" appeared verbatim in a scraped reply), which the
// model then echoes. Strip it before anything tries to parse the text.
export function cleanReply(text) {
  return (typeof text === 'string' ? text : '').replace(/<\/?system>[\s\S]*?<\/system>/gi, ' ').trim();
}

// Last resort for a reply whose string content carries raw quotes, which the
// model produces when it quotes the prompt back at itself. The full parse is
// tried first; this only salvages the common {"done":"…"} shape.
function scanDone(s) {
  const m = s.match(/\{\s*"done"\s*:\s*"([\s\S]*)"\s*\}/);
  return m ? { done: m[1] } : null;
}

// The opening fence of the first fenced block, its language tag, and the body.
// Returns null when there is no fence.
function codeBlock(s) {
  const open = s.match(/^[ \t]*```[ \t]*([^\n`]*)\r?\n/m);
  if (!open) return null;
  const bodyStart = open.index + open[0].length;
  const rest = s.slice(bodyStart);
  const close = rest.search(/^[ \t]*```/m);
  return { lang: open[1].trim(), body: close < 0 ? rest : rest.slice(0, close) };
}

// Page chrome that a scraped reply drags along: the copy/download controls and
// the language label of a rendered code block.
const PAGE_CHROME = /复制|下载|Copy|Download|\bpython\b|\bplaintext\b/gi;

// File content travels in ONE fenced block, with the path on its first line:
//
//   # path: tool.py
//   import argparse
//   ...
//
// No JSON anywhere. The earlier protocol asked for a JSON line and then a fence,
// which required the page to keep them on separate lines — and the page glues the
// code block's rendered header onto the preceding line, so `}python复制下载` ended
// up attached to the JSON and the fence stopped starting a line. Every such merge
// produced `no tool "undefined"` and lost the file.
//
// The leading comment marker is MANDATORY. With it optional, an edit reply whose
// first block began with the line `    path = sys.argv[2]` parsed as a write of a
// file literally named `sys.argv[2]`, and that file got created.
const PATH_LINE = /^\s*(?:#|\/\/|--|;)\s*path\s*[:=]\s*(.+?)\s*$/i;

// A path, not an expression. Second line of defence against a code line being
// read as a filename. An allowlist rather than a blocklist: a hand-written
// blocklist rejected `.selftest-written.py` while still letting `sys.argv[2]`
// through, which is exactly backwards.
const SAFE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const isPath = (p) => SAFE_PATH.test(p) && !p.includes('..');

export function readFencedWrite(text) {
  const cleaned = cleanReply(text);
  const block = codeBlock(cleaned);
  if (!block) return null;
  const body = block.body.replace(PAGE_CHROME, '');
  const lines = body.split('\n');
  const m = (lines[0] ?? '').match(PATH_LINE);
  if (!m) return null;
  const arg = m[1].replace(/["'`]/g, '').trim();
  if (!isPath(arg)) return null;
  // `tool` is required: the caller looks the tool up by it, and a result without
  // it arrives as `no tool "undefined"` and drops the file.
  return { tool: 'write', arg, content: lines.slice(1).join('\n') };
}

// All fences in a reply, in order, with their bodies.
//
// Walks left to right in one pass. Scanning with a global regex reported a spurious
// empty block between two adjacent blocks: the first block's closing fence and
// the second's opening fence are consecutive, and the regex consumed one as the
// close and then matched the next as a fresh open. Bookkeeping, not matching, is
// what this needs.
const fenceAt = (s, i) => {
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  return s.startsWith('```', j) ? j : -1;
};

export function fences(s) {
  const out = [];
  let open = null;
  let i = 0;
  while (i < s.length) {
    const at = fenceAt(s, i);
    if (at >= 0) {
      const lineEnd = s.indexOf('\n', at);
      if (open === null) {
        open = lineEnd < 0 ? s.length : lineEnd + 1;
      } else {
        out.push(s.slice(open, i));
        open = null;
      }
      i = lineEnd < 0 ? s.length : lineEnd + 1;
      continue;
    }
    const nl = s.indexOf('\n', i);
    i = nl < 0 ? s.length : nl + 1;
  }
  if (open !== null) out.push(s.slice(open));
  return out;
}

// An edit as two fenced blocks: the text to find, then its replacement.
//
//   {"tool":"edit","arg":"tool.py"}
//   ```
//   <old text, verbatim>
//   ```
//   ```
//   <new text, verbatim>
//   ```
//
// Same reason as write: JSON string values need every `"` escaped as `\"`, and a
// model editing code writes quotes constantly. An unescaped `"-"` inside the
// string made the whole reply unparseable and the edit was lost.
export function readEditBlocks(text) {
  const meta = readJson(text);
  if (!meta || meta.tool !== 'edit' || typeof meta.arg !== 'string') return null;
  const blocks = fences(cleanReply(text));
  // Exactly two, not "at least two". A recorded reply carried three: the model
  // showed the original code for the reader, then the real old, then the new. The
  // first two got paired, so `old` was the illustration — which is not in the file
  // — and the tool answered "old text not found ... must match exactly". The text
  // was in the file. The model spent two turns hunting a byte difference that did
  // not exist, and blamed the `\n` escaping. Refusing to guess lets TOOLS.edit
  // report the real problem: the reply's shape.
  if (blocks.length !== 2) return null;
  return { tool: 'edit', arg: meta.arg, old: blocks[0], new: blocks[1] };
}

export function readWriteBlock(text) {
  const fenced = readFencedWrite(text);
  if (fenced) return fenced;

  // Legacy protocol, kept because a model that has seen the old prompt in the
  // conversation may still answer that way: JSON line, then a fence.
  const cleaned = cleanReply(text);
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  const end = cleaned.indexOf('}', start);
  if (end < 0) return null;
  let meta;
  try {
    meta = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (meta?.tool !== 'write' || typeof meta.arg !== 'string') return null;

  const block = codeBlock(cleaned);
  if (block) return { tool: 'write', arg: meta.arg, content: block.body };

  // No fence: take what follows the JSON rather than reject a file that exists.
  const rest = cleaned
    .slice(end + 1)
    .split('\n')
    .filter((line, i) => !(i === 0 && line.trim() === ''))
    .filter((line, i) => !(i === 0 && line.trim() && line.trim().length < 12 && !/[=(){}\[\];]/.test(line)))
    .join('\n');
  const body = rest.replace(PAGE_CHROME, '').replace(/\n+$/, '');
  return body.trim() ? { tool: 'write', arg: meta.arg, content: `${body}\n`, unfenced: true } : null;
}

// The answer arrives glued to the model's visible reasoning, which can itself
// contain braces, so take the LAST balanced object: the first `{` to the last
// `}` would splice reasoning into the answer. Non-string input returns null
// rather than throwing, because the extension can hand back anything.
export function readJson(text) {
  const s = cleanReply(text);
  for (let end = s.lastIndexOf('}'); end >= 0; end = s.lastIndexOf('}', end - 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = end; i >= 0; i--) {
      const c = s[i];
      if (inStr) {
        if (c === '"' && s[i - 1] !== '\\') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '}') depth++;
      else if (c === '{' && --depth === 0) {
        try {
          const parsed = JSON.parse(s.slice(i, end + 1));
          if (parsed && typeof parsed === 'object') return parsed;
        } catch {
          // not valid JSON here; try the next outer closing brace
        }
        break;
      }
    }
  }
  return scanDone(s);
}

// ---- the workspace: the one folder the tools may change ------------------------------
//
// Every path a tool touches goes through `safe()` below, and `safe()` resolves against ROOT. So the
// fence is not a policy that has to be remembered in nine tools — it is one function, and pointing
// ROOT somewhere else is the whole mechanism. Two things still reach outside, and both are said out
// loud rather than hidden: an approved one-shot call (a person clicks for it), and a `run` script,
// whose body can write anywhere the process can (documented in README, inherent to running code).
const workspaceOf = () => ROOT;

/**
 * Point every tool at another folder, and remember it.
 *
 * @param {string} dir - the folder to work in. Must already exist.
 * @returns {Promise<string>} the resolved workspace.
 */
async function setWorkspace(dir) {
  const next = path.resolve(String(dir ?? '').trim());
  if (!dir || !String(dir).trim()) throw new Error('给一个路径');
  // Refused before anything is written: a typo that silently pointed the workspace at a missing
  // directory would make every later tool fail with ENOENT and no mention of the cause.
  if (!statSync(next).isDirectory()) throw new Error(`${next} 不是文件夹`);
  ROOT = next;
  // Saved so a restart lands in the same place; the bridge's own files stay where they are.
  await writeFile(WORKSPACE_FILE, `${next}\n`, 'utf8');
  record(`工作区：${next}`);
  return next;
}

// ponytail: string prefix check, no realpath. Swap in fs.realpath if paths get untrusted.
function safe(rel) {
  const p = path.resolve(ROOT, rel || '.');
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) {
    // Out of the workspace. Only an approved one-shot call passes; otherwise this refusal is
    // what the dispatcher turns into an approval request — which is why the hint is in the
    // error: the error is the only place the model learns it may ask.
    if (approvedCall) return p;
    throw new Error(
      `path escapes workspace: ${rel} —— 工作区外的路径要用户批准。同一次调用加上 "outside":true 和 "why":"要它干什么"，`
      + '用户会在控制台看到并决定；允许了这一次就放行。',
    );
  }
  return p;
}

// ---- observed files: look before you change ------------------------------------------
//
// What the model has actually seen, so a change is never made from memory. Two rules, which are
// the useful half of the harness's observed-state policy: an existing file must have been read
// (or written by this process) before anything changes it, and it must not have moved since.
// The second rule is the one that earns its keep here — another agent, or the user, can rewrite
// a file between the read and the edit, and the model's `old` text is then a faithful copy of a
// file that no longer exists.
//
// ponytail: mtime + size is the version. A same-millisecond, same-size rewrite slips through;
// hash the content if that ever bites.
const observed = new Map();

const fileVersion = (abs) => {
  const s = statSync(abs);
  return `${s.mtimeMs}:${s.size}`;
};

/** Remember the state of a file just looked at or written. */
function noteObserved(abs) {
  try {
    observed.set(abs, fileVersion(abs));
  } catch {
    // Gone (a write that deleted it, say): nothing to remember.
    observed.delete(abs);
  }
}

/**
 * Refuse to change a file that was never looked at, or that moved since it was.
 *
 * @param {string} abs - absolute path about to be changed.
 * @param {string} verb - `edit` or `write`, for the message.
 * @param {string} shown - the path as the model wrote it, so the message is copy-pasteable.
 */
function requireObserved(abs, verb, shown) {
  // A folder can never satisfy this rule — `read` refuses it — so saying "read it first" would
  // send the caller after an action that cannot succeed. Say what the real choice is instead.
  if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${shown} 是文件夹，${verb} 只改文件：里面的文件逐个改；整个不要了就用 {"tool":"fs","verb":"delete","arg":${JSON.stringify(shown)},"recursive":true}`);
  }
  let now;
  try {
    now = fileVersion(abs);
  } catch {
    // Not there: a write may create it, and edit's own read will say what is wrong.
    return;
  }
  const seen = observed.get(abs);
  if (seen === undefined) {
    throw new Error(
      `${verb} 之前要先看这个文件：{"tool":"read","arg":${JSON.stringify(shown)}}。`
      + '改一个没看过、也不是你建的文件，等于在猜它里面是什么。',
    );
  }
  if (seen !== now) {
    throw new Error(
      `${shown} 在你读过之后变了 —— 别人改过它，或者你自己用 run 改的。重新 read 一次再改，`
      + '否则你手上的原文已经不是文件里的原文。',
    );
  }
}

// Where `fs` puts what it deletes. A folder the tools may touch has to be one they can empty, and
// the model cannot be trusted to be right about what is no longer needed — so a delete is a move
// aside, and a wrong one is undone by hand. It lives beside the bridge's own files, not in the
// workspace, so pointing the workspace at somebody's real project does not drop a `.trash` in it.
const TRASH_DIR = '.trash';
// A tag old enough that nothing else in the tree has it is a whole millisecond. Collisions inside
// one millisecond are not possible here: the loop runs one call at a time.
const uniqTag = () => Date.now().toString(36);

// `.sessions` holds this loop's own transcripts, so a grep for any common word
// returns the agent's own past chatter instead of the code. `.run-*.tmp` are the
// run tool's scratch files, one pair per run. `.spill` holds the full text of outputs too
// big to hand over, addressed by the path in the notice rather than discovered by a
// listing. None is source; all are noise.
const SKIP = new Set(['node_modules', '.git', '.chrome-profile', '.npm-cache', '.sessions', '.spill', '.trash']);
// One predicate, both listings. `ls` used to readdir straight and show the run
// tool's scratch files while glob and grep hid them, so the same directory had two
// answers. A recorded run read that pile as leaked temp files and spent its whole
// step budget probing them — its own in-flight log was always among them, and it
// could not tell "mine, still being written" from "left behind".
const isNoise = (name) => SKIP.has(name) || name.startsWith('.run-');

const MAX_HITS = 50;
// grep skips a file larger than this instead of scanning it.
const MAX_FILE = 200000;
// read() without a window returns at most this much text, and says where to resume.
const READ_LIMIT = 8000;
const MAX_READ_LINES = 1000;
// read() loads the whole file into a string before it cuts anything, so the only
// bound on memory used to be the file itself: grep had a size limit and read had
// none, and one call on a large log could take the server down. This is a crash
// guard, not a context limit — anywhere near this size the answer is a `run`
// script that prints the part you need, not a read.
const MAX_READ_BYTES = 4000000;

// The run tool is deliberately narrow: two interpreters, no shell, a hard
// timeout, and a bounded output. The agent needs to verify what it wrote, and
// without this it can only hand the job back to a human. A general shell would
// also allow deleting the workspace, so the allowlist is the point.
// Nothing here can delete for good either — `fs delete` parks a path in the trash — which is why
// the workspace is worth pointing at real code at all.
const RUNNERS = new Set(['python', 'python3', 'py', 'node']);
const RUN_TIMEOUT = Number(process.env.BRIDGE_RUN_TIMEOUT ?? 30000);
// A test run and a build are the same tool with a different clock. The call may ask for longer, up
// to this ceiling — a knob the model can turn, not a knob it can remove. A person pressing stop
// also ends the child early (`killRunningRun`), so the ceiling is not how long a run must take.
const RUN_TIMEOUT_MAX = Number(process.env.BRIDGE_RUN_TIMEOUT_MAX ?? 600000);
const RUN_OUTPUT = 4000;
const RUN_ARGS = 20;
const RUN_STDIN = 60000;
// Where an oversized output goes instead of the bin. The model gets the head, the tail, and
// the path, so it can read the middle it was cut out of — before this, the full text was
// deleted and the only way back was re-running the script and hoping it printed less.
//
// Inside the workspace, not next to the bridge, because the notice hands the model a path it then
// `read`s, and `read` resolves against the workspace. A function rather than a constant for the same
// reason the workspace is not one: it follows a switch.
const spillDir = () => path.join(ROOT, '.spill');
const SPILL_KEEP = 20;

/** Drop all but the newest {@link SPILL_KEEP} spilled files. Named by timestamp, so a name sort is an age sort. */
async function pruneSpill() {
  try {
    const files = (await readdir(spillDir())).sort().reverse();
    for (const old of files.slice(SPILL_KEEP)) await rm(path.join(spillDir(), old), { force: true });
  } catch {
    // Nothing to prune, or a file vanished underneath: the spill itself already succeeded.
  }
}

/** Move a truncated run's full output into .spill and return its workspace-relative path. */
async function spillOutput(logFile, tag) {
  await mkdir(spillDir(), { recursive: true });
  // Timestamp first: pruning sorts by name, and that only means "oldest first" if the
  // name starts with something that grows with time.
  const name = `.spill/${Date.now()}-${tag}.txt`;
  await rename(logFile, path.join(ROOT, name));
  await pruneSpill();
  return name;
}

/** The same, for text already in hand — an oversized MCP reply never went through a file. */
async function spillText(text, tag) {
  await mkdir(spillDir(), { recursive: true });
  const name = `.spill/${Date.now()}-${tag}.txt`;
  await writeFile(path.join(ROOT, name), text, 'utf8');
  await pruneSpill();
  return name;
}
// Every run gets its own pair of scratch files. They used to be two fixed names,
// which broke the moment a `run` script called `run`: the inner one reopened the
// outer's log with 'w' (throwing away the output the outer was still writing) and
// then deleted it, so the outer reported `[exit 1, 无输出]` for a script that had
// printed plenty. The child is a separate process, so the pid separates nested
// runs; the counter separates two runs started together inside one process.
let RUN_SEQ = 0;

// A short script can be handed over on stdin instead of as an argument. Inline `-c`
// / `-e` arguments survive neither Windows quoting nor the argument length cap, so
// every throwaway check used to mean writing a file first. `python -` reads its
// program from stdin, which is the case this serves.
//
// `timeoutMs` is the call's own clock. `stderr` gets its own file so that a traceback and the
// progress lines around it do not interleave: the exit code alone does not say which stream failed.
export function runTool(command, args = [], stdin = null, timeoutMs = RUN_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timeout = Math.min(Math.max(1000, Number(timeoutMs) || RUN_TIMEOUT), RUN_TIMEOUT_MAX);
    const tag = `${process.pid}.${++RUN_SEQ}`;
    const logFile = path.join(ROOT, `.run-${tag}-out.tmp`);
    const errFile = path.join(ROOT, `.run-${tag}-err.tmp`);
    const inFile = path.join(ROOT, `.run-${tag}-in.tmp`);
    let fd;
    let errFd;
    let inFd = null;
    try {
      fd = openSync(logFile, 'w');
      errFd = openSync(errFile, 'w');
      if (stdin !== null) {
        writeFileSync(inFile, stdin, 'utf8');
        inFd = openSync(inFile, 'r');
      }
    } catch (e) {
      return reject(new Error(`cannot open the run files: ${e.message}`));
    }
    const cleanup = async () => {
      for (const handle of [fd, errFd, inFd]) {
        if (handle === null || handle === undefined) continue;
        try {
          closeSync(handle);
        } catch {
          // already closed
        }
      }
      if (inFd !== null) await rm(inFile, { force: true });
    };
    // stdio 0/1/2 or 'ignore' are the only modes this sandbox allows; a piped
    // child is refused with EPERM, and 'ignore' would discard the output this
    // tool exists to return. So the child reads from a file and writes to one,
    // and we read the output back afterwards.
    const child = spawn(command, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: [inFd ?? 'ignore', fd, errFd],
    });
    runningChild = child;
    let settled = false;
    let timedOut = false;
    const finish = async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningChild = null;
      const readBack = (file) => {
        try {
          return readFileSync(file, 'utf8').trim();
        } catch {
          return '';
        }
      };
      const out = readBack(logFile);
      const err = readBack(errFile);
      // Labelled, not JSON: putting a script's output inside a JSON string escapes every newline
      // and quote and turns a readable traceback into one line nothing can be read out of.
      let text = err ? `${out}${out ? '\n' : ''}[stderr]\n${err}` : out;
      const big = text.length > RUN_OUTPUT;
      let spilled = null;
      // Cleanup must never swallow the result. This is an async callback nobody
      // awaits, so a throw here — on Windows, removing a file another handle still
      // has open is an EPERM — became an unhandled rejection and the promise never
      // settled: the bridge sat there looking busy and the run never came back.
      // A leftover scratch file is the lesser problem.
      try {
        await cleanup();
        if (big) spilled = await spillOutput(logFile, tag);
        else await rm(logFile, { force: true });
        await rm(errFile, { force: true });
      } catch {
        // the files are named per run, so a stray one cannot corrupt the next run
      }
      if (big) {
        // Both ends, not just the head. A script that prints a lot and then dies
        // puts its traceback in the LAST lines; keeping only the first 4000
        // characters showed a wall of output and hid the one line the loop ran
        // the script to see. The tail is what verification needs.
        const head = text.slice(0, Math.floor(RUN_OUTPUT * 0.4));
        const tail = text.slice(-Math.floor(RUN_OUTPUT * 0.6));
        const where = spilled
          ? `全文在 ${spilled}，接着看用 {"tool":"read","arg":"${spilled}","offset":1,"limit":200}`
          : '全文没能留下（.spill 写失败），要看得让脚本少打印一点';
        text = `${head}\n... [中间省略 ${text.length - head.length - tail.length} 字符，共 ${text.length} 字符；保留开头和结尾。${where}] ...\n${tail}`;
      }
      // A non-zero exit is information the model needs, not a failure to hide:
      // seeing the traceback is how it corrects itself.
      resolve(text ? `${text}\n[exit ${code}]` : `[exit ${code}, 无输出]`);
    };
    const timer = setTimeout(() => {
      // Kill, then report on close: reading the log before the child has
      // actually exited loses whatever it had already written.
      timedOut = true;
      child.kill();
      child.once('close', () => finish('timeout'));
    }, timeout);
    child.on('error', (e) => finish(e.code ?? 'spawn-error'));
    child.on('close', (code) => finish(timedOut ? 'timeout' : (code ?? 0)));
  });
}

// The child of the run in flight, so a person pressing stop can actually stop it. Before this the
// stop flag was only read between steps, which for a two-minute build means "stop" does nothing
// until the build finishes — the one moment somebody wants it.
let runningChild = null;
/** Kill the run in flight, if any. The tool reports it as a timeout, which is what it is. */
export function killRunningRun() {
  if (!runningChild) return false;
  try {
    runningChild.kill();
    return true;
  } catch {
    return false;
  }
}

// ---- MCP: the servers the user configured ------------------------------------------
//
// One tool speaks the protocol; the servers come from mcp.json and nowhere else. That file
// is read once when the server starts, so writing it mid-run changes nothing until a human
// restarts — the model can call a configured server, but it cannot turn one on. The command
// and args live in that file, which makes it the allowlist: unlike `run`, nothing here
// accepts a command from the model.
const MCP_CONFIG = path.join(HERE, process.env.BRIDGE_MCP_CONFIG ?? 'mcp.json');
const MCP_TIMEOUT = Number(process.env.BRIDGE_MCP_TIMEOUT ?? 20000);
const MCP_REPLY = 4000;
// The revision asked for. Servers negotiate down, and we use nothing version-gated, so the
// string every deployed server accepts beats matching the newest spec.
const MCP_REVISION = '2024-11-05';

let mcpServers = {};
let mcpReady = null;
let mcpSeq = 0;

/**
 * Read mcp.json once per process. Called from {@link start} rather than at module load,
 * because a check may import this module without starting a server.
 * @returns {Promise<void>} resolves once the config has been read.
 */
function loadMcp() {
  mcpReady ??= (async () => {
    try {
      mcpServers = JSON.parse(await readFile(MCP_CONFIG, 'utf8'))?.servers ?? {};
    } catch {
      // No config file is the normal state, not a failure: there is nothing to offer.
      mcpServers = {};
    }
  })();
  return mcpReady;
}

/** Newline-delimited JSON-RPC, which is all the stdio transport is. */
async function* readLines(stream) {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

/**
 * Spawn a configured server with pipes, turning every way that can fail into one message.
 * The sandbox refusal arrives as a synchronous throw from `spawn` itself, so a try around
 * the later awaits would miss it.
 */
function spawnPiped(server, spec) {
  try {
    return spawn(spec.command, spec.args ?? [], {
      cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e?.code === 'EPERM') {
      // Worth naming: the whole protocol needs two-way pipes, so an environment that
      // refuses piped children refuses MCP — nothing about the config is wrong.
      throw new Error(`MCP ${server}: 起不了子进程（EPERM）—— 这个环境不允许带管道的子进程，MCP 全程需要双向 stdio`);
    }
    throw new Error(`MCP ${server}: 起不了 ${spec.command}：${e.message}`);
  }
}

/**
 * One request to one server, over a freshly spawned process: initialize, initialized, then
 * the request, then close.
 *
 * ponytail: a process per call. One code path, nothing to reap, and the price is the
 * server's startup time on every call — keep a process table if that ever shows up in a
 * measurement.
 *
 * @param {string} server - key in mcp.json.
 * @param {string} method - JSON-RPC method, e.g. `tools/list`.
 * @param {object} params - method parameters.
 * @returns {Promise<unknown>} the response's `result`.
 */
async function mcpRun(server, method, params) {
  const spec = mcpServers[server];
  if (!spec?.command) {
    throw new Error(`没有叫 "${server}" 的 MCP 服务器（配置在 ${path.basename(MCP_CONFIG)}）`);
  }
  const child = spawnPiped(server, spec);
  // A stream error nobody listens for is fatal to the process, and a child that dies mid
  // write raises EPIPE on stdin. Both are reported through the child's own error below.
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  let spawnError = null;
  child.on('error', (e) => {
    spawnError = e;
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  let timedOut = false;
  let closedReason = null;
  const why = () => {
    if (spawnError) return `起不了 ${spec.command}（${spawnError.code ?? spawnError.message}）`;
    if (timedOut) return `超过 ${MCP_TIMEOUT}ms 没回答`;
    return `退出了${stderr ? `：${stderr.trim().slice(-300)}` : ''}`;
  };
  // One pump owns stdout for the life of the process, and requests wait on their own id.
  // Reading with `for await` inside each request instead looked simpler and was wrong: leaving
  // that loop early (to return the reply) makes the iterator run its cleanup, which destroys
  // the stream — so the initialize reply arrived and every later request saw a dead pipe.
  const waiting = new Map();
  const pumped = (async () => {
    try {
      for await (const message of readLines(child.stdout)) {
        const waiting_ = waiting.get(message.id);
        if (waiting_) {
          waiting.delete(message.id);
          waiting_.resolve(message);
        }
        // Notifications and ids nobody asked for need no answer here.
      }
    } catch (e) {
      closedReason = `读 stdout 失败：${e.message}`;
    }
    // The pipe ended: whatever is still waiting will never be answered.
    for (const reply of [...waiting.values()]) reply.reject(new Error(`MCP ${server} 在回答前${closedReason ?? why()}`));
    waiting.clear();
  })();
  const ask = (message) =>
    new Promise((resolve, reject) => {
      waiting.set(message.id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, MCP_TIMEOUT);
  try {
    const hello = await ask({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: MCP_REVISION, capabilities: {}, clientInfo: { name: 'web-bridge', version: '0.1' } },
    });
    if (hello.error) throw new Error(`MCP ${server} 不接受 initialize：${hello.error.message}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const reply = await ask({ jsonrpc: '2.0', id: 2, method, params });
    if (reply.error) throw new Error(`MCP ${server} 的 ${method} 失败：${reply.error.message}`);
    return reply.result;
  } finally {
    clearTimeout(timer);
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // Already gone.
    }
  }
}

// Every file under a workspace-relative directory, skipping vendored and VCS
// trees. Sync on purpose: the walk is bounded and the loop is strictly serial.
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (isNoise(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// Translate a glob into a regex. Deliberately small: `**` spans directories, and
// because `**/` must also match zero directories, its slash is optional so that
// `**/*.mjs` finds a root-level `bridge.mjs` as well as nested files.
function globToRe(pattern) {
  let re = '';
  for (const seg of pattern.split('/')) {
    if (seg === '**') re += '(?:.*/)?';
    else re += `${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}/`;
  }
  return new RegExp(`^${re.replace(/\/$/, '')}$`);
}

// ---- skills: rule files the model reads only when it needs them -------------
// One markdown file under skills/ is one skill. On demand, so the standing
// prompt stays short and a rule can be added without editing this file.
const SKILLS = path.join(HERE, 'skills');
const SKILL_LIMIT = 8000;

/** Names plus their first line, so the model can tell which one to read. */
async function listSkills() {
  let files;
  try {
    // Directories are filtered out rather than filtered by name: a directory called
    // `x.md` would otherwise be read as a file, throw EISDIR, and take the whole
    // menu down with it — leaving the model unable to see any skill at all.
    files = (await readdir(SKILLS, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name)
      .sort();
  } catch {
    // No skills directory is a normal state, not a failure: there is nothing to
    // offer yet, and saying so is more useful than an errno.
    return 'no skills yet';
  }
  if (!files.length) return 'no skills yet';
  return (await Promise.all(files.map(async (f) => {
    const first = (await readFile(path.join(SKILLS, f), 'utf8')).split('\n').find((l) => l.trim());
    return `- ${f.slice(0, -3)}${first ? ` — ${first.replace(/^#+\s*/, '').trim()}` : ''}`;
  }))).join('\n');
}

export const TOOLS = {
  ls: async ({ arg }) => (await readdir(safe(arg))).filter((n) => !isNoise(n)).join('\n'),

  // Whole file, or one numbered window of it. A silent truncation was the reason a
  // throwaway slice script got written on nearly every debugging run: the model hit
  // the cut with no way to ask for the next part. `offset` and `limit` are in lines,
  // and a truncated read now says so and how to continue.
  read: async ({ arg, offset, limit }) => {
    const file = safe(arg);
    // A directory reaches EISDIR from deep inside `readFile`, which says nothing about what to do
    // instead. This is the same dead end `fs delete` had: the answer is a different tool, and the
    // error is the only place that can say so. A missing path is left to `readFile`, whose ENOENT
    // is the right answer for that case.
    if (statSync(file, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${arg} 是文件夹，用 {"tool":"ls","arg":${JSON.stringify(arg)}} 看里面有哪些文件`);
    }
    // Refused before it is opened, not after: the size is the whole risk, and a
    // window does not avoid it because the window is cut from the loaded string.
    const { size } = statSync(file);
    if (size > MAX_READ_BYTES) {
      throw new Error(
        `read refuses ${arg}: ${size} bytes is over the ${MAX_READ_BYTES}-byte limit, because read loads the whole file. `
        + 'Locate the line with grep and read a window around it, or use a `run` script that prints only the part you need.',
      );
    }
    // Normalised to LF on the way out. A CRLF file put a `\r` at the end of every
    // line, which is invisible in the transcript: the model copied text that looked
    // identical and did not match the file. What `read` shows is now exactly what
    // `edit` accepts, byte for byte, so the CRLF tolerance below is a safety net
    // rather than the only thing holding the round trip together.
    const text = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    // Looked at, so it may now be changed — and the version recorded is the one the model's
    // `old` text corresponds to.
    noteObserved(file);
    const lines = text.split('\n');
    if (offset || limit) {
      const start = Math.max(1, Number(offset) || 1);
      const want = Math.min(Math.max(1, Number(limit) || 200), MAX_READ_LINES);
      const window = lines.slice(start - 1, start - 1 + want);
      const head = `${arg} 第 ${start}-${start + window.length - 1} 行，共 ${lines.length} 行`;
      return `${head}\n${window.map((l, i) => `${start + i}: ${l}`).join('\n')}`;
    }
    if (text.length <= READ_LIMIT) return text;
    const shown = text.slice(0, READ_LIMIT);
    const shownLines = shown.split('\n').length;
    return (
      `${shown}\n[已截断：文件共 ${lines.length} 行，上面是前 ${shownLines} 行。` +
      `继续读用 {"tool":"read","arg":${JSON.stringify(arg)},"offset":${shownLines + 1},"limit":200}]`
    );
  },

  write: async (call) => {
    // Called with null when nothing parsed; say so rather than throwing a
    // destructuring TypeError that says nothing about what to fix.
    if (!call || typeof call !== 'object') {
      throw new Error('write needs a fenced block whose first line names the file, e.g. "# path: tool.py"');
    }
    const { arg, content, unfenced } = call;
    if (typeof arg !== 'string' || typeof content !== 'string') {
      throw new Error('write needs a fenced block whose first line names the file, e.g. "# path: tool.py"');
    }
    // Refuse a path that looks like code. A parse slip once created a file named
    // `sys.argv[2]`; a wrong path is worse than a refused one because it silently
    // succeeds and leaves the real file untouched.
    if (!isPath(arg)) {
      throw new Error(`refusing to write to ${JSON.stringify(arg)}: that is not a file path`);
    }
    const file = safe(arg);
    // A new file in a folder that does not exist yet used to fail with ENOENT and send the model
    // looking for a way to make a directory — which there was none, so it wrote a `run` script for
    // it. The folder a file is written into is part of the same intent.
    await mkdir(path.dirname(file), { recursive: true });
    // Overwriting a file nobody looked at is the mistake this refuses. Creating one is fine.
    requireObserved(file, 'write', arg);
    await writeFile(file, content, 'utf8');
    noteObserved(file);
    // Count lines, not newlines. `content.split('\n')` gave "x\n" two entries and the
    // tool reported "(2 lines)" for a one-line file, four runs in a row. A model that
    // trusts the number then spends a turn re-reading the file to find out why — one
    // recorded run did exactly that.
    const lines = content.replace(/\n$/, '').split('\n').length;
    // Say when the fence was missing: the page may have merged its header into
    // the body, so the file is worth re-reading before trusting it.
    return `wrote ${arg} (${lines} lines)${unfenced ? ' — WARNING: no fence found, header text may have leaked in' : ''}`;
  },

  // Exact-string replace. Without this the model must reply with a whole file
  // to change one line, which is the single biggest source of bad edits and
  // wasted context on a chat-backed loop.
  edit: async ({ arg, old, new: replacement }) => {
    if (typeof old !== 'string' || !old) {
      throw new Error('edit needs two fenced blocks: the text to find, then its replacement');
    }
    if (typeof replacement !== 'string') {
      throw new Error('edit needs a second fenced block holding the replacement text');
    }
    const file = safe(arg);
    requireObserved(file, 'edit', arg);
    const text = await readFile(file, 'utf8');
    // Fenced blocks arrive with LF, but a file written on Windows has CRLF. The
    // two look identical on screen, so a multi-line `old` copied from the file
    // looked right and still failed "must match exactly": the bytes differed by
    // a `\r` on every line. Both styles are tried, and the replacement is written
    // back in the style that matched, so a CRLF file stays CRLF.
    const lf = old.replace(/\r\n/g, '\n');
    const trimmed = lf.replace(/\n+$/, '');
    const shapes = [...new Set([lf, trimmed, `${trimmed}\n`])];
    let parts = null;
    let needle = null;
    let crlf = false;
    for (const base of shapes) {
      for (const candidate of new Set([base, base.replace(/\n/g, '\r\n')])) {
        const split = text.split(candidate);
        if (split.length > 2) {
          throw new Error(`old text matches ${split.length - 1} places in ${arg} — include more context`);
        }
        if (split.length === 2 && !parts) {
          parts = split;
          needle = candidate;
          crlf = candidate.includes('\r\n');
        }
      }
    }
    if (!parts) {
      throw new Error(`old text not found in ${arg} — must match exactly, including indentation`);
    }
    const toStyle = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));
    const withNewline = lf.endsWith('\n') && needle.endsWith('\n');
    const glued = withNewline
      ? `${toStyle(replacement).replace(/\r?\n+$/, '')}${crlf ? '\r\n' : '\n'}`
      : toStyle(replacement);
    await writeFile(file, parts.join(glued), 'utf8');
    noteObserved(file);
    return `edited ${arg}`;
  },

  glob: async ({ arg }) => {
    let re;
    try {
      re = globToRe(arg || '**/*');
    } catch (e) {
      throw new Error(`bad glob pattern: ${e.message}`);
    }
    const hits = walk(ROOT).map(rel).filter((r) => re.test(r));
    return hits.length ? hits.slice(0, MAX_HITS).join('\n') : 'no files matched';
  },

  // Case-insensitive is the default because the alternative is a second call with a `(?i)` pattern
  // guessed at, and `i:false` is there for the times the case IS the thing being looked for.
  // `context` and `glob` exist because the answer to "where is this" is almost always followed by
  // "and what is around it" / "only in the tests", which used to cost a read or a second walk.
  grep: async ({ arg, i, context, glob, max }) => {
    let re;
    try {
      re = new RegExp(arg ?? '', i === false ? '' : 'i');
    } catch (e) {
      throw new Error(`bad regex: ${e.message}`);
    }
    let filter = null;
    if (glob) {
      try {
        filter = globToRe(String(glob));
      } catch (e) {
        throw new Error(`bad glob: ${e.message}`);
      }
    }
    const pad = Math.min(Math.max(0, Number(context) || 0), 10);
    const cap = Math.min(Math.max(1, Number(max) || MAX_HITS), MAX_HITS * 4);
    const lines = [];
    let listed = 0;
    let more = false;
    outer:
    for (const file of walk(ROOT)) {
      const shown = rel(file);
      if (filter && !filter.test(shown)) continue;
      let text;
      try {
        if (statSync(file).size > MAX_FILE) continue;
        text = readFileSync(file, 'utf8');
      } catch {
        continue; // binary or unreadable: not a text search hit
      }
      const body = text.split('\n');
      // A window around each match, adjacent windows merged, so two hits a line apart read as one
      // block instead of the same three lines printed twice.
      let previousEnd = -1;
      for (let n = 0; n < body.length; n++) {
        if (!re.test(body[n])) continue;
        if (lines.length >= cap) {
          more = true;
          break outer;
        }
        const run = [`${shown}:${n + 1}:${body[n].trim().slice(0, 200)}`];
        for (let c = Math.max(0, n - pad); c <= Math.min(body.length - 1, n + pad); c++) {
          if (c === n) continue;
          run.push(`${shown}-${c + 1}-${body[c].slice(0, 200)}`);
        }
        if (previousEnd >= 0 && n - pad <= previousEnd) run.shift();
        previousEnd = n + pad;
        lines.push(...run);
        listed++;
      }
    }
    if (!lines.length) return 'no matches';
    // The cap is a promise about how much comes back, and a silently cut list reads as "this is all
    // of it". The count is what tells the model to narrow the pattern instead of believing it.
    return more ? `${lines.join('\n')}\n[已到上限：还有更多匹配，把 ${arg} 写细一点，或用 "glob" 限定文件]` : lines.join('\n');
  },

  // The three file operations no other tool covers. Argument names mirror the harness's fs tool so
  // that a model which knows one recognises the other; the verbs are the ones this bridge can
  // actually honour — no reads, no copies, and a delete that is a move.
  fs: async ({ verb = 'mkdir', arg, args, to, recursive }) => {
    const list = args ?? (arg !== undefined ? [arg] : []);
    const paths = (Array.isArray(list) ? list : [list]).map(String);
    if (!paths.length) throw new Error('fs needs "arg": a path, or "args": [paths]');

    if (verb === 'mkdir') {
      for (const p of paths) {
        if (!isPath(p)) throw new Error(`refusing to make ${JSON.stringify(p)}: that is not a path`);
        await mkdir(safe(p), { recursive: true });
      }
      return `made ${paths.join(', ')}`;
    }

    if (verb === 'move') {
      if (paths.length !== 1) throw new Error('move takes exactly one path in "arg"');
      const from = paths[0];
      if (typeof to !== 'string' || !to.trim()) throw new Error('move needs "to": where it goes');
      const src = safe(from);
      const dst = safe(to);
      // A move is a delete of the old path as far as the model's memory is concerned: its `read`
      // of that file stops describing anything real. Same rule as write/edit — and, like delete,
      // files only: a folder cannot be `read`, so demanding that would make moving one impossible.
      if (!statSync(src).isDirectory()) requireObserved(src, 'move', from);
      await mkdir(path.dirname(dst), { recursive: true });
      try {
        await rm(dst, { force: true });
        await rename(src, dst);
      } catch (e) {
        // EXDEV: two drives, no rename. Read and rewrite is the only way across, and it is still
        // one move as far as the caller is concerned.
        if (e.code !== 'EXDEV') throw e;
        await writeFile(dst, await readFile(src));
        await rm(src, { force: true });
      }
      noteObserved(dst);
      return `moved ${from} -> ${to}`;
    }

    if (verb === 'delete') {
      const done = [];
      for (const p of paths) {
        const target = safe(p);
        const isDir = statSync(target).isDirectory();
        // A folder is asked about by name rather than inferred from the path, and that guard is
        // asked BEFORE the look-first rule: this is the one that decides whether the call is
        // allowed at all, and the one whose wording has to come back.
        if (isDir && recursive !== true) {
          throw new Error(`${p} 是文件夹：确实要连里面一起删就加 "recursive":true`);
        }
        // The look-first rule is for files only. Applied to a folder it is a dead end, and this
        // exact dead end was hit: `read` answers EISDIR on a directory, `ls` looks at the folder
        // without recording it as observed, so the gate demanded an action no tool can perform and
        // the folder could not be deleted at all. For a folder the recursive flag is the guard:
        // it is explicit, and what it moves to the trash is recoverable either way.
        if (!isDir) requireObserved(target, 'delete', p);
        const kept = path.join(HERE, TRASH_DIR, uniqTag(), p.replace(/[\\/]/g, '_'));
        await mkdir(path.dirname(kept), { recursive: true });
        await rename(target, kept).catch(() => rm(target, { recursive: true, force: true }));
        observed.delete(target);
        done.push(p);
      }
      return `moved to ${TRASH_DIR}/ (可恢复): ${done.join(', ')}`;
    }

    throw new Error(`fs verb must be mkdir, move or delete; got ${JSON.stringify(verb)}`);
  },

  // Run a script so the loop can verify its own work. `arg` is the interpreter,
  // `args` the script and its arguments. No shell is involved, so there is no
  // pipeline, redirect, glob or `&&` to worry about; the interpreter name is
  // allowlisted and the working directory is the workspace.
  run: async ({ arg, args, stdin, timeout }) => {
    const command = String(arg ?? '').trim();
    if (!RUNNERS.has(command)) {
      throw new Error(`run only allows ${[...RUNNERS].join(', ')}; got ${JSON.stringify(command)}`);
    }
    const list = Array.isArray(args) ? args.map(String) : [];
    if (list.length > RUN_ARGS) throw new Error(`run takes at most ${RUN_ARGS} arguments`);
    for (const a of list) {
      if (a.length > 300) throw new Error('argument too long');
      if (a.includes('\0')) throw new Error('argument contains a null byte');
      // Arguments name files inside the workspace. An absolute path or a `..`
      // segment reaches outside it, which is the boundary the tool promises to
      // respect; the interpreter itself is already run with cwd = workspace.
      if (path.isAbsolute(a)) {
        throw new Error(`argument ${JSON.stringify(a)} is an absolute path; paths must be inside the workspace`);
      }
      if (/(^|[\\/])\.\.([\\/]|$)/.test(a)) {
        throw new Error(`argument ${JSON.stringify(a)} escapes the workspace`);
      }
    }
    // A script named in the arguments must resolve inside the workspace, the same
    // rule as read/write. Plain flags and `-` (stdin) are left alone.
    for (const a of list) {
      if (!a.startsWith('-')) safe(a);
    }
    const input = typeof stdin === 'string' ? stdin : null;
    if (input !== null && input.length > RUN_STDIN) {
      throw new Error(`stdin is limited to ${RUN_STDIN} characters`);
    }
    // The call may ask for a longer clock than the default — a build or a test suite needs one, and
    // before this the only way past 30s was to not run it. The ceiling is the server's, so the
    // model can turn the knob but not remove it; a non-number falls back to the default.
    return runTool(command, list, input, typeof timeout === 'number' ? timeout : undefined);
  },

  // Two calls on purpose: listing is cheap, and the file itself is only spent
  // from the context budget when the model has decided it needs those rules.
  skill: async ({ arg }) => {
    const name = String(arg ?? '').trim();
    if (!name) return listSkills();
    // The name indexes a file name, so separators and dots are refused outright.
    // With this pattern the only reachable path is skills/<name>.md, and `../`
    // has nowhere to go. Same reasoning as the run tool's argument check.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      throw new Error(`bad skill name ${JSON.stringify(name)}: letters, digits, - and _ only`);
    }
    let text;
    try {
      text = await readFile(path.join(SKILLS, `${name}.md`), 'utf8');
    } catch {
      // An unknown name is a guess, so answer with the menu it should have
      // picked from. Only a missing file reaches here: the name is already
      // known to be a plain name inside skills/.
      return `ERROR: no skill named ${name}. Available:\n${await listSkills()}`;
    }
    text = text.replace(/\r\n/g, '\n');
    if (text.length <= SKILL_LIMIT) return text;
    return (
      `${text.slice(0, SKILL_LIMIT)}\n[已截断：skill ${name} 共 ${text.length} 字符，`
      + `上面是前 ${SKILL_LIMIT}。一条规则太长就拆成两条，别写成一个巨型 skill。]`
    );
  },

  // One tool for every configured server, so the standing prompt grows by one line
  // whatever the user installs. Listing is the same call with no name.
  mcp: async ({ arg, args }) => {
    await loadMcp();
    const names = Object.keys(mcpServers);
    const config = path.basename(MCP_CONFIG);
    if (!names.length) {
      return `没有配置 MCP 服务器。写 ${config} 之后重启服务，格式：`
        + '{"servers":{"名字":{"command":"npx","args":["-y","包名"]}}}';
    }
    if (!arg) {
      const rows = [];
      const errors = [];
      for (const name of names) {
        try {
          const list = await mcpRun(name, 'tools/list', {});
          const tools = list?.tools ?? [];
          if (!tools.length) rows.push(`${name} — 没有工具`);
          for (const t of tools) {
            rows.push(`${name}/${t.name} — ${String(t.description ?? '').split('\n')[0].slice(0, 90)}`);
          }
        } catch (e) {
          errors.push(e);
          rows.push(`${name} — 列不出来：${e.message}`);
        }
      }
      // One broken server must not hide the others, but when none of them answered, a list
      // of failures reads like a menu. Throw instead, so "MCP is not working here" is loud.
      if (errors.length === names.length) throw errors[0];
      // The full name is what the next call needs, so the list is the whole menu, not a teaser.
      return `${rows.join('\n')}\n调用：{"tool":"mcp","arg":"服务器/工具","args":{...}}`;
    }
    const cut = String(arg).indexOf('/');
    if (cut < 1 || cut === String(arg).length - 1) {
      throw new Error(`mcp 的 arg 写成 "服务器/工具"，例如 "fs/read_file"，收到 ${JSON.stringify(arg)}`);
    }
    const server = String(arg).slice(0, cut);
    const tool = String(arg).slice(cut + 1);
    const result = await mcpRun(server, 'tools/call', { name: tool, arguments: args ?? {} });
    const text = (result?.content ?? [])
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
    // A server may answer with something other than text blocks (images, resources); showing
    // the raw result beats showing nothing, and it is what the model can act on.
    const body = text || JSON.stringify(result ?? null);
    if (result?.isError) return `ERROR: ${body}`;
    if (body.length <= MCP_REPLY) return body;
    let where = '全文没能留下（.spill 写失败），要让服务器少返回一点';
    try {
      const spilled = await spillText(body, `mcp-${++mcpSeq}`);
      where = `全文在 ${spilled}，接着看用 {"tool":"read","arg":"${spilled}","offset":1,"limit":200}`;
    } catch {
      // Spilling is best effort; the head below is still useful.
    }
    return `${body.slice(0, MCP_REPLY)}\n[已截断：共 ${body.length} 字符。${where}]`;
  },

  // Ask the human and wait for the answer. The run blocks on it, which is the point: guessing
  // and being wrong twice costs more than one question.
  ask: async ({ arg, options }) => {
    const question = String(arg ?? '').trim();
    if (!question) throw new Error('ask 把问题写在 "arg" 里，选项可选：{"tool":"ask","arg":"...","options":["a","b"]}');
    const answer = await askHuman({
      kind: 'question',
      question,
      options: Array.isArray(options) ? options.map(String).slice(0, 6) : [],
    });
    if (answer === null) return '用户没有回答（超时）。按你手上的信息继续，或者收尾说明卡在哪里。';
    if (answer.dropped) return `这次提问被中止：${answer.text}`;
    return `用户回答：${answer.text}`;
  },
};

/** Send one prompt with no protocol wrapper. The escape hatch when the JSON
 * contract is not what you want: `node bridge.mjs --ask "explain this file"`. */
export async function ask(text) {
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const reply = await turn(text);
  console.log(`  (turn done in ${elapsed()})`);
  return reply;
}

/** How many tool-shaped objects a reply contains. readJson picks the last balanced
 * one, so a reply with several silently ran one and dropped the rest; the model
 * believed it had delegated work that never happened. */
export const countToolCalls = (text) => [...String(text ?? '').matchAll(/\{\s*"tool"\s*:/g)].length;

/** Run the tool loop. `log` receives progress lines; the console and the
 * terminal both want them, and neither should own the other's output. */
export async function agent(task, log = console.log, fresh = true) {
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  // How long the reply currently in hand took to arrive. `elapsed()` counts from the start of the
  // run, and it was being used for both this and the tool cards — so a card for `ls` read "12.2s"
  // and the whole run looked like it was slow in the tools. It is not: they take milliseconds.
  let lastTurn = 0;
  const askModel = async (text, freshTurn = false) => {
    const startedAt = Date.now();
    const answer = await turn(text, freshTurn);
    lastTurn = (Date.now() - startedAt) / 1000;
    return answer;
  };
  if (!task.trim()) throw new Error('no task text: pass one, or --task-file <path> for long tasks');
  log(`task: ${task.length} chars | ${JSON.stringify(task.slice(0, 80))}`);
  let reply = cleanReply(await askModel(`${SYS}\n\nTask: ${task}`, fresh));
  let repairs = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    // Checked between turns, not during one: a turn is a single message to the
    // page, and the extension is asked separately to stop the generation.
    if (consoleState.stop) {
      consoleState.stop = false;
      throw new Error(`已停止 (第 ${step} 轮)`);
    }
    // A write arrives as a JSON line plus a fenced block, so it is parsed before
    // the plain tool lookup: readJson alone would see a write call with no
    // content and discard the file.
    // Order matters: the write parser is the looser one, so the declared tool is
    // checked first. Otherwise an edit reply whose first block starts a line with
    // `path = ...` is taken as a write of a file named after that expression.
    const editCall = readEditBlocks(reply);
    const writeCall = editCall ? null : readWriteBlock(reply);
    const msg = editCall ?? writeCall ?? readJson(reply);
    // Log every raw turn: a wrong or truncated answer is otherwise invisible,
    // and "the process ended without output" is undebuggable from the outside. The tail
    // is written with its real line breaks, not JSON.stringify-ed: escaping turned every
    // break into a literal \n, so a long answer read as one unbroken line in the console
    // — and the console is where the answer is read.
    log(`[${step}] +${lastTurn.toFixed(1)}s <- ${reply.slice(-200)}`);
    // Whatever it said this turn is shown as conversation, the way a chat client
    // would. A tool call is carried by the same reply, so speaking and acting are
    // not separate modes any more.
    if (reply.trim()) emit({ type: 'assistant', text: reply, at: new Date().toISOString() });
    if (msg?.done !== undefined) return String(msg.done);
    if (!msg) {
      // A reply carrying {"tool":...} that did not parse is not a plain answer.
      // Ending here is the worst outcome available: the client shows the model
      // saying what it is about to run, the run is over, and nothing says why. The
      // recorded cause is a JSON string holding an unescaped quote — a script with
      // `print("args:")` inside `stdin`, which is not JSON and never will be. The
      // probe that would have found the real bug was never run because of it.
      if (countToolCalls(reply) > 0) {
        // Stop and say so. Without this the corrective round repeats until the step
        // cap, and the run dies looking like it ran out of turns.
        if (repairs >= MAX_REPAIRS) {
          throw new Error(
            `模型连续 ${repairs} 次回了无法解析的工具调用，已停止（第 ${step} 轮）。原文在 .sessions 里，`
            + '多半是 JSON 字符串里出现了没转义的双引号：脚本内容要走文件，不要放进 "stdin" 或 "args"。',
          );
        }
        repairs++;
        log(`[${step}] tool call present but unparseable — asking for a repair (${repairs}/${MAX_REPAIRS})`);
        reply = cleanReply(
          await askModel(
            `RESULT: ${JSON.stringify(
              'ERROR: this reply looked like a tool call but was not valid JSON, so nothing ran. '
                + 'The usual cause is an unescaped double quote inside a JSON string. Never put script '
                + 'text in "stdin" or "args": write the script to a file, then run the file.',
            )}`,
          ),
        );
        continue;
      }
      // No tool named and no tool syntax anywhere: it answered in prose and is
      // finished. Requiring a done wrapper was protocol for its own sake.
      return reply;
    }
    const fn = Object.hasOwn(TOOLS, msg.tool) ? TOOLS[msg.tool] : null;
    if (!fn) {
      // Not a tool call, just prose with braces in it. Treat it as the answer.
      if (typeof msg.tool !== 'string') return reply;
      // A finishing verb under any name is a finish signal rather than a typo
      // worth a retry. The two data shapes below are what was actually observed:
      // {"tool":"done"} and {"tool":"done","args":{}}.
      // Answering ERROR here made the model quote the same example again, which
      // produced the same ERROR — a loop that explaining the error only fed.
      if (isFinishName(msg.tool)) return reply;
      // Record what was actually parsed. Without this the branch reported only
      // `no tool "undefined"` to the model and kept nothing on the server, so the
      // reply that caused it could not be examined afterwards.
      log(
        `[${step}] unparsed tool: ${JSON.stringify({
          tool: msg.tool,
          keys: Object.keys(msg),
          arg: typeof msg.arg === 'string' ? msg.arg.slice(0, 60) : msg.arg,
        })}`,
      );
      // Unknown tool is recoverable: tell the model the menu instead of dying.
      // Object.hasOwn, not `in`, so inherited names like "constructor" are not
      // mistaken for tools.
      reply = cleanReply(
        await askModel(
          `RESULT: ${JSON.stringify(`ERROR: no tool "${msg.tool}". Available: ${Object.keys(TOOLS).join(', ')}`)}`,
        ),
      );
      continue;
    }
    let result;
    // Checkpoint before the side effect: the log says the call was made before the call can
    // change anything, so a crash cannot leave it out. Nothing here waits before a model
    // turn — the model's context is the web page, not this log, so flushing first would
    // buy nothing.
    await flushLog();
    // Timed around the call itself, so the card says what the tool cost rather than how far into
    // the run it happened.
    const toolStartedAt = Date.now();
    // The human's standing permission is checked here rather than inside each tool: one place,
    // and it also covers a tool added later. `run` is on the list because it can write.
    if (consoleState.mode === 'read-only' && WRITERS.has(String(msg.tool))) {
      result = `ERROR: 现在是只读模式，${msg.tool} 不会被发出去。需要改东西就让用户在控制台把模式调成「工作区」。`;
    } else {
      try {
        result = await fn(msg);
      } catch (e) {
        // Being outside the workspace is the one refusal a human can lift, so it gets one
        // question and one retry. Everything else stays the tool's own error.
        if (msg.outside !== true || !/path escapes workspace/.test(e.message)) {
          result = `ERROR: ${e.message}`;
        } else if (consoleState.mode === 'read-only') {
          result = 'ERROR: 只读模式下工作区外一律不发。';
        } else {
          result = await askToLeave(fn, step, msg, e.message);
        }
      }
    }
    log(`[${step}] ${msg.tool} ${msg.arg ?? ''} -> ${String(result).slice(0, 120)}`);
    // A structured copy of the same step, for the console's tool cards. The text
    // log stays the record of truth; this is only for rendering.
    emit({
      type: 'tool',
      tool: String(msg.tool),
      target: typeof msg.arg === 'string' ? msg.arg : Array.isArray(msg.args) ? [msg.arg, ...msg.args].join(' ') : '',
      result: String(result),
      step,
      // What this call cost, not the run's clock. A tool that answers in 3ms used to be labelled
      // "12.2s" because the number was the run's elapsed time, which reads as "the tools are slow"
      // when they are not.
      elapsed: `${((Date.now() - toolStartedAt) / 1000).toFixed(1)}s`,
      at: new Date().toISOString(),
    });
    // What the file looked like before and after, so the client can show the
    // change instead of making the user open an editor to see it. Only on success:
    // a refused edit changed nothing.
    if (!String(result).startsWith('ERROR')) {
      if (msg.tool === 'edit') {
        emit({ type: 'change', arg: msg.arg, kind: 'edit', before: msg.old, after: msg.new, at: new Date().toISOString() });
      } else if (msg.tool === 'write') {
        emit({ type: 'change', arg: msg.arg, kind: 'write', before: null, after: msg.content, at: new Date().toISOString() });
      }
    }
    // Say when a reply carried more than one call. The parse picks the last one and
    // the extras vanish, so the model believed it had delegated work that never
    // ran; in one recorded run it apologised for doing this and then did it twice
    // more, because nothing had told it the calls were dropped rather than run.
    const extra = countToolCalls(reply) - 1;
    let note = '';
    if (extra > 0) {
      note = `\n[注意：这条回复里有 ${extra + 1} 个工具调用，只执行了最后一个，其余 ${extra} 个被丢弃。一次只发一个工具调用。]`;
      log(`[${step}] 丢弃了 ${extra} 个多余的工具调用`);
    }
    // Escape the tool output before it reaches the model. Raw file content can
    // contain quotes and braces; handing it over verbatim is what made the model
    // emit unparseable JSON when it quoted the content back.
    reply = cleanReply(await askModel(`RESULT:\n${JSON.stringify(result)}${note}`)); // same conversation, no history replay
  }
  return `(step cap reached after ${elapsed()})`;
}

// Flags are recognised, not assumed: a task can start with any word, and
// slicing the first argument off unconditionally made every plain
// `node bridge.mjs "task"` invocation arrive as an empty task.
export function parseArgs(argv) {
  const [first, ...tail] = argv;
  if (first === '--task-file') return { flag: first, text: null, file: tail[0] };
  if (first?.startsWith('--')) return { flag: first, text: tail.join(' ') };
  return { flag: null, text: argv.join(' ') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // A very long task hits the command-line length limit and arrives truncated,
  // which looks exactly like the model misreading the prompt. Read it from a
  // file when that matters.
  const text = args.file ? await readFile(safe(args.file), 'utf8') : args.text;
  try {
    await start();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  // Serve mode is the default. Start it once and leave it up: the web console
  // is then the only interface, so no terminal per task and no extension reload.
  // A task argument becomes one run and then exits, for scripting.
  if (!args.flag && !text) {
    console.log(`deepseek web bridge — open http://127.0.0.1:${PORT}`);
    console.log('the browser extension must be polling; click its toolbar icon once');
    return; // no close, no exit: stay resident
  }

  if (args.flag === '--probe') {
    console.log(`listening on http://127.0.0.1:${PORT} — probing the page`);
    console.log('probe:', JSON.stringify(await probe().catch((e) => `FAILED: ${e.message}`), null, 2));
  } else if (args.flag === '--ask') {
    console.log(`listening on http://127.0.0.1:${PORT} — sending one prompt as-is`);
    console.log(`\n${cleanReply(await ask(text))}`);
  } else {
    console.log(`listening on http://127.0.0.1:${PORT} — waiting for the extension`);
    console.log(`\n=== done ===\n${await agent(text)}`);
  }
  server.close();
  process.exit(0);
}

/** Bind the extension channel. Exported so check-protocol.mjs can drive it. */
export function start(port = PORT) {
  // The MCP config is read here, once per process: mid-run edits then need a human restart,
  // which is what keeps the model from installing a server by writing a file.
  loadMcp();
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      // A second copy is the common mistake, and the raw EADDRINUSE stack says
      // nothing about what to do. Say what is actually wrong.
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is already in use — stop the running bridge, or set BRIDGE_PORT to another port`));
      } else {
        reject(e);
      }
    });
    server.listen(port, '127.0.0.1', resolve);
  });
}

// Self-check for the only real logic here. Runs without a browser.
// Everything below runs only when this file is the entry point, never on import.
if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  if (process.argv[2] === '--selftest') {
    // Argument parsing. Slicing the first argument off unconditionally made
    // every plain `node bridge.mjs "task"` arrive as an empty task.
    assert.deepEqual(parseArgs(['找出所有 mjs 文件']), { flag: null, text: '找出所有 mjs 文件' });
    assert.deepEqual(parseArgs(['a', 'b']), { flag: null, text: 'a b' });
    assert.deepEqual(parseArgs(['--ask', '你好']), { flag: '--ask', text: '你好' });
    assert.deepEqual(parseArgs(['--probe']), { flag: '--probe', text: '' });
    assert.deepEqual(parseArgs(['--task-file', 'p.md']), { flag: '--task-file', text: null, file: 'p.md' });
    assert.deepEqual(readJson('```json\n{"tool":"ls","arg":""}\n```'), { tool: 'ls', arg: '' });
    assert.deepEqual(readJson('sure! {"done":"hi"} hope that helps'), { done: 'hi' });
    // The real shape: visible reasoning containing braces, answer at the end.
    assert.deepEqual(
      readJson('We need {"tool":"ls"} first. Maybe like {"a":{"b":1}} then\n{"tool":"read","arg":"x.md"}'),
      { tool: 'read', arg: 'x.md' },
      'must take the last object, not splice the reasoning into it',
    );
    assert.deepEqual(readJson('text {"done":"brace } inside a string"}'), { done: 'brace } inside a string' });
    // The scraped reply can carry harness markup, which the model then echoes.
    assert.deepEqual(
      readJson('{"tool":"ls","arg":"."}\n\n<system>Tool ran without output or errors</system>'),
      { tool: 'ls', arg: '.' },
      'wrapper markup must be stripped before parsing',
    );
    assert.equal(cleanReply('<system>x</system>  hi '), 'hi');
    // The request digest identifies one outbound prompt across turns and runs. A
    // length plus a tail does not: every step after the first sends a `RESULT:`
    // wrapper of similar size around a different payload.
    assert.match(promptDigest('abc'), /^[0-9a-f]{12}$/);
    assert.equal(promptDigest('abc'), promptDigest('abc'), 'the same prompt must digest the same');
    assert.notEqual(promptDigest('abc'), promptDigest('abd'), 'a different prompt must digest differently');
    assert.match(promptDigest(undefined), /^[0-9a-f]{12}$/, 'a missing prompt must not throw');
    assert.match(promptDigest({ reply: 'x' }), /^[0-9a-f]{12}$/, 'a non-string prompt must not throw');
    // Model quoted the prompt back at itself, leaving raw quotes in the string.
    assert.deepEqual(
      readJson('{"done":"No task was provided — the "Task:" line was empty."}'),
      { done: 'No task was provided — the "Task:" line was empty.' },
      'a done-only reply must be salvaged when its quotes are unescaped',
    );
    assert.equal(readJson('no json at all'), null);
    assert.equal(readJson('{broken'), null);
    assert.equal(readJson(''), null);
    assert.equal(readJson(undefined), null, 'a non-string reply must not throw');
    assert.equal(readJson({ reply: 'x' }), null, 'an object reply must not throw');
    assert.equal(safe('a/b.txt'), path.join(ROOT, 'a', 'b.txt'));
    // Tool output reaches the model escaped, so a file containing quotes cannot
    // come back as unparseable JSON.
    const quoted = JSON.stringify('run node bridge.mjs "任务"');
    assert.deepEqual(readJson(`{"done":${quoted}}`), { done: 'run node bridge.mjs "任务"' });

    // Primary protocol: ONE fence, path on its first line, no JSON at all. Two
    // formats meant the page could merge them out of alignment and lose the file;
    // one format cannot.
    //
    // `tool` is asserted everywhere below on purpose. It was missing from every
    // return of this parser while the assertions only checked arg and content, so
    // the caller looked up `TOOLS[undefined]` and every write died with
    // `no tool "undefined"` — a bug the tests could not see.
    assert.deepEqual(
      readWriteBlock('```python\n# path: tool.py\nimport sys\n\n\ndef main():\n    print("hi")\n```'),
      { tool: 'write', arg: 'tool.py', content: 'import sys\n\n\ndef main():\n    print("hi")\n' },
    );
    // The page's label and buttons can land in front of the fence.
    assert.deepEqual(readWriteBlock('python复制下载\n```\n# path: a.py\nprint(1)\n```'), {
      tool: 'write',
      arg: 'a.py',
      content: 'print(1)\n',
    });
    // ...or be glued onto the opening line, which used to break the parse.
    assert.deepEqual(readWriteBlock('```python\n# path: b.py\nprint(1)\n```python复制下载'), {
      tool: 'write',
      arg: 'b.py',
      content: 'print(1)\n',
    });
    // Indentation inside the fence is what makes generated code runnable.
    const indented = readWriteBlock('```\n# path: c.py\ndef f():\n    return 1\n```');
    assert.match(indented.content, /\n    return 1/, 'indentation must survive');
    // A fence without a path line is not a write.
    assert.equal(readWriteBlock('```\nprint(1)\n```'), null, 'a fence with no path line is not a write');

    // Legacy protocol: JSON line then a fence, in case a model answers that way
    // from older context in the same conversation.
    const fenced = '{"tool":"write","arg":"x.py"}\n```python\ndef f():\n    return 1\n```';
    assert.deepEqual(readWriteBlock(fenced), { tool: 'write', arg: 'x.py', content: 'def f():\n    return 1\n' });
    assert.equal(readWriteBlock('{"tool":"write","arg":"x.py"}'), null, 'no fence means no content');
    assert.equal(readWriteBlock('{"done":"hi"}'), null);
    assert.equal(readWriteBlock(''), null);
    // An unterminated fence still yields the body: a stream cut short is better
    // reported than silently dropped. Its content has no trailing newline,
    // because there is no closing fence to slice off.
    assert.deepEqual(readWriteBlock('{"tool":"write","arg":"y.py"}\n```\nprint(1)'), {
      tool: 'write',
      arg: 'y.py',
      content: 'print(1)',
    });
    assert.deepEqual(readWriteBlock('```\n# path: y2.py\nprint(1)'), {
      tool: 'write',
      arg: 'y2.py',
      content: 'print(1)',
    });
    const real = '{"tool":"write","arg":"tool.py"}\n```\nimport sys\n\n\ndef main():\n    print("hi")\n```';
    assert.deepEqual(readWriteBlock(real), {
      tool: 'write',
      arg: 'tool.py',
      content: 'import sys\n\n\ndef main():\n    print("hi")\n',
    });
    assert.match(readWriteBlock(real).content, /\n    print\("hi"\)/);
    assert.doesNotMatch(readWriteBlock(real).content, /^python/, 'the language label must not become the first line');

    // The page's own header can land ON the JSON line, which is what made three
    // write calls fail: `{"tool":"write","arg":"x.py"}python复制下载`.
    assert.deepEqual(readWriteBlock('{"tool":"write","arg":"simple.py"}python复制下载\n```\nprint(1)\n```'), {
      tool: 'write',
      arg: 'simple.py',
      content: 'print(1)\n',
    });
    // No fence at all: the body after the JSON line is still the file.
    const bare = readWriteBlock('{"tool":"write","arg":"b.py"}python复制下载\nimport sys\nname = "世界"');
    assert.equal(bare.arg, 'b.py');
    assert.equal(bare.content, 'import sys\nname = "世界"\n');
    assert.equal(bare.unfenced, true, 'an unfenced body must be flagged so it can be reported');
    // Chrome words must never survive into a file.
    assert.doesNotMatch(bare.content, /复制|下载|python/);
    // Prose after the fence must not leak into the file content.
    const withProse = `{"tool":"write","arg":"z.py"}\n\`\`\`\nprint(1)\n\`\`\`\n\nThat writes a file.`;
    assert.equal(readWriteBlock(withProse).content, 'print(1)\n');

    // Every parsed write must name a real tool, or the caller looks up
    // TOOLS[undefined] and the file is lost with `no tool "undefined"`. This one
    // assertion is what the field-by-field checks above could not provide.
    for (const src of [
      '```\n# path: k1.py\nprint(1)\n```',
      '{"tool":"write","arg":"k2.py"}\n```\nprint(1)\n```',
      '{"tool":"write","arg":"k3.py"}python复制下载\nprint(1)',
    ]) {
      const parsed = readWriteBlock(src);
      assert.ok(parsed, `should parse: ${src.slice(0, 30)}`);
      assert.ok(
        Object.hasOwn(TOOLS, parsed.tool),
        `parsed write must carry a known tool, got ${JSON.stringify(parsed.tool)}`,
      );
      assert.equal(typeof parsed.arg, 'string');
      assert.equal(typeof parsed.content, 'string');
    }

    // A reply that is an edit must NOT parse as a write. The write parser is the
    // looser one, and with an optional comment marker it read the line
    // `    path = sys.argv[2]` as a path declaration, then created a file with
    // exactly that name and left the real target untouched.
    const editLookingLikeWrite = [
      '{"tool":"edit","arg":"tool.py"}',
      '```',
      '    path = sys.argv[2]',
      "    with open(path, 'r', encoding='utf-8') as f:",
      '        text = f.read()',
      '```',
      '```',
      '    path = sys.argv[2]',
      '    if path == "-":',
      '        text = sys.stdin.read()',
      '```',
    ].join('\n');
    assert.equal(readWriteBlock(editLookingLikeWrite), null, 'an edit reply must not parse as a write');
    assert.equal(readEditBlocks(editLookingLikeWrite)?.tool, 'edit');
    // A bare `path = ...` line is never a path declaration; the marker is required.
    assert.equal(readWriteBlock('```\npath = sys.argv[2]\nprint(1)\n```'), null);
    assert.equal(readWriteBlock('```\n# path: ok.py\nprint(1)\n```')?.arg, 'ok.py');

    // An edit as two fences. The point is that quotes need no escaping: the model
    // editing code writes `"-"` constantly, and as a JSON string that quote made
    // the whole reply unparseable and the edit was lost.
    const editReply = [
      '{"tool":"edit","arg":"tool.py"}',
      '```',
      '    path = sys.argv[2]',
      "    with open(path, 'r', encoding='utf-8') as f:",
      '        text = f.read()',
      '```',
      '```',
      '    path = sys.argv[2]',
      '    if path == "-":',
      '        text = sys.stdin.read()',
      '    else:',
      "        with open(path, 'r', encoding='utf-8-sig') as f:",
      '            text = f.read()',
      '```',
    ].join('\n');
    assert.deepEqual(readEditBlocks(editReply), {
      tool: 'edit',
      arg: 'tool.py',
      old: "    path = sys.argv[2]\n    with open(path, 'r', encoding='utf-8') as f:\n        text = f.read()\n",
      new:
        '    path = sys.argv[2]\n    if path == "-":\n        text = sys.stdin.read()\n    else:\n' +
        "        with open(path, 'r', encoding='utf-8-sig') as f:\n            text = f.read()\n",
    });
    assert.match(readEditBlocks(editReply).new, /path == "-"/, 'quotes need no escaping');
    assert.match(readEditBlocks(editReply).old, /^ {4}path = sys\.argv\[2\]/, 'indentation of the first line must survive');
    // One fence is not an edit.
    assert.equal(readEditBlocks('{"tool":"edit","arg":"x.py"}\n```\nonly one\n```'), null);
    assert.equal(readEditBlocks('{"tool":"write","arg":"x.py"}\n```\na\n```\n```\nb\n```'), null);

    // A bare {"tool":"done"} in prose is a finish signal. Dispatching it produced
    // `no tool "done"`, whose ERROR reply made the model repeat the same example,
    // which produced the same ERROR — a loop that explaining the error only fed.
    assert.ok(isFinishName('done') && isFinishName('DONE') && isFinishName('finish'));
    assert.ok(!isFinishName('ls') && !isFinishName('read') && !isFinishName('donex'));
    assert.ok(!isFinishName(undefined) && !isFinishName({}));

    // A reply with several tool calls runs only the last one; the extras vanish
    // silently, so the model thinks it delegated work that never happened.
    assert.equal(countToolCalls('{"tool":"ls","arg":"."}'), 1);
    assert.equal(countToolCalls('{"tool":"a"}{"tool":"b"}'), 2);
    assert.equal(countToolCalls('x {"tool":"a"} y {"tool":"b"} z {"tool":"c"}'), 3);
    assert.equal(countToolCalls('no calls here'), 0);
    assert.equal(countToolCalls(undefined), 0);

    // Tool behavior. The edit tool is the one with real branching, so it gets
    // tested against a scratch file rather than only through error paths.
    assert.match(await TOOLS.glob({ arg: '**/*.mjs' }), /bridge\.mjs/);
    assert.match(await TOOLS.grep({ arg: 'waiting for the extension' }), /bridge\.mjs:\d+:/);
    assert.match(await TOOLS.ls({ arg: '.' }), /README\.md/);
    // ls and glob must agree about what is in the directory. They did not: glob
    // skipped the run tool's scratch files and ls listed them, and a run that saw
    // the disagreement read its own in-flight log as leaked temp files.
    const noise = safe('.run-9999-out.tmp');
    await writeFile(noise, 'x', 'utf8');
    try {
      assert.ok(!(await TOOLS.ls({ arg: '.' })).includes('.run-'), 'ls must hide the run tool scratch files');
      assert.match(await TOOLS.glob({ arg: '.*' }), /^\.gitignore$/m, 'and glob still lists the real dotfiles');
    } finally {
      await rm(noise, { force: true });
    }
    // The skill name indexes a file, so the name check is the whole boundary:
    // a separator or a dot must be refused before it ever reaches readFile.
    await mkdir(SKILLS, { recursive: true });
    const skillFile = path.join(SKILLS, 'selftest-skill.md');
    await writeFile(skillFile, '# heading is the description\nrule one\n', 'utf8');
    try {
      assert.match(await TOOLS.skill({ arg: 'selftest-skill' }), /^# heading is the description/, 'reading a skill returns the file');
      assert.match(await TOOLS.skill({ arg: 'selftest-skill' }), /rule one/);
      // The listing is what the model picks from, so the name alone is not enough:
      // the first line of the file is its one-line description. A heading that
      // repeats the file name reads as a stutter, which is why the convention is
      // "first line describes, it does not name".
      assert.match(
        await TOOLS.skill({}),
        /^- selftest-skill — heading is the description$/m,
        'the listing must carry the name and its first line, or the model picks blind',
      );
      const unknown = await TOOLS.skill({ arg: 'no-such-skill' });
      assert.match(unknown, /no skill named no-such-skill/);
      assert.match(unknown, /selftest-skill/, 'an unknown name must answer with the menu to pick from');
      for (const bad of ['../README', '..\\README', '/etc/passwd', 'a/b', 'selftest-skill.md', '.hidden']) {
        await assert.rejects(() => TOOLS.skill({ arg: bad }), /bad skill name/, `"${bad}" must be refused, not resolved`);
      }
      // A directory whose name looks like a skill must not take the menu down with
      // it: reading it throws EISDIR, so the listing fails outright and the model
      // cannot see any skill at all. Without the `isFile()` filter this throws
      // instead of returning the menu.
      const skillDir = path.join(SKILLS, 'selftest-dir.md');
      await mkdir(skillDir, { recursive: true });
      try {
        assert.match(await TOOLS.skill({}), /^- selftest-skill — /m, 'a directory must not hide the real skills');
      } finally {
        await rm(skillDir, { recursive: true, force: true });
      }
      // A skill long enough to crowd out the task says so instead of arriving half-read.
      await writeFile(skillFile, `# selftest-skill\n${'x'.repeat(SKILL_LIMIT + 10)}`, 'utf8');
      assert.match(await TOOLS.skill({ arg: 'selftest-skill' }), /已截断/, 'an oversized skill must say it was cut');
    } finally {
      await rm(skillFile, { force: true });
    }
    assert.match(await TOOLS.read({ arg: 'README.md' }), /deepseek web bridge/);
    // The extension announces its own version and the server compares. A mismatch
    // only ever showed up as a red line in the client, which is one reload too late:
    // the run then fails on stale scraping code. Bumping one file and not the other
    // is a one-word mistake with a confusing symptom, so it fails here instead.
    const contentSrc = await readFile(safe('ext/content.js'), 'utf8');
    assert.equal(
      Number(contentSrc.match(/CONTENT_VERSION = (\d+)/)[1]),
      CONTENT_VERSION,
      'ext/content.js and bridge.mjs must agree on CONTENT_VERSION',
    );
    // A windowed read is numbered, so the model can name the lines it saw.
    const windowed = await TOOLS.read({ arg: 'README.md', offset: 3, limit: 2 });
    assert.match(windowed, /第 3-4 行，共 \d+ 行/);
    assert.match(windowed, /^3: /m);
    assert.match(windowed, /^4: /m);
    // An oversized read says where it stopped and how to continue, instead of
    // truncating silently — that silence is why slice scripts kept getting written.
    const big = safe('.selftest-big.txt');
    await writeFile(big, Array.from({ length: 400 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`).join('\n'), 'utf8');
    try {
      const truncated = await TOOLS.read({ arg: '.selftest-big.txt' });
      assert.match(truncated, /已截断/, 'a truncated read must say so');
      assert.match(truncated, /"offset":\d+/, 'a truncated read must say how to continue');
      assert.match(await TOOLS.read({ arg: '.selftest-big.txt', offset: 300, limit: 5 }), /^300: line 300/m);
      // The size guard is a crash guard: read loads the whole file before it cuts
      // anything, so without this one call on a large log takes the server down.
      // Written as a real file because the guard reads the real size.
      const huge = safe('.selftest-huge.txt');
      await writeFile(huge, Buffer.alloc(MAX_READ_BYTES + 1, 120));
      try {
        await assert.rejects(
          () => TOOLS.read({ arg: '.selftest-huge.txt' }),
          /over the \d+-byte limit/,
          'a file over the read limit must be refused, not loaded',
        );
        // A window must not be a way around it: the window is cut after the load.
        await assert.rejects(() => TOOLS.read({ arg: '.selftest-huge.txt', offset: 1, limit: 1 }), /over the \d+-byte limit/);
      } finally {
        await rm(huge, { force: true });
      }
      // A CRLF file must reach the model as LF. The `\r` is invisible in the
      // transcript, so without this the model copies text that looks right and
      // silently fails to match. Asserted on the windowed form too, where the
      // `\r` would land between the line number and the text.
      const crlfFile = safe('.selftest-crlf.txt');
      await writeFile(crlfFile, 'a\r\nb\r\nc\r\n', 'utf8');
      try {
        assert.equal(await TOOLS.read({ arg: '.selftest-crlf.txt' }), 'a\nb\nc\n', 'CRLF read must come back LF');
        // The windowed form is checked on the line, not on the header. The header is
        // a format string that will legitimately change, and a test pinned to it then
        // fails for the wrong reason — the mistake NEXT.md warns about, made again
        // here. `\r` would land between the number and the text, so look for it.
        const oneLine = await TOOLS.read({ arg: '.selftest-crlf.txt', offset: 2, limit: 1 });
        assert.match(oneLine, /^2: b$/m, 'a windowed CRLF read must number the LF line');
        assert.ok(!oneLine.includes('\r'), 'no carriage return may survive a windowed read');
      } finally {
        await rm(crlfFile, { force: true });
      }
    } finally {
      await rm(big, { force: true });
    }
    assert.throws(() => safe('../outside'));

    // The loop's own transcripts must stay out of its own searches. `.sessions`
    // grows with every run, so without the exclusion a grep for a common word
    // returns the agent's past chatter instead of the code — a degradation that
    // gets worse the more the tool is used.
    await mkdir(SESSIONS, { recursive: true });
    const sentinel = path.join(SESSIONS, '.selftest-sentinel.jsonl');
    // Built at runtime, not written literally: the word must not appear in this
    // file, or grep finds the assertion text instead of the sentinel.
    const word = ['ZZ', 'SENT', 'INEL', 'ZZ'].join('');
    await writeFile(sentinel, `{"type":"log","text":"${word}"}\n`, 'utf8');
    try {
      assert.doesNotMatch(await TOOLS.grep({ arg: word }), new RegExp(word), 'grep must not search .sessions');
      assert.doesNotMatch(await TOOLS.glob({ arg: '**/*.jsonl' }), /\.sessions/, 'glob must not list .sessions');
      // The exclusion is for the walkers only: reading them is still the point.
      assert.match(await TOOLS.read({ arg: '.sessions/.selftest-sentinel.jsonl' }), new RegExp(word));
    } finally {
      await rm(sentinel, { force: true });
    }

    const scratch = safe('.selftest-scratch.txt');
    await writeFile(scratch, 'keep me\nchange this line\nkeep me too\n', 'utf8');
    try {
      // The file was created behind the bridge's back, so the first edit has to be refused:
      // that refusal IS the observed-file rule, and this is where it is asserted against the
      // real tools rather than against a helper.
      await assert.rejects(
        () => TOOLS.edit({ arg: '.selftest-scratch.txt', old: 'change this line', new: 'changed' }),
        /要先看这个文件/,
        'editing a file nobody looked at must be refused',
      );
      await TOOLS.read({ arg: '.selftest-scratch.txt' });
      assert.equal(await TOOLS.edit({ arg: '.selftest-scratch.txt', old: 'change this line', new: 'changed' }), 'edited .selftest-scratch.txt');
      assert.equal(await readFile(scratch, 'utf8'), 'keep me\nchanged\nkeep me too\n');
      // Changing the file behind the bridge's back after the read is the other half of the rule.
      await writeFile(scratch, 'keep me\nsomeone else typed here\nkeep me too\n', 'utf8');
      await assert.rejects(
        () => TOOLS.edit({ arg: '.selftest-scratch.txt', old: 'someone else typed here', new: 'x' }),
        /在你读过之后变了/,
        'a file that moved since the read must be refused, not edited',
      );
      await TOOLS.read({ arg: '.selftest-scratch.txt' });
      await assert.rejects(
        () => TOOLS.edit({ arg: '.selftest-scratch.txt', old: 'nope', new: 'x' }),
        /not found/,
        'a non-matching old string must be reported, not silently written',
      );
      await assert.rejects(
        () => TOOLS.edit({ arg: '.selftest-scratch.txt', old: 'keep me', new: 'x' }),
        /matches 2 places/,
        'an ambiguous old string must be refused',
      );
      await assert.rejects(() => TOOLS.edit({ arg: '.selftest-scratch.txt', new: 'x' }), /two fenced blocks/);

      // write must land the fenced body byte for byte, indentation included.
      const written = safe('.selftest-written.py');
      try {
        // The primary protocol: one fence, path on its first line.
        const call = readWriteBlock('```python\n# path: .selftest-written.py\ndef f():\n    return 1\n```');
        const result = await TOOLS.write(call);
        assert.match(result, /wrote/);
        assert.doesNotMatch(result, /WARNING/, 'a fenced write must not warn');
        assert.equal(await readFile(written, 'utf8'), 'def f():\n    return 1\n', 'indentation must survive write');
        // The reported count is what the model uses to decide the file landed whole,
        // so it must not be off by one. `split('\n')` counted the empty tail as a line
        // and answered "(2 lines)" for a one-line file — confirmed in four separate
        // runs, and one of them spent a whole turn re-reading the file over it.
        const oneLiner = await TOOLS.write({ arg: '.selftest-oneline.txt', content: 'x\n' });
        assert.equal(
          Number((oneLiner.match(/\((\d+)\s*lines?\)/) ?? [])[1]),
          (await readFile(safe('.selftest-oneline.txt'), 'utf8')).replace(/\n$/, '').split('\n').length,
          `the reported line count must be the real one: ${oneLiner}`,
        );
        await assert.rejects(() => TOOLS.write(null), /fenced block/, 'a null call must be reported, not throw a TypeError');
        await assert.rejects(() => TOOLS.write({ arg: 'x.py' }), /fenced block/, 'a call with no content must be reported');
        // A path that looks like code must be refused rather than created.
        await assert.rejects(
          () => TOOLS.write({ tool: 'write', arg: 'sys.argv[2]', content: 'print(1)\n' }),
          /not a file path/,
          'a code expression must never become a filename',
        );

        // The legacy protocol, JSON line then fence, still has to work.
        const legacy = readWriteBlock('{"tool":"write","arg":".selftest-written.py"}\n```\ndef f():\n    return 1\n```');
        assert.match(await TOOLS.write(legacy), /wrote/);
        assert.equal(await readFile(written, 'utf8'), 'def f():\n    return 1\n');

        // The un-fenced path: header glued to the JSON line, body after it.
        const bare = readWriteBlock(
          '{"tool":"write","arg":".selftest-written.py"}python复制下载\nimport sys\nprint(1)',
        );
        const bareResult = await TOOLS.write(bare);
        assert.match(bareResult, /WARNING/, 'an unfenced write must say so');
        assert.equal(await readFile(written, 'utf8'), 'import sys\nprint(1)\n');
      } finally {
        await rm(written, { force: true });
        await rm(safe('.selftest-oneline.txt'), { force: true });
      }
    } finally {
      await rm(scratch, { force: true });
    }
    // The other half of the observed-file rule, for write: creating a file is free, overwriting
    // one nobody looked at is not, and a file this process wrote counts as looked at.
    const overwrite = safe('.selftest-overwrite.txt');
    await writeFile(overwrite, 'not looked at\n', 'utf8');
    try {
      await assert.rejects(
        () => TOOLS.write({ arg: '.selftest-overwrite.txt', content: 'clobber\n' }),
        /要先看这个文件/,
        'overwriting a file nobody looked at must be refused',
      );
      await TOOLS.read({ arg: '.selftest-overwrite.txt' });
      assert.match(await TOOLS.write({ arg: '.selftest-overwrite.txt', content: 'clobber\n' }), /wrote/);
      // No read between these two: writing it is what makes it observed.
      assert.match(await TOOLS.write({ arg: '.selftest-overwrite.txt', content: 'again\n' }), /wrote/);
    } finally {
      await rm(overwrite, { force: true });
    }
    // A truncated run keeps its whole output in `.spill` and names the path. Before this
    // the full text was deleted, so the middle the model was cut out of could only be
    // recovered by re-running the script and hoping it printed less this time.
    const body = `MARKER7391${'x'.repeat(9000)}`;
    const spilled = await TOOLS.run({ arg: 'node', args: ['-'], stdin: `process.stdout.write(${JSON.stringify(body)})` });
    assert.match(spilled, /中间省略/, 'a truncated run must say it was cut');
    const spillPath = (spilled.match(/全文在 (\.spill\/\S+\.txt)/) ?? [])[1];
    assert.ok(spillPath, `the notice must name the spill file: ${spilled.slice(0, 160)}`);
    try {
      assert.equal(
        await readFile(safe(spillPath), 'utf8'),
        body,
        'the spill file must hold the whole output, byte for byte',
      );
      // Readable by the path in the notice, which is the only thing the model is given.
      assert.match(await TOOLS.read({ arg: spillPath, offset: 1, limit: 1 }), /MARKER7391/);
    } finally {
      await rm(safe(spillPath), { force: true });
    }
    // A run under the cap must not leave anything behind: spilling is for the cut case only.
    const quiet = await TOOLS.run({ arg: 'node', args: ['-'], stdin: 'process.stdout.write("small")' });
    assert.equal(quiet.trim(), 'small\n[exit 0]', JSON.stringify(quiet));

    // The call's own clock. Before this the 30s default was the whole story: a build or a test
    // suite that took 40s could not be run at all, and the only workaround was not to run it —
    // which is the one thing the loop exists to do. The script sleeps far past the asked-for
    // clock, so a run that comes back fast proves the number was used and not merely accepted.
    const slowStart = Date.now();
    const asked = await TOOLS.run({
      arg: 'node',
      args: ['-'],
      timeout: 1200,
      stdin: 'setTimeout(() => process.stdout.write("never"), 20000)',
    });
    const slowTook = Date.now() - slowStart;
    assert.match(asked, /\[exit timeout/, `a call may shorten its own clock: ${JSON.stringify(asked)}`);
    assert.ok(slowTook < 8000, `and the clock asked for is the one used, not the default: ${slowTook}ms`);

    // grep's four new knobs, on a file built for exactly these questions. Context and case were a
    // read away each, glob a walk away, and the cap was a constant the model could not raise.
    const scratchDir = safe('.selftest-scratch');
    await rm(scratchDir, { recursive: true, force: true });
    // Written through `write`, which is also the new mkdir: two folders deep, none of which exist.
    await TOOLS.write({ arg: '.selftest-scratch/deep/sample.txt', content: 'CONFIG = 1\nnext\nCONFIG = 2\n' });
    await TOOLS.write({ arg: '.selftest-scratch/sample.txt', content: 'CONFIG = 1\nnext\nCONFIG = 2\n' });
    await TOOLS.write({ arg: '.selftest-scratch/other.txt', content: 'x\n' });
    try {
      assert.match(await TOOLS.read({ arg: '.selftest-scratch/deep/sample.txt' }), /CONFIG = 1/, 'write must make the folders a new file needs');
      assert.equal(
        (await TOOLS.grep({ arg: 'config', glob: '.selftest-scratch/deep/*.txt' })).split('\n').length,
        2,
        'glob must pick the files to search, case-insensitively by default',
      );
      assert.equal(
        await TOOLS.grep({ arg: 'config', glob: '.selftest-scratch/deep/*.txt', i: false }),
        'no matches',
        '"i":false must make the search case-sensitive',
      );
      assert.equal(
        await TOOLS.grep({ arg: 'config = 1', context: 1, glob: '.selftest-scratch/deep/*.txt' }).then((r) => r.split('\n').length),
        2,
        'context must bring the lines around a match',
      );
      assert.match(await TOOLS.grep({ arg: 'config', max: 1, glob: '.selftest-scratch/deep/*.txt' }), /已到上限/, 'a cut list must say it was cut');
      assert.doesNotMatch(await TOOLS.grep({ arg: 'config', max: 50, glob: '.selftest-scratch/deep/*.txt' }), /已到上限/, 'and must not say so when it was not');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }

    // fs: the three operations nothing else covered. A delete is a move into the bridge's trash, so
    // a wrong one is recoverable — that is the whole reason the tool may delete at all.
    const fsDir = safe('.selftest-fs');
    const doomed = safe('.selftest-fs/doomed.txt');
    const movedTo = safe('.selftest-fs/moved.txt');
    await rm(fsDir, { recursive: true, force: true });
    await TOOLS.fs({ verb: 'mkdir', args: ['.selftest-fs/sub', '.selftest-fs/other'] });
    assert.ok(statSync(safe('.selftest-fs/sub')).isDirectory() && statSync(safe('.selftest-fs/other')).isDirectory(), 'mkdir must make every path it is given');
    await writeFile(doomed, 'bye\n', 'utf8');
    await TOOLS.read({ arg: '.selftest-fs/doomed.txt' });
    assert.match(await TOOLS.fs({ verb: 'move', arg: '.selftest-fs/doomed.txt', to: '.selftest-fs/moved.txt' }), /moved/, 'move must report the move');
    assert.equal(await readFile(movedTo, 'utf8'), 'bye\n', 'and the bytes must arrive');
    assert.throws(() => statSync(doomed), 'with nothing left at the old path');
    // A file nobody looked at is not deleted, for the same reason it is not overwritten.
    await writeFile(safe('.selftest-fs/unread.txt'), 'still here\n', 'utf8');
    await assert.rejects(
      () => TOOLS.fs({ verb: 'delete', arg: '.selftest-fs/unread.txt' }),
      /要先看这个文件/,
      'deleting a file nobody read must be refused',
    );
    // A folder takes its contents with it, so it is asked for by name rather than guessed from the
    // path — an ordinary `delete` on a directory must refuse, not empty it.
    await TOOLS.read({ arg: '.selftest-fs/moved.txt' });
    await assert.rejects(() => TOOLS.fs({ verb: 'delete', arg: '.selftest-fs' }), /"recursive":true/, 'a folder needs recursive:true');
    await TOOLS.read({ arg: '.selftest-fs/unread.txt' });
    // The trash folders this check creates are named after the moment, so they are listed before
    // and after rather than guessed at. A check that leaves its own deletions in the drawer would
    // make the drawer grow by two folders per run.
    const trashBefore = await readdir(path.join(HERE, TRASH_DIR)).catch(() => []);
    try {
      assert.match(
        await TOOLS.fs({ verb: 'delete', args: ['.selftest-fs/moved.txt', '.selftest-fs/unread.txt'] }),
        /可恢复/,
        'a delete must say where it went',
      );
      assert.throws(() => statSync(movedTo), 'what was deleted is gone from the workspace');
      // Recoverable, which is the whole reason a delete is allowed at all: the bytes are still on
      // disk, so a wrong one costs a person a drag instead of a rewrite.
      const parked = (await readdir(path.join(HERE, TRASH_DIR), { recursive: true })).map(String);
      assert.ok(
        parked.some((f) => f.endsWith('moved.txt')),
        `a deleted file must be recoverable from ${TRASH_DIR}/: ${parked.join(', ')}`,
      );
    } finally {
      const left = await readdir(path.join(HERE, TRASH_DIR)).catch(() => []);
      for (const folder of left) {
        if (!trashBefore.includes(folder)) await rm(path.join(HERE, TRASH_DIR, folder), { recursive: true, force: true });
      }
      // The drawer itself goes too, now empty, whether or not this check is what made it: an empty
      // `.trash` in a clean checkout is residue all the same.
      await rm(path.join(HERE, TRASH_DIR), { recursive: true, force: true });
    }
    await rm(fsDir, { recursive: true, force: true });
    // A folder has to be deletable, and this is the case that proved it was not. The look-first
    // rule cannot apply to a directory: `read` answers EISDIR, and `ls` looks without recording —
    // so the gate demanded an action no tool could perform, and the folder was stuck for good.
    // An empty one is the sharpest case, because there is not even a file inside to read instead.
    const emptyDir = safe('.selftest-fs-empty');
    await mkdir(emptyDir, { recursive: true });
    assert.equal(await TOOLS.ls({ arg: '.selftest-fs-empty' }), '', 'the folder is empty, as a person would see it');
    assert.match(
      await TOOLS.fs({ verb: 'delete', arg: '.selftest-fs-empty', recursive: true }),
      /可恢复/,
      'an empty folder must be deletable: reading it is impossible, so it must not be required',
    );
    assert.throws(() => statSync(emptyDir), 'and it is gone');
    // Moving a folder is the same dead end, so it is the same rule.
    await mkdir(safe('.selftest-fs-move/inner'), { recursive: true });
    assert.match(
      await TOOLS.fs({ verb: 'move', arg: '.selftest-fs-move', to: '.selftest-fs-moved' }),
      /moved/,
      'a folder must be movable for the same reason it is deletable',
    );
    assert.ok(statSync(safe('.selftest-fs-moved/inner')).isDirectory(), 'with its contents');
    await rm(safe('.selftest-fs-moved'), { recursive: true, force: true });
    await rm(path.join(HERE, TRASH_DIR), { recursive: true, force: true });
    // The same trap in the tools that are NOT `fs`: a folder handed to `read` came back as a bare
    // EISDIR from inside readFile, and handed to write/edit as "read it first" — for a folder,
    // where `read` can never succeed. Each says what to do instead.
    const dirTarget = safe('.selftest-fs-dir');
    await mkdir(dirTarget, { recursive: true });
    await assert.rejects(() => TOOLS.read({ arg: '.selftest-fs-dir' }), /是文件夹.*ls/, 'read on a folder must point at ls');
    await assert.rejects(() => TOOLS.write({ arg: '.selftest-fs-dir', content: 'x' }), /是文件夹/, 'write on a folder must not ask for a read that cannot happen');
    await assert.rejects(() => TOOLS.edit({ arg: '.selftest-fs-dir', old: 'a', new: 'b' }), /是文件夹/, 'and neither must edit');
    // A path that is simply not there keeps its own answer: ENOENT is right for that case, and
    // the folder check must not turn it into something else.
    await assert.rejects(() => TOOLS.read({ arg: '.selftest-fs-missing.txt' }), /ENOENT|no such file/, 'a missing file still reports ENOENT');
    await rm(dirTarget, { recursive: true, force: true });
    // The trash is the bridge's own drawer, not workspace content: a listing must never show it, or
    // every "what is in here" answer fills up with yesterday's deletions.
    assert.ok(!(await TOOLS.ls({ arg: '.' })).includes(TRASH_DIR), 'the trash must stay out of ls');
    // The fence, the mode, and the one-shot approval all meet in `safe()`, so one set of
    // assertions covers the three, and none of them needs a server. The read-only gate is not
    // here on purpose: it lives in the loop, so check-protocol drives it through a real run.
    consoleState.mode = 'workspace';
    await assert.rejects(() => TOOLS.ls({ arg: '..' }), /path escapes workspace/, 'the fence holds in workspace mode');
    // The refusal is the only place the model learns it may ask, so the hint is load-bearing.
    await assert.rejects(() => TOOLS.ls({ arg: '..' }), /"outside":true/, 'and the refusal says how to ask');
    // There is no standing "allow anything": only the one-call flag below opens the fence, and
    // the list of modes itself is asserted here so removing a mode cannot leave a button behind.
    assert.deepEqual(MODES, ['read-only', 'workspace'], 'the modes a person may pick');
    // The flag the loop sets only after a human allows one call, and only for that call.
    approvedCall = true;
    try {
      assert.ok((await TOOLS.ls({ arg: '..' })).length > 0, 'an approved call passes the fence');
    } finally {
      approvedCall = false;
    }
    await assert.rejects(() => TOOLS.ls({ arg: '..' }), /path escapes workspace/, 'and the fence is back right after');

    // A question blocks until an answer arrives, and the answer is the tool result. The HTTP
    // half of this is asserted in check-protocol; here it is the tool's own contract.
    const asking = TOOLS.ask({ arg: '选哪个？', options: ['a', 'b'] });
    const question = [...pendingAsks.values()][0];
    assert.ok(question, 'the question must be waiting for an answer');
    assert.equal(question.kind, 'question', 'and it must be a question, not an approval');
    question.resolve({ text: 'a', allow: false });
    assert.match(await asking, /用户回答：a/, 'the answer must come back as the tool result');
    assert.equal(pendingAsks.size, 0, 'and the question must not stay pending');
    await assert.rejects(() => TOOLS.ask({ arg: '  ' }), /"arg"/, 'a question with no text must be refused');

    // The workspace is the fence: every tool path resolves against it, so moving it moves the
    // boundary. Asserted here because that one fact is the whole feature, and because it is cheap
    // to check without a server.
    const homeRoot = workspaceOf();
    const savedSetting = await readFile(WORKSPACE_FILE, 'utf8').catch(() => null);
    const sub = safe('.selftest-workspace');
    await mkdir(sub, { recursive: true });
    try {
      assert.equal(await setWorkspace(sub), sub, 'the switch resolves and returns the new workspace');
      assert.equal(workspaceOf(), sub, 'and the tools follow it');
      assert.equal(safe('inside.txt'), path.join(sub, 'inside.txt'), 'a relative path resolves inside it');
      await assert.rejects(() => TOOLS.ls({ arg: '..' }), /path escapes workspace/, 'climbing out of it is still refused');
      await assert.rejects(() => setWorkspace(path.join(sub, 'nope')), /ENOENT|no such file/, 'a missing folder is refused, not adopted');
      await assert.rejects(() => setWorkspace('   '), /给一个路径/, 'an empty path says so');
    } finally {
      // Put the person's own setting back, exactly as it was, and leave no test folder behind.
      await setWorkspace(homeRoot);
      if (savedSetting === null) await rm(WORKSPACE_FILE, { force: true });
      else await writeFile(WORKSPACE_FILE, savedSetting, 'utf8');
      await rm(sub, { recursive: true, force: true });
    }

    // Every tool the instructions name must exist. A renamed or deleted tool that the
    // prompt still advertises costs a round on a name that resolves to nothing, and
    // that prompt is the only description of the tool set the model ever sees. The
    // reverse is deliberately not asserted: `write` is reached through the fenced
    // protocol instead of naming itself in JSON, which is a difference, not a gap.
    for (const [, named] of SYS.matchAll(/\{"tool":"(\w+)"/g)) {
      assert.ok(Object.hasOwn(TOOLS, named), `the instructions name "${named}", which is not a tool`);
    }
    console.log('selftest ok');
  } else {
    await main();
  }
}
