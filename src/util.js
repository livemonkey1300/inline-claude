'use strict';

/** Remove a wrapping ``` fence the model may have added despite instructions. */
function stripFences(s) {
  let t = s.replace(/\r\n/g, '\n');
  const m = /^\s*```[\w.+-]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  if (m) return m[1];
  // opening fence only (truncated output)
  t = t.replace(/^\s*```[\w.+-]*\n/, '');
  return t;
}

function sleep(ms, token) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    token?.onCancellationRequested?.(() => { clearTimeout(t); resolve(); });
  });
}

/** Create an AbortController that aborts when a vscode CancellationToken fires. */
function abortFromToken(token) {
  const ac = new AbortController();
  if (token.isCancellationRequested) ac.abort();
  else token.onCancellationRequested(() => ac.abort());
  return ac;
}

function compareVersions(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const A = p(a), B = p(b);
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
  return 0;
}

module.exports = { stripFences, sleep, abortFromToken, compareVersions };
