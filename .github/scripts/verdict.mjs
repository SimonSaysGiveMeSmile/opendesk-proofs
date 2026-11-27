#!/usr/bin/env node
// THE VERDICT of one check run, carried from the check job (check.yml, on pull_request: no
// credentials, a read-only token) to the verdict job (verdict.yml, on workflow_run: base code
// only, allowed to comment, label and set the commit status) as a small artifact. Plain node, no
// dependencies.
//
//   node verdict.mjs make <in dir> <pr number> <head sha> <out file>
//   node verdict.mjs pr-of <verdict file>
//   node verdict.mjs read <verdict file> <trusted dir> <out dir>
//   node verdict.mjs refused <guard output file> <trusted dir> <out dir>
//   node verdict.mjs fault <guard output file> <trusted dir> <out dir>
//
// make (check job): reads what the earlier steps left in <in dir> (pr.*, gap.* from the guard;
// stage; guard.out; code and out from the checker; proof.lean) and writes the verdict file.
// pr-of (verdict job): prints the pull request number of a verdict file that is well formed.
// read (verdict job): the verdict file must be well formed AND name exactly the pull request,
// head, file, blob, gap and kind that the verdict job found itself from the API and the base
// branch's guard (<trusted dir>: pr.number, pr.head, pr.file, pr.blob, gap.id, gap.kind,
// proof.sha256). Only the verdict word and its one reason line are taken from the artifact.
// refused (verdict job): the base branch's guard refused the pull request; the verdict is
// REFUSED with the guard's first reason, whatever the artifact says.
// fault (verdict job): the verdict job itself could not finish its checks (the desk's gap list or
// the API could not be read): the verdict is FAULT with the first `FAULT: ` line of its output,
// never REFUSED, whatever the artifact says. The maintainers re-run it.
// read, refused and fault write <out dir>/verdict (the word), status.json (a commit status), comment.json
// (an issue comment body) and label (the one label of the verdict).
//
// The check job runs the checker, and the checker compiles a file nobody has vouched for: so the
// artifact is DATA from an untrusted job. It is at most MAX_BYTES, ASCII, a fixed list of lines
// each matching a strict pattern, and it can only say what the trusted side then binds to the
// pull request's current head. Exit 0 with `VERDICT OK: <command>` last; exit 1 `REFUSED: ...`;
// exit 3 bad usage.
//
// Adapted in spirit from open-goat/pequalnp-proofs (Apache-2.0), .github/workflows/authoritative.yml
// (its VERDICT lines and the rule that only the base branch's code judges).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BYTES = 4096;
export const CONTEXT = 'opendesk/check';
export const MARKER = '<!-- opendesk-verdict -->';
export const VERDICTS = ['ACCEPTED', 'REJECTED', 'REFUSED', 'FAULT', 'REVIEW'];
export const LABELS = { ACCEPTED: 'opendesk:accepted', REJECTED: 'opendesk:rejected', REFUSED: 'opendesk:rejected', FAULT: 'opendesk:fault', REVIEW: 'opendesk:review' };
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NUM = /^[1-9][0-9]{0,8}$/;
const GAP = /^[a-z][a-z0-9_]{0,127}$/;
const FILE = /^(?:lean\/OpenDesk\/Outside\/[a-z][a-z0-9_]{0,127}\.lean|statements\/[a-z][a-z0-9_]{0,127}\.lean|witnesses\/[a-z][a-z0-9_]{0,127}\.json)$/;
const KIND = /^(?:check|refute|state|compute)$/;
const REASON = /^[A-Za-z0-9 .,:;()_'=+\/?-]{0,300}$/;
// The lines, in this order, and the pattern of each value. `-` is "not known" (the run stopped
// before that value was read).
const FIELDS = [['pr', NUM], ['head', SHA], ['file', FILE], ['blob', SHA], ['gap', GAP], ['kind', KIND], ['sha256', SHA256], ['verdict', null], ['reason', REASON]];
const HEADER = 'opendesk-verdict 1';

export class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };
// Free text made safe for one reason line: printable ASCII of the allowed set only, at most 300.
export const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/[^A-Za-z0-9 .,:;()_'=+\/?-]/g, '?').trim().slice(0, 300);
const readOr = (dir, name, dflt = '-') => {
  const p = join(dir, name);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : dflt;
};
const val = (v, re) => (typeof v === 'string' && re.test(v) ? v : '-');

// The check job's verdict, from what its steps left behind. Nothing here trusts the checker's
// output beyond its exit code and its last REJECTED/ACCEPTED line.
export function make(dir, prNumber, headSha) {
  const kind = val(readOr(dir, 'gap.kind'), KIND);
  const proofPath = join(dir, 'proof.lean');
  const sha256 = existsSync(proofPath) ? createHash('sha256').update(readFileSync(proofPath)).digest('hex') : '-';
  const stage = readOr(dir, 'stage', 'none');
  let verdict = 'FAULT', reason = 'the run stopped before the checker gave a verdict; this says nothing about the proof';
  if (stage === 'refused') {
    const line = readOr(dir, 'guard.out', '').split('\n').find((l) => l.startsWith('REFUSED: '));
    verdict = 'REFUSED'; reason = line ? line.slice('REFUSED: '.length) : 'the guard refused the pull request';
  } else if (stage === 'review') {
    if (kind === 'state' || kind === 'compute') { verdict = 'REVIEW'; reason = `the file rules hold; a person reviews ${kind} jobs`; }
  } else if (stage === 'judged') {
    const code = readOr(dir, 'code', '');
    const lines = readOr(dir, 'out', '').split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines.at(-1) ?? '';
    const rejected = lines.filter((l) => l.startsWith('REJECTED')).at(-1);
    const manifest = lines.find((l) => l.startsWith('MANIFEST '));
    let fileSha = '';
    try { fileSha = JSON.parse(manifest.slice('MANIFEST '.length))?.file?.sha256 ?? ''; } catch { fileSha = ''; }
    if (code === '1' && rejected) { verdict = 'REJECTED'; reason = rejected; }
    else if (code === '0' && last.startsWith('ACCEPTED') && (kind === 'check' || kind === 'refute') && fileSha === sha256) { verdict = 'ACCEPTED'; reason = last; }
    else if (code === '0') reason = 'the checker exited 0 without an ACCEPTED line and a MANIFEST of this file';
    else reason = `the checker could not judge (exit ${/^[0-9]{1,3}$/.test(code) ? code : '?'}); this says nothing about the proof`;
  }
  const v = {
    pr: val(String(prNumber), NUM), head: val(headSha, SHA), file: val(readOr(dir, 'pr.file'), FILE), blob: val(readOr(dir, 'pr.blob'), SHA),
    gap: val(readOr(dir, 'gap.id'), GAP), kind, sha256: val(sha256, SHA256), verdict, reason: clean(reason),
  };
  return `${HEADER}\n${FIELDS.map(([k]) => `${k} ${v[k]}`.trimEnd()).join('\n')}\n`;
}

// The verdict file, strictly: size, ASCII, header, every line in order, every value its pattern.
export function parse(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length === 0 || bytes.length > MAX_BYTES) refuse('the verdict file is empty or too large');
  if (!bytes.every((b) => b === 0x0a || (b >= 0x20 && b < 0x7f))) refuse('the verdict file is not plain ASCII');
  const lines = bytes.toString('ascii').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== FIELDS.length + 1 || lines[0] !== HEADER) refuse('the verdict file does not have the fixed lines');
  const v = {};
  FIELDS.forEach(([k, re], i) => {
    const line = lines[i + 1];
    if (!(line === k || line.startsWith(`${k} `))) refuse(`line ${i + 2} of the verdict file is not ${k}`);
    const x = line === k ? '' : line.slice(k.length + 1);
    if (k === 'verdict') { if (!VERDICTS.includes(x)) refuse('the verdict is not one of the verdict words'); }
    else if (k === 'reason') { if (!re.test(x)) refuse('the reason holds characters a reason may not'); }
    else if (!(x === '-' || re.test(x))) refuse(`the ${k} of the verdict file is malformed`);
    v[k] = x;
  });
  if (v.pr === '-' || v.head === '-') refuse('the verdict file names no pull request or head');
  return v;
}

