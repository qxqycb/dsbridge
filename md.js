// Markdown, the subset a model reply actually uses, as pure functions: blocks and inline
// runs. No DOM, no dependency.
//
// It lives in its own file rather than inside ui.html so the same functions the page runs
// can be imported and asserted in node. A copy of this logic in the page would drift with
// nothing to notice it — the mistake check-codetext.mjs was rewritten to stop making.
//
// Nothing here returns HTML. The page turns runs into text nodes, so a reply is displayed
// rather than interpreted.

/** Whether a line opens a block other than a paragraph, so a paragraph knows where to stop. */
const startsBlock = (line) =>
  /^```/.test(line)
  || /^#{1,6}\s/.test(line)
  || /^\s*[-*+]\s+/.test(line)
  || /^\s*\d+[.)]\s+/.test(line)
  || /^>\s?/.test(line);

/**
 * Split markdown into blocks, in order.
 *
 * @param {string} text - markdown source, as scraped from the page.
 * @returns {Array<{kind: string, text?: string, lang?: string, level?: number, items?: string[]}>} blocks; `kind` is `code`, `h`, `ul`, `ol`, `quote` or `p`.
 */
export function mdBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      // The closing fence is absent when the reply was cut short; the code block is still
      // worth showing, so this only consumes it when it is really there.
      if (i < lines.length) i++;
      out.push({ kind: 'code', lang: fence[1], text: body.join('\n') });
      continue;
    }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      out.push({ kind: 'h', level: head[1].length, text: head[2] });
      i++;
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    if (bullet.test(line)) {
      const items = [];
      while (i < lines.length && bullet.test(lines[i])) items.push(lines[i++].replace(bullet, ''));
      out.push({ kind: 'ul', items });
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+/;
    if (numbered.test(line)) {
      const items = [];
      while (i < lines.length && numbered.test(lines[i])) items.push(lines[i++].replace(numbered, ''));
      out.push({ kind: 'ol', items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ''));
      out.push({ kind: 'quote', text: quoted.join('\n') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // A paragraph runs to the next blank line or block, so a sentence wrapped across lines
    // stays one paragraph. The first line is taken unconditionally: every branch above
    // advanced the cursor, so this one has to as well or the loop never ends.
    const para = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++]);
    out.push({ kind: 'p', text: para.join('\n') });
  }
  return out;
}

/**
 * Split one line into inline runs, in order.
 *
 * @param {string} text - one line of markdown.
 * @returns {Array<{kind?: string, text: string, href?: string}>} runs; a run with no `kind` is plain text, otherwise `code`, `strong`, `em` or `link`.
 */
export function mdInline(text) {
  const s = String(text ?? '');
  const runs = [];
  // Group 4 is the link text and group 5 its target, so the anchor is built from the text
  // rather than from the whole `[text](url)` match.
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  for (const m of s.matchAll(pattern)) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    if (m[1]) runs.push({ kind: 'code', text: m[1].slice(1, -1) });
    else if (m[2]) runs.push({ kind: 'strong', text: m[2].slice(2, -2) });
    else if (m[3]) runs.push({ kind: 'em', text: m[3].slice(1, -1) });
    else runs.push({ kind: 'link', text: m[4], href: m[5] });
    last = m.index + m[0].length;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs;
}
