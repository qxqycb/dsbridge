// Bumped whenever this file's scraping behaviour changes. The probe reports it
// and the server compares it with its own copy, because a page still running an
// older content script behaves differently with no other visible symptom — that
// wasted three debugging rounds.
const CONTENT_VERSION = 14;

// Runs on chat.deepseek.com. Injects a prompt, waits for the answer to stop
// streaming, hands the text back to the service worker.
//
// ponytail: this file is the whole maintenance surface. If the site changes,
// run `node bridge.mjs --probe` and fix the candidate arrays below.
//
// ==== verified DOM baseline, 2026-09-25 ====
// Frozen from a live --probe run. When something stops working, diff the new
// probe output against this: the first line that differs is the break.
//
// input   <textarea class="_27c9245 ds-scroll-area ..." placeholder="给 DeepSeek 发送消息 "
//                  rows="2" autocomplete="off" name="search">
// send    <div role="button" tabindex="0" style="--dsl-button-height: 34px;"
//                  class="ds-button ds-button--primary ds-button--filled
//                         ds-button--circle ds-button--m ds-button--icon-relative-m _52c986b">
//         Its sibling is the Deep Think toggle:
//                  class="ds-button ds-button--iconLabelPrimary ... f02f0e25"
//         Both carry `primary`, which is why SEND excludes `iconLabel`.
// reply   <div class="ds-markdown ds-assistant-message-main-content"> — the
//         answer body. ANSWER matches that second class directly, which is
//         stronger than the older trick of taking .ds-markdown and excluding
//         the reasoning: the Deep Think monologue shares .ds-markdown and is
//         only distinguishable by its ds-think-content ancestor.
//             answer    div.ds-markdown.ds-assistant-message-main-content
//                         > div.ds-message
//             reasoning div.ds-markdown > div.ds-think-content > div.ds-message
//         Measured 2026-09-25; matching .ds-markdown alone scraped reasoning.
//
// Class names starting with `_` are build hashes (_27c9245, _52c986b, f02f0e25)
// and change on every deploy. Never match on them; prefer aria-label,
// data-testid, then the semantic `ds-*` names.
// ===========================================
const REPLY = ['.ds-markdown'];
// The reasoning wrapper. Excluding it is what separates the answer from the
// model's visible monologue.
const THINKING = '.ds-think-content';
// Measured 2026-09-25: the answer body carries this class directly, so it names
// the answer instead of inferring it by excluding the reasoning. Preferred over
// the exclusion below when present.
const ANSWER = '.ds-assistant-message-main-content';
// Both the reasoning and the answer live inside one message container, so the
// newest container is the right place to look. Anchoring there also keeps the
// user's own prompt out: it is a different container, and it renders as
// markdown too.
const MESSAGE = '.ds-message';

// The newest answer. No fallback to the reasoning text on purpose: an empty
// reply is a visible failure, whereas scraping the monologue looks like a
// working run that answers with its own thoughts.
const pickReply = () => {
  const direct = document.querySelectorAll(ANSWER);
  if (direct.length) return direct[direct.length - 1];
  const messages = document.querySelectorAll(MESSAGE);
  const last = messages[messages.length - 1];
  if (last) {
    const inside = [...last.querySelectorAll(REPLY.join(','))];
    const answers = inside.filter((e) => !e.closest(THINKING));
    if (answers.length) return answers[answers.length - 1];
    // Only reasoning so far: report nothing rather than the monologue.
    if (inside.length) return null;
  }
  const loose = [...document.querySelectorAll(REPLY.join(','))].filter((e) => !e.closest(THINKING));
  return loose[loose.length - 1] ?? null;
};
const INPUT = ['textarea', 'div[contenteditable="true"]'];
// Send sits beside the composer textarea as a filled circle icon button.
// Attribute labels come first: they survive DeepSeek's hashed class renames.
const SEND = [
  '[data-testid="send-button"]',
  '[aria-label*="发送"]',
  '[aria-label*="Send"]',
  'div[role="button"][class*="ds-button--primary"]:not([class*="iconLabel"])',
  'div[role="button"][class*="ds-button--filled"]',
];

