// node --test .github/scripts/outside-guard.test.mjs
// The rules of outside-guard.mjs: the shapes a proof file and a pull request may take, the ways a
// file could carry code that runs while it compiles, and the honest shapes that must pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile, checkGap, checkImports, checkOwnNamespace, checkPr, checkProofFile, isConstant, MAX_NAME, quoteName, Refused } from './outside-guard.mjs';

const MOD = 'FormalConjectures.ErdosProblems.«1»';
const M = 'OpenDesk.Outside.erdos_1';
const head = `import Mathlib\nimport ${MOD}\n\n`;
const enc = (s) => new TextEncoder().encode(s);
const run = (body) => checkProofFile(enc(head + body), [MOD], M);
const refused = (name, body, word) => test(`refused: ${name}`, () => {
  assert.throws(() => run(body), (e) => e instanceof Refused && e.message.includes(word), 'not refused, or for another reason');
});
const passes = (name, body) => test(`passes: ${name}`, () => {
  assert.deepEqual(run(body), ['Mathlib', MOD]);
});
const thm = `theorem ${M} : True := trivial\n`;
const by = (tac) => `theorem ${M} : True := by\n  ${tac}\n`;

// Imports
test('passes: the gap module written with guillemets on its import line', () => {
  assert.deepEqual(checkImports(enc(head + thm), [MOD]), ['Mathlib', MOD]);
});
test('refused: another formal-conjectures module', () => {
  assert.throws(() => checkImports(enc(`import Mathlib\nimport FormalConjectures.ErdosProblems.«2»\n\n${thm}`), [MOD]), /not allowed/);
});
test('refused: FormalConjecturesUtil, which the gap does not list', () => {
  assert.throws(() => checkImports(enc(`import FormalConjecturesUtil\n\n${thm}`), [MOD]), /not allowed/);
});
test('refused: a project module', () => {
  assert.throws(() => checkImports(enc(`import OpenDesk.Outside.erdos_2\n\n${thm}`), [MOD]), /not allowed/);
});
refused('an import after the header', `${thm}-- import Lean\n`, 'import');
refused('a module header', 'module\n', 'import');
refused('guillemets outside the import lines', `theorem ${M} : «True» := trivial\n`, '«');

// The plain-file rule
refused('sorry', by('sorry'), 'sorry');
refused('native_decide', by('native_decide'), 'native');
refused('decide +native', by('decide +native'), 'native');
refused('ofReduceBool', by('exact ofReduceBool x true rfl'), 'ofReduce');
refused('an axiom', `${thm} axiom a : False\n`, 'axiom');
refused('#eval', `${thm} #eval 1\n`, '#');
refused('open Lean', `open Lean in\n${thm}`, 'Lean');
refused('a string literal', `${thm}  -- "x"\n`, '"');
refused('an attribute that is not simp', `@[to_additive] theorem foo : True := trivial\n${thm}`, '@[');
refused('an option that is not a limit', `set_option debug.skipKernelTC true in\n${thm}`, 'set_option');
refused('a term elaborator name%', `theorem ${M} : type_of% Erdos1.erdos_1 := trivial\n`, 'type_of');
refused('no theorem at all', 'def x : Nat := 1\n', 'no theorem');
refused('a direction-changing character', `-- ‮\n${thm}`, 'invisible');

// The own-namespace rule
refused('a helper outside the own namespace', `lemma helper : True := trivial\n${thm}`, 'outside the file');
refused('a namespace of another file', `namespace OpenDesk.Outside.erdos_2\nlemma h : True := trivial\nend OpenDesk.Outside.erdos_2\n${thm}`, 'top level');
refused('a declaration after the theorem', `${thm}lemma late : True := trivial\n`, 'after the theorem');
test('refused: a theorem under the wrong name', () => {
  assert.throws(() => checkOwnNamespace(head + 'theorem Erdos1.erdos_1 : True := trivial\n', M), /full name/);
});

