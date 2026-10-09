'use strict';
const vscode = require('vscode');

const SYSTEM = [
  'You are a meticulous senior code reviewer.',
  'Review ONLY the code given. Report real problems: bugs, security issues, error handling, performance, confusing code.',
  'Reply with ONLY a JSON array, no prose, no fences: [{"line": <line number as shown>, "severity": "error"|"warning"|"info", "message": "<short issue + suggested fix>"}].',
  'At most 10 items. Reply [] if the code is fine.',
].join(' ');

const SEV = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };

class Review {
  constructor(svc, edit, context) {
    this.svc = svc;
    this.edit = edit;
    this.diags = vscode.languages.createDiagnosticCollection('Claude Review');
    context.subscriptions.push(this.diags,
      vscode.workspace.onDidCloseTextDocument((d) => this.diags.delete(d.uri)));
  }

  async run() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    let range = editor.selection;
    if (range.isEmpty) range = await this.edit.expandToSymbol(doc, range.active);
    const first = range.start.line, last = range.end.line;

    const numbered = [];
    for (let i = first; i <= last; i++) numbered.push(`${i + 1}: ${doc.lineAt(i).text}`);
    const prompt = `File: ${vscode.workspace.asRelativePath(doc.uri)} (${doc.languageId})\n\n${numbered.join('\n')}`;

    let res;
    try {
      res = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Claude is reviewing…', cancellable: true,
      }, (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return this.svc.run('edit', { prompt, system: SYSTEM, model: this.svc.model(), tools: [] }, { signal: ac.signal });
      });
    } catch (e) { return this.svc.reportError(e); }

    let items = [];
    try {
      const m = /\[[\s\S]*\]/.exec(res.text);
      items = m ? JSON.parse(m[0]) : [];
    } catch {
      return vscode.window.showWarningMessage('Claude review returned an unreadable answer — try again.');
    }

    // keep diagnostics outside the reviewed range, replace those inside it
    const keep = (this.diags.get(doc.uri) || []).filter((d) => d.range.start.line < first || d.range.start.line > last);
    const fresh = items.filter((it) => Number.isInteger(it.line)).map((it) => {
      const ln = Math.min(Math.max(it.line - 1, first), last);
      const text = doc.lineAt(ln);
      const d = new vscode.Diagnostic(
        new vscode.Range(ln, text.firstNonWhitespaceCharacterIndex, ln, text.text.length),
        String(it.message || 'Issue'), SEV[it.severity] ?? vscode.DiagnosticSeverity.Warning);
      d.source = 'Claude';
      return d;
    });
    this.diags.set(doc.uri, [...keep, ...fresh]);

    if (!fresh.length) return vscode.window.showInformationMessage('Claude review: looks good, no issues found.');
    const pick = await vscode.window.showInformationMessage(
      `Claude review: ${fresh.length} issue${fresh.length > 1 ? 's' : ''} marked in the editor (hover them, or use the lightbulb to fix).`,
      'Show Problems', 'Clear');
    if (pick === 'Show Problems') vscode.commands.executeCommand('workbench.actions.view.problems');
    else if (pick === 'Clear') this.diags.delete(doc.uri);
  }

  clear() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) this.diags.delete(uri);
  }
}

module.exports = { Review };