// A message that is still streaming has no action bar (copy / regenerate /
// feedback). Its appearance is the completion signal the quiet window was only
// approximating, and it is what a truncated long file needed: the write stopped
// changing for a moment mid-render and the quiet test settled on half a file.
const ACTION_HINT = '[class*="action"], [class*="toolbar"], [class*="feedback"], button[aria-label*="复制"], button[aria-label*="Copy"]';

function messageComplete() {
  const node = pickReply();
  const message = node?.closest(MESSAGE);
  if (!message) return false;
  return Boolean(message.querySelector(ACTION_HINT));
}

// What the completion check can see right now, for the probe: if actionButtons
// stays 0 even after an answer finishes, messageComplete() is blind and the
// quiet window is the only fallback left.
const messageMarkers = () => {
  const message = pickReply()?.closest(MESSAGE);
  if (!message) return { actionButtons: 0, sample: [] };
  const buttons = [...message.querySelectorAll('button, [role="button"], [class*="action"]')];
  return {
    actionButtons: buttons.length,
    sample: buttons.slice(0, 6).map((el) => ({
      cls: String(el.className ?? '').slice(0, 50),
      label: (el.getAttribute('aria-label') ?? el.innerText ?? '').trim().slice(0, 20),
    })),
  };
};

// The raw markup of the answer's code block, and of the message around it.
// The scraper's selectors were guessed repeatedly and each wrong guess cost a
// round, so the probe reports the actual structure to read instead of infer.
const codeHtml = () => {
  const node = pickReply();
  if (!node) return { messageHtml: null, codeHtml: null };
  const pre = node.querySelector('pre');
  return {
    messageHtml: node.outerHTML.slice(0, 1500),
    // The whole <pre> subtree: how the code is actually split into elements.
    codeHtml: pre ? pre.outerHTML.slice(0, 2500) : null,
    // Which child holds whole lines, and what codeText() would extract from it.
    codeProbe: pre
      ? [...pre.querySelectorAll('*')]
          .slice(0, 8)
          .map((el) => ({
            tag: el.tagName,
            cls: String(el.className ?? '').slice(0, 40),
            children: el.children.length,
            lines: (el.textContent ?? '').split('\n').length,
            head: (el.textContent ?? '').slice(0, 40),
          }))
      : null,
    // What codeText() actually produces, which is what lands in the file. Guarded
    // because a throw here used to take down the entire probe and return nothing
    // but the error message, losing every other diagnostic with it.
    codeExtracted: (() => {
      try {
        return pre ? codeText(pre) : null;
      } catch (e) {
        return `THREW: ${e.message}`;
      }
    })(),
    // Every distinct class in the code block, which is what a selector needs.
    codeClasses: pre
      ? [...new Set([...pre.querySelectorAll('*')].map((e) => String(e.className ?? '')).filter(Boolean))]
      : [],
  };
};

// innerText reflects rendered layout and collapses runs of whitespace. That cost
// us twice: four-space Python indentation arrived as one space, and every newline
// in the model's prose was replaced by a space, so a reply came through as one
// long line. textContent keeps both.
const readReply = () => pickReply()?.textContent ?? '';

// The reply as the model wrote it, with code blocks restored as fences.
//
// The page renders a fenced block as a language label plus copy/download buttons
// plus the code, so innerText never contains the backticks and DOES contain the
// button labels. Reading it verbatim would both hide the fence from the server's
// parser and inject "复制"/"下载" into the file being written. Code therefore
// comes from the <pre> subtree, which also drops the buttons.
// Extract the code text from one rendered code block.
//
// Measured structure (2026-09-25):
//   div.md-code-block
//     div.md-code-block-banner-wrap > span.d813de27        <- "python" label
//                                  > div[role=button]      <- copy / download
//     pre                                                  <- the code itself
// The label and the buttons live in the banner, OUTSIDE the <pre>, so taking
// the <pre> subtree excludes them without any text filtering.
//
// Reading only the <pre>'s direct textContent loses the newlines: the highlighter
// splits the code into per-line elements, so the line structure exists in the
// element tree, not in text nodes. Prefer the element that holds whole lines.
const codeText = (pre) => {
  // querySelector returns null when there is no <code>, and the page does not use
  // one: its code lives in per-line divs inside the <pre>. Pushing that null into
  // the candidate list crashed the whole probe on the first element.
  const candidates = [pre.querySelector('code'), ...pre.querySelectorAll('div, span')].filter(Boolean);
  for (const el of candidates) {
    const raw = el.textContent ?? '';
    if (el.children.length && raw.includes('\n')) return raw;
  }
  // Fall back to whatever text this node exposes: innerText is absent on some
  // node types, so guard by typeof rather than by ??.
  if (typeof pre.innerText === 'string') return pre.innerText;
  if (typeof pre.textContent === 'string') return pre.textContent;
  return '';
};

