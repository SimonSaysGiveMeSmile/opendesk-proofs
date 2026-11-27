#!/usr/bin/env node
// THE CHECKER. Nothing else can mark a gap checked or refuted.
//
//   node tools/check-lean.mjs <lean file> <gap constant> <gap module> [check|refute]
//
//   <gap constant>  the fully qualified formal-conjectures theorem, e.g. Erdos1.erdos_1
//   <gap module>    the module that declares it, any module under FormalConjectures, e.g.
//                   FormalConjectures.ErdosProblems.«1» (the plain form
//                   FormalConjectures.ErdosProblems.1 is taken too) or FormalConjectures.Wikipedia.Goldbach
//
// Exit 0 ONLY when all of these hold, each read from the compiled result:
//   1. the file builds in the pinned environment (lean/lean-toolchain, lean/lakefile.toml,
//      lean/lake-manifest.json, and every package checkout at the revision the manifest names);
//   2. the gap's statement, read from the PINNED formal-conjectures package, rests on no sorry
//      (a statement with answer(sorry) or a sorry placeholder definition is refused: gap-excluded);
//   3. the file imports only Mathlib, modules of Mathlib, and the gap's module;
//   4. the kernel accepts, a second time, every declaration of the file;
//   5. the theorem (named after its module, one gap one file) rests on no `sorry` and on no
//      axiom outside propext, Classical.choice, Quot.sound. The walk goes through pinned
//      theorems too, so a proof that cites the formal-conjectures theorem (itself proved by
//      sorry) is refused;
//   6. the theorem's type is the type of the original constant (its negation for `refute`),
//      syntactically or at reducible transparency, and the kernel agrees.
// Steps 2 to 6 are lean/CheckLemma.lean. On acceptance it prints, before the last line:
//   MANIFEST {"file":{"module","sha256"},"gap":{"constant","module"},"formal_conjectures":"<rev>","match":"exact|reducible-defeq"}
// Any other outcome is a non-zero exit:
//   1 = REJECTED (the last line says why): the checker ran and the file is not a proof it accepts;
//   3 = CHECKER FAULT: the checker could not judge (a missing path, a build that failed for a
//       reason outside the file, a tree whose build configuration is not the committed one).
//       A fault says nothing about the proof.
//
// WHAT IS FIXED BEFORE ANYTHING IS BUILT. The gap (constant and module) is checked against strict
// patterns and written to a private, read-only copy that the verifier reads; the verifier binary
// is hashed before the judged build and must be the same file after it; the judged tree's
// lakefile, manifest and toolchain must be what its commit holds, with no lakefile.lean beside
// them, and every package checkout must be at its manifest revision with no tracked change; no
// build setting is inherited from the caller's environment.
//
// SEVERAL TREES. The checker itself, and its verifier, always run from THIS clone;
// OPEN_DESK_REPO_ROOT names the tree whose Lean file is being judged. So the author of a proof
// cannot change the checker it is judged by.
//
// A Lean file runs code while it compiles. Run this script on a file you do not trust only
// inside an isolated environment.
//
// Adapted from open-goat/pequalnp-proofs (Apache-2.0), tools/check-lean.mjs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHECKER_VERSION = 'opendesk-check-lean 1';
const CHECKER_LEAN_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lean');
const LEAN_DIR = process.env.OPEN_DESK_REPO_ROOT ? join(process.env.OPEN_DESK_REPO_ROOT, 'lean') : CHECKER_LEAN_DIR;
const OUTSIDE = ['OpenDesk', 'Outside'];                     // every judged file is lean/OpenDesk/Outside/<gap id>.lean
const GAP_ID_RE = /^[a-z][a-z0-9_]{0,127}$/;
const BOARD = 'FormalConjectures';
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const LOCK = join(LEAN_DIR, '.lake', 'check.lock');
const LOCK_STALE_MS = 2 * BUILD_TIMEOUT_MS;

