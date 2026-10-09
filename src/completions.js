'use strict';
const vscode = require('vscode');
const { stripFences, sleep } = require('./util');

class CompletionProvider {
  constructor(svc) {
    this.svc = svc;
    this.recent = []; // recent suggestions, matched as the user types (typeahead)
    this.inflight = null;
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
    // Full text before the (virtual) cursor and the start of the text after it — used to
    // match what the user keeps typing against suggestions we already have.
    const head = doc.getText(new vscode.Range(new vscode.Position(0, 0), anchor)) + accepted;
    const tail = suffix.slice(0, 120);
    const uri = doc.uri.toString();

    let rem = this.reuse(uri, head, tail);
    if (rem !== null) return rem ? item(rem) : undefined;

    // A request is already running from a point the user has typed past: wait for it
    // instead of killing it (each CLI call takes ~2-3s; restarting per keystroke never finishes).
    const fl = this.inflight;
    if (fl && fl.uri === uri && head.startsWith(fl.head) && fl.tail === tail) {
      this.log('waiting for running request');
      await fl.promise.catch(() => {});
      if (token.isCancellationRequested) return;
      rem = this.reuse(uri, head, tail);
      if (rem !== null) return rem ? item(rem) : undefined;
    } else if (fl) {
      fl.ac.abort();
      this.inflight = null;
    }

    if (automatic) {
      await sleep(svc.get('completions.debounceMs') || 600, token);
      if (token.isCancellationRequested) return;
    }
    if (this.inflight) return; // another trigger started one during our debounce

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

    const ac = new AbortController();
    const t0 = Date.now();
    const promise = svc.run('completion', { prompt, system, model: svc.completionModel(), tools: [] }, { signal: ac.signal })
      .then((res) => {
        const text = this.clean(res.text, linePrefix, maxLines);
        this.remember({ uri, head, tail, text });
        this.log(`${Date.now() - t0}ms → ${text ? JSON.stringify(text.slice(0, 60)) : '(empty)'}`);
        return text;
      });
    const entry = { uri, head, tail, promise, ac };
    this.inflight = entry;
    promise.finally(() => { if (this.inflight === entry) this.inflight = null; }).catch(() => {});

    try {
      await promise;
    } catch (e) {
      if (e?.name === 'AbortError') return this.log('aborted (cursor moved elsewhere)');
      if (!this.warned) { this.warned = true; svc.reportError(e); }
      return;
    }
    if (token.isCancellationRequested) return; // kept for typeahead on the next keystroke
    rem = this.reuse(uri, head, tail);
    return rem ? item(rem) : undefined;
  }

  /** Remaining suggestion text if the user's typing still matches a stored suggestion; '' = known empty; null = no match. */
  reuse(uri, head, tail) {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const r = this.recent[i];
      if (r.uri !== uri || r.tail !== tail || !head.startsWith(r.head)) continue;
      if (!r.text) { if (head === r.head) return ''; continue; }
      const full = r.head + r.text;
      if (full.startsWith(head) && full.length > head.length) return full.slice(head.length);
    }
    return null;
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

  remember(r) {
    this.recent.push(r);
    if (this.recent.length > 30) this.recent.shift();
  }
}

module.exports = { CompletionProvider };
