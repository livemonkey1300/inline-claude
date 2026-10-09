'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { MODELS, fmt } = require('./service');
const { newSessionId } = require('./claude');

const ASK_SYSTEM = 'You are Claude inside a VS Code chat panel. Answer using the code context provided. Use markdown with language-tagged code fences.';
const AGENT_SYSTEM = 'You are Claude working as a coding agent inside VS Code. You may read, search and edit files in the workspace using your tools. Make focused changes across as many files as needed, then summarize what you changed.';
const CONCISE = ' Be concise: no filler, no restating the question.';

class ChatProvider {
  constructor(svc, context) {
    this.svc = svc;
    this.context = context;
    this.view = null;
    this.running = null;
    this.sessionId = null;
    this.started = false;
    this.mode = svc.get('chat.defaultMode') || 'ask';
    this.queue = [];
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidDispose(() => { this.view = null; });
  }

  html(webview, media) {
    const nonce = require('crypto').randomBytes(16).toString('hex');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${css}"></head>
<body>
<div id="log"></div>
<div id="composer">
  <div id="bar">
    <select id="mode" title="Ask = no tools (cheapest). Agent = reads, searches and edits files."><option value="ask">Ask</option><option value="agent">Agent</option></select>
    <select id="model" title="Model"></select>
    <label title="Attach the active file"><input type="checkbox" id="file"> file</label>
    <span id="tok" title="Tokens used by the last reply"></span>
  </div>
  <textarea id="input" rows="3" placeholder="Ask Claude… use @file to attach files (Enter to send, Shift+Enter for newline)"></textarea>
  <div id="btns"><button id="send">Send</button><button id="stop" hidden>Stop</button></div>
</div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  post(m) { this.view?.webview.postMessage(m); }

  async onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', models: this.modelList(), model: this.svc.model(), mode: this.mode });
        for (const q of this.queue.splice(0)) this.send(q.text, q.opts);
        break;
      case 'send': this.mode = m.mode; return this.send(m.text, { mode: m.mode, includeFile: m.includeFile });
      case 'stop': this.running?.abort(); break;
      case 'setModel': await this.svc.cfg().update('model', m.model, true); break;
      case 'setMode': this.mode = m.mode; break;
      case 'insert': this.insertCode(m.code); break;
      case 'openFile': this.openFile(m.path); break;
    }
  }

  modelList() {
    const ids = MODELS.map((x) => x.id);
    for (const c of this.svc.get('customModels') || []) if (!ids.includes(c)) ids.push(c);
    if (!ids.includes(this.svc.model())) ids.push(this.svc.model());
    return ids;
  }

  newChat() {
    this.running?.abort();
    this.sessionId = null; this.started = false;
    this.post({ type: 'reset' });
  }

  /** Called from commands (right-click actions). */
  async ask(text, opts = {}) {
    await vscode.commands.executeCommand('inlineClaude.chatView.focus');
    if (!this.view) { this.queue.push({ text, opts }); return; }
    this.send(text, opts);
  }

  // ---- context -----------------------------------------------------------
  buildContext(text, mode, includeFile) {
    const parts = [];
    const editor = vscode.window.activeTextEditor;
    const maxLines = this.svc.get('chat.maxContextLines') || 300;
    const root = this.svc.cwd();

    if (editor && editor.document.uri.scheme === 'file') {
      const doc = editor.document;
      const rel = vscode.workspace.asRelativePath(doc.uri);
      const sel = editor.selection;
      if (!sel.isEmpty) {
        const t = doc.getText(sel);
        parts.push(`Selected code in ${rel} (lines ${sel.start.line + 1}-${sel.end.line + 1}):\n${fence(doc.languageId, clip(t, maxLines))}`);
        if (mode === 'agent') parts.push(`Active file: ${rel}`);
      } else if (mode === 'ask' || includeFile) {
        if (mode === 'agent') parts.push(`Active file: ${rel} (cursor at line ${sel.active.line + 1})`);
        else {
          const half = Math.floor(maxLines / 2);
          const s = doc.lineCount <= maxLines ? 0 : Math.max(0, sel.active.line - half);
          const e = doc.lineCount <= maxLines ? doc.lineCount - 1 : Math.min(doc.lineCount - 1, s + maxLines - 1);
          const body = doc.getText(new vscode.Range(s, 0, e, doc.lineAt(e).text.length));
          parts.push(`Active file ${rel} (lines ${s + 1}-${e + 1} of ${doc.lineCount}, cursor on line ${sel.active.line + 1}):\n${fence(doc.languageId, body)}`);
        }
      }
    }

    // @file mentions
    const mentions = [...new Set([...text.matchAll(/(?:^|\s)@([\w@./\\-]+\.\w+)/g)].map((x) => x[1]))].slice(0, 6);
    for (const mnt of mentions) {
      const abs = root ? path.resolve(root, mnt) : null;
      if (!abs || !abs.startsWith(root) || !fs.existsSync(abs)) continue;
      if (mode === 'agent') parts.push(`Mentioned file: ${mnt}`);
      else {
        try {
          const body = clip(fs.readFileSync(abs, 'utf8'), maxLines);
          parts.push(`File ${mnt}:\n${fence(path.extname(mnt).slice(1), body)}`);
        } catch { /* ignore */ }
      }
    }
    return parts.join('\n\n');
  }

  // ---- send ----------------------------------------------------------------
  async send(text, opts = {}) {
    if (!text?.trim()) return;
    if (this.running) return vscode.window.showInformationMessage('Claude is still replying — press Stop first.');
    const mode = opts.mode || this.mode;
    const ctx = opts.noContext ? '' : this.buildContext(text, mode, opts.includeFile);
    const prompt = ctx ? `${ctx}\n\n---\n${text}` : text;

    this.post({ type: 'user', text, mode });
    const ac = new AbortController();
    this.running = ac;
    this.post({ type: 'start' });

    const concise = this.svc.get('chat.concise') ? CONCISE : '';
    const o = {
      prompt,
      model: this.svc.model(),
      persist: true,
      appendSystem: (mode === 'agent' ? AGENT_SYSTEM : ASK_SYSTEM) + concise,
    };
    if (mode === 'agent') {
      let tools = (this.svc.get('chat.agentTools') || 'Read,Glob,Grep,Edit,Write').split(',').map((s) => s.trim()).filter(Boolean);
      if (this.svc.get('chat.allowBash') && !tools.includes('Bash')) tools.push('Bash');
      o.tools = tools;
      o.permissionMode = 'acceptEdits';
      if (this.svc.get('chat.allowBash')) o.permissionMode = 'bypassPermissions';
    } else {
      o.tools = [];
    }
    if (!this.sessionId) { this.sessionId = newSessionId(); this.started = false; }
    if (this.started) o.resume = this.sessionId; else o.sessionId = this.sessionId;

    try {
      const r = await this.svc.run('chat', o, {
        signal: ac.signal,
        onText: (t) => this.post({ type: 'delta', text: t }),
        onTool: (t) => this.post({ type: 'tool', ...describeTool(t, this.svc.cwd()) }),
      });
      this.started = true;
      const u = r.usage;
      this.post({ type: 'done', tokens: `${fmt(u.input + u.cacheWrite + u.output)} tok (+${fmt(u.cacheRead)} cached)` });
    } catch (e) {
      if (e?.name === 'AbortError') this.post({ type: 'done', tokens: 'stopped' });
      else {
        if (!this.started && /session|resume/i.test(e?.message || '')) { this.sessionId = null; }
        this.post({ type: 'error', message: String(e?.message || e) });
        if (e?.code === 'NOT_LOGGED_IN') this.svc.reportError(e);
      }
    } finally {
      this.running = null;
    }
  }

  async insertCode(code) {
    const editor = vscode.window.activeTextEditor || vscode.window.visibleTextEditors[0];
    if (!editor) return;
    await editor.edit((b) => b.replace(editor.selection, code));
  }

  async openFile(p) {
    const root = this.svc.cwd();
    const abs = path.isAbsolute(p) ? p : path.join(root || '', p);
    try { await vscode.window.showTextDocument(vscode.Uri.file(abs)); } catch { /* ignore */ }
  }
}

function fence(lang, body) { return '```' + (lang || '') + '\n' + body + '\n```'; }
function clip(text, maxLines) {
  const lines = text.split('\n');
  return lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n') + `\n… [${lines.length - maxLines} more lines omitted]`;
}

function describeTool(t, root) {
  const i = t.input || {};
  const file = i.file_path || i.path || null;
  const rel = file && root && file.startsWith(root) ? path.relative(root, file) : file;
  let label = t.name;
  if (rel) label += ' ' + rel;
  else if (i.pattern) label += ' ' + i.pattern;
  else if (i.command) label += ' ' + String(i.command).slice(0, 80);
  return { name: t.name, label, file: rel && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t.name) ? rel : null };
}

module.exports = { ChatProvider };
