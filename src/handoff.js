'use strict';
// Hand the selection (or current file) off to the official Claude Code extension for
// multi-file "heavy lifting" — the Copilot "Open in Chat / Agent" equivalent.
// Claude Code's `claude-vscode.editor.open(sessionId, prompt)` opens a new session tab
// with the prompt prefilled; the user reviews and presses Enter.

const CLAUDE_CODE_ID = 'anthropic.claude-code';
const MAX_INLINE_LINES = 200;

/**
 * Build the hand-off prompt. Pure (no vscode) so it can be smoke-tested.
 * @param {{ task?: string, rel: string, lang: string, startLine: number, endLine: number, code?: string, diagnostics?: string[] }} o
 *   startLine/endLine are 1-based; code is omitted when the whole file is referenced.
 */
function buildPrompt(o) {
  const ref = o.code === undefined
    ? `@${o.rel}`
    : o.startLine === o.endLine ? `@${o.rel}#L${o.startLine}` : `@${o.rel}#L${o.startLine}-${o.endLine}`;
  const out = [o.task?.trim() || 'Look at this code and improve it.', '', `Context: ${ref}`];
  if (o.code !== undefined) {
    const lines = o.code.split('\n');
    if (lines.length <= MAX_INLINE_LINES) out.push('', '```' + o.lang, o.code.replace(/\n$/, ''), '```');
  }
  if (o.diagnostics?.length) out.push('', 'Current problems in this range:', ...o.diagnostics.map((d) => `- ${d}`));
  return out.join('\n');
}

async function sendToClaudeCode(task) {
  const vscode = require('vscode');
  const editor = vscode.window.activeTextEditor;
  if (!editor) return vscode.window.showInformationMessage('Open a file first.');

  if (!vscode.extensions.getExtension(CLAUDE_CODE_ID)) {
    const pick = await vscode.window.showWarningMessage(
      'Handing off needs the Claude Code extension (anthropic.claude-code).', 'Install');
    if (pick === 'Install') await vscode.commands.executeCommand('workbench.extensions.installExtension', CLAUDE_CODE_ID);
    return;
  }

  if (task === undefined) {
    task = await vscode.window.showInputBox({
      title: 'Hand off to Claude Code',
      prompt: 'What should Claude Code do? It can read, edit and run across the whole workspace.',
      placeHolder: 'e.g. refactor this into a service and update every caller',
      ignoreFocusOut: true,
    });
    if (task === undefined) return; // Esc
  }

  const doc = editor.document;
  const sel = editor.selection;
  const whole = sel.isEmpty;
  const range = whole ? undefined : sel;
  const diagnostics = vscode.languages.getDiagnostics(doc.uri)
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error && (!range || range.intersection(d.range)))
    .slice(0, 10)
    .map((d) => `L${d.range.start.line + 1}: ${d.message}`);

  // Claude Code reads files from disk — make sure it sees what's on screen.
  if (doc.isDirty && !doc.isUntitled) await doc.save();

  const prompt = buildPrompt({
    task,
    rel: vscode.workspace.asRelativePath(doc.uri),
    lang: doc.languageId,
    startLine: (range?.start.line ?? 0) + 1,
    endLine: (range ? range.end.line - (range.end.character === 0 && range.end.line > range.start.line ? 1 : 0) : doc.lineCount - 1) + 1,
    code: range ? doc.getText(range) : undefined,
    diagnostics,
  });

  try {
    await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, prompt);
  } catch (e) {
    // Older Claude Code builds: fall back to clipboard + open.
    await vscode.env.clipboard.writeText(prompt);
    await vscode.commands.executeCommand('claude-vscode.editor.open').then(undefined, () => {});
    vscode.window.showInformationMessage('Prompt copied — paste it into Claude Code.');
  }
}

module.exports = { buildPrompt, sendToClaudeCode, CLAUDE_CODE_ID };