passes('one theorem', thm);
passes('open lines from the formal-conjectures file, and the gap namespace opened', `open Filter\nopen scoped Topology Real\nopen Erdos1\n\n${thm}`);
passes('helpers in the own namespace', `namespace ${M}\nlemma helper : 1 + 1 = 2 := rfl\nend ${M}\n\n${thm}`);
passes('the limit options', `set_option maxHeartbeats 400000 in\n${thm}`);
passes('decide +kernel', by('decide +kernel'));
passes('the cited theorem is fine for the guard (the checker refuses it: sorry)', `theorem ${M} : True := Erdos1.erdos_1\n`);

// The pull request
const sha = 'a'.repeat(40), blob = 'b'.repeat(40);
const pr = (over = {}) => ({ state: 'open', base: { repo: { full_name: 'o/r' }, ref: 'main' }, head: { sha }, user: { login: 'someone' }, changed_files: 1, number: 7, ...over });
const file = 'lean/OpenDesk/Outside/erdos_1.lean';
const files = [{ filename: file, status: 'added', sha: blob }];
const tree = (mode = '100644', size = 100) => ({ tree: [{ path: file, type: 'blob', mode, sha: blob, size }] });
test('passes: one added plain file', () => {
  assert.equal(checkPr(pr(), files, tree(), 'o/r', 'main').module, M);
});
test('refused: two files', () => { assert.throws(() => checkPr(pr({ changed_files: 2 }), files, tree(), 'o/r', 'main'), /one file per pull request/); });
test('refused: a link', () => { assert.throws(() => checkPr(pr(), files, tree('120000'), 'o/r', 'main'), /plain file/); });
test('refused: an executable', () => { assert.throws(() => checkPr(pr(), files, tree('100755'), 'o/r', 'main'), /plain file/); });
test('refused: too large', () => { assert.throws(() => checkPr(pr(), files, tree('100644', 600000), 'o/r', 'main'), /between 1 and/); });
test('refused: a modified file', () => { assert.throws(() => checkPr(pr(), [{ ...files[0], status: 'modified' }], tree(), 'o/r', 'main'), /must be added/); });
test('refused: the wrong path', () => {
  assert.throws(() => checkPr(pr(), [{ ...files[0], filename: 'lean/OpenDesk/Outside/Erdos_1.lean' }], tree(), 'o/r', 'main'), /lean\/OpenDesk\/Outside/);
  assert.throws(() => checkPr(pr(), [{ ...files[0], filename: 'lean/OpenDesk/erdos_1.lean' }], tree(), 'o/r', 'main'), /lean\/OpenDesk\/Outside/);
});

// The gap row
const row = { id: 'erdos_1', constant: 'Erdos1.erdos_1', module: MOD, file, kind: 'refute', imports: ['Mathlib', MOD] };
test('passes: the gap row of the file', () => {
  const g = checkGap({ gaps: [row] }, file);
  assert.equal(g.constant, 'Erdos1.erdos_1');
  assert.equal(g.kind, 'refute');
  assert.deepEqual(g.imports, ['Mathlib', MOD]);
});
test('refused: no row', () => { assert.throws(() => checkGap({ gaps: [] }, file), /not on the desk/); });
test('refused: a checked gap', () => { assert.throws(() => checkGap({ gaps: [], checked: [{ id: 'erdos_1', file }] }, file), /CHECKED/); });
test('refused: a row whose file is not its id', () => { assert.throws(() => checkGap({ gaps: [{ ...row, id: 'erdos_2' }] }, file), /names a file/); });
test('refused: a row that lists a non-Mathlib import', () => { assert.throws(() => checkGap({ gaps: [{ ...row, imports: ['FormalConjecturesUtil'] }] }, file), /import/); });
test('refused: a row whose constant is not a plain name', () => { assert.throws(() => checkGap({ gaps: [{ ...row, constant: 'Erdos1.«x y»' }] }, file), /constant/); });
test('refused: an unknown kind', () => { assert.throws(() => checkGap({ gaps: [{ ...row, kind: 'reduce' }] }, file), /unknown kind/); });