// Every byte this script prints is written synchronously: process.exit drops what a piped,
// asynchronous stdout has not drained.
const writeAll = (fd, text) => {
  const buf = Buffer.from(text);
  for (let off = 0; off < buf.length;) {
    try { off += writeSync(fd, buf, off, buf.length - off); } catch (e) { if (e.code !== 'EAGAIN') throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
  }
};
const out = (line) => writeAll(1, `${line}\n`);
const fault = (msg) => { writeAll(2, `CHECKER FAULT: ${msg}\n`); process.exit(3); };
const T0 = Date.now();
const stage = (name) => writeAll(2, `checker stage: ${name} t=${Math.round((Date.now() - T0) / 1000)}s\n`);
const reject = (cls, msg) => { out(`REJECTED (${cls}): ${msg}`); process.exit(1); };
// Anything this script did not foresee is a fault of the checker, never a verdict on the proof.
process.on('uncaughtException', (e) => fault(`the checker stopped on an error of its own: ${e?.message ?? e}`));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A Lean name as the desk writes it, split into its parts. A plain part is a letter or `_` then
// letters, digits, `_`, `'`; a part in guillemets holds letters, digits, `_` and `.`, and does not
// start with a dot: FormalConjectures.ErdosProblems.«1», FormalConjectures.Arxiv.«2104.00502».X,
// Arxiv.«2104.00502».barker_conjecture. For a module, a numeric part may also be written plain
// (FormalConjectures.ErdosProblems.1). Returns the parts, or null.
const PART = String.raw`(?:«[A-Za-z0-9_][A-Za-z0-9_.]*»|[A-Za-z_][A-Za-z0-9_']*|[0-9][A-Za-z0-9_]*)`;
const NAME_RE = new RegExp(`^${PART}(?:\\.${PART}){0,15}$`, 'u');
export function nameParts(m) {
  if (typeof m !== 'string' || m.length > 200 || !NAME_RE.test(m)) return null;
  return [...m.matchAll(new RegExp(PART, 'gu'))].map(([p]) => (p.startsWith('«') ? p.slice(1, -1) : p));
}
// The gap's module: any module below FormalConjectures (every collection: ErdosProblems, OEIS,
// Wikipedia, GreensOpenProblems, Arxiv, ...). Never FormalConjecturesUtil or another package.
export function moduleParts(m) {
  const parts = nameParts(m);
  return parts && parts.length >= 2 && parts.length <= 9 && parts[0] === BOARD && parts.every((p) => !p.includes("'")) ? parts : null;
}
// The constant: a name of at least two parts (its namespace first), no plain numeric part.
export function constantParts(c) {
  const parts = nameParts(c);
  return parts && parts.length >= 2 && !/(^|\.)[0-9]/.test(c.replace(/«[^»]*»/gu, 'x')) ? parts : null;
}

const main = () => {
  const [file, constant, gapModule, kind = 'check'] = process.argv.slice(2);
  if (!file || !constant || !gapModule) fault('usage: node tools/check-lean.mjs <lean file> <gap constant> <gap module> [check|refute]');
  if (kind !== 'check' && kind !== 'refute') fault(`kind must be check or refute, got "${kind}"`);
  const constParts = constantParts(constant);
  if (!constParts) fault('the gap constant is not a plain dotted Lean name');
  const modParts = moduleParts(gapModule);
  if (!modParts) fault(`the gap module is not a module under ${BOARD}`);
  const plainMod = modParts.join('/');
  if (!existsSync(file)) fault(`the proof file ${file} does not exist`);
  if (!existsSync(LEAN_DIR)) fault(`there is no lean/ directory in the tree being judged (${LEAN_DIR})`);
  // The gap, as it is now. Nothing that runs later can change what is judged.
  // The verifier reads each name as its parts joined by `/` (a part may hold a dot).
  const gapBytes = Buffer.from(`${constParts.join('/')}\n${plainMod}\n`);
  // The proof file, as it is now: what is recorded is these bytes, and they must not move.
  const fileBytes = readFileSync(file);

  // The module is the file's place under lean/, and it must be an outside proof file.
  const rel = relative(realpathSync(LEAN_DIR), realpathSync(file));
  const parts = rel.split(sep);
  if (rel.startsWith('..') || parts.length !== 3 || parts[0] !== OUTSIDE[0] || parts[1] !== OUTSIDE[1]
    || !parts[2].endsWith('.lean') || !GAP_ID_RE.test(parts[2].slice(0, -'.lean'.length))) {
    reject('not-an-outside-module', `${file} is not lean/OpenDesk/Outside/<gap id>.lean (gap id: lower case letters, digits, underscores)`);
  }
  const module = parts.join('.').slice(0, -'.lean'.length);

  // The judged tree builds with the configuration its commit holds, and no other.
  const TREE = dirname(LEAN_DIR);
  const CONFIG = ['lean/lakefile.toml', 'lean/lake-manifest.json', 'lean/lean-toolchain'];
  const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 120000 });
  const manifest = (() => { try { return JSON.parse(readFileSync(join(LEAN_DIR, 'lake-manifest.json'), 'utf8')); } catch { return null; } })();
  const fcRev = manifest?.packages?.find((p) => p?.name === 'formal_conjectures')?.rev;
  // Every package checkout at its manifest revision, with no tracked change. Lake builds what is
  // in .lake/packages; this makes that the pinned source, not whatever a tree left there.
  const packagesFault = () => {
    if (!Array.isArray(manifest?.packages)) return 'lean/lake-manifest.json lists no packages';
    for (const p of manifest.packages) {
      if (typeof p?.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.name) || !/^[0-9a-f]{40}$/.test(p.rev ?? '')) return 'the manifest names a package without a plain name and a full revision';
      const dir = join(LEAN_DIR, '.lake', 'packages', p.name);
      if (!existsSync(dir)) return `the package ${p.name} is not checked out (run \`lake exe cache get\` in lean/ first)`;
      const head = git(dir, ['rev-parse', 'HEAD']);
      if (head.error || head.status !== 0 || head.stdout.trim() !== p.rev) return `the package ${p.name} is not at its manifest revision ${p.rev}`;
      const clean = git(dir, ['diff', '--quiet', 'HEAD']);
      if (clean.error || clean.status !== 0) return `the package ${p.name} has changes to its tracked files`;
    }
    return null;
  };
  const configFault = () => {
    if (existsSync(join(LEAN_DIR, 'lakefile.lean'))) return 'lean/lakefile.lean exists; the project is configured by lean/lakefile.toml alone';
    const tracked = git(TREE, ['ls-files', '--error-unmatch', '--', ...CONFIG]);
    if (tracked.error || tracked.status !== 0) return `not every one of ${CONFIG.join(', ')} is a committed file of this tree`;
    const same = git(TREE, ['diff', '--quiet', 'HEAD', '--', ...CONFIG]);
    if (same.error || same.status !== 0) return `${CONFIG.join(', ')} are not what this tree's commit holds`;
    if (!/^[0-9a-f]{40}$/.test(fcRev ?? '')) return 'lean/lake-manifest.json pins no formal_conjectures revision';
    return packagesFault();
  };
  const configNow = configFault();
  if (configNow) fault(`the build configuration of the judged tree (${TREE}) is not the committed one: ${configNow}. Restore it, then run again.`);

  // The pinned Mathlib must already be there, prebuilt. The checker never compiles it.
  if (!existsSync(join(LEAN_DIR, '.lake', 'packages', 'mathlib', '.lake', 'build', 'lib', 'lean', 'Mathlib.olean'))) {
    fault('the prebuilt Mathlib cache is missing. Run `lake exe cache get` in lean/.');
  }

  stage('started');
  // One build at a time in this directory.
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  mkdirSync(join(LEAN_DIR, '.lake'), { recursive: true });
  for (;;) {
    try { mkdirSync(LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') fault(`cannot take the build lock: ${e.message}`);
      let age = 0; try { age = Date.now() - statSync(LOCK).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { try { rmdirSync(LOCK); } catch { /* another run took it */ } } else sleep(500);
    }
  }
  stage('build lock taken');
  const unlock = () => { try { rmdirSync(LOCK); } catch { /* already gone */ } };
  process.on('exit', unlock);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(3));

  // No Lean or Lake setting is inherited from the caller: the search path, the sysroot and the
  // toolchain are the judged tree's own (elan's lake reads lean/lean-toolchain), and Lake's
  // shared artifact cache is off (false, not unset: unset, Lake still reads its default cache).
  const lakeEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LAKE($|_)|LEAN_|ELAN_TOOLCHAIN$)/.test(k)));
  lakeEnv.LAKE_ARTIFACT_CACHE = 'false';
  const opts = (cwd) => ({ cwd, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: lakeEnv });
  const lakeIn = (cwd, args) => spawnSync('lake', args, opts(cwd));
  const lake = (args) => lakeIn(LEAN_DIR, args);
  const tail = (r, n = 30) => (r.stdout + r.stderr).trim().split('\n').slice(-n).join('\n');

  // The verifier is part of the checker: built from this repository, by the pinned toolchain.
  stage('building the verifier');
  const exe = lakeIn(CHECKER_LEAN_DIR, ['build', 'checklemma']);
  if (exe.error || exe.status !== 0) fault(`the verifier did not build.\n${exe.error?.message ?? tail(exe)}`);
  const VERIFIER = join(CHECKER_LEAN_DIR, '.lake', 'build', 'bin', 'checklemma');
  const verifierHash = sha256(readFileSync(VERIFIER));

  // 1. The file builds in the pinned environment (this also builds the gap's module, from the
  // pinned formal-conjectures source).
  stage('building the file');
  const build = lake(['build', `+${module}`]);
  if (build.error) fault(`the build could not run: ${build.error.message}`);
  if (build.status !== 0) {
    // "Does not compile" is a verdict on the file only when Lean reported an error in the file
    // itself. A build that failed any other way is a fault, and says nothing of the proof.
    const inSource = new RegExp(`^error: (\\./)?OpenDesk/Outside/${parts[2].replace('.', '\\.')}:`, 'm');
    if (build.status === null || !inSource.test(build.stdout + build.stderr)) fault(`the build failed for a reason that is not an error in the proof file.\n${tail(build)}`);
    out(tail(build));
    reject('does-not-compile', `${module} does not build in the pinned environment`);
  }
  const fixedFault = () => {
    if (sha256(readFileSync(VERIFIER)) !== verifierHash) return 'the verifier binary changed while the judged file was built';
    const c = configFault();
    return c ? `the build configuration of the judged tree changed while the checker ran: ${c}` : null;
  };
  const moved = fixedFault();
  if (moved) fault(`${moved}. Nothing was judged.`);

  // 2 to 6. Read the compiled result, with the checker's own verifier binary and the judged
  // tree's search path. It reads the gap from a private copy of the bytes fixed at the start.
  const PRIVATE = mkdtempSync(join(tmpdir(), 'open-desk-check-'));
  process.on('exit', () => { try { rmSync(PRIVATE, { recursive: true, force: true }); } catch { /* gone */ } });
  const gapCopy = join(PRIVATE, 'gap.txt');
  writeFileSync(gapCopy, gapBytes, { mode: 0o400 });
  stage('verifier reading the built file');
  const verify = lake(['env', VERIFIER, module, gapCopy, kind]);
  if (verify.error) fault(`the verifier could not run: ${verify.error.message}`);
  if (!readFileSync(gapCopy).equals(gapBytes)) fault('the private copy of the gap changed while the verifier ran. Nothing was judged.');
  const movedAfter = fixedFault();
  if (movedAfter) fault(`${movedAfter}. Nothing was judged.`);
  const lines = verify.stdout.trim().split('\n');
  const last = lines.at(-1) ?? '';
  const say = (keep) => { writeAll(1, lines.filter(keep).join('\n') + '\n'); writeAll(2, verify.stderr); };
  // A REJECTED line anywhere is a rejection, whatever the exit status says.
  if (lines.some((l) => l.startsWith('REJECTED'))) { say(() => true); process.exit(1); }
  // Neither a REJECTED line nor an acceptance: the verifier did not reach a verdict. A fault.
  if (verify.status !== 0 || !last.startsWith('ACCEPTED')) { say(() => true); fault(`the verifier ended without a verdict (exit ${verify.status}).`); }

  // Accepted. Record what was judged, then confirm nothing moved since the build.
  const listed = (tag) => (lines.find((l) => l.startsWith(`${tag} `)) ?? '').split(' ').slice(1).filter(Boolean);
  const mods = listed('MODULES');
  if (mods.length !== 1 || mods[0] !== module) fault('the verifier did not list exactly the proof module as what it checked');
  const how = listed('MATCH')[0];
  if (how !== 'exact' && how !== 'reducible-defeq') fault('the verifier did not say how the statement matched');
  if (!readFileSync(file).equals(fileBytes)) fault('the proof file changed while the checker ran. Run it again on the finished file.');
  const record = { file: { module, sha256: sha256(fileBytes) }, gap: { constant, module: gapModule }, formal_conjectures: fcRev, match: how };
  const fresh = lake(['build', '--no-build', `+${module}`]);
  if (fresh.error || fresh.status !== 0) fault('a source file changed while the checker ran. Run it again on the finished file.');
  say((l) => !l.startsWith('MODULES ') && !l.startsWith('MATCH ') && l !== last);
  out(`MANIFEST ${JSON.stringify(record)}`);
  out(last);
  process.exit(0);
};

// Run as a script (not imported by a test)? Compared by real path, so a path with '#', '%' or a symlink
// still runs main(); a URL comparison would skip it silently, and exit 0 with no output.
const isMain = () => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
};

if (isMain()) main();
