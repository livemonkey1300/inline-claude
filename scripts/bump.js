'use strict';
// Decide the next semver from Conventional Commits since the last v* tag.
//   feat            -> minor      fix/perf/refactor/etc -> patch
//   type! / BREAKING CHANGE -> major (minor while version is 0.x)
//   chore(release) commits, docs/ci/test/style/chore only -> no release
const { execSync } = require('child_process');
const fs = require('fs');

const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

function decide(messages) {
  let level = 0; // 0 none, 1 patch, 2 minor, 3 major
  for (const m of messages) {
    const head = m.split('\n')[0];
    if (/^chore\(release\)/.test(head)) continue;
    const t = /^(\w+)(\([^)]*\))?(!)?:/.exec(head);
    if (/BREAKING[ -]CHANGE/.test(m) || (t && t[3])) level = Math.max(level, 3);
    else if (t && t[1] === 'feat') level = Math.max(level, 2);
    else if (t && ['fix', 'perf', 'refactor', 'revert'].includes(t[1])) level = Math.max(level, 1);
    else if (!t) level = Math.max(level, 1); // non-conventional message: treat as patch
  }
  return level;
}

function next(version, level) {
  let [a, b, c] = version.split('.').map(Number);
  if (level === 3 && a === 0) level = 2; // stay 0.x until you decide to go 1.0
  if (level === 3) return `${a + 1}.0.0`;
  if (level === 2) return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

if (require.main === module) {
  let tag = '';
  try { tag = sh('git describe --tags --abbrev=0 --match "v*"'); } catch { /* first release */ }
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const msgs = sh(`git log ${range} --format=%B%x00`).split('\0').map((s) => s.trim()).filter(Boolean);
  const force = process.env.FORCE_BUMP; // patch|minor|major from manual dispatch
  const level = force ? { patch: 1, minor: 2, major: 3 }[force] : decide(msgs);
  const current = tag ? tag.slice(1) : JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const version = level ? next(current, level) : current;
  const out = `release=${level ? 'true' : 'false'}\nversion=${version}\n`;
  console.log(out + `(since ${tag || 'start'}: ${msgs.length} commits)`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
}

module.exports = { decide, next };