// Every collection of formal-conjectures, not only the Erdős problems
const GOLD = 'FormalConjectures.Wikipedia.Goldbach';
const ARX = 'FormalConjectures.Arxiv.«2104.00502».BarkerSequence';
const W1 = 'OpenDesk.Outside.wikipedia_goldbach';
test('passes: a Wikipedia module', () => {
  assert.deepEqual(checkProofFile(enc(`import Mathlib\nimport ${GOLD}\n\ntheorem ${W1} : True := trivial\n`), [GOLD], W1), ['Mathlib', GOLD]);
});
test('passes: an Arxiv module whose part holds a dot', () => {
  assert.deepEqual(checkProofFile(enc(`import Mathlib\nimport ${ARX}\n\ntheorem ${W1} : True := trivial\n`), [ARX], W1), ['Mathlib', ARX]);
});
test('refused: another collection than the gap lists', () => {
  assert.throws(() => checkImports(enc(`import FormalConjectures.Wikipedia.TwinPrimes\n\n${thm}`), [GOLD]), /not allowed/);
});
const wrow = { id: 'oeis_a000001_a_1', constant: 'OeisA1.a_1', module: 'FormalConjectures.OEIS.«1»', file: 'lean/OpenDesk/Outside/oeis_a000001_a_1.lean' };
test('passes: an OEIS gap row', () => { assert.equal(checkGap({ gaps: [wrow] }, wrow.file).kind, 'check'); });
test('passes: a constant with a part in guillemets', () => {
  const r = { ...wrow, constant: 'Arxiv.«2104.00502».barker_conjecture', module: ARX };
  assert.equal(checkGap({ gaps: [r] }, wrow.file).module, ARX);
});
test('refused: a row whose module is FormalConjecturesUtil', () => { assert.throws(() => checkGap({ gaps: [{ ...wrow, module: 'FormalConjecturesUtil' }] }, wrow.file), /module/); });
test('refused: a row whose module is outside FormalConjectures', () => { assert.throws(() => checkGap({ gaps: [{ ...wrow, module: 'Mathlib.Logic.Basic' }] }, wrow.file), /module/); });

// The desk's module and constant names with a bare numeric part (FormalConjectures.ErdosProblems.1)
test('quoteName: a bare numeric part is put in guillemets, a quoted one is kept', () => {
  assert.equal(quoteName('FormalConjectures.ErdosProblems.1'), MOD);
  assert.equal(quoteName(MOD), MOD);
  assert.equal(quoteName(ARX), ARX);
  assert.equal(quoteName('FormalConjectures.Wikipedia.Goldbach'), 'FormalConjectures.Wikipedia.Goldbach');
});
test('passes: a row whose module has a bare numeric part reads as its guillemet form', () => {
  const g = checkGap({ gaps: [{ ...row, module: 'FormalConjectures.ErdosProblems.1', imports: ['Mathlib', 'FormalConjectures.ErdosProblems.1'] }] }, file);
  assert.equal(g.module, MOD);
  assert.deepEqual(g.imports, ['Mathlib', MOD]);
});
test('passes: the desk gaps.json shape (board, generated_at, rows with level, title, url, no imports)', () => {
  const desk = { board: 'open', generated_at: '2026-11-25T00:00:00Z', gaps: [{ id: 'erdos_1', constant: 'Erdos1.erdos_1', module: 'FormalConjectures.ErdosProblems.1', file, kind: 'check', level: 'research', title: 'x "y" $(z)', url: 'https://example.org' }] };
  const g = checkGap(desk, file);
  assert.deepEqual(g, { id: 'erdos_1', constant: 'Erdos1.erdos_1', module: MOD, kind: 'check', imports: [MOD], file });
});
test('refused: two rows for one file', () => { assert.throws(() => checkGap({ gaps: [row, row] }, file), /more than one/); });

