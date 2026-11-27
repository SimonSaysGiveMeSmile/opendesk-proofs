// node --test .github/scripts/desk.test.mjs
// tools/desk.sh, the agent's helper: which origin addresses count as your fork, and what a failed
// next or submit says and leaves, against a stub desk on 127.0.0.1, a stub gh, and local git
// repositories that stand in for GitHub (url.<path>.insteadOf). Needs bash, git, python3 and curl.
// DESK_TEST_BASH picks the bash (e.g. /bin/bash, macOS's bash 3.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESK = fileURLToPath(new URL('../../tools/desk.sh', import.meta.url));
const CHECK_LEAN = fileURLToPath(new URL('../../tools/check-lean.mjs', import.meta.url));
const BASH = process.env.DESK_TEST_BASH || 'bash';
const UP = 'SimonSaysGiveMeSmile/opendesk-proofs';
const ID = 'foo_1', FILE = `witnesses/${ID}.json`;

// A home of its own: git reads no global or system config but the one written here.
const world = () => {
  const t = mkdtempSync(join(tmpdir(), 'desk-'));
  const home = join(t, 'home'), bin = join(t, 'bin'); mkdirSync(home); mkdirSync(bin);
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${bin}:${process.env.PATH}`, GIT_TERMINAL_PROMPT: '0' };
  delete env.DESK_URL; delete env.DESK_UPSTREAM;
  const git = (cwd, ...a) => {
    const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  return { t, home, bin, env, git };
};

// GitHub, made of local repositories: the upstream with one commit on main, alice's fork of it, and a
// clone of the fork whose origin reads https://github.com/alice/opendesk-proofs.
const repos = (w) => {
  const { t, git } = w;
  const seed = join(t, 'seed'); mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'proofs\n'); writeFileSync(join(seed, '.gitignore'), '.desk/\n');
  git(seed, 'add', '.'); git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'start');
  git(t, 'clone', '-q', '--bare', seed, 'upstream.git');
  git(t, 'clone', '-q', '--bare', join(t, 'upstream.git'), 'fork.git');
  writeFileSync(w.env.GIT_CONFIG_GLOBAL, [
    '[user]', '\tname = alice', '\temail = alice@example.com',
    `[url "${join(t, 'upstream.git')}"]`, `\tinsteadOf = https://github.com/${UP}.git`,
    `[url "${join(t, 'fork.git')}"]`, '\tinsteadOf = https://github.com/alice/opendesk-proofs', ''].join('\n'));
  git(t, 'clone', '-q', join(t, 'fork.git'), 'work');
  const work = join(t, 'work');
  git(work, 'remote', 'set-url', 'origin', 'https://github.com/alice/opendesk-proofs');
  return work;
};

// A stub gh: alice is signed in, a pull request opens as #7, no pull request is open yet, and GitHub
// knows the repository alice/opendesk-proofs.
const stubGh = (w) => {
  writeFileSync(join(w.bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "api user") echo alice ;;
  "api repos/alice/opendesk-proofs") echo alice/opendesk-proofs ;;
  "api "*) echo "HTTP 404" >&2; exit 1 ;;
  "pr create") echo "https://github.com/${UP}/pull/7" ;;
  "pr list") ;;
  *) echo "stub gh: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(w.bin, 'gh'), 0o755);
};

// A job held here: a compute job whose witness was checked.
const holdJob = (work) => {
  mkdirSync(join(work, '.desk'), { recursive: true }); mkdirSync(join(work, 'witnesses'), { recursive: true });
  writeFileSync(join(work, '.desk', `${ID}.json`), JSON.stringify({ lease: 'L1', gap: { id: ID, file: FILE, kind: 'compute' }, beat_every_s: 300 }));
  const body = JSON.stringify({ gap: ID, claim: 'a bound', witness: [1] }) + '\n';
  writeFileSync(join(work, FILE), body);
  writeFileSync(join(work, '.desk', `${ID}.checked`), `${createHash('sha256').update(body).digest('hex')} ${FILE}\n`);
};