// Text of a subtree, with a newline after every block it contains.
//
// `innerText` cannot be used for this. The clone below is not in the document, so it is
// not "being rendered", and the innerText getter falls back to `textContent` — which joins
// <p> to <p> with nothing at all. That is how every paragraph break in the model's prose
// was lost: a reply came back as one long line. `textContent` is only right for a subtree
// with no blocks in it.
const BREAK_AFTER = [
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI',
  'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
];
const blockText = (node) => {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeName === 'BR') return '\n';
  // Comments and anything else that is not an element carry no reply text.
  if (node.nodeType !== 1) return '';
  const inner = [...(node.childNodes ?? [])].map(blockText).join('');
  return BREAK_AFTER.includes(node.nodeName) ? `${inner}\n` : inner;
};

const readReplyForWire = () => {
  const node = pickReply();
  if (!node) return '';
  const clone = node.cloneNode(true);
  for (const pre of clone.querySelectorAll('pre')) {
    // No language tag in the fence: the label sits in the banner, and a fence
    // whose body starts with the word "python" would corrupt the file.
    const body = codeText(pre).replace(/\n+$/, '');
    // Drop the banner too. Its label and copy/download text are separate nodes
    // that innerText glues onto the JSON line with no separator, and on a
    // multi-line block they merge into one junk line rather than being split off.
    pre.parentElement?.querySelector('.md-code-block-banner-wrap')?.remove();
    pre.replaceWith(document.createTextNode(`\n\`\`\`\n${body}\n\`\`\`\n`));
  }
  // The fence text nodes pass through untouched, and no newline is ever collapsed, so a
  // code body keeps every blank line it was written with — which matters, because that
  // text is what `write` puts on disk.
  return blockText(clone).trim();
};

const replyTextVariants = () => {
  const node = pickReply();
  if (!node) return { variants: null };
  const measure = (text) => {
    const lines = text.split('\n').slice(0, 6);
    return lines.map((l) => (l.match(/^ */) ?? [''])[0].length);
  };
  const inner = node.innerText ?? '';
  return {
    innerText: { lineCount: inner.split('\n').length, leadingSpaces: measure(inner), head: inner.slice(0, 60) },
    textContent: { lineCount: (node.textContent ?? '').split('\n').length, leadingSpaces: measure(node.textContent ?? '') },
    codeBlock: (() => {
      const pre = node.querySelector('pre, code');
      if (!pre) return null;
      const t = pre.innerText ?? '';
      return { tag: pre.tagName, lineCount: t.split('\n').length, leadingSpaces: measure(t) };
    })(),
  };
};


// Laid out by the browser, so a human could click it. The page keeps hidden copies
// of things — a virtual list, collapsed panes — and they have exactly the right
// attributes. Typing into one writes a real value into a node the app has nothing
// to do with: focus() lands nowhere, execCommand is refused, the DOM shows the text,
// the app's state stays empty and the send button stays disabled.
const visible = (el) => {
  const r = el?.getBoundingClientRect?.();
  return Boolean(r && r.width > 0 && r.height > 0);
};

