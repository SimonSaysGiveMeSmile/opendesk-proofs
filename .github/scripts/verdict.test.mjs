// node --test .github/scripts/verdict.test.mjs
// The verdict artifact between check.yml (untrusted) and verdict.yml (trusted): what the check job
// writes, and every way a forged or stale artifact is refused by the verdict job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bind, clean, faultReason, make, parse, render, Refused } from './verdict.mjs';

const head = 'a'.repeat(40), blob = 'b'.repeat(40);
const file = 'lean/OpenDesk/Outside/erdos_1.lean';
const proof = 'import Mathlib\n\ntheorem OpenDesk.Outside.erdos_1 : True := trivial\n';
const sha256 = createHash('sha256').update(proof).digest('hex');
const dir = (files) => {
  const d = mkdtempSync(join(tmpdir(), 'verdict-'));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return d;
};
const base = { 'pr.file': `${file}\n`, 'pr.blob': `${blob}\n`, 'gap.id': 'erdos_1\n', 'gap.kind': 'check\n', 'proof.lean': proof };
const manifest = `MANIFEST ${JSON.stringify({ file: { module: 'OpenDesk.Outside.erdos_1', sha256 }, gap: {}, match: 'exact' })}`;
const t = { number: '7', head, file, blob, gap: 'erdos_1', kind: 'check', sha256 };
const refusedBy = (fn, word) => assert.throws(fn, (e) => e instanceof Refused && e.message.includes(word));

test('make: an accepted run', () => {
  const v = parse(make(dir({ ...base, stage: 'judged', code: '0', out: `${manifest}\nACCEPTED OpenDesk.Outside.erdos_1\n` }), '7', head));
  assert.equal(v.verdict, 'ACCEPTED');
  assert.equal(v.sha256, sha256);
  assert.equal(bind(v, t).verdict, 'ACCEPTED');
});
test('make: exit 0 with a MANIFEST of other bytes is a FAULT, not ACCEPTED', () => {
  const bad = manifest.replace(sha256, 'c'.repeat(64));
  assert.equal(parse(make(dir({ ...base, stage: 'judged', code: '0', out: `${bad}\nACCEPTED x\n` }), '7', head)).verdict, 'FAULT');
});
test('make: a rejected run keeps the REJECTED line as the reason, cleaned', () => {
  const v = parse(make(dir({ ...base, stage: 'judged', code: '1', out: 'REJECTED (statement): the type is not `Erdos1.erdos_1` «x»\n' }), '7', head));
  assert.equal(v.verdict, 'REJECTED');
  assert.match(v.reason, /^REJECTED \(statement\): the type is not \?Erdos1\.erdos_1\? \?x\?$/);
});
test('make: a checker fault, and a run that stopped early', () => {
  assert.equal(parse(make(dir({ ...base, stage: 'judged', code: '3', out: '' }), '7', head)).verdict, 'FAULT');
  assert.equal(parse(make(dir({}), '7', head)).verdict, 'FAULT');
});
test('make: refused by the guard, with its first reason', () => {
  const v = parse(make(dir({ stage: 'refused', 'guard.out': 'REFUSED: one file per pull request\nREFUSED: more\n' }), '7', head));
  assert.equal(v.verdict, 'REFUSED');
  assert.equal(v.reason, 'one file per pull request');
  assert.equal(v.file, '-');
});
test('make: a statement job goes to review', () => {
  const v = parse(make(dir({ 'pr.file': 'statements/erdos_3.lean', 'pr.blob': blob, 'gap.id': 'erdos_3', 'gap.kind': 'state', stage: 'review' }), '7', head));
  assert.equal(v.verdict, 'REVIEW');
  assert.equal(bind(v, { ...t, file: 'statements/erdos_3.lean', gap: 'erdos_3', kind: 'state' }).verdict, 'REVIEW');
});