// The stub desk: route(path, req, res) answers; every request is logged.
const desk = async (route) => {
  const log = [];
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); log.push(`${req.method} ${u.pathname}`);
    const json = (code, d) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (route(u.pathname, req, res, json) === undefined && !res.headersSent) json(404, { error: 'not_found', say: 'no such route' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/desk`, log, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
};

// Run desk.sh without blocking this process (the stub desk answers from it).
const run = (w, cwd, deskUrl, ...args) => new Promise((resolve) => {
  const p = spawn(BASH, [DESK, ...args], { cwd, env: { ...w.env, DESK_URL: deskUrl } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (status) => resolve({ status, out }));
});

// The functions alone: desk.sh sourced in a git repository runs no command.
const fn = (w, cwd, script) => spawnSync(BASH, ['-c', `source "$1"; ${script}`, 'desk-test', DESK], { cwd, env: w.env, encoding: 'utf8' });

test('desk.sh: which origin addresses are your fork', () => {
  const w = world();
  try {
    w.git(w.t, 'init', '-q', 'r');
    const cases = [
      ['https://github.com/alice/opendesk-proofs', 'fork'],
      ['https://github.com/alice/opendesk-proofs.git', 'fork'],
      ['https://github.com/Alice/opendesk-proofs/', 'fork'],
      ['https://alice@github.com/alice/opendesk-proofs.git', 'fork'],
      ['git@github.com:alice/opendesk-proofs.git', 'fork'],
      ['ssh://git@github.com/alice/opendesk-proofs.git', 'fork'],
      ['ssh://git@github.com:22/alice/opendesk-proofs', 'fork'],
      ['ssh://github.com/alice/opendesk-proofs', 'fork'],
      ['github-personal:alice/opendesk-proofs', 'fork'],
      ['me@gh-work:alice/opendesk-proofs.git', 'fork'],
      ['ssh://gh-work:2222/alice/opendesk-proofs', 'fork'],
      [`https://github.com/${UP}`, 'not-yours'],
      ['https://github.com/bob/opendesk-proofs', 'not-yours'],
      ['github-personal:bob/opendesk-proofs', 'not-yours'],
      ['https://gitlab.com/alice/opendesk-proofs', 'not-github'],
      ['/srv/git/opendesk-proofs.git', 'not-github'],
      ['file:///srv/git/alice/opendesk-proofs', 'not-github'],
      ['https://github.com/alice/opendesk-proofs/extra', 'not-github'],
    ];
    for (const [url, want] of cases) {
      const r = fn(w, join(w.t, 'r'), `origin_kind '${url}' alice '${UP}' || true`);
      assert.equal(r.stdout.trim(), want, `${url}: ${r.stdout}${r.stderr}`);
    }
    const own = fn(w, join(w.t, 'r'), `origin_kind 'git@github.com:simonsaysgivemesmile/opendesk-proofs' SimonSaysGiveMeSmile '${UP}'`);
    assert.equal(own.stdout.trim(), 'upstream-owner');
    const r = fn(w, join(w.t, 'r'), `repo_of_url 'git@github.com:alice/x.git'; echo; repo_of_alias 'github-personal:alice/x.git'; echo; repo_of_url 'github-personal:alice/x' || echo none`);
    assert.equal(r.stdout, 'alice/x\nalice/x\nnone\n');
  } finally { rmSync(w.t, { recursive: true, force: true }); }
});

test('desk.sh: must_say passes only on the checker\'s own verdict line', () => {
  const w = world();
  try {
    w.git(w.t, 'init', '-q', 'r');
    const r = fn(w, join(w.t, 'r'), `must_say ACCEPTED sh -c 'echo ACCEPTED x' && echo P1; must_say ACCEPTED true || echo F1; must_say ACCEPTED sh -c 'echo ACCEPTED; exit 2' || echo "F2 $?"`);
    assert.match(r.stdout, /^ACCEPTED x\nP1\n/);
    assert.match(r.stdout, /\nF1\n/);
    assert.match(r.stderr, /REJECTED \(no verdict\)/);
    assert.match(r.stdout, /F2 2\n$/);
  } finally { rmSync(w.t, { recursive: true, force: true }); }
});

// A STOP the background beat wrote is printed and sets BEAT_STOPPED, which check and fix read to end
// with exit 3 instead of a pass.
test('desk.sh stop_beater: a STOP from the background beat is printed and remembered', () => {
  const w = world();
  try {
    w.git(w.t, 'init', '-q', 'r');
    const r = fn(w, join(w.t, 'r'), 'sleep 30 & BEATER=$!; BEAT_NOTE="$(mktemp)"; echo "STOP: the lease lapsed" > "$BEAT_NOTE"; stop_beater; echo "S=$BEAT_STOPPED"; sleep 30 & BEATER=$!; BEAT_STOPPED=""; BEAT_NOTE="$(mktemp)"; stop_beater; echo "T=$BEAT_STOPPED"');
    assert.equal(r.stdout, 'S=yes\nT=\n', r.stderr);
    assert.match(r.stderr, /STOP \(from the background beat while this ran\)[\s\S]*the lease lapsed/);
  } finally { rmSync(w.t, { recursive: true, force: true }); }
});

test('desk.sh fork_check (setup, submit, fix) takes an SSH host alias origin GitHub knows, and refuses one it does not', async () => {
  const w = world();
  try {
    const work = repos(w); stubGh(w);
    w.git(work, 'remote', 'set-url', 'origin', 'github-personal:alice/opendesk-proofs');
    const r = fn(w, work, 'fork_check; echo "HEAD=$HEAD_PREFIX"');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /HEAD=alice:/);
    assert.match(r.stderr, /host alias; taken as github.com\/alice\/opendesk-proofs/);
    w.git(work, 'remote', 'set-url', 'origin', 'github-personal:alice/other-name');
    const bad = fn(w, work, 'fork_check');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /GitHub does not know that repository/);
  } finally { rmSync(w.t, { recursive: true, force: true }); }
});