// Strictly a visible match, or nothing. Failing here is the point: a hidden match
// means the page is mid-remount or the selector is wrong, and typing into a hidden
// node is what turned "the app never received the text" into a report about the send
// button. Only the probe wants the lenient version below.
const pickVisible = (sels) => {
  for (const s of sels) {
    const shown = [...document.querySelectorAll(s)].filter(visible);
    if (shown.length) return shown[shown.length - 1];
  }
  return null;
};

// Lenient: last match whatever its state, so a probe can still report what is there
// when nothing is visible. Never use this to type.
const pick = (sels) => {
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    if (els.length) return els[els.length - 1];
  }
  return null;
};

// The ancestor chain of the composer. The controls that matter live next to the input;
// probeNear walks the same levels for its report.
const composerRoots = (input) => {
  const roots = [];
  let node = input;
  for (let up = 0; node && up < 6; up++) {
    node = node.parentElement;
    if (node) roots.push(node);
  }
  return roots;
};

// SEND resolved inside the composer, never against the whole document.
//
// The two class-based fallbacks in SEND are generic enough to match the sidebar's
// new-chat button. Clicking that opens a fresh conversation, and it also empties the
// composer — which the send path reads as a successful send, so the message is lost and
// the run continues in the wrong conversation with nothing reporting a failure. A button
// that cannot be found is loud; that is the trade made here on purpose, and --probe
// reports the composer's buttons when a selector needs updating.
const pickInComposer = (input, sels, onlyVisible = true) => {
  for (const root of composerRoots(input)) {
    for (const s of sels) {
      const found = [...root.querySelectorAll(s)].filter((el) => !onlyVisible || visible(el));
      if (found.length) return found[found.length - 1];
    }
  }
  return null;
};

// The conversation id in an address, or null for the blank chat at the root. Used to tell
// "the app gave this new chat an id after the first message" (expected) apart from "the
// page moved to a different conversation" (never expected mid-turn).
const chatId = (url) => (String(url ?? '').match(/\/a\/chat\/s\/([\w-]+)/) ?? [])[1] ?? null;

// Whether the page moved from one conversation to another. Deliberately not "the address
// changed": the app rewrites a blank chat to its id after the first message, and treating
// that as a move would fail every first send.
const movedConversation = (before, after) => {
  const was = chatId(before);
  return Boolean(was) && chatId(after) !== was;
};

// What the DOM looks like around the newest message. Generation indicators are
// a cursor element, a streaming class, or an animated sibling — all of which are
// visible here and none of which were guessable from the send button.
const replyMarkers = () => {
  const node = pickReply();
  if (!node) return { picked: null, answers: 0, thinking: 0, title: document.title };
  const chain = [];
  let el = node;
  for (let up = 0; el && up < 4; up++) {
    chain.push({ up, tag: el.tagName, cls: String(el.className ?? '').slice(0, 120) });
    el = el.parentElement;
  }
  // Animated elements are the usual "still writing" tell.
  const animated = [...node.querySelectorAll('*')]
    .filter((e) => e.getAnimations?.().length)
    .slice(0, 5)
    .map((e) => ({ tag: e.tagName, cls: String(e.className ?? '').slice(0, 60) }));
  return {
    title: document.title,
    // What pickReply() chose, so a wrong pick is visible instead of inferred.
    pickedContainer: String(node.closest(MESSAGE)?.className ?? '').slice(0, 60),
    pickedHead: (node.innerText ?? '').trim().slice(0, 60),
    // Counts tell apart "no answer yet" from "selector stopped matching".
    answers: [...document.querySelectorAll(REPLY.join(','))].filter((e) => !e.closest(THINKING)).length,
    thinking: [...document.querySelectorAll(THINKING)].length,
    // Every markdown node on the page with its message container, so the user's
    // own prompt can be told apart from the assistant's answer. If they are
    // indistinguishable, pickReply() will hand back the prompt we just sent.
    all: [...document.querySelectorAll(REPLY.join(','))].map((e) => ({
      inThinking: Boolean(e.closest(THINKING)),
      msg: String(e.closest('.ds-message')?.className ?? '').slice(0, 60),
      text: (e.innerText ?? '').trim().slice(0, 24),
    })),
    chain,
    animated,
    childCount: node.childElementCount,
    tail: (node.innerText ?? '').slice(-40),
  };
};

