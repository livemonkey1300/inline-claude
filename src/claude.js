'use strict';
// Thin, vscode-independent wrapper around the `claude` CLI (print mode).
// Uses the user's logged-in Claude subscription — never an API key by default.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'claude.exe' : 'claude';

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function versionKey(name) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m ? m.slice(1).map(Number) : [0, 0, 0];
}

/** Find the claude binary: setting -> PATH -> common installs -> official VS Code extension. */
function resolveBinary(configured) {
  if (configured && configured !== 'claude') return configured;

  const exts = IS_WIN ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = path.join(dir, 'claude' + e);
      if (isFile(p)) return p;
    }
  }

  const home = os.homedir();
  const common = [
    path.join(home, '.local', 'bin', EXE),
    path.join(home, '.claude', 'local', EXE),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of common) if (isFile(p)) return p;

  // Binary bundled with the official "Claude Code for VS Code" extension.
  for (const root of ['.vscode', '.vscode-server', '.vscode-insiders', '.cursor', '.windsurf', '.vscode-oss']) {
    const dir = path.join(home, root, 'extensions');
    let entries = [];
    try { entries = fs.readdirSync(dir).filter((n) => n.startsWith('anthropic.claude-code-')); } catch { continue; }
    entries.sort((a, b) => {
      const A = versionKey(a), B = versionKey(b);
      for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return B[i] - A[i];
      return 0;
    });
    for (const n of entries) {
      const p = path.join(dir, n, 'resources', 'native-binary', EXE);
      if (isFile(p)) return p;
    }
  }
  return 'claude';
}

class ClaudeError extends Error {
  constructor(message, code) { super(message); this.name = 'ClaudeError'; this.code = code; }
}

/**
 * opts:
 *  prompt, cwd, model, system (replaces default prompt), appendSystem,
 *  tools: string[] | null (null = CLI default, [] = none), permissionMode,
 *  persist (bool), sessionId, resume,
 *  lean (bool), subscriptionOnly (bool), bin (string)
 * handlers: onText(delta), onTool({name,input}), signal (AbortSignal)
 * returns { text, usage, cost, sessionId, model }
 */
function run(opts, handlers = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

  if (opts.model) args.push('--model', opts.model);
  if (opts.system) args.push('--system-prompt', opts.system);
  if (opts.appendSystem) args.push('--append-system-prompt', opts.appendSystem);
  if (opts.tools) args.push('--tools', opts.tools.join(','));
  else if (Array.isArray(opts.tools)) args.push('--tools', '');
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);

  if (opts.resume) args.push('--resume', opts.resume);
  else if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (!opts.persist) args.push('--no-session-persistence');

  if (opts.lean !== false) {
    args.push('--setting-sources', opts.settingSources ?? 'project', '--strict-mcp-config', '--disable-slash-commands');
  }

  const env = { ...process.env };
  if (opts.subscriptionOnly !== false) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  env.CLAUDE_CODE_ENTRYPOINT = 'inline-claude-vscode';

  const bin = resolveBinary(opts.bin);

  return new Promise((resolve, reject) => {
    if (handlers.signal?.aborted) return reject(abortError());

    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd || os.homedir(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: IS_WIN && /\.cmd$/i.test(bin),
        windowsHide: true,
      });
    } catch (e) {
      return reject(new ClaudeError(String(e.message || e), 'SPAWN'));
    }

    let text = '';
    let streamed = false;
    let final = null;
    let stderr = '';
    let buf = '';
    let settled = false;

    const done = (fn, v) => { if (settled) return; settled = true; cleanup(); fn(v); };
    const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } done(reject, abortError()); };
    const cleanup = () => handlers.signal?.removeEventListener('abort', onAbort);
    handlers.signal?.addEventListener('abort', onAbort);

    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }

      if (ev.type === 'stream_event') {
        const e = ev.event || {};
        if (e.type === 'message_start' && streamed && text) { text += '\n\n'; handlers.onText?.('\n\n'); }
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          streamed = true;
          text += e.delta.text;
          handlers.onText?.(e.delta.text);
        }
      } else if (ev.type === 'assistant') {
        for (const b of ev.message?.content || []) {
          if (b.type === 'tool_use') handlers.onTool?.({ name: b.name, input: b.input || {} });
        }
      } else if (ev.type === 'result') {
        final = ev;
      }
    };

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 8000) stderr = stderr.slice(-8000); });

    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        done(reject, new ClaudeError(
          'Claude Code CLI not found. Install the official Claude Code extension or the CLI, or set "inlineClaude.claudePath".', 'ENOENT'));
      } else done(reject, new ClaudeError(String(e.message || e), 'SPAWN'));
    });

    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf);
      if (final) {
        if (final.is_error) {
          const msg = String(final.result || stderr || 'Claude returned an error').trim();
          const notLoggedIn = /not logged in|\/login|please run .*login|authentication|invalid api key/i.test(msg);
          return done(reject, new ClaudeError(msg, notLoggedIn ? 'NOT_LOGGED_IN' : 'API'));
        }
        const u = final.usage || {};
        return done(resolve, {
          text: streamed ? text : String(final.result ?? ''),
          usage: {
            input: u.input_tokens || 0,
            cacheWrite: u.cache_creation_input_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0,
            output: u.output_tokens || 0,
          },
          cost: final.total_cost_usd || 0,
          sessionId: final.session_id,
          model: Object.keys(final.modelUsage || {})[0],
        });
      }
      const msg = (stderr || `claude exited with code ${code}`).trim();
      const notLoggedIn = /not logged in|\/login|login/i.test(msg);
      done(reject, new ClaudeError(msg, notLoggedIn ? 'NOT_LOGGED_IN' : 'EXIT'));
    });

    child.stdin.on('error', () => { /* process died early; close handler reports */ });
    child.stdin.end(opts.prompt);
  });
}

function abortError() { const e = new Error('cancelled'); e.name = 'AbortError'; return e; }

function newSessionId() { return crypto.randomUUID(); }

module.exports = { run, resolveBinary, ClaudeError, newSessionId };
