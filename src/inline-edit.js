'use strict';
const vscode = require('vscode');
const path = require('path');
const { stripFences } = require('./util');

const SYSTEM = [
  'You are a precise code-editing engine embedded in an editor.',
  'You receive a file excerpt, a target region, and an instruction.',
  'Reply with ONLY the new code that should replace the target region (or be inserted at <cursor/>).',
  'No markdown fences, no commentary, no explanations. Preserve the existing indentation style.',
  'Do not repeat code outside the target region. If the instruction is a question, answer it as a code comment.',
].join(' ');

const ORIG_SCHEME = 'inline-claude-orig';

class InlineEdit {
  constructor(svc, context) {
    this.svc = svc;
    this.pending = null;
    this.origDocs = new Map();
    this.lastInstruction = '';
    this.lensEmitter = new vscode.EventEmitter();
    this.deco = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    });

    context.subscriptions.push(
      this.deco,
      this.lensEmitter,
      vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, {
        provideTextDocumentContent: (uri) => this.origDocs.get(uri.query) || '',
      }),
      vscode.languages.registerCodeLensProvider({ scheme: '*' }, {
        onDidChangeCodeLenses: this.lensEmitter.event,
        provideCodeLenses: (doc) => this.lenses(doc),
      }),
      vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
        provideCodeActions: (doc, range, ctx) => this.quickFixes(doc, range, ctx),
      }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    );
  }

  // ---- UI bits ----------------------------------------------------------
  lenses(doc) {
    const p = this.pending;
    if (!p || p.uri.toString() !== doc.uri.toString()) return [];
    const r = new vscode.Range(p.range.start, p.range.start);
    return [
      new vscode.CodeLens(r, { title: '$(check) Accept', command: 'inlineClaude.acceptEdit', tooltip: 'Ctrl+Enter' }),
      new vscode.CodeLens(r, { title: '$(close) Reject', command: 'inlineClaude.rejectEdit', tooltip: 'Esc' }),
      new vscode.CodeLens(r, { title: '$(diff) Diff', command: 'inlineClaude.showDiff' }),
    ];
  }

  quickFixes(doc, range, ctx) {
    if (!ctx.diagnostics.length) return [];
    const a = new vscode.CodeAction('Fix with Claude', vscode.CodeActionKind.QuickFix);
    a.command = { command: 'inlineClaude.fix', title: 'Fix with Claude' };
    a.diagnostics = ctx.diagnostics;
    return [a];
  }

  setPending(p) {
    this.pending = p;
    vscode.commands.executeCommand('setContext', 'inlineClaude.editPending', !!p);
    this.lensEmitter.fire();
  }

  // ---- entry points -----------------------------------------------------
  async start(preset) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showInformationMessage('Open a file first.');
    if (this.pending) await this.accept(); // finalize the previous edit

    let instruction = preset?.instruction;
    if (!instruction) {
      const sel = editor.selection;
      instruction = await vscode.window.showInputBox({
        title: 'Claude Inline Edit',
        prompt: sel.isEmpty ? 'What should Claude write at the cursor?' : 'How should Claude change the selection?',
        placeHolder: sel.isEmpty ? 'e.g. a function that debounces another function' : 'e.g. convert to async/await, add error handling',
        value: this.lastInstruction,
        ignoreFocusOut: true,
      });
      if (!instruction?.trim()) return;
      this.lastInstruction = instruction;
    }

    const doc = editor.document;
    let range = editor.selection;
    if (preset?.expand && range.isEmpty) range = await this.expandToSymbol(doc, range.active);
    range = this.snapToLines(doc, range);

    const original = doc.getText(range);
    const ctxLines = this.svc.get('edit.contextLines') || 40;
    const before = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, range.start.line - ctxLines), 0), range.start));
    const lastLine = doc.lineCount - 1;
    const afterEndLine = Math.min(lastLine, range.end.line + ctxLines);
    const after = doc.getText(new vscode.Range(range.end, doc.lineAt(afterEndLine).range.end));

    const rel = vscode.workspace.asRelativePath(doc.uri);
    const prompt = [
      `File: ${rel} (${doc.languageId})`,
      '<before>', before, '</before>',
      range.isEmpty ? '<cursor/>' : `<target>\n${original}\n</target>`,
      '<after>', after, '</after>',
      '',
      `Instruction: ${instruction}`,
    ].join('\n');

    const fullBefore = doc.getText();
    const versionBefore = doc.version;
    let result;
    try {
      result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `Claude (${this.svc.modelLabel(this.svc.model())}) is editing…`, cancellable: true,
      }, (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return this.svc.run('edit', { prompt, system: SYSTEM, model: this.svc.model(), tools: [] }, { signal: ac.signal });
      });
    } catch (e) {
      await this.svc.reportError(e);
      return;
    }

    let text = stripFences(result.text);
    if (!original.endsWith('\n')) text = text.replace(/\n+$/, '');
    if (!text.trim() && !original.trim()) return vscode.window.showWarningMessage('Claude returned nothing.');
    if (text === original) return vscode.window.showInformationMessage('Claude suggested no changes.');

    if (doc.version !== versionBefore) {
      return vscode.window.showWarningMessage('The file changed while Claude was working — edit discarded. Try again.');
    }

    const id = String(Date.now());
    this.origDocs.set(id, fullBefore);
    const startOffset = doc.offsetAt(range.start);
    const ok = await editor.edit((b) => b.replace(range, text), { undoStopBefore: true, undoStopAfter: true });
    if (!ok) return;
    const newRange = new vscode.Range(doc.positionAt(startOffset), doc.positionAt(startOffset + text.length));
    editor.setDecorations(this.deco, [newRange]);
    editor.revealRange(newRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.setPending({ uri: doc.uri, range: newRange, original, text, origId: id, editor });
  }

  snapToLines(doc, range) {
    if (range.isEmpty || range.start.line === range.end.line) return range;
    const endLine = range.end.character === 0 ? range.end.line - 1 : range.end.line;
    return new vscode.Range(new vscode.Position(range.start.line, 0), doc.lineAt(Math.max(endLine, range.start.line)).range.end);
  }

  async expandToSymbol(doc, pos) {
    try {
      const syms = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
      let best;
      const walk = (list) => {
        for (const s of list || []) {
          if (s.range.contains(pos)) { best = s.range; walk(s.children); }
        }
      };
      walk(syms);
      if (best) return best;
    } catch { /* fall through */ }
    if (doc.lineCount <= 200) return new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
    const s = Math.max(0, pos.line - 15), e = Math.min(doc.lineCount - 1, pos.line + 15);
    return new vscode.Range(s, 0, e, doc.lineAt(e).text.length);
  }

  // ---- accept / reject / diff ------------------------------------------
  async accept() {
    const p = this.pending;
    if (!p) return;
    this.clear(p);
  }

  async reject() {
    const p = this.pending;
    if (!p) return;
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === p.uri.toString());
    if (!editor) { this.clear(p); return; }
    if (editor.document.getText(p.range) !== p.text) {
      this.clear(p);
      return vscode.window.showWarningMessage('You edited that region since — use Undo (Ctrl+Z) to revert instead.');
    }
    await editor.edit((b) => b.replace(p.range, p.original), { undoStopBefore: true, undoStopAfter: true });
    this.clear(p);
  }

  async showDiff() {
    const p = this.pending;
    if (!p) return;
    const orig = vscode.Uri.from({ scheme: ORIG_SCHEME, path: p.uri.path, query: p.origId });
    await vscode.commands.executeCommand('vscode.diff', orig, p.uri, `Claude edit — ${path.basename(p.uri.fsPath)}`);
  }

  clear(p) {
    for (const e of vscode.window.visibleTextEditors) e.setDecorations(this.deco, []);
    this.origDocs.delete(p.origId);
    this.setPending(null);
  }

  // ---- right-click presets ---------------------------------------------
  diagnosticsFor(editor) {
    const doc = editor.document;
    const sel = editor.selection;
    const target = sel.isEmpty ? doc.lineAt(sel.active.line).range : sel;
    return vscode.languages.getDiagnostics(doc.uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning && d.range.intersection(target))
      .map((d) => `- line ${d.range.start.line + 1}: ${d.message}`);
  }

  fix() {
    const editor = vscode.window.activeTextEditor; if (!editor) return;
    const diags = this.diagnosticsFor(editor);
    const instruction = diags.length
      ? `Fix these problems with minimal changes:\n${diags.join('\n')}`
      : 'Find and fix any bugs or mistakes in this code with minimal changes. If it is already correct, return it unchanged.';
    return this.start({ instruction, expand: true });
  }
  optimize() { return this.start({ instruction: 'Optimize this code for performance and readability without changing behavior.', expand: true }); }
  docs() { return this.start({ instruction: 'Add concise, idiomatic documentation comments for this code (doc-comment style for the language). Do not change the code itself.', expand: true }); }
}

module.exports = { InlineEdit };
