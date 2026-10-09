'use strict';
const vscode = require('vscode');
const { Service } = require('./service');
const { InlineEdit } = require('./inline-edit');
const { CompletionProvider } = require('./completions');
const { ChatProvider } = require('./chat');
const commit = require('./commit');
const updater = require('./updater');

function activate(context) {
  const svc = new Service(context);
  const edit = new InlineEdit(svc, context);
  const chat = new ChatProvider(svc, context);

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // Inline edit (Ctrl+I) and right-click presets
  reg('inlineClaude.inlineEdit', () => edit.start());
  reg('inlineClaude.acceptEdit', () => edit.accept());
  reg('inlineClaude.rejectEdit', () => edit.reject());
  reg('inlineClaude.showDiff', () => edit.showDiff());
  reg('inlineClaude.fix', () => edit.fix());
  reg('inlineClaude.optimize', () => edit.optimize());
  reg('inlineClaude.docs', () => edit.docs());

  // Chat-based actions
  reg('inlineClaude.explain', () => chat.ask('Explain this code: what it does, and anything surprising.', { mode: 'ask' }));
  reg('inlineClaude.tests', () => chat.ask(
    'Write unit tests for this code. Follow the testing framework and conventions already used in this project; create or extend the appropriate test file.',
    { mode: 'agent' }));
  reg('inlineClaude.askSelection', async () => {
    const q = await vscode.window.showInputBox({ title: 'Ask Claude about the selection', placeHolder: 'Your question…', ignoreFocusOut: true });
    if (q?.trim()) chat.ask(q, { mode: chat.mode });
  });
  reg('inlineClaude.openChat', () => vscode.commands.executeCommand('inlineClaude.chatView.focus'));
  reg('inlineClaude.newChat', () => chat.newChat());

  // Control hub / model switch / usage
  reg('inlineClaude.selectModel', () => svc.hub());
  reg('inlineClaude.toggleCompletions', () => svc.cfg().update('completions.enabled', !svc.get('completions.enabled'), true));
  reg('inlineClaude.showUsage', () => svc.showUsage());
  reg('inlineClaude.resetUsage', () => svc.resetUsage());
  reg('inlineClaude.signIn', () => svc.signIn());
  reg('inlineClaude.checkUpdate', () => updater.check(context, svc, true));

  // AI commit message
  reg('inlineClaude.generateCommit', (arg) => commit.generate(svc, arg));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('inlineClaude.chatView', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new CompletionProvider(svc)),
  );

  setTimeout(() => updater.check(context, svc, false), 15000);
}

function deactivate() {}

module.exports = { activate, deactivate };
