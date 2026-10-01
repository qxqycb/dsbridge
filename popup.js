// Shows what the worker is doing and owns the on/off switch.
const $ = (id) => document.getElementById(id);
let rendered = null; // last log painted, so an unchanged log is never rebuilt
let timer = null;

async function render() {
  const { wanted, log = [] } = await chrome.storage.local.get(['wanted', 'log']);
  $('state').textContent = wanted ? '轮询中' : '已停止';
  $('state').className = wanted ? 'on' : 'off';
  $('toggle').textContent = wanted ? '停止' : '启动';

  // Rebuilding the list drops the user's text selection, so only touch the DOM
  // when the log actually changed. Stopped means frozen: safe to copy from.
  const key = log.join('\n');
  if (key === rendered) return;
  rendered = key;
  const box = $('log');
  box.innerHTML = '';
  if (!log.length) box.textContent = '(还没有事件)';
  for (const line of log.slice().reverse()) {
    box.append(Object.assign(document.createElement('div'), { textContent: line }));
  }
}

// Refresh while polling; once stopped nothing is coming, so stop redrawing.
function follow(wanted) {
  clearInterval(timer);
  timer = wanted ? setInterval(render, 1000) : null;
}

$('toggle').addEventListener('click', async () => {
  const { wanted } = await chrome.runtime.sendMessage({ want: 'toggle' });
  await render();
  follow(wanted);
});
$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ want: 'clear' });
  rendered = null; // force one repaint for the emptied log
  await render();
});

render().then(async () => follow((await chrome.storage.local.get('wanted')).wanted === true));