// The verdict, bound to what the verdict job found itself.
export function bind(v, t) {
  if (v.pr !== t.number) refuse('the verdict is for another pull request');
  if (v.head !== t.head) refuse('the verdict is for another head commit (a newer push supersedes it)');
  const known = (k) => v[k] !== '-';
  for (const [k, tk] of [['file', 'file'], ['blob', 'blob'], ['gap', 'gap'], ['kind', 'kind']]) {
    if (known(k) && v[k] !== t[tk]) refuse(`the verdict names another ${k} than the pull request's`);
  }
  if (v.verdict === 'ACCEPTED' || v.verdict === 'REJECTED' || v.verdict === 'REVIEW') {
    for (const k of ['file', 'blob', 'gap', 'kind']) if (!known(k)) refuse(`a ${v.verdict} verdict must name its ${k}`);
  }
  const proof = t.kind === 'check' || t.kind === 'refute';
  if ((v.verdict === 'ACCEPTED' || v.verdict === 'REJECTED') && !proof) refuse(`a ${t.kind} job is reviewed by a person, not judged by the checker`);
  if (v.verdict === 'REVIEW' && proof) refuse('a proof is judged by the checker, not sent to review');
  if (v.verdict === 'ACCEPTED' && v.sha256 !== t.sha256) refuse('the accepted bytes are not the bytes of the pull request\'s file');
  return v;
}

