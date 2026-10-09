'use strict';
const vscode = require('vscode');
const { stripFences } = require('./util');

function gitApi() {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) return null;
  const exports = ext.isActive ? ext.exports : null;
  return exports ? exports.getAPI(1) : null;
}

async function pickRepo(api, arg) {
  if (arg?.rootUri) {
    const r = api.repositories.find((x) => x.rootUri.toString() === arg.rootUri.toString());
    if (r) return r;
  }
  if (arg?.inputBox) return arg; // already a Repository
  const repos = api.repositories;
  if (repos.length <= 1) return repos[0];
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const m = repos.filter((r) => active.fsPath.startsWith(r.rootUri.fsPath)).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (m) return m;
  }
  const pick = await vscode.window.showQuickPick(repos.map((r) => ({ label: vscode.workspace.asRelativePath(r.rootUri), r })), { title: 'Repository' });
  return pick?.r;
}

const STYLES = {
  conventional: 'Use Conventional Commits: `type(scope): subject` (feat, fix, docs, style, refactor, perf, test, build, ci, chore). Subject in imperative mood, max 72 chars, no trailing period. Optional body after a blank line only if the change needs explaining (wrap at 72).',
  plain: 'Write a short imperative subject line (max 72 chars, no trailing period). Optional body after a blank line only if needed.',
  gitmoji: 'Start the subject with one fitting gitmoji, then an imperative subject (max 72 chars). Optional short body after a blank line.',
};

async function generate(svc, arg) {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (ext && !ext.isActive) await ext.activate();
  const api = gitApi();
  if (!api) return vscode.window.showErrorMessage('The built-in Git extension is not available.');
  const repo = await pickRepo(api, arg);
  if (!repo) return vscode.window.showWarningMessage('No git repository found.');

  let diff = await repo.diff(true);
  let scope = 'staged changes';
  if (!diff.trim()) {
    diff = await repo.diff(false);
    scope = 'unstaged changes (nothing is staged)';
  }
  if (!diff.trim()) return vscode.window.showInformationMessage('No changes to describe.');

  const max = svc.get('commit.maxDiffChars') || 12000;
  let truncated = false;
  if (diff.length > max) { diff = shrinkDiff(diff, max); truncated = true; }

  let recent = '';
  try {
    const log = await repo.log({ maxEntries: 5 });
    recent = log.map((c) => `- ${c.message.split('\n')[0]}`).join('\n');
  } catch { /* new repo */ }

  const style = STYLES[svc.get('commit.style')] || STYLES.conventional;
  const system = [
    'You write git commit messages.',
    style,
    `Write in ${svc.get('commit.language') || 'English'}.`,
    'Describe WHAT changed and WHY, based only on the diff. Output ONLY the commit message — no quotes, no markdown, no preamble.',
  ].join(' ');
  const prompt = `${recent ? `Recent commits (match their style):\n${recent}\n\n` : ''}Diff of ${scope}${truncated ? ' (truncated)' : ''}:\n${diff}`;

  await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Claude is writing the commit message…' }, async () => {
    try {
      const r = await svc.run('commit', { prompt, system, model: svc.model(), tools: [] }, {});
      let msg = stripFences(r.text).trim().replace(/^["'`]+|["'`]+$/g, '');
      if (msg) repo.inputBox.value = msg;
    } catch (e) { await svc.reportError(e); }
  });
}

/** Keep the file headers + the first hunks of every file instead of cutting mid-file. */
function shrinkDiff(diff, max) {
  const files = diff.split(/^(?=diff --git )/m);
  const per = Math.max(600, Math.floor(max / files.length));
  const out = files.map((f) => (f.length > per ? f.slice(0, per) + '\n… [truncated]\n' : f)).join('');
  return out.length > max ? out.slice(0, max) + '\n… [truncated]' : out;
}

module.exports = { generate };
