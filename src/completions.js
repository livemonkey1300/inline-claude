'use strict';
const vscode = require('vscode');
const { stripFences, sleep, abortFromToken } = require('./util');

class CompletionProvider {
  constructor(svc) {
    this.svc = svc;
    this.cache = new Map(); // LRU of recent suggestions
  }

  async provideInlineCompletionItems(doc, pos, ctx, token) {
    const svc = this.svc;
    if (!svc.get('completions.enabled')) return;
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return;
    if ((svc.get('completions.disabledLanguages') || []).includes(doc.languageId)) return;
    if (ctx.selectedCompletionInfo) return; // don't fight the suggest widget

    const automatic = ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
    if (automatic && svc.get('completions.mode') === 'manual') return;

    const line = doc.lineAt(pos.line).text;
    const linePrefix = line.slice(0, pos.character);
    const lineSuffix = line.slice(pos.character);
    if (automatic) {
      if (/\w$/.test(linePrefix) && /^\w/.test(lineSuffix)) return;   // mid-word
      if (lineSuffix.trim().length > 0 && !/^[)\]}'"`;,\s]*$/.test(lineSuffix)) return; // mid-expression
    }

    const preLines = svc.get('completions.maxPrefixLines') || 60;
    const sufLines = svc.get('completions.maxSuffixLines') || 20;
    const prefix = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, pos.line - preLines), 0), pos));
    const lastLine = Math.min(doc.lineCount - 1, pos.line + sufLines);
    const suffix = doc.getText(new vscode.Range(pos, doc.lineAt(lastLine).range.end));
    if (!prefix.trim() && !suffix.trim()) return;

    const key = doc.languageId + '\0' + prefix.slice(-500) + '\0' + suffix.slice(0, 200);
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key); this.cache.set(key, hit);
      return hit ? [new vscode.InlineCompletionItem(hit, new vscode.Range(pos, pos))] : undefined;
    }

    if (automatic) {
      await sleep(svc.get('completions.debounceMs') || 900, token);
      if (token.isCancellationRequested) return;
    }

    const maxLines = svc.get('completions.maxLines') || 12;
    const system = [
      'You are an inline code-completion engine inside an editor.',
      'The file contains a <CURSOR> marker. Reply with ONLY the exact text to insert at the cursor.',
      'No markdown fences, no explanations, and never repeat text that is already before or after the cursor.',
      `Complete the current statement or block; at most ${maxLines} lines. Match the file's style and indentation.`,
      'If nothing sensible can be inserted, reply with an empty message.',
    ].join(' ');
    const prompt = `file: ${vscode.workspace.asRelativePath(doc.uri)}\nlanguage: ${doc.languageId}\n\n${prefix}<CURSOR>${suffix}`;

    const ac = abortFromToken(token);
    let res;
    try {
      res = await svc.run('completion', {
        prompt, system, model: svc.completionModel(), tools: [],
      }, { signal: ac.signal });
    } catch (e) {
      if (e?.name !== 'AbortError' && !this.warned) { this.warned = true; svc.reportError(e); }
      return;
    }
    if (token.isCancellationRequested) return;

    const text = this.clean(res.text, linePrefix, maxLines);
    this.remember(key, text);
    if (!text) return;
    return [new vscode.InlineCompletionItem(text, new vscode.Range(pos, pos))];
  }

  clean(raw, linePrefix, maxLines) {
    let t = stripFences(raw).replace(/<\/?CURSOR>/g, '');
    // model sometimes echoes the line it was asked to continue
    const lp = linePrefix.trimStart();
    if (lp && t.trimStart().startsWith(lp)) t = t.trimStart().slice(lp.length);
    const lines = t.split('\n');
    if (lines.length > maxLines) t = lines.slice(0, maxLines).join('\n');
    return t.replace(/\s+$/, '').length ? t.replace(/\s+$/, '') : '';
  }

  remember(key, text) {
    this.cache.set(key, text);
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
  }
}

module.exports = { CompletionProvider };