const NEXT = {
  ACCEPTED: 'The base branch\'s checker accepted this file. A maintainer merges it; on merge the desk credits the gap to the author of this pull request.',
  REJECTED: 'The checker ran and does not accept this file; the line above says why. Push a fixed file to this pull request (the check runs again), or close it.',
  REFUSED: 'The file or the pull request breaks a rule before anything is built (CONTRIBUTING.md). Fix it and push again; nothing was compiled.',
  FAULT: 'The check could not reach a verdict (an outage or a failed step, not this file). This says nothing about the proof: do not change the file. The maintainers will re-run the check.',
  REVIEW: 'The file rules hold. A person reviews this job; on merge the desk credits the gap to the author of this pull request.',
};
const STATE = { ACCEPTED: 'success', REVIEW: 'success', REJECTED: 'failure', REFUSED: 'failure', FAULT: 'error' };

// The status, the comment and the label of a verdict. Every value in them passed a pattern; the
// reason goes in a fenced block, and a reason can hold no backtick, so it cannot leave it.
export function render(verdict, reason, t) {
  const gap = GAP.test(t.gap ?? '') ? t.gap : '';
  const file = FILE.test(t.file ?? '') ? t.file : '';
  const head = SHA.test(t.head ?? '') ? t.head : '';
  const r = clean(reason);
  const description = `${verdict}${gap ? ` ${gap}` : ''}${verdict === 'REVIEW' ? ' (a person reviews it)' : ''}`.slice(0, 140);
  const body = [
    MARKER,
    `**Open Desk check: ${verdict}**${gap ? ` for gap \`${gap}\`` : ''}${file ? ` (\`${file}\`` : ''}${file && head ? `, head \`${head.slice(0, 12)}\`)` : file ? ')' : ''}`,
    '',
    '```',
    r || '(no reason given)',
    '```',
    '',
    NEXT[verdict],
    '',
    '<sub>Posted by verdict.yml from the base branch. Only the one file of this pull request is judged; its description, title and comments are not read.</sub>',
  ].join('\n');
  return { status: { state: STATE[verdict], context: CONTEXT, description }, comment: { body }, label: LABELS[verdict] };
}

// The reason of a FAULT the verdict job found itself: its first `FAULT: ` line, cleaned.
export const faultReason = (out) => {
  const line = String(out ?? '').split('\n').find((l) => l.startsWith('FAULT: '));
  return line ? line.slice('FAULT: '.length) : 'the verdict job could not finish its checks';
};

const trusted = (dir) => ({
  number: readOr(dir, 'pr.number'), head: readOr(dir, 'pr.head'), file: readOr(dir, 'pr.file'), blob: readOr(dir, 'pr.blob'),
  gap: readOr(dir, 'gap.id'), kind: readOr(dir, 'gap.kind'), sha256: readOr(dir, 'proof.sha256'),
});
const emit = (out, verdict, r) => {
  writeFileSync(join(out, 'verdict'), `${verdict}\n`);
  writeFileSync(join(out, 'status.json'), JSON.stringify(r.status));
  writeFileSync(join(out, 'comment.json'), JSON.stringify(r.comment));
  writeFileSync(join(out, 'label'), `${r.label}\n`);
};

const main = () => {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'make' && a.length === 4) {
    writeFileSync(a[3], make(a[0], a[1], a[2]));
  } else if (cmd === 'pr-of' && a.length === 1) {
    process.stdout.write(`${parse(readFileSync(a[0])).pr}\n`);
  } else if (cmd === 'read' && a.length === 3) {
    const t = trusted(a[1]);
    const v = bind(parse(readFileSync(a[0])), t);
    emit(a[2], v.verdict, render(v.verdict, v.reason, t));
    process.stdout.write(`verdict: ${v.verdict}\nreason: ${v.reason}\n`);
  } else if (cmd === 'refused' && a.length === 3) {
    const line = readFileSync(a[0], 'utf8').split('\n').find((l) => l.startsWith('REFUSED: '));
    const t = trusted(a[1]);
    emit(a[2], 'REFUSED', render('REFUSED', line ? line.slice('REFUSED: '.length) : 'the guard refused the pull request', t));
    process.stdout.write('verdict: REFUSED\n');
  } else if (cmd === 'fault' && a.length === 3) {
    const t = trusted(a[1]);
    emit(a[2], 'FAULT', render('FAULT', faultReason(existsSync(a[0]) ? readFileSync(a[0], 'utf8') : ''), t));
    process.stdout.write('verdict: FAULT\n');
  } else {
    process.stderr.write('usage: verdict.mjs make|pr-of|read|refused|fault ... (see the header)\n');
    process.exit(3);
  }
};

// Run as a script (not imported by a test)? Compared by real path, so a path with '#', '%' or a symlink
// still runs main(); a URL comparison would skip it silently, and exit 0 with no output.
const isMain = () => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
};

if (isMain()) {
  try { main(); process.stdout.write(`VERDICT OK: ${process.argv[2]}\n`); } catch (e) {
    if (!(e instanceof Refused)) throw e;
    process.stdout.write(`REFUSED: ${e.message}\n`);
    process.exit(1);
  }
}
