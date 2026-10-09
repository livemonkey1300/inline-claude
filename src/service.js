'use strict';
const vscode = require('vscode');
const claude = require('./claude');

const MODELS = [
  { id: 'haiku', label: 'Haiku', detail: 'Fastest, lightest on your usage limits' },
  { id: 'sonnet', label: 'Sonnet', detail: 'Balanced — best default for editing and chat' },
  { id: 'opus', label: 'Opus', detail: 'Strongest reasoning, burns usage limits fastest' },
];

const FEATURES = ['completion', 'edit', 'chat', 'commit'];

class Service {
  constructor(context) {
    this.context = context;
    this.busy = 0;
    this.out = vscode.window.createOutputChannel('Inline Claude');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = 'inlineClaude.selectModel';
    this.status.show();
    this.usage = context.globalState.get('usage') || {};
    this.session = {}; // per-window counters
    this.refreshStatus();
    context.subscriptions.push(this.status, this.out,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('inlineClaude')) this.refreshStatus();
      }));
  }

  cfg() { return vscode.workspace.getConfiguration('inlineClaude'); }
  get(key) { return this.cfg().get(key); }
  model() { return this.get('model') || 'sonnet'; }
  completionModel() { return this.get('completionModel') || 'haiku'; }
  cwd() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }

  modelLabel(id) {
    const m = MODELS.find((x) => x.id === id);
    return m ? m.label : id;
  }

  // ---- status bar -------------------------------------------------------
  refreshStatus() {
    const comp = this.get('completions.enabled')
      ? (this.get('completions.mode') === 'manual' ? 'manual' : 'on') : 'off';
    const icon = this.busy > 0 ? '$(loading~spin)' : '$(sparkle)';
    this.status.text = `${icon} ${this.modelLabel(this.model())}`;
    const t = this.totals(true);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Inline Claude** — uses your Claude subscription\n\n`);
    md.appendMarkdown(`Chat/Edit model: **${this.model()}** · Suggestions: **${this.completionModel()}** (${comp})\n\n`);
    md.appendMarkdown(`This window: ${t.calls} calls · ${fmt(t.billed)} tokens (+${fmt(t.cacheRead)} cached reads)\n\n`);
    md.appendMarkdown(`_Click to switch model, toggle suggestions, view usage._`);
    this.status.tooltip = md;
  }

  setBusy(delta) { this.busy = Math.max(0, this.busy + delta); this.refreshStatus(); }

  // ---- usage ------------------------------------------------------------
  record(feature, r) {
    for (const [store, persist] of [[this.session, false], [this.usage, true]]) {
      const u = (store[feature] ||= { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 });
      u.calls++;
      u.input += r.usage.input; u.cacheWrite += r.usage.cacheWrite;
      u.cacheRead += r.usage.cacheRead; u.output += r.usage.output;
      u.cost += r.cost || 0;
      if (persist) this.context.globalState.update('usage', this.usage);
    }
    this.out.appendLine(`[${feature}] ${r.model || ''} in=${r.usage.input} cacheW=${r.usage.cacheWrite} cacheR=${r.usage.cacheRead} out=${r.usage.output}`);
    this.refreshStatus();
  }

  totals(sessionOnly) {
    const src = sessionOnly ? this.session : this.usage;
    const t = { calls: 0, billed: 0, cacheRead: 0, cost: 0 };
    for (const f of FEATURES) {
      const u = src[f]; if (!u) continue;
      t.calls += u.calls; t.billed += u.input + u.cacheWrite + u.output; t.cacheRead += u.cacheRead; t.cost += u.cost;
    }
    return t;
  }

  showUsage() {
    this.out.clear();
    const row = (name, u) => `${name.padEnd(12)} ${String(u?.calls || 0).padStart(6)} ${fmt((u?.input || 0) + (u?.cacheWrite || 0)).padStart(10)} ${fmt(u?.cacheRead || 0).padStart(10)} ${fmt(u?.output || 0).padStart(10)}`;
    for (const [title, src] of [['This window', this.session], ['All time (this machine)', this.usage]]) {
      this.out.appendLine(`== ${title} ==`);
      this.out.appendLine('feature        calls   input(new)  cache-read     output');
      for (const f of FEATURES) this.out.appendLine(row(f, src[f]));
      this.out.appendLine('');
    }
    this.out.appendLine('Tokens count against your Claude subscription limits (5-hour / weekly), not a per-token bill.');
    this.out.appendLine('Tip: keep suggestions on Haiku, use Ask mode (no tools), switch Opus on only for hard problems.');
    this.out.show(true);
  }

  resetUsage() { this.usage = {}; this.session = {}; this.context.globalState.update('usage', {}); this.refreshStatus(); }

  // ---- running ----------------------------------------------------------
  /** feature: completion | edit | chat | commit */
  async run(feature, opts, handlers) {
    const base = {
      bin: this.get('claudePath'),
      lean: this.get('leanMode'),
      subscriptionOnly: this.get('subscriptionOnly'),
      cwd: opts.cwd || this.cwd(),
    };
    this.setBusy(1);
    try {
      const r = await claude.run({ ...base, ...opts }, handlers);
      this.record(feature, r);
      return r;
    } finally {
      this.setBusy(-1);
    }
  }

  /** Show a friendly error. Returns true if it was a real error (not a cancel). */
  async reportError(e) {
    if (e?.name === 'AbortError') return false;
    this.out.appendLine(`ERROR ${e?.code || ''}: ${e?.message || e}`);
    if (e?.code === 'NOT_LOGGED_IN') {
      const pick = await vscode.window.showErrorMessage(
        'Claude is not signed in. Sign in with your Claude Pro/Max account (no API key needed).', 'Sign in');
      if (pick === 'Sign in') this.signIn();
    } else if (e?.code === 'ENOENT') {
      vscode.window.showErrorMessage(e.message);
    } else {
      const pick = await vscode.window.showErrorMessage(`Claude: ${String(e?.message || e).slice(0, 300)}`, 'Show log');
      if (pick === 'Show log') this.out.show(true);
    }
    return true;
  }

  signIn() {
    const bin = claude.resolveBinary(this.get('claudePath'));
    const term = vscode.window.createTerminal({ name: 'Claude sign-in' });
    term.show();
    term.sendText(`"${bin}" auth login`);
  }

  // ---- model picker / control hub --------------------------------------
  async pickModel(title, current) {
    const custom = (this.get('customModels') || []).map((id) => ({ id, label: id, detail: 'custom' }));
    const items = [...MODELS, ...custom].map((m) => ({
      label: (m.id === current ? '$(check) ' : '') + m.label, description: m.id, detail: m.detail, id: m.id,
    }));
    items.push({ label: '$(edit) Other model id…', id: '__custom', description: '', detail: 'e.g. claude-opus-5-5' });
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: `Current: ${current}` });
    if (!pick) return undefined;
    if (pick.id === '__custom') {
      return vscode.window.showInputBox({ prompt: 'Model alias or full id', value: current });
    }
    return pick.id;
  }

  async hub() {
    const enabled = this.get('completions.enabled');
    const mode = this.get('completions.mode');
    const items = [
      { label: '$(symbol-method) Chat / Edit / Commit model', description: this.model(), act: 'model' },
      { label: '$(zap) Auto-suggestion model', description: this.completionModel(), act: 'cmodel' },
      { label: enabled ? '$(circle-slash) Turn auto-suggestions off' : '$(check) Turn auto-suggestions on', act: 'toggle' },
      { label: '$(settings-gear) Suggestions trigger', description: mode === 'auto' ? 'automatic (as you type)' : 'manual (Alt+\\)', detail: 'Manual = zero background token use', act: 'mode' },
      { label: '$(graph) Token usage', description: `${fmt(this.totals(true).billed)} this window`, act: 'usage' },
      { label: '$(comment-discussion) Open chat', act: 'chat' },
      { label: '$(account) Sign in / switch account', act: 'signin' },
      { label: '$(gear) Open settings', act: 'settings' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Inline Claude' });
    if (!pick) return;
    const cfg = this.cfg();
    switch (pick.act) {
      case 'model': { const m = await this.pickModel('Model for chat, edit and commit', this.model()); if (m) await cfg.update('model', m, true); break; }
      case 'cmodel': { const m = await this.pickModel('Model for auto-suggestions', this.completionModel()); if (m) await cfg.update('completionModel', m, true); break; }
      case 'toggle': await cfg.update('completions.enabled', !enabled, true); break;
      case 'mode': await cfg.update('completions.mode', mode === 'auto' ? 'manual' : 'auto', true); break;
      case 'usage': this.showUsage(); break;
      case 'chat': vscode.commands.executeCommand('inlineClaude.openChat'); break;
      case 'signin': this.signIn(); break;
      case 'settings': vscode.commands.executeCommand('workbench.action.openSettings', 'inlineClaude'); break;
    }
  }
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

module.exports = { Service, MODELS, fmt };