// The composer toolbar sits with the input, so walk up from the input and
// describe every button in its ancestors. Guessing selectors from the page at
// large is what failed before: the send control only exists near the input.
const probeNear = () => {
  const input = pick(INPUT);
  const out = { input: input?.outerHTML?.slice(0, 200) ?? null, levels: [] };
  let node = input;
  for (let up = 0; node && up < 5; up++) {
    node = node.parentElement;
    if (!node) break;
    const controls = [...node.querySelectorAll('button, [role="button"], [data-testid]')].map((el) => ({
      tag: el.tagName,
      attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value.slice(0, 60)])),
      html: el.outerHTML.slice(0, 220),
    }));
    out.levels.push({ up, cls: String(node.className ?? '').slice(0, 80), controls: controls.slice(0, 12) });
  }
  return out;
};

// Writing `.value` through the prototype setter is the usual React trick, but on
// this composer it leaves the app's own state empty. Verified on the live page: a
// failed send left 2267 chars in the textarea, the send button still carried
// `ds-button--disabled`, and the value was never reverted — the DOM had the text,
// the app did not, so two clicks did nothing and the error blamed nothing.
//
// Typing through the browser's editing pipeline is what the app listens to, so it
// is tried first; the result is read back, and the setter is only the fallback.
function setText(input, text) {
  input.focus();
  const read = () => (input.tagName === 'TEXTAREA' ? input.value : input.textContent);
  try {
    // execCommand replaces the current selection, so select first. This also
    // covers contenteditable, which cannot be selected the same way.
    if (typeof input.select === 'function') input.select();
    else input.textContent = '';
    document.execCommand('insertText', false, text);
  } catch {
    // Refused; the readback below decides what to do about it.
  }
  if (read() !== text) {
    if (input.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, text);
    } else {
      input.textContent = text;
    }
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// How the last `waitReply` ended and how long it held on after the text stopped changing. Set by
// that function, reported to the server with every reply: the console cannot see this wait, and a
// turn that spends eight seconds here looks exactly like one that spends two.
let lastSettle = null;

// The page marks the send button disabled with a class, not with the attribute:
// probing the live page found `ds-button--disabled` on the button while
// aria-disabled was null. Reading only the attribute reported `null` on every
// failure and hid the one signal that explains a send that does nothing.
const isDisabled = (el) =>
  Boolean(el.disabled) ||
  el.classList.contains('ds-button--disabled') ||
  [...el.classList].some((c) => c.endsWith('--disabled')) ||
  el.getAttribute('aria-disabled') === 'true';

// Measured 2026-09-25 while the model was visibly mid-generation: the send
// button keeps its idle shape, the composer stays enabled, no stop control
// exists, and the title is unchanged. Every signal here was false, so this
// normally never fires. It matters when it fires wrongly: a composer left
// holding text after a send reads as "disabled" and pins this true forever,
// which stalled a whole turn until the 10-minute timeout.
const composerText = (input) => (input.tagName === 'TEXTAREA' ? input.value : input.textContent);

const isGenerating = () => {
  const stop = [...document.querySelectorAll('button, [role="button"]')].some((el) =>
    /停止|stop/i.test(`${el.getAttribute('aria-label') ?? ''} ${el.innerText ?? ''}`),
  );
  if (stop) return true;
  // Visible only: a hidden composer's leftover text says nothing about the live one.
  const input = pickVisible(INPUT);
  if (!input) return false;
  // Leftover text is not evidence of generation; it is leftover text.
  if (composerText(input).length > 0) return false;
  return isDisabled(input);
};

// Wait for a NEW reply, not merely a stable one: the previous answer is already
// on screen and would satisfy a stability test immediately.
//
// Always returns within capMs, even if nothing settles. A wait that never ends
// is worse than a wrong answer: the content script stops polling, the server
// keeps reporting "running", and every later job is refused with 409 until the
// page is reloaded by hand.
async function waitReply(prev, capMs = 240000) {
  const start = Date.now();
  let last = '';
  let sawFresh = false;
  let sawGenerating = false;
  let quietSince = Date.now();
  // Which exit ends this wait, and how long after the text stopped changing. The wait itself is
  // invisible from the server, so a turn that spends eight seconds here and a turn that spends two
  // look identical in the log — and the only way to tell which is to measure it at the source.
  lastSettle = { how: 'cap', ms: 0, chars: 0 };
  while (Date.now() - start < capMs) {
    await wait(400);
    const now = readReply();
    if (now !== prev && now) sawFresh = true;
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    }
    if (isGenerating()) {
      sawGenerating = true;
      continue; // never settle while the UI says it is still generating
    }
    const quiet = Date.now() - quietSince;
    // A generation we watched end that produced NOTHING is over. Both exits below
    // require sawFresh, so stopping before the first token arrived left them false
    // and this function sat here for the full four-minute cap; the server owned the
    // turn for all of it and the console's send button stayed disabled, so the run
    // looked dead and could not be restarted. This is what sawGenerating was for.
    // Returning '' and not `now` matters: `now` is still the PREVIOUS answer, and
    // handing that back would feed the loop an old reply as if it were new.
    if (!sawFresh && sawGenerating && quiet > 1500) {
      lastSettle = { how: 'empty', ms: quiet, chars: 0 };
      return '';
    }
    // The action bar appearing on the message is the real completion signal.
    // Once seen, a short pause is enough; a file mid-render has no action bar.
    if (sawFresh && messageComplete() && quiet > 1500) {
      lastSettle = { how: 'action-bar', ms: quiet, chars: now.length };
      return readReply();
    }
    // No action bar yet. Fall back to a quiet window scaled by how much text has
    // streamed (~400 chars/s), so a long file gets a long grace period instead
    // of being cut off at whatever pause happened to exceed 2.5s.
    //
    // The floor used to be 8s, and it is paid *per turn* whenever that action-bar check misses:
    // a one-line tool call waited 8.2s after the model had finished, which looks like a slow model
    // from the console and is not one. 2s matches the pause the action-bar path already accepts,
    // and the per-character term — the part that actually protects a long file mid-render — is
    // untouched. `lastSettle` now reports which path each turn took, so this number can be argued
    // with data instead of by feel.
    const grace = Math.min(30000, 2000 + Math.round(now.length / 0.4 / 1000) * 1000);
    if (sawFresh && quiet > grace) {
      lastSettle = { how: 'grace', ms: quiet, chars: now.length };
      return now;
    }
  }
  // Timed out. Return whatever arrived so the caller can report it rather than
  // hanging; the server's own timeout would otherwise be the only way out.
  lastSettle = { how: 'cap', ms: Date.now() - quietSince, chars: last.length };
  return sawFresh ? last : '';
}

