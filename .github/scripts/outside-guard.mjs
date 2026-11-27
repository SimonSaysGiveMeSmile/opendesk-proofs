#!/usr/bin/env node
// Guards for a pull request that adds one proof file. Used by the workflows before anything is
// built. Plain node, no dependencies. Every value this script hands back to the shell has passed
// a strict pattern, so the shell never sees free text from a pull request.
//
//   node outside-guard.mjs pr <pr.json> <files.json> <tree.json> <repo> <default branch> <out dir>
//   node outside-guard.mjs merged <pr.json> <files.json> <tree.json> <repo> <default branch> <out dir>
//   node outside-guard.mjs closed <pr.json> <files.json> <tree.json> <repo> <default branch> <out dir>
//   node outside-guard.mjs gap-of-file <gaps.json> <file path> <out dir>
//   node outside-guard.mjs gap-of-merged-file <gaps.json> <file path> <out dir>
//   node outside-guard.mjs imports <file> <imports.json> <file path in the pull request>
//
// A proof (check) or a refutation (refute) of a gap is the one file of its desk row,
// lean/OpenDesk/Outside/<gap id>.lean, gap id lower case letters, digits and underscores. The
// desk row names the formal-conjectures constant (e.g. Erdos1.erdos_1) and its module, any module
// of any collection (e.g. FormalConjectures.ErdosProblems.«1», FormalConjectures.Wikipedia.Goldbach);
// the checker reads the statement from the pinned package. A module or constant the desk writes
// with a bare numeric part (FormalConjectures.ErdosProblems.1) is read as its guillemet form.
// A statement-writing job (state) is statements/<gap id>.lean: the import and plain-file rules,
// with `sorry` and `@[category ...]` allowed. A computation job (compute) is
// witnesses/<gap id>.json: UTF-8 JSON, an object or an array. Both are reviewed by a person; only
// check and refute files are judged by tools/check-lean.mjs.
//
// `merged` is `pr` for a pull request that is already merged (the credit workflow), `closed` for
// one closed without a merge (the credit workflow hands its gap back to the desk);
// `gap-of-merged-file` also finds the gap in the desk's `checked` list.
//
// Exit 0: the guard holds, and the last line printed is `GUARD OK: <command>`.
// Exit 1: REFUSED, one line per reason, each line starting `REFUSED: `.
// The pull-request and gap checks give one reason (the first). The checks of the file's text (the
// import, plain-file and own-namespace rules) give EVERY problem they find, in file order, at most
// MAX_PROBLEMS lines, then `... and N more`. Exit 3: bad usage.
//
// Adapted from open-goat/pequalnp-proofs (Apache-2.0), .github/scripts/outside-guard.mjs.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GAP_RE = /^[a-z][a-z0-9_]{0,127}$/;
export const FILE_RE = /^lean\/OpenDesk\/Outside\/[a-z][a-z0-9_]{0,127}\.lean$/;
export const OUTSIDE_MODULE_RE = /^OpenDesk\.Outside\.[a-z][a-z0-9_]{0,127}$/;
// A Lean identifier part, as formal-conjectures writes its constants: the first character a
// Unicode letter or `_` (Greek and other letter-like characters included: μ_half, Δ_elkies28,
// HasGδSingletons), then Unicode letters, decimal digits, `_`, `'`, `!`, `?` and the sub- and
// superscript digits and letters (moment_isEquiv₁, lt₂_example_1). λ, Π and Σ are Lean tokens,
// never part of a name. Nothing else: no space, quote, backslash, `$`, `;` or any other character
// a shell or a workflow command treats specially, so a name that passes is inert anywhere.
const SUBSUP = '\u2080-\u2089\u2090-\u209c\u2070\u2071\u00b9\u00b2\u00b3\u2074-\u2079\u207f\u1d62-\u1d6a\u2c7c';
const ID_FIRST = String.raw`(?![λΠΣ])[\p{L}_]`;
const ID_REST = String.raw`(?![λΠΣ])[\p{L}\p{Nd}_'!?${SUBSUP}]`;
export const IDENT = `${ID_FIRST}(?:${ID_REST})*`;
// A part in guillemets (a module's or a namespace's numeric name): letters, digits, `_` and `.`,
// not starting with a dot (Arxiv.«2104.00502».barker_conjecture, Kourovka.«1.35c»). Module names
// keep the plain ASCII form; a constant's guillemet part may also hold the identifier characters.
const GPART = '«[A-Za-z0-9_][A-Za-z0-9_.]*»';
const CGPART = String.raw`«[\p{L}\p{Nd}_${SUBSUP}][\p{L}\p{Nd}_'!?.${SUBSUP}]*»`;
// A formal-conjectures constant: a dotted name, at least two parts (its namespace first), at most
// MAX_NAME characters.
export const MAX_NAME = 300;
export const CONST_RE = new RegExp(`^(?:${IDENT}|${CGPART})(?:\\.(?:${IDENT}|${CGPART})){1,15}$`, 'u');
export const isConstant = (c) => typeof c === 'string' && c.length <= MAX_NAME && CONST_RE.test(c);
// The gap's module as an import line writes it, in any collection of formal-conjectures
// (FormalConjectures.ErdosProblems.«1», FormalConjectures.Wikipedia.Goldbach, ...): a part that
// does not start with a letter is written in guillemets.
export const FC_MODULE_RE = new RegExp(`^FormalConjectures(?:\\.(?:${GPART}|[A-Za-z][A-Za-z0-9_]*)){1,8}$`, 'u');
export const MATHLIB_RE = /^Mathlib(\.[A-Za-z][A-Za-z0-9_]*)*$/;
export const KINDS = ['check', 'refute', 'state', 'compute'];
export const STATEMENT_RE = /^statements\/[a-z][a-z0-9_]{0,127}\.lean$/;
export const WITNESS_RE = /^witnesses\/[a-z][a-z0-9_]{0,127}\.json$/;
// A statement file may also import the formal-conjectures helpers (answer(), the category
// attribute), as every formal-conjectures problem file does.
export const STATE_IMPORTS = ['FormalConjecturesUtil'];
// The one file a gap of each kind is sent as.
export const fileFor = (id, kind) => (kind === 'state' ? `statements/${id}.lean` : kind === 'compute' ? `witnesses/${id}.json` : `lean/OpenDesk/Outside/${id}.lean`);
// Which rules a path falls under: proof (check, refute), state, compute; null for any other path.
export const pathKind = (file) => (typeof file !== 'string' ? null : FILE_RE.test(file) ? 'proof' : STATEMENT_RE.test(file) ? 'state' : WITNESS_RE.test(file) ? 'compute' : null);
export const idOfFile = (file) => file.slice(file.lastIndexOf('/') + 1, file.lastIndexOf('.'));
// A dotted name in which a part that starts with a digit is written in guillemets, as Lean needs
// it: FormalConjectures.ErdosProblems.1 -> FormalConjectures.ErdosProblems.«1». Parts already in
// guillemets are kept. Anything that does not split cleanly is handed back as it is (and the
// strict patterns then refuse it).
export const quoteName = (name) => {
  if (typeof name !== 'string') return name;
  const parts = name.match(/«[^«»]*»|[^.«»]+/gu);
  if (!parts || parts.join('.') !== name) return name;
  return parts.map((p) => (/^[0-9]/.test(p) ? `«${p}»` : p)).join('.');
};
export const MAX_BYTES = 512 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/;
const FILE_SAY = 'the one file must be lean/OpenDesk/Outside/<gap id>.lean (a proof), statements/<gap id>.lean (a statement) or witnesses/<gap id>.json (a computation), gap id in lower case letters, digits, underscores';
const ONE_FILE_SAY = 'one file per pull request, so send each gap as its own pull request';