// The merged pull request (credit workflow)
test('passes: a merged pull request in merged mode', () => {
  assert.equal(checkPr(pr({ state: 'closed', merged: true }), files, tree(), 'o/r', 'main', { merged: true }).file, file);
});
test('refused: a closed, unmerged pull request in merged mode', () => {
  assert.throws(() => checkPr(pr({ state: 'closed', merged: false }), files, tree(), 'o/r', 'main', { merged: true }), /not merged/);
});
test('passes: a pull request closed without a merge in closed mode', () => {
  assert.equal(checkPr(pr({ state: 'closed', merged: false }), files, tree(), 'o/r', 'main', { closed: true }).file, file);
});
test('refused in closed mode: a merged or an open pull request', () => {
  assert.throws(() => checkPr(pr({ state: 'closed', merged: true }), files, tree(), 'o/r', 'main', { closed: true }), /without a merge/);
  assert.throws(() => checkPr(pr(), files, tree(), 'o/r', 'main', { closed: true }), /without a merge/);
});
test('refused: an open pull request in merged mode', () => { assert.throws(() => checkPr(pr(), files, tree(), 'o/r', 'main', { merged: true }), /not merged/); });
test('refused in open mode, found in merged mode: a gap the desk already lists as checked', () => {
  const g = { gaps: [], checked: [row] };
  assert.throws(() => checkGap(g, file), /CHECKED/);
  assert.equal(checkGap(g, file, { merged: true }).id, 'erdos_1');
});

