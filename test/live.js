'use strict';
// Smoke test for the CLI wrapper against the real, logged-in `claude` (no vscode needed).
const assert = require('assert');
const { run, resolveBinary } = require('../src/claude');
const { stripFences } = require('../src/util');

(async () => {
  assert.strictEqual(stripFences('```js\nlet a = 1;\n```'), 'let a = 1;');
  assert.strictEqual(stripFences('plain'), 'plain');

  console.log('binary:', resolveBinary('claude'));

  let streamed = '';
  const r = await run({
    prompt: 'function add(a, b) {<CURSOR>}',
    system: 'Code completion engine. Reply with ONLY the text to insert at <CURSOR>. No fences.',
    model: 'haiku', tools: [],
  }, { onText: (t) => { streamed += t; } });

  console.log('completion:', JSON.stringify(r.text));
  console.log('usage:', r.usage, 'model:', r.model);
  assert.ok(r.text.length > 0, 'got text');
  assert.strictEqual(streamed, r.text, 'streamed deltas match final text');
  assert.ok(r.usage.input + r.usage.cacheWrite + r.usage.cacheRead < 20000, 'lean mode keeps overhead tiny');

  // cancellation
  const ac = new AbortController();
  const p = run({ prompt: 'count to 1000', model: 'haiku', tools: [] }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  await p.then(() => assert.fail('should abort'), (e) => assert.strictEqual(e.name, 'AbortError'));

  console.log('OK');
})().catch((e) => { console.error(e); process.exit(1); });