const good = make(dir({ ...base, stage: 'judged', code: '0', out: `${manifest}\nACCEPTED x\n` }), '7', head);
test('parse: refused shapes', () => {
  refusedBy(() => parse(''), 'empty');
  refusedBy(() => parse('x'.repeat(5000)), 'too large');
  refusedBy(() => parse(good.replace('verdict ACCEPTED', 'verdict ACCEPTEDé')), 'ASCII');
  refusedBy(() => parse(good.replace('verdict ACCEPTED', 'verdict OK')), 'verdict words');
  refusedBy(() => parse(good.replace('opendesk-verdict 1', 'opendesk-verdict 2')), 'fixed lines');
  refusedBy(() => parse(`${good}extra 1\n`), 'fixed lines');
  refusedBy(() => parse(good.replace(`file ${file}`, 'file .github/workflows/x.yml')), 'file');
  refusedBy(() => parse(good.replace(/reason .*/, 'reason `@someone` <img>')), 'reason');
  refusedBy(() => parse(good.replace('pr 7', 'pr -')), 'no pull request');
  refusedBy(() => parse(good.replace(/\nkind check/, '\ngap erdos_1')), 'kind');
});
test('bind: a forged or stale artifact is refused', () => {
  const v = parse(good);
  refusedBy(() => bind(v, { ...t, number: '8' }), 'another pull request');
  refusedBy(() => bind(v, { ...t, head: 'c'.repeat(40) }), 'another head');
  refusedBy(() => bind(v, { ...t, blob: 'c'.repeat(40) }), 'another blob');
  refusedBy(() => bind(v, { ...t, gap: 'erdos_2' }), 'another gap');
  refusedBy(() => bind(v, { ...t, sha256: 'd'.repeat(64) }), 'accepted bytes');
  refusedBy(() => bind(parse(good.replace('kind check', 'kind state')), { ...t, kind: 'state' }), 'reviewed by a person');
  refusedBy(() => bind(parse(good.replace('verdict ACCEPTED', 'verdict REVIEW')), t), 'judged by the checker');
  refusedBy(() => bind(parse(good.replace(`gap erdos_1`, 'gap -')), t), 'must name its gap');
});
test('render: the status and the comment hold only checked values', () => {
  const r = render('ACCEPTED', 'ACCEPTED x', t);
  assert.deepEqual(r.status, { state: 'success', context: 'opendesk/check', description: 'ACCEPTED erdos_1' });
  assert.equal(r.label, 'opendesk:accepted');
  assert.ok(r.comment.body.startsWith('<!-- opendesk-verdict -->\n**Open Desk check: ACCEPTED** for gap `erdos_1`'));
  assert.equal(render('REJECTED', 'x', { ...t, gap: '`; evil' }).status.description, 'REJECTED');
  assert.equal(render('FAULT', '', t).status.state, 'error');
  assert.equal(clean('a\n`b` @c <d>'), 'a ?b? ?c ?d?');
});

// An outage in the verdict job (the desk's gap list, the API) is a FAULT: neutral status, the
// fault label (never rejected), and a comment that says the maintainers re-run it.
const VM = fileURLToPath(new URL('./verdict.mjs', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [VM, ...args], { encoding: 'utf8' });
test('fault: the verdict job could not read the desk\'s gap list', () => {
  const out = dir({}), tr = dir({ 'pr.number': '7\n', 'pr.head': `${head}\n`, 'pr.file': `${file}\n` });
  const g = join(tr, 'guard.out');
  writeFileSync(g, 'GUARD OK: pr\ncurl: (6) Could not resolve host\nFAULT: the desk\'s gap list could not be read\n');
  const r = cli('fault', g, tr, out);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(out, 'verdict'), 'utf8'), 'FAULT\n');
  assert.equal(readFileSync(join(out, 'label'), 'utf8'), 'opendesk:fault\n');
  const st = JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'));
  assert.equal(st.state, 'error');
  assert.equal(st.context, 'opendesk/check');
  const body = JSON.parse(readFileSync(join(out, 'comment.json'), 'utf8')).body;
  assert.match(body, /\*\*Open Desk check: FAULT\*\*/);
  assert.match(body, /the desk's gap list could not be read/);
  assert.match(body, /maintainers will re-run/);
  assert.doesNotMatch(body, /breaks a rule|Fix it/);
});
test('fault: never REFUSED, even when the output also holds REFUSED lines or no FAULT line', () => {
  assert.equal(faultReason('REFUSED: x\nFAULT: the tree of the head commit could not be read\n'), 'the tree of the head commit could not be read');
  assert.equal(faultReason(''), 'the verdict job could not finish its checks');
  const out = dir({}), tr = dir({});
  assert.equal(cli('fault', join(tr, 'missing.out'), tr, out).status, 0);
  assert.equal(readFileSync(join(out, 'verdict'), 'utf8'), 'FAULT\n');
  assert.notEqual(render('FAULT', 'x', t).label, 'opendesk:rejected');
  assert.equal(render('REFUSED', 'x', t).label, 'opendesk:rejected');
});