export class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };
export const MAX_PROBLEMS = 40;
export const MAX_REFUSAL = 6000;
const MAX_LINE = 400;
// A piece of the file's own text quoted in a sentence: at most 60 characters, and only letters,
// digits, dot, underscore and apostrophe (anything else reads `?`).
export const tok = (x) => String(x).slice(0, 60).replace(/[^A-Za-z0-9._']/g, '?');
const refuseAll = (problems) => {
  if (problems.length === 0) return;
  const all = problems.map((p, k) => ({ ...p, k })).sort((a, b) => a.at - b.at || a.k - b.k)
    .map((p) => (p.why.length > MAX_LINE ? `${p.why.slice(0, MAX_LINE - 3)}...` : p.why));
  const out = [];
  let size = 0;
  for (const why of all) {
    if (out.length > 0 && (out.length === MAX_PROBLEMS || size + 1 + why.length > MAX_REFUSAL - 200)) break;
    out.push(why); size += (out.length > 1 ? 1 : 0) + why.length;
  }
  if (out.length < all.length) out.push(`... and ${all.length - out.length} more`);
  throw new Refused(out.join('\n'));
};
const json = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return refuse(`${path} is not JSON`); } };
export const moduleOf = (file) => file.slice('lean/'.length, -'.lean'.length).split('/').join('.');