test('desk.sh submit: a failed push leaves the file in the tree, and submit goes on from there', async () => {
  const w = world();
  const d = await desk((p, req, res, json) => {
    if (p === '/desk/step') return json(200, { state: 'leased', gap: { id: ID } });
    if (p === '/desk/beat') return json(200, { ok: true, expires_at: '2026-01-01T00:00:00Z' });
    if (p === '/desk/release') return json(200, { ok: true, gap: ID, reason: 'submitted' });
  });
  try {
    const work = repos(w); stubGh(w); holdJob(work);
    const hook = join(w.t, 'fork.git', 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "refused by the test" >&2\nexit 1\n'); chmodSync(hook, 0o755);
    const r = await run(w, work, d.url, 'submit', ID);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /the push to origin failed/);
    assert.match(r.out, /is committed on the branch foo_1 here/);
    assert.match(r.out, /you are still on the branch foo_1/);
    assert.doesNotMatch(r.out, /git branch -D/);
    assert.ok(existsSync(join(work, FILE)), 'the file left the tree');
    assert.equal(w.git(work, 'symbolic-ref', '--short', 'HEAD'), ID);
    rmSync(hook);
    const again = await run(w, work, d.url, 'submit', ID);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /submitted https:\/\/github\.com\/SimonSaysGiveMeSmile\/opendesk-proofs\/pull\/7/);
    assert.ok(!existsSync(join(work, '.desk', `${ID}.json`)), 'the job was not cleared');
  } finally { await d.close(); rmSync(w.t, { recursive: true, force: true }); }
});

test('desk.sh submit: a gap solved after the push says release, never submit again or beat', async () => {
  const w = world();
  let steps = 0;
  const d = await desk((p, req, res, json) => {
    if (p === '/desk/step') { steps += 1; return json(200, { state: steps === 1 ? 'leased' : 'solved', say: 'solved by another pull request', gap: { id: ID } }); }
    if (p === '/desk/beat') return json(200, { ok: true });
  });
  try {
    const work = repos(w); stubGh(w); holdJob(work);
    const r = await run(w, work, d.url, 'submit', ID);
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /this gap is no longer open \(solved\)/);
    assert.match(r.out, /the gap is closed/);
    assert.match(r.out, /give the job back: tools\/desk\.sh release foo_1 other/);
    assert.doesNotMatch(r.out, /to go on/);
    assert.doesNotMatch(r.out, /keep it: tools\/desk\.sh beat/);
    assert.equal(w.git(work, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.ok(w.git(work, 'show', `${ID}:${FILE}`).includes('"gap"'), 'the file is not kept on the branch');
  } finally { await d.close(); rmSync(w.t, { recursive: true, force: true }); }
});

test('desk.sh next: one request; an answer cut off after 200 says a lease may be held', async () => {
  const w = world();
  const d = await desk((p, req, res) => {
    if (p === '/desk/next') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
      res.write('{"gap":{"id":"foo_1","kind":"compute"'); setTimeout(() => res.destroy(), 50); return true;
    }
  });
  try {
    const work = repos(w); stubGh(w);
    const r = await run(w, work, d.url, 'next');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /HTTP 200\) but its answer was cut off/);
    assert.match(r.out, /A lease may now be held for you/);
    assert.doesNotMatch(r.out, /nothing was taken/);
    assert.deepEqual(d.log.filter((l) => l.endsWith('/desk/next')), ['GET /desk/next']);
    assert.ok(!existsSync(join(work, '.desk', '.last.json')));
  } finally { await d.close(); rmSync(w.t, { recursive: true, force: true }); }
});

test('desk.sh next: a desk that cannot be reached took nothing', async () => {
  const w = world();
  const d = await desk(() => undefined); const url = d.url; await d.close();
  try {
    const work = repos(w); stubGh(w);
    const r = await run(w, work, url, 'next');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /could not be reached \(no answer, curl exit 7\); nothing was taken/);
  } finally { rmSync(w.t, { recursive: true, force: true }); }
});

// check-lean.mjs's main guard: from a path with '#' and '%' it still runs (here: its usage fault).
test('check-lean.mjs runs from a path with # and %', () => {
  const t = mkdtempSync(join(tmpdir(), 'check-lean-'));
  try {
    mkdirSync(join(t, 'a#b%c')); copyFileSync(CHECK_LEAN, join(t, 'a#b%c', 'check-lean.mjs'));
    const r = spawnSync(process.execPath, [join(t, 'a#b%c', 'check-lean.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.match(r.stdout + r.stderr, /CHECKER FAULT: usage/);
  } finally { rmSync(t, { recursive: true, force: true }); }
});