async function type(text) {
  // Never type into a page that is still generating. A busy page keeps its send
  // button disabled whatever the composer holds, and the click then does nothing —
  // which reads as a send problem when the page was simply not ready. Stopping a run
  // does not guarantee the page stopped with it, and that sequence is exactly how
  // this failure was produced: stop pressed, next task sent, nothing happened.
  for (let i = 0; i < 15 && isGenerating(); i++) await wait(200);
  if (isGenerating()) {
    throw new Error(
      'the page is still generating — it will not send until that finishes. Press stop on the page, or reload it.',
    );
  }
  // Visible only, and no silent fallback. A hidden match means the page is
  // remounting the composer or the selector is stale; typing into it writes into a
  // node the app has nothing to do with, and the failure then gets reported against
  // the send button, which was never the problem.
  let input = pickVisible(INPUT);
  if (!input) {
    throw new Error(
      'no visible chat input — the page may be remounting the composer. Reload the page and retry; run --probe for the candidate list.',
    );
  }
  const before = readReply();
  setText(input, text); // replaces whatever the composer held; never appends
  await wait(400);
  // Take the composer again. A fresh conversation remounts it, and the node typed
  // into above is then detached: its value still reads back at full length, so
  // nothing notices, while the page's own composer is empty and its send button
  // stays disabled.
  const live = pickVisible(INPUT);
  if (live && live !== input && composerText(live) !== text) {
    input = live;
    setText(input, text);
    await wait(400);
  }
  // Prove the app took the text before blaming anything downstream. Without this,
  // "the input never arrived" and "the click did nothing" are the same message, and
  // that message pointed at the send button for a fault that was upstream of it.
  const got = composerText(input);
  if (got !== text) {
    throw new Error(
      `composer did not take the text — read back ${got.length} chars, expected ${text.length}, ` +
        `visible=${visible(input)}. The app never received the input, so its send button stays disabled. ` +
        `This is an input problem, not a send problem: do not go looking at SEND.`,
    );
  }
  const sendButton = () => {
    const b = pickInComposer(input, SEND) ?? pickInComposer(input, SEND, false);
    return b ? b.closest('button, [role="button"]') ?? b : null;
  };
  // The send button is the app's own verdict on the composer, and the only honest
  // way to tell whether it ACCEPTED the text: it carries the disabled class while
  // its state is empty. `input.value` cannot tell us that — a prototype-setter write
  // leaves the DOM full and React's state empty, which is how a message claiming
  // "the input side is already proven" got sent while the button sat disabled.
  let enabled = null;
  for (let i = 0; i < 10 && !enabled; i++) {
    const b = sendButton();
    if (b && !isDisabled(b)) enabled = b;
    else await wait(200);
  }
  // Not enabled after two seconds. Click anyway: the disabled class may not be the
  // only thing the button gates on, and a send that used to work must not be blocked
  // by that guess. Keeping the state lets the failure below say which side was wrong.
  const clickable = enabled ?? sendButton();
  if (!clickable) {
    throw new Error(
      `no send button found next to the composer: SEND=${JSON.stringify(SEND.slice(0, 3))} — run --probe for the composer's button list`,
    );
  }
  clickable.click();

  // The composer clears itself once the message is accepted. Wait generously:
  // the first send in a fresh conversation posts the conversation into
  // existence, and a click that lands early is simply lost.
  const accepted = async () => {
    for (let i = 0; i < 25; i++) {
      if (!composerText(input) || readReply() !== before) return true;
      await wait(200);
    }
    return false;
  };
  if (await accepted()) return before;
  // One retry: a dropped first click is the common cause, and the send control
  // is idempotent as long as the composer still holds the text.
  clickable.click();
  if (await accepted()) return before;
  // What was actually measured, not what it might mean. Two earlier versions of this
  // message named a culprit and both were wrong: the first said the input was proven
  // when the read-back only proves the DOM, and the second said the click was not
  // being delivered — but the button's state CHANGED across the clicks, which a click
  // that never arrived could not do. `isGenerating()` is not reported here either: it
  // returns false the moment the composer holds text, so it says nothing in exactly
  // this situation.
  const now2 = readReply();
  throw new Error(
    `the send click did not send — ${composerText(input).length} chars are still in the composer ` +
      `(was ${text.length}), and the last reply has ${now2 === before ? 'not changed' : 'changed'}. ` +
      `send button: ${enabled ? 'enabled when first clicked' : 'never enabled after typing'}, ` +
      `now disabled=${isDisabled(clickable)} (class=${JSON.stringify([...clickable.classList].filter((c) => c.includes('disabled')))}). ` +
      `stop control on the page=${Boolean(stopControl())}, composer disabled=${isDisabled(input)}. ` +
      `Raw readings only — which of these is the cause is still unproven.`,
  );
}