// The pull request must add exactly one file, at the right path, as a plain file, and nothing
// else. Read from the API's own answers: the pull request, its file list, the tree of its head.
export function checkPr(pr, files, tree, repo, defaultBranch, { merged = false, closed = false } = {}) {
  if (merged) {
    if (pr?.merged !== true || pr?.state !== 'closed') refuse('the pull request is not merged');
  } else if (closed) {
    if (pr?.merged !== false || pr?.state !== 'closed') refuse('the pull request is not closed without a merge');
  } else if (pr?.state !== 'open') refuse('the pull request is not open');
  if (pr.base?.repo?.full_name !== repo) refuse('the pull request is not against this repository');
  if (pr.base?.ref !== defaultBranch) refuse(`the pull request is not against ${defaultBranch}`);
  const head = pr.head?.sha;
  if (!SHA_RE.test(head ?? '')) refuse('the pull request has no head commit');
  const author = pr.user?.login;
  if (!LOGIN_RE.test(author ?? '')) refuse('the pull request author is not a plain account name');
  if (pr.changed_files > 1) refuse(`the pull request changes ${pr.changed_files} files; ${ONE_FILE_SAY}`);
  if (pr.changed_files !== 1) refuse(`the pull request changes ${pr.changed_files} files; it must add exactly one`);
  if (!Array.isArray(files) || files.length !== 1) refuse(Array.isArray(files) && files.length > 1 ? ONE_FILE_SAY : 'the pull request must add exactly one file');
  const f = files[0];
  if (pathKind(f.filename) === null) refuse(FILE_SAY);
  if (f.status !== 'added') refuse(`the file must be added, not ${tok(f.status)}`);
  if (!SHA_RE.test(f.sha ?? '')) refuse('the file list names no content hash');
  // 100644 is a plain file: a symbolic link is 120000, an executable 100755, a submodule 160000.
  if (tree?.truncated) refuse('the tree of the head commit is too large to read whole');
  const entries = (tree?.tree ?? []).filter((e) => e.path === f.filename);
  if (entries.length !== 1) refuse('the file is not in the tree of the head commit');
  const e = entries[0];
  if (e.type !== 'blob' || e.mode !== '100644') refuse('the file must be a plain file (not a link, not executable)');
  if (e.sha !== f.sha) refuse('the file list and the tree disagree about the content');
  if (!Number.isInteger(e.size) || e.size < 1 || e.size > MAX_BYTES) refuse(`the file must be between 1 and ${MAX_BYTES} bytes`);
  const rules = pathKind(f.filename);
  const number = Number.isInteger(pr.number) && pr.number > 0 ? pr.number : refuse('the pull request has no number');
  return { file: f.filename, rules, module: rules === 'proof' ? moduleOf(f.filename) : '', head, blob: f.sha, author, size: e.size, number };
}

