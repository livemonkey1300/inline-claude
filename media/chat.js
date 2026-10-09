(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input'), sendBtn = $('send'), stopBtn = $('stop');
  let cur = null, curText = '', busy = false;

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function inline(s) {
    return esc(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^(#{1,4})\s+(.*)$/gm, (_m, h, t) => `<div class="h${h.length}">${t}</div>`);
  }

  function render(el, text) {
    const parts = text.split(/```/);
    let html = '';
    parts.forEach((p, i) => {
      if (i % 2 === 0) { html += `<div class="prose">${inline(p)}</div>`; return; }
      const nl = p.indexOf('\n');
      const lang = nl >= 0 ? p.slice(0, nl).trim() : '';
      const code = nl >= 0 ? p.slice(nl + 1) : p;
      html += `<div class="code"><div class="chead"><span>${esc(lang)}</span><span>` +
        `<a data-act="copy">Copy</a> <a data-act="insert">Insert</a></span></div><pre>${esc(code.replace(/\n$/, ''))}</pre></div>`;
    });
    el.innerHTML = html;
  }

  function add(cls, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    if (text != null) d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function setBusy(b) {
    busy = b; sendBtn.hidden = b; stopBtn.hidden = !b; input.disabled = b;
    if (!b) input.focus();
  }

  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    vscode.postMessage({ type: 'send', text, mode: $('mode').value, includeFile: $('file').checked });
    input.value = '';
  }

  sendBtn.onclick = send;
  stopBtn.onclick = () => vscode.postMessage({ type: 'stop' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  $('model').onchange = (e) => vscode.postMessage({ type: 'setModel', model: e.target.value });
  $('mode').onchange = (e) => vscode.postMessage({ type: 'setMode', mode: e.target.value });

  log.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-act]');
    if (a) {
      const code = a.closest('.code').querySelector('pre').textContent;
      if (a.dataset.act === 'copy') { navigator.clipboard?.writeText(code); a.textContent = 'Copied'; setTimeout(() => (a.textContent = 'Copy'), 1200); }
      else vscode.postMessage({ type: 'insert', code });
      return;
    }
    const f = e.target.closest('a[data-file]');
    if (f) vscode.postMessage({ type: 'openFile', path: f.dataset.file });
  });

  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'init': {
        const sel = $('model'); sel.innerHTML = '';
        for (const id of m.models) { const o = document.createElement('option'); o.value = o.textContent = id; sel.appendChild(o); }
        sel.value = m.model; $('mode').value = m.mode;
        if (!log.children.length) add('hint', 'Ask mode sends only the code you give it (cheapest). Agent mode lets Claude read, search and edit multiple files.');
        break;
      }
      case 'reset': log.innerHTML = ''; $('tok').textContent = ''; setBusy(false); add('hint', 'New chat started.'); break;
      case 'user': add('user', m.text); break;
      case 'start': cur = add('bot'); curText = ''; cur.innerHTML = '<span class="dots">…</span>'; setBusy(true); $('tok').textContent = ''; break;
      case 'delta': if (cur) { curText += m.text; render(cur, curText); log.scrollTop = log.scrollHeight; } break;
      case 'tool': {
        const d = add('tool');
        if (m.file) d.innerHTML = `🔧 ${esc(m.name)} <a data-file="${esc(m.file)}">${esc(m.file)}</a>`;
        else d.textContent = '🔧 ' + m.label;
        // keep the streaming bubble last
        if (cur) log.appendChild(cur);
        break;
      }
      case 'done': setBusy(false); $('tok').textContent = m.tokens || ''; if (cur && !curText) cur.remove(); cur = null; break;
      case 'error': setBusy(false); if (cur) cur.remove(); cur = null; add('err', m.message); break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
