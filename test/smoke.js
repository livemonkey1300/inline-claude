'use strict';
// Offline smoke test: runs anywhere (CI, Windows, macOS, Linux) — no Claude login needed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripFences, compareVersions } = require('../src/util');
const { resolveBinary } = require('../src/claude');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// util
assert.strictEqual(stripFences('```js\nlet a = 1;\n```'), 'let a = 1;');
assert.strictEqual(stripFences('plain'), 'plain');
assert.strictEqual(stripFences('```\nx\n'), 'x\n');

// binary resolution never throws and returns a string
assert.strictEqual(typeof resolveBinary('claude'), 'string');
assert.strictEqual(resolveBinary('/custom/claude'), '/custom/claude');

// updater version compare
assert.ok(compareVersions('1.2.0', '1.1.9') > 0);
assert.ok(compareVersions('0.1.0', '0.1.0') === 0);
assert.ok(compareVersions('v0.2.0', '0.10.0') < 0);

// manifest consistency: every contributed command is registered, every file exists
const ext = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
for (const c of pkg.contributes.commands) assert.ok(ext.includes(`'${c.command}'`), `command not registered: ${c.command}`);
assert.ok(fs.existsSync(path.join(root, pkg.main)), 'main exists');
assert.ok(fs.existsSync(path.join(root, pkg.icon)), 'icon exists');
for (const f of ['chat.js', 'chat.css', 'icon.svg']) assert.ok(fs.existsSync(path.join(root, 'media', f)), f);
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);

console.log('offline smoke OK — v' + pkg.version);