// The gap the desk posts for this file. gaps.json (the desk's GET /desk/gaps.json):
// {board, generated_at, gaps:[{id, constant, module, file, kind, level, title, url, imports?}],
//  checked?:[{id, file?, ...}], withdrawn?:{id: reason}}. Only id, constant, module, file, kind
// and imports are read; the others are free text and never reach the shell.
// A row's kind is check (the default), refute, state or compute; its file must be the one file
// of that kind (fileFor). A state or compute row may name no constant or module.
// { merged: true } (the credit workflow): a gap already in the desk's checked list is found too,
// with its kind taken from its path and no constant or module.
const kindOf = (g) => (g?.kind === undefined ? 'check' : g.kind);
const rowFile = (g) => (typeof g?.file === 'string' && g.file !== '' ? g.file : GAP_RE.test(String(g?.id)) ? fileFor(g.id, kindOf(g)) : undefined);
export function checkGap(gaps, file, { merged = false } = {}) {
  if (pathKind(file) === null) refuse(FILE_SAY);
  const all = Array.isArray(gaps?.gaps) ? gaps.gaps : refuse('the gap list has no gaps');
  const done = Array.isArray(gaps?.checked) ? gaps.checked.filter((c) => rowFile(c) === file) : [];
  let found = all.filter((x) => rowFile(x) === file);
  // The desk's checked rows are {id, file} only (lib/desk.js gaps()): such a row's kind is read
  // from its path, and it names no constant or module (a credit call needs neither).
  if (found.length === 0 && merged && done.length === 1) {
    const c = done[0];
    const rules = pathKind(c?.file);
    if (rules === null || typeof c.id !== 'string' || !GAP_RE.test(c.id) || c.file !== file || idOfFile(file) !== c.id) refuse('the checked gap of this file is malformed');
    const kind = rules === 'proof' ? (c.kind === 'refute' ? 'refute' : 'check') : rules;
    if (c.kind !== undefined && c.kind !== kind) refuse(`the checked gap ${c.id} names a kind that is not the kind of its file`);
    return { id: c.id, constant: '', module: '', kind, imports: [], file };
  }
  if (found.length !== 1) {
    if (found.length > 1) refuse('the desk posts more than one gap for this file');
    if (done.length > 0) refuse(`the gap ${GAP_RE.test(String(done[0].id)) ? done[0].id : ''} is already CHECKED: ask the desk for a gap that is still open`);
    const id = idOfFile(file);
    if (gaps?.withdrawn && typeof gaps.withdrawn === 'object' && Object.hasOwn(gaps.withdrawn, id)) {
      const why = String(gaps.withdrawn[id] ?? '').replace(/[^A-Za-z0-9 .,;:()'_+=<>-]/g, '').slice(0, 200);
      refuse(`the gap ${id} was WITHDRAWN from the desk (${why || 'no reason given'}): ask the desk for a gap that is still open`);
    }
    refuse('the gap is not on the desk (not open, not checked, not withdrawn): ask the desk for a gap that is still open');
  }
  const g = found[0];
  if (typeof g.id !== 'string' || !GAP_RE.test(g.id)) refuse('the posted gap has a malformed id');
  const kind = KINDS.includes(kindOf(g)) ? kindOf(g) : refuse(`gap ${g.id} has an unknown kind`);
  const want = fileFor(g.id, kind);
  if (file !== want || rowFile(g) !== want) refuse(`gap ${g.id} names a file that is not ${want} (its kind is ${kind})`);
  const proof = kind === 'check' || kind === 'refute';
  const constant = g.constant === undefined || g.constant === null || g.constant === '' ? '' : quoteName(g.constant);
  const module = g.module === undefined || g.module === null || g.module === '' ? '' : quoteName(g.module);
  if ((proof || constant !== '') && !isConstant(constant)) refuse(`gap ${g.id} names no plain formal-conjectures constant`);
  if ((proof || module !== '') && (typeof module !== 'string' || !FC_MODULE_RE.test(module))) refuse(`gap ${g.id} names no module under FormalConjectures`);
  const listed = (g.imports ?? (module ? [module] : [])).map?.((m) => quoteName(m));
  if (!Array.isArray(listed) || !listed.every((m) => typeof m === 'string' && (MATHLIB_RE.test(m) || m === module))) refuse(`gap ${g.id} lists an import that is neither Mathlib nor its own module`);
  // A proof imports Mathlib and its module; a statement may also import the formal-conjectures
  // helpers; a witness imports nothing (it is JSON).
  const imports = kind === 'compute' ? [] : [...new Set([...listed, ...(module ? [module] : []), ...(kind === 'state' ? STATE_IMPORTS : [])])];
  return { id: g.id, constant, module, kind, imports, file: want };
}

// The text of the file's bytes. What cannot be read as text is refused at once, alone.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/u;
const plainChars = (text) => {
  if (CONTROL.test(text.replace(/\r?\n/g, ''))) refuse('the file holds control characters');
  if (INVISIBLE.test(text)) refuse('the file holds invisible or direction-changing characters');
};
const textOf = (bytes) => {
  if (bytes.length > MAX_BYTES) refuse(`the file is larger than ${MAX_BYTES} bytes`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return refuse('the file is not UTF-8 text'); }
  if (text.includes('\0')) refuse('the file holds a NUL byte');
  plainChars(text);
  return text;
};

// THE IMPORT RULE. The file starts with its import lines, one module per line, nothing else among
// them. Each is Mathlib, a module of Mathlib, or a module the gap lists (its formal-conjectures
// module, which Lean writes with guillemets: FormalConjectures.ErdosProblems.«1»). After the import
// lines the word `import` may not appear at all, comments included: Lean reads imports through
// comments. Returns the imports seen and the number of header lines (blank or import).
const IMPORT_LINE = new RegExp(`^import ((?:[A-Za-z][A-Za-z0-9_]*|${GPART})(?:\\.(?:[A-Za-z][A-Za-z0-9_]*|${GPART}))*)[ \t]*$`, 'u');
function importProblems(text, allowed, problems) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const ok = new Set(allowed);
  const seen = [];
  let i = 0;
  for (; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') continue;
    const m = IMPORT_LINE.exec(l);
    if (!m) break;
    const name = m[1];
    if (MATHLIB_RE.test(name) || ok.has(name)) seen.push(name);
    else problems.push({ at: i + 1, why: `line ${i + 1}: import ${tok(name)} is not allowed (only Mathlib, modules of Mathlib, and the gap's own module)` });
  }
  const header = i;
  for (; i < lines.length; i += 1) {
    if (/(^|[^A-Za-z0-9_])import([^A-Za-z0-9_]|$)/.test(lines[i])) problems.push({ at: i + 1, why: `line ${i + 1}: the word "import" after the import lines (imports are plain lines at the top, one module each)` });
  }
  return { seen, header };
}

// THE PLAIN-FILE RULE (as in pequalnp-proofs): a first filter, NOT what makes an outside file safe
// to build. A Lean file runs code while it compiles; what contains that is the sandbox the job runs
// in and the checker's own rules. The RAW text is searched, comments included, nothing stripped.
// The import lines are passed over (their guillemets are the module's own name). Elsewhere the
// only guillemets allowed are a numeric name part, as formal-conjectures names its namespaces
// (`open Arxiv.«1207.5099»`, Kourovka.«1.35c».x): letters, digits, `_` and `.`, at least one digit,
// not starting with a dot. Its guillemets are read as spaces, so what is inside is searched like
// any other text; every other guillemet is refused. The only attributes are `@[simp]` and `@[local simp]`; the only options
// are four limits. KNOWN LIMIT: the list cannot be complete; what it misses meets the sandbox.
const B = String.raw`(?<![A-Za-z0-9_])`, A = String.raw`(?![A-Za-z0-9_])`;
const FORBIDDEN = new RegExp([
  String.raw`"|[«»]|simproc|builtin_|native|bv_decide|ofReduce|reduceNat|reduceBool`,
  '|' + B + String.raw`(Lean|System|IO|Elab|Meta|Lake|FS|Process|EIO)` + A,
  // _root_ is a whole name part (_root_.x, x._root_.y), not the letters inside cube_root_x.
  '|' + B + '_root_' + A + String.raw`|RealWorld|BaseIO|include_str|notation|[A-Za-z_][A-Za-z0-9_']*[A-Za-z0-9_']%|polyrith|initialize|run_cmd|run_tac|run_elab|run_meta|by_elab`,
  '|' + B + String.raw`elab|` + B + String.raw`macro|` + B + 'syntax' + A + '|' + B + 'attribute' + A,
  '|' + B + 'axiom' + A + '|' + B + 'opaque' + A + String.raw`|unsafe|` + B + 'partial' + A + String.raw`|sorry|` + B + 'admit' + A,
  String.raw`|#[a-z_][a-z_]{2,}|implemented_by|extern`,
  String.raw`|` + '`' + String.raw`\([a-z]+\||\$\(|%\[|@\[|register_|declare_|lcProof|lcUnreachable|` + B + 'infix|' + B + 'prefix' + A + '|' + B + 'postfix' + A,
  String.raw`|set_option|binder_predicate|unif_hint|^\s*add_\w+|unseal|compile_inductive|irreducible_def|proof_wanted|mk_iff_of_inductive_prop`,
].join(''), 'u');
const RAW_WORDS = new Set([
  '"', '«', '»', '$(', '%[', '@[', '`(tactic|', '`(term|', '`(command|', '`(conv|', '`(doElem|',
  '#eval', '#check', '#print', '#reduce', '#synth', '#exit', '#help', '#lint', '#guard', '#guard_msgs',
  'simproc', 'builtin_', 'native', 'bv_decide', 'ofReduce', 'reduceNat', 'reduceBool',
  'Lean', 'System', 'IO', 'Elab', 'Meta', 'Lake', 'FS', 'Process', 'EIO',
  '_root_', 'RealWorld', 'BaseIO', 'include_str', 'notation', 'polyrith', 'initialize',
  'run_cmd', 'run_tac', 'run_elab', 'run_meta', 'by_elab', 'elab', 'macro', 'syntax', 'attribute',
  'axiom', 'opaque', 'unsafe', 'partial', 'sorry', 'admit', 'implemented_by', 'extern',
  'register_', 'declare_', 'lcProof', 'lcUnreachable', 'infix', 'prefix', 'postfix',
  'set_option', 'binder_predicate', 'unif_hint', 'unseal', 'compile_inductive', 'irreducible_def',
  'proof_wanted', 'mk_iff_of_inductive_prop',
]);
const NUMERIC_GPART = /«(?=[A-Za-z0-9_.]*[0-9])([A-Za-z0-9_][A-Za-z0-9_.]*)»/gu;
const sayWord = (w) => (RAW_WORDS.has(w) ? w : tok(w));
const LIMIT = /set_option (maxRecDepth|maxHeartbeats|synthInstance\.maxSize|synthInstance\.maxHeartbeats) [0-9]+ in(?![A-Za-z0-9_])/gu;

// A statement file (state) may also hold `sorry` (its proof is not the job) and the
// formal-conjectures category attribute, written exactly as that package writes it.
const STATE_SORRY = /(?<![A-Za-z0-9_])sorry(?![A-Za-z0-9_'])/gu;
const CATEGORY = /@\[category [a-z_]{1,20}(?: [a-z_]{1,20})?(?:, AMS(?: [0-9]{1,2}){1,8})?\]/gu;
function plainProblems(text, problems, header = 0, { statement = false } = {}) {
  let theorems = 0;
  text.split('\n').forEach((raw, k) => {
    const line = raw.replace(/\r$/, '');
    if (k < header) return;   // blank lines and import lines, already judged by the import rule
    let judged = line.replace(NUMERIC_GPART, ' $1 ').replace(LIMIT, '').replace(/@\[(local )?simp\]/gu, '');
    if (statement) judged = judged.replace(CATEGORY, '').replace(STATE_SORRY, '');
    const m = FORBIDDEN.exec(judged);
    let hint = m && /^add_/.test(m[0].trim()) ? '; a line may not BEGIN with a name that starts with add_: put it after other text on the line or rename it' : '';
    if (m && /^\s*set_option (maxRecDepth|maxHeartbeats|synthInstance\.maxSize|synthInstance\.maxHeartbeats) [0-9]+\s*$/u.test(line)) hint = '; a limit option holds only for one declaration: write it as set_option <option> <value> in, directly before the declaration that needs it';
    if (m && m[0].trim() === 'bv_decide') hint = '; bv_decide runs a SAT solver as the file builds, so use tactics the kernel checks alone, e.g. decide, simp, omega';
    if (m && m[0].trim() === 'native') hint = '; native_decide rests on the axiom Lean.ofReduceBool, which the checker refuses anyway: use decide, or decide +kernel';
    if (m) problems.push({ at: k + 1, why: `line ${k + 1}: "${sayWord(m[0].trim())}" is not allowed in a proof file, in code or in a comment (no code that runs at build time, no new syntax, no string literals, no attributes but simp, no options but the four limits)${hint}` });
    if (/^\s*(@\[(local )?simp\] )?((private|protected) )?theorem /u.test(statement ? line.replace(CATEGORY, '').trimStart() : line)) theorems += 1;
  });
  if (theorems === 0) problems.push({ at: Infinity, why: 'the file holds no theorem' });
}

export function checkPlain(text) {
  plainChars(text);
  const problems = [];
  plainProblems(text, problems);
  refuseAll(problems);
}

export function checkImports(bytes, allowed) {
  const text = textOf(bytes);
  const problems = [];
  const { seen, header } = importProblems(text, allowed, problems);
  plainProblems(text, problems, header);
  refuseAll(problems);
  return seen;
}

// THE OWN-NAMESPACE RULE (as in pequalnp-proofs). Every helper of the file sits inside a namespace
// block named after the file. For lean/OpenDesk/Outside/x.lean, M is OpenDesk.Outside.x, and at
// the top level the only code lines are: import lines; `open ...` lines; the four limit options
// (`set_option <limit> <n> in`); `namespace N` where N is M, M.<more>, M_aux or M_aux.<more>; the
// one theorem, written `theorem M ...` with its full name, last: after it only its proof.
// `namespace`, `section`, `end` and `mutual` stand alone at column 0; each `end` names what it closes.
const ID = `${IDENT}(?:\\.${IDENT})*`;
const W = (words) => new RegExp(String.raw`(?<![\p{L}\p{N}_.'!?])(?:${words})(?![\p{L}\p{N}_'!?])`, 'u');
const SCOPE_WORD = W('namespace|section|end|mutual');
const SCOPE_LINE = new RegExp(String.raw`^(?:(namespace) (${ID})|(noncomputable section|section)(?: (${ID}))?|(end)(?: (${ID}))?|(mutual))[ \t]*$`, 'u');
const AFTER_THEOREM = W('def|theorem|lemma|abbrev|instance|structure|class|inductive|coinductive|example|opaque|axiom|noncomputable|private|protected|partial|unsafe|variable|universe|attribute|export|deriving|alias|local|scoped|omit|include|mk_iff_of_inductive_prop');
const TOP_LIMIT = /^set_option (maxRecDepth|maxHeartbeats|synthInstance\.maxSize|synthInstance\.maxHeartbeats) [0-9]+ in[ \t]*$/u;

// The text with every comment blanked (same length, line breaks kept). No string literal can
// stand in a file that passed the plain-file rule, so a comment opener is always one.
export function blankComments(text) {
  let out = '', i = 0, depth = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < text.length) {
    if (depth > 0) {
      if (text.startsWith('/-', i)) { depth += 1; out += '  '; i += 2; } else if (text.startsWith('-/', i)) { depth -= 1; out += '  '; i += 2; } else { out += blank(text[i]); i += 1; }
    } else if (text.startsWith('/-', i)) { depth = 1; out += '  '; i += 2; }
    else if (text.startsWith('--', i)) { const j = text.indexOf('\n', i); const e = j < 0 ? text.length : j; out += blank(text.slice(i, e)); i = e; }
    else { out += text[i]; i += 1; }
  }
  return out;
}

function namespaceProblems(text, module, problems) {
  if (!OUTSIDE_MODULE_RE.test(module)) { problems.push({ at: -1, why: `${tok(module)} is not the module of an outside proof file` }); return; }
  if (module.endsWith('_aux')) problems.push({ at: -1, why: 'the file name may not end in _aux (that suffix names the helper namespace of another file)' });
  const own = (n) => n === module || n.startsWith(`${module}.`) || n === `${module}_aux` || n.startsWith(`${module}_aux.`);
  const fix = `put every helper inside \`namespace ${module}\` ... \`end ${module}\`; only the imports, open lines and the theorem stay outside`;
  const stack = [];
  let theorem = false;
  blankComments(text).split('\n').forEach((raw, k) => {
    const code = raw.replace(/\r$/, '').replace(/[ \t]+$/, '');
    if (code.trim() === '') return;
    const at = `line ${k + 1}`;
    const note = (why) => problems.push({ at: k + 1, why });
    if (SCOPE_WORD.test(code)) {
      const m = SCOPE_LINE.exec(code);
      if (!m) { note(`${at}: \`namespace\`, \`section\`, \`end\` and \`mutual\` must stand alone at the start of a line (not indented, nothing else on it); ${fix}`); return; }
      if (theorem) { note(`${at}: nothing but the proof may follow the theorem ${module}; ${fix}`); return; }
      if (m[1]) {
        if (stack.length === 0 && !own(m[2])) note(`${at}: \`namespace ${tok(m[2])}\` at the top level; the only namespace allowed there is the file's own; ${fix}`);
        stack.push({ kind: 'namespace', name: m[2] });
      } else if (m[3]) {
        if (stack.length === 0) note(`${at}: a section at the top level; open it inside the file's own namespace; ${fix}`);
        stack.push({ kind: 'section', name: m[4] });
      } else if (m[7]) {
        if (stack.length === 0) note(`${at}: \`mutual\` at the top level; ${fix}`);
        stack.push({ kind: 'mutual' });
      } else {
        const top = stack.pop();
        if (!top) note(`${at}: \`end\` with nothing open to close; ${fix}`);
        else if (top.kind === 'mutual' ? m[6] !== undefined : m[6] !== top.name) note(`${at}: \`end${m[6] ? ` ${tok(m[6])}` : ''}\` does not name what it closes`);
      }
      return;
    }
    if (theorem) {
      const w = AFTER_THEOREM.exec(code);
      if (w) note(`${at}: "${tok(w[0])}" after the theorem ${module}; nothing but its proof may follow it; ${fix}`);
      return;
    }
    if (stack.length > 0) return;
    if (/^import [^ \t]+$/u.test(code) || TOP_LIMIT.test(code)) return;
    if (/^open[ \t]/u.test(code)) {
      if (/[ \t]in[ \t]+\S/u.test(code)) note(`${at}: an \`open ... in\` line must end with \`in\`, with the theorem on the next line; ${fix}`);
      return;
    }
    if (new RegExp(String.raw`^theorem ${module.replace(/\./g, '\\.')}(?![\p{L}\p{N}_'!?.])`, 'u').test(code)) { theorem = true; return; }
    note(`${at}: a declaration or command outside the file's own namespace (at the top level only imports, \`open\` lines, the four limit options, \`namespace ${module}\` and \`theorem ${module}\` may stand); ${fix}`);
  });
  if (!theorem) problems.push({ at: Infinity, why: `the theorem must stand at the top level, last, written with its full name: \`theorem ${module} ...\`; ${fix}` });
}

export function checkOwnNamespace(text, module) {
  const problems = [];
  namespaceProblems(text, module, problems);
  refuseAll(problems);
}

// The whole-file check of the `imports` command: the import, plain-file and own-namespace rules
// read the same text, and every problem of all three is refused at once, in file order.
export function checkProofFile(bytes, allowed, module) {
  const text = textOf(bytes);
  const problems = [];
  const { seen, header } = importProblems(text, allowed, problems);
  plainProblems(text, problems, header);
  namespaceProblems(text, module, problems);
  refuseAll(problems);
  return seen;
}

// A statement file (state, statements/<gap id>.lean): the import rule and the plain-file rule,
// with `sorry` and the category attribute allowed. No own-namespace rule: a person reviews it.
export function checkStatementFile(bytes, allowed) {
  const text = textOf(bytes);
  const problems = [];
  const { seen, header } = importProblems(text, allowed, problems);
  plainProblems(text, problems, header, { statement: true });
  refuseAll(problems);
  return seen;
}

// A witness (compute, witnesses/<gap id>.json): UTF-8 text, at most MAX_BYTES, one JSON object
// or array. Nothing in it is run; a person reviews it.
export function checkWitnessFile(bytes) {
  const text = textOf(bytes);
  let v;
  try { v = JSON.parse(text); } catch { return refuse('the witness is not JSON'); }
  if (v === null || typeof v !== 'object') refuse('the witness must be a JSON object or array');
  return [];
}

// The rules of the one file, by its path.
export function checkFile(bytes, allowed, file) {
  const rules = pathKind(file);
  if (rules === 'proof') return checkProofFile(bytes, allowed, moduleOf(file));
  if (rules === 'state') return checkStatementFile(bytes, allowed);
  if (rules === 'compute') return checkWitnessFile(bytes);
  return refuse(FILE_SAY);
}

const put = (dir, name, value) => writeFileSync(join(dir, name), value);
const main = () => {
  const [cmd, ...a] = process.argv.slice(2);
  if ((cmd === 'pr' || cmd === 'merged' || cmd === 'closed') && a.length === 6) {
    const r = checkPr(json(a[0]), json(a[1]), json(a[2]), a[3], a[4], { merged: cmd === 'merged', closed: cmd === 'closed' });
    for (const [k, v] of Object.entries(r)) put(a[5], `pr.${k}`, `${v}\n`);
  } else if ((cmd === 'gap-of-file' || cmd === 'gap-of-merged-file') && a.length === 3) {
    const [gapsPath, file, out] = a;
    const g = checkGap(json(gapsPath), file, { merged: cmd === 'gap-of-merged-file' });
    put(out, 'gap.id', `${g.id}\n`);
    put(out, 'gap.constant', `${g.constant}\n`);
    put(out, 'gap.module', `${g.module}\n`);
    put(out, 'gap.kind', `${g.kind}\n`);
    put(out, 'imports.json', JSON.stringify(g.imports));
    // The board the desk names, for the credit call (absent or malformed: the desk's default).
    const board = typeof json(gapsPath)?.board === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(json(gapsPath).board) ? json(gapsPath).board : '';
    put(out, 'gap.board', `${board}\n`);
  } else if (cmd === 'imports' && a.length === 3) {
    if (pathKind(a[2]) === null) refuse(FILE_SAY);
    const allowed = json(a[1]);
    if (!Array.isArray(allowed) || !allowed.every((m) => typeof m === 'string' && (MATHLIB_RE.test(m) || FC_MODULE_RE.test(m) || STATE_IMPORTS.includes(m)))) refuse('the listed imports are malformed');
    if (pathKind(a[2]) !== 'state' && allowed.some((m) => STATE_IMPORTS.includes(m))) refuse('the listed imports are malformed');
    const seen = checkFile(readFileSync(a[0]), allowed, a[2]);
    process.stdout.write(`imports allowed: ${seen.join(' ') || '(none)'}\n`);
  } else {
    process.stderr.write('usage: outside-guard.mjs pr|merged|closed|gap-of-file|gap-of-merged-file|imports ... (see the header)\n');
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
  try { main(); process.stdout.write(`GUARD OK: ${process.argv[2]}\n`); } catch (e) {
    if (!(e instanceof Refused)) throw e;
    process.stdout.write(e.message.split('\n').map((l) => `REFUSED: ${l}\n`).join(''));
    process.exit(1);
  }
}
