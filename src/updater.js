'use strict';
// Update check for sideloaded installs (VSIX from GitHub Releases).
// Marketplace / Open VSX installs are updated by VS Code itself.
const vscode = require('vscode');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compareVersions } = require('./util');

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'inline-claude-updater', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(get(res.headers.location, headers));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      resolve(res);
    }).on('error', reject);
  });
}

async function json(url) {
  const res = await get(url, { Accept: 'application/vnd.github+json' });
  let s = ''; for await (const c of res) s += c;
  return JSON.parse(s);
}

async function download(url, dest) {
  const res = await get(url);
  await new Promise((resolve, reject) => { const f = fs.createWriteStream(dest); res.pipe(f); f.on('finish', resolve); f.on('error', reject); });
}

async function check(context, svc, manual) {
  const mode = svc.get('autoUpdate');
  if (!manual && mode === 'off') return;
  const repo = context.extension.packageJSON.repository?.url?.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
  if (!repo) return;
  try {
    const rel = await json(`https://api.github.com/repos/${repo}/releases/latest`);
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const current = context.extension.packageJSON.version;
    if (!latest || compareVersions(latest, current) <= 0) {
      if (manual) vscode.window.showInformationMessage(`Inline Claude is up to date (v${current}).`);
      return;
    }
    const asset = (rel.assets || []).find((a) => a.name.endsWith('.vsix'));
    if (!asset) return;
    const skipped = context.globalState.get('skipVersion');
    if (!manual && skipped === latest) return;

    const doInstall = async () => {
      const dest = path.join(os.tmpdir(), asset.name);
      await download(asset.browser_download_url, dest);
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(dest));
      const pick = await vscode.window.showInformationMessage(`Inline Claude v${latest} installed. Reload to use it.`, 'Reload');
      if (pick === 'Reload') vscode.commands.executeCommand('workbench.action.reloadWindow');
    };

    if (mode === 'install' && !manual) return await doInstall();
    const pick = await vscode.window.showInformationMessage(
      `Inline Claude v${latest} is available (you have v${current}).`, 'Update now', 'Release notes', 'Skip this version');
    if (pick === 'Update now') await doInstall();
    else if (pick === 'Release notes') vscode.env.openExternal(vscode.Uri.parse(rel.html_url));
    else if (pick === 'Skip this version') context.globalState.update('skipVersion', latest);
  } catch (e) {
    svc.out.appendLine('update check failed: ' + (e.message || e));
    if (manual) vscode.window.showWarningMessage('Update check failed: ' + (e.message || e));
  }
}

module.exports = { check };