// Stop the generation in progress. The page shows a stop control while the model
// is writing; clicking it is the only way to make the browser stop, and the
// server-side flag only stops the loop between turns.
const stopControl = () =>
  [...document.querySelectorAll('button, [role="button"]')].find((el) =>
    /停止|stop/i.test(`${el.getAttribute('aria-label') ?? ''} ${el.innerText ?? ''}`),
  ) ?? null;

async function handle(job) {
  if (job.cmd === 'stop') {
    const btn = stopControl();
    if (!btn) return { cmd: 'stop', stopped: false, reason: 'no stop control on the page' };
    (btn.closest('button, [role="button"]') ?? btn).click();
    return { cmd: 'stop', stopped: true };
  }
  if (job.cmd === 'probe') {
    // Nothing is typed: an earlier version typed into the composer to reveal the
    // send button, which polluted the page and made "is the composer holding text?"
    // impossible to answer from a probe. The one side effect left is a focus() for
    // focusLanded below, which changes no content.
    const input = pick(INPUT);
    const report = {
      cmd: 'probe',
      contentVersion: CONTENT_VERSION,
      input: input?.tagName ?? null,
      // What the send guard reads. If composerText is non-empty here, a previous
      // send failed to clear it and the next send will refuse.
      composerText: input ? composerText(input).slice(0, 80) : null,
      composerLength: input ? composerText(input).length : null,
      // Every element the INPUT selectors match, not only the one picked. Two
      // composers in the document with the wrong one picked looks exactly like
      // "the app ignored my typing", and the old report could not show it.
      inputs: [...document.querySelectorAll(INPUT.join(','))].map((el, i) => ({
        i,
        tag: el.tagName,
        placeholder: el.getAttribute('placeholder'),
        cls: String(el.className ?? '').slice(0, 60),
        visible: visible(el),
        size: (() => {
          const r = el.getBoundingClientRect();
          return `${Math.round(r.width)}x${Math.round(r.height)}`;
        })(),
        picked: el === input,
      })),
      // Focus not landing is what makes execCommand refuse: the DOM then shows the
      // text, the app knows nothing, and the send button stays class-disabled.
      focusLanded: (() => {
        if (!input) return null;
        input.focus();
        return document.activeElement === input;
      })(),
      generating: isGenerating(),
      inputDisabled: input ? isDisabled(input) : null,
      sendDisabled: (() => {
        const b = pick(SEND);
        return b ? isDisabled(b) : null;
      })(),
      stopControls: [...document.querySelectorAll('button, [role="button"]')]
        .map((el) => `${el.getAttribute('aria-label') ?? ''}|${(el.innerText ?? '').trim().slice(0, 20)}`)
        .filter((s) => /停止|stop|发送|send/i.test(s)),
      send: pick(SEND)?.outerHTML?.slice(0, 200) ?? null,
      markers: { ...replyMarkers(), ...messageMarkers(), ...replyTextVariants(), ...codeHtml() },
      candidates: probeNear(),
      // What the server would receive, after code blocks are restored as fences.
      reply: readReplyForWire().slice(0, 200),
      replyRawHead: readReply().slice(0, 120),
      url: location.href,
    };
    return report;
  }
  const urlBefore = location.href;
  const prev = await type(job.text);
  await waitReply(prev);
  // A turn that did not ask for a new conversation must not have moved to another one.
  if (!job.fresh && movedConversation(urlBefore, location.href)) {
    throw new Error(
      `发送时页面从一个对话跳到了另一个（${chatId(urlBefore)} → ${chatId(location.href) ?? '空对话'}），`
      + '而这次任务本该继续上一个对话。说明点到的是会导航的控件，不是发送控件。这条消息没有发出去。',
    );
  }
  // Re-read after waiting: fenced blocks must be reconstructed from the <pre>
  // subtree, and waitReply already returns the settled text for its own needs.
  return {
    contentVersion: CONTENT_VERSION,
    reply: readReplyForWire(),
    sent: job.text.slice(0, 60),
    // How the page decided the answer was over. The server logs it, because this wait is the one
    // cost the console cannot see and the first thing to check when a turn feels slow.
    settle: lastSettle,
  };
}

chrome.runtime.onMessage.addListener((job, _sender, reply) => {
  handle(job).then(
    (r) => reply({ ok: true, ...r }),
    (e) => reply({ ok: false, error: String(e.message ?? e) }),
  );
  return true; // keep the channel open for the async reply
});

// Manual entry point: run one turn against whatever is on screen right now.
window.bridgeTurn = async (text) => waitReply(await type(text));
console.log(
  `[bridge] loaded v${CONTENT_VERSION} on ${location.href} | window.bridgeTurn(text) available`,
);