// Statement (state) and computation (compute) jobs
const sfile = 'statements/erdos_9.lean', wfile = 'witnesses/oeis_a1_c.json';
const srow = { id: 'erdos_9', kind: 'state', title: 'write the statement' };
const crow = { id: 'oeis_a1_c', kind: 'compute' };
test('passes: a statement pull request and its row (no constant, no module, no file)', () => {
  const f = [{ filename: sfile, status: 'added', sha: blob }];
  const t = { tree: [{ path: sfile, type: 'blob', mode: '100644', sha: blob, size: 10 }] };
  assert.equal(checkPr(pr(), f, t, 'o/r', 'main').rules, 'state');
  const g = checkGap({ gaps: [srow] }, sfile);
  assert.equal(g.kind, 'state');
  assert.deepEqual(g.imports, ['FormalConjecturesUtil']);
});
test('passes: a computation row', () => { assert.deepEqual(checkGap({ gaps: [crow] }, wfile), { id: 'oeis_a1_c', constant: '', module: '', kind: 'compute', imports: [], file: wfile }); });
test('refused: a statement file for a check gap', () => { assert.throws(() => checkGap({ gaps: [{ ...row, file: sfile, id: 'erdos_9' }] }, sfile), /names a file/); });
test('refused: a proof file for a state gap', () => { assert.throws(() => checkGap({ gaps: [{ ...srow, id: 'erdos_1' }] }, file), /names a file|not on the desk/); });
test('refused: another path', () => {
  assert.throws(() => checkPr(pr(), [{ filename: 'statements/x/y.lean', status: 'added', sha: blob }], tree(), 'o/r', 'main'), /statements/);
  assert.throws(() => checkPr(pr(), [{ filename: 'witnesses/x.lean', status: 'added', sha: blob }], tree(), 'o/r', 'main'), /witnesses/);
});
const stmt = 'import Mathlib\nimport FormalConjecturesUtil\n\n@[category research open, AMS 11]\ntheorem erdos_9 : answer(sorry) ↔ True := by\n  sorry\n';
test('passes: a statement with sorry and the category attribute', () => {
  assert.deepEqual(checkFile(enc(stmt), ['Mathlib', 'FormalConjecturesUtil'], sfile), ['Mathlib', 'FormalConjecturesUtil']);
});
test('refused: sorry in a proof file all the same', () => { assert.throws(() => checkFile(enc(head + by('sorry')), [MOD], file), /sorry/); });
test('refused: a statement with code that runs at build time', () => {
  assert.throws(() => checkFile(enc(`${stmt}#eval 1\n`), ['Mathlib', 'FormalConjecturesUtil'], sfile), /#eval/);
  assert.throws(() => checkFile(enc(`import Mathlib\n\n@[implemented_by x] theorem t : True := sorry\n`), ['Mathlib'], sfile), /not allowed/);
});
test('refused: a statement that imports something else', () => {
  assert.throws(() => checkFile(enc('import Lean\n\ntheorem t : True := sorry\n'), ['Mathlib', 'FormalConjecturesUtil'], sfile), /not allowed/);
});
test('passes: a witness that is a JSON object', () => { assert.deepEqual(checkFile(enc('{"n": 5, "values": [1, 2]}\n'), [], wfile), []); });
test('refused: a witness that is not JSON, or not an object', () => {
  assert.throws(() => checkFile(enc('n = 5\n'), [], wfile), /not JSON/);
  assert.throws(() => checkFile(enc('5\n'), [], wfile), /object or array/);
});

// Lean identifiers in the desk's constants: Unicode letters (Greek and the like), sub- and
// superscripts, ', !, ? and guillemet parts; nothing a shell or a workflow command reads specially.
const LEAN_NAMES = [
  'Arxiv.«1609.08688».lt₂_example_1', 'Arxiv.«1609.08688».isIncreasing₂_sequenceProduct_example',
  'Erdos868.erdos_868.variants.fixed_ε', 'Mathoverflow10799.μ_half_eq_uniform', 'Mathoverflow10799.μFamily_univ',
  'CardinalityLindelof.HasGδSingletons.lindelof_card', 'ReedOmegaDeltaChi.reed_conjecture_Δ_6_ω_2',
  'RiemannZetaMoments.moment_isEquiv₁', 'RiemannZetaMoments.moment_isEquivₖ', 'EllipticCurveRank.WeierstrassCurve.Δ_elkies28',
  'Kourovka.«1.35c».kourovka_1_35c', 'Arxiv.«math.0110202».x', 'A.b!', 'A.b?', "A.b'", 'A.x²', 'A.xⁿ', '_x.y', 'Α.β', 'A.«μ₁»',
];
test('passes: Lean identifiers with Unicode letters, sub/superscripts, !, ?, and guillemet parts', () => {
  for (const c of LEAN_NAMES) assert.ok(isConstant(c), c);
  for (const c of LEAN_NAMES) assert.equal(checkGap({ gaps: [{ ...wrow, constant: c }] }, wrow.file).constant, c);
});
test('refused: names that are not Lean identifiers (shell, workflow command, whitespace, tokens)', () => {
  const bad = ['Erdos705.erdos_705:', 'A', 'A.', '.A', 'A..b', 'A.1b', 'A.b c', 'A.b\tc', 'A.b\nc', 'A.$(id)', 'A.`id`', 'A.b;c', 'A.b|c',
    'A.b&c', 'A.b"c', "A.'b", 'A.b\\c', 'A.b/c', 'A.b::c', 'A.«x y»', 'A.«»', 'A.«.x»', 'A.«x»»', 'A.«x', 'A.λx', 'A.Πx', 'A.xΣ', 'A.b​',
    'A.b‮', 'A.b\u0000', 'A.b%', 'A.b+', 'A.b₊', 'A.b⁻', 'A.!b', 'A.?b', 'A.½', `A.${'x'.repeat(MAX_NAME)}`];
  for (const c of bad) assert.equal(isConstant(c), false, JSON.stringify(c));
  assert.throws(() => checkGap({ gaps: [{ ...wrow, constant: 'Erdos705.erdos_705:' }] }, wrow.file), /constant/);
});
test('passes: a proof that opens and names a numeric guillemet namespace', () => {
  const mod = 'FormalConjectures.Arxiv.«1207.5099»';
  const text = `import Mathlib\nimport ${mod}\n\nopen Arxiv.«1207.5099»\n\ntheorem ${M} : Arxiv.«1207.5099».subprime_part 0 = 0 := by\n  simp [Arxiv.«1207.5099».subprime_part]\n`;
  assert.deepEqual(checkProofFile(enc(text), ['Mathlib', mod], M), ['Mathlib', mod]);
});
refused('a guillemet name with no digit outside the import lines', `theorem ${M} : «True» := trivial\n`, '«');
refused('a guillemet name with a space', `theorem ${M} : X.«1 2» := trivial\n`, '«');
refused('a forbidden word inside a numeric guillemet name', `open X.«1.native»\n${thm}`, 'native');
refused('Lean inside a numeric guillemet name', `open X.«1.Lean»\n${thm}`, 'Lean');
test('passes: helpers with Unicode names in the own namespace', () => {
  run(`namespace ${M}\ntheorem μ₁_le! : True := trivial\nend ${M}\n\ntheorem ${M} : True := ${M}.μ₁_le!\n`);
});

// The desk's checked rows are {id, file} only: the credit workflow's re-run finds them by path.
test('passes in merged mode: checked rows {id, file} of each kind, kind read from the path', () => {
  const ck = (id, f) => checkGap({ gaps: [], checked: [{ id, file: f }] }, f, { merged: true });
  assert.deepEqual(ck('erdos_1', file), { id: 'erdos_1', constant: '', module: '', kind: 'check', imports: [], file });
  assert.deepEqual(ck('erdos_9', sfile), { id: 'erdos_9', constant: '', module: '', kind: 'state', imports: [], file: sfile });
  assert.deepEqual(ck('oeis_a1_c', wfile), { id: 'oeis_a1_c', constant: '', module: '', kind: 'compute', imports: [], file: wfile });
  assert.throws(() => checkGap({ gaps: [], checked: [{ id: 'erdos_9', file: sfile }] }, sfile), /CHECKED/);
});
test('refused in merged mode: a checked row whose id, file or kind disagree', () => {
  assert.throws(() => checkGap({ gaps: [], checked: [{ id: 'erdos_2', file }] }, file, { merged: true }), /not on the desk|malformed/);
  assert.throws(() => checkGap({ gaps: [], checked: [{ id: 'erdos_9', file: sfile, kind: 'compute' }] }, sfile, { merged: true }), /kind/);
  assert.throws(() => checkGap({ gaps: [], checked: [{ id: 'erdos_1', file }, { id: 'erdos_1', file }] }, file, { merged: true }), /CHECKED/);
});
refused('_root_ as a name part', `theorem ${M} : True := _root_.trivial\n`, '_root_');
refused('_root_ after a dot', `theorem ${M} : True := X._root_.trivial\n`, '_root_');
passes('a name that only contains the letters _root_ (cube_root_linearithmic)', `namespace ${M}\ntheorem cube_root_le : True := trivial\nend ${M}\n\ntheorem ${M} : True := ${M}.cube_root_le\n`);

// Run as a script from a folder whose name holds '#' and '%', and through a symlink: main() still runs
// and prints its verdict line. (Compared as URLs, such a path skipped main() and exited 0 silently.)
test('main runs from a path with # and %, and through a symlink', () => {
  const base = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const odd = join(base, 'a#b%c'); mkdirSync(odd);
    const script = join(odd, 'outside-guard.mjs');
    copyFileSync(fileURLToPath(new URL('./outside-guard.mjs', import.meta.url)), script);
    symlinkSync(script, join(base, 'link.mjs'));
    writeFileSync(join(base, 'proof.lean'), head + thm); writeFileSync(join(base, 'imports.json'), JSON.stringify([MOD]));
    for (const s of [script, join(base, 'link.mjs')]) {
      const ok = spawnSync(process.execPath, [s, 'imports', join(base, 'proof.lean'), join(base, 'imports.json'), 'lean/OpenDesk/Outside/erdos_1.lean'], { encoding: 'utf8' });
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.match(ok.stdout, /^GUARD OK: imports$/m);
      const bad = spawnSync(process.execPath, [s, 'imports', join(base, 'proof.lean'), join(base, 'imports.json'), 'elsewhere.lean'], { encoding: 'utf8' });
      assert.equal(bad.status, 1, bad.stdout + bad.stderr);
      assert.match(bad.stdout, /^REFUSED: the one file must be/m);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
