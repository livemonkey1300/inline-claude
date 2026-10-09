'use strict';
const vscode = require('vscode');
const { stripFences, sleep, abortFromToken } = require('./util');

class CompletionProvider {
  constructor(svc) {
    this.svc = svc;
    this.cache = new Map(); // LRU of recent suggestions
  }

  log(msg) { if (this.svc.get('completions.debug')) this.svc.out.appendLine(`[completion] ${msg}`); }

  async provideInlineCompletionItems(doc, pos, ctx, token) {
    const svc = this.svc;
    if (!svc.get('completions.enabled')) return;
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return;
    if ((svc.get('completions.disabledLanguages') || []).includes(doc.languageId)) return;

    const automatic = ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
    if (automatic && svc.get('completions.mode') === 'manual') return;

    // When the suggest dropdown is open (very common with Pylance, TS, etc.), VS Code only shows
    // ghost text that extends the highlighted item. Pretend that item is already typed and
    // complete after it — the same thing Copilot does.
    const sci = ctx.selectedCompletionInfo;
    const anchor = sci ? sci.range.start : pos;
    const replaceRange = sci ? sci.range : new vscode.Range(pos, pos);
    const accepted = sci ? sci.text : '';

    const line = doc.lineAt(pos.line).text;
    const linePrefix = line.slice(0, anchor.character) + accepted;
    const lineSuffix = line.slice(pos.character);
    if (automatic && !sci) {
      if (/\w$/.test(linePrefix) && /^\w/.test(lineSuffix)) return this.log('skip: mid-word');
      if (lineSuffix.trim().length > 0 && !/^[)\]}'"`;:,\s]*$/.test(lineSuffix)) return this.log('skip: text after cursor');
    }

    const preLines = svc.get('completions.maxPrefixLines') || 60;
    const sufLines = svc.get('completions.maxSuffixLines') || 20;
    const prefix = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, pos.line - preLines), 0), anchor)) + accepted;
    const lastLine = Math.min(doc.lineCount - 1, pos.line + sufLines);
    const suffix = doc.getText(new vscode.Range(pos, doc.lineAt(lastLine).range.end));
    if (!prefix.trim() && !suffix.trim()) return;

    const item = (t) => [new vscode.InlineCompletionItem(accepted + t, replaceRange)];
    const key = doc.languageId + '\0' + prefix.slice(-500) + '\0' + suffix.slice(0, 200);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key); this.cache.set(key, hit);
      return hit ? item(hit) : undefined;
    }

    if (automatic) {
      await sleep(svc.get('completions.debounceMs') || 600, token);
      if (token.isCancellationRequested) return;
    }

    const maxLines = svc.get('completions.maxLines') || 12;
    const system = [
      'You are an inline code-completion engine inside an editor.',
      'The file contains a <CURSOR> marker. Reply with ONLY the exact text to insert at the cursor.',
      'No markdown fences, no explanations, and never repeat text that is already before or after the cursor.',
      `Complete the current statement or block; at most ${maxLines} lines. Match the file's style and indentation.`,
      'If the cursor is at the end of a line and the next line should start new code, begin your reply with a newline.',
      'If nothing sensible can be inserted, reply with an empty message.',
    ].join(' ');
    const prompt = `file: ${vscode.workspace.asRelativePath(doc.uri)}\nlanguage: ${doc.languageId}\n\n${prefix}<CURSOR>${suffix}`;

    const ac = abortFromToken(token);
    const t0 = Date.now();
    let res;
    try {
      res = await svc.run('completion', { prompt, system, model: svc.completionModel(), tools: [] }, { signal: ac.signal });
    } catch (e) {
      if (e?.name === 'AbortError') return this.log('cancelled (kept typing)');
      if (!this.warned) { this.warned = true; svc.reportError(e); }
      return;
    }

    const text = this.clean(res.text, linePrefix, maxLines);
    this.remember(key, text);
    this.log(`${Date.now() - t0}ms → ${text ? JSON.stringify(text.slice(0, 60)) : '(empty)'}${token.isCancellationRequested ? ' [discarded: cursor moved]' : ''}`);
    if (!text || token.isCancellationRequested) return;
    return item(text);
  }

  clean(raw, linePrefix, maxLines) {
    let t = stripFences(raw).replace(/<\/?CURSOR>/g, '');
    // model sometimes echoes the line it was asked to continue
    const lp = linePrefix.trimStart();
    if (lp && t.trimStart().startsWith(lp)) t = t.trimStart().slice(lp.length);
    const lines = t.split('\n');
    if (lines.length > maxLines) t = lines.slice(0, maxLines).join('\n');
    t = t.replace(/\s+$/, '');
    return t.trim() ? t : '';
  }

  remember(key, text) {
    this.cache.set(key, text);
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
  }
}

module.exports = { CompletionProvider };
