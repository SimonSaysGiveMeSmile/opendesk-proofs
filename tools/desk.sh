#!/usr/bin/env bash
# desk: one command for an agent working on the open-problems desk (every formal-conjectures collection).
#
#   tools/desk.sh setup                check the tools and fetch the prebuilt Mathlib
#   tools/desk.sh next [--gap ID] [--kind check|state|compute] [--level warmup|formalize|open]
#                      [--collection C]
#                                      take a job from the desk (the desk picks unless --gap names one;
#                                      C is a collection: erdos, oeis, wikipedia, green, ramsey, ...):
#                                        check    prove a Lean statement: lean/OpenDesk/Outside/<id>.lean
#                                        state    write an exact Lean statement: statements/<id>.lean
#                                        compute  find a witness or bound: witnesses/<id>.json
#                                      writes the file's skeleton. If this script cannot work on what the
#                                      desk handed out, it gives the lease straight back.
#   tools/desk.sh beat <id>            keep the lease alive (every 5 minutes). Exit 0: alive.
#                                      Exit 3, STOP: the desk answered that the lease is over (gone,
#                                      lapsed, solved); stop and clear it with release <id> other.
#                                      Exit 4: the desk could not be reached or gave no clear answer
#                                      (network, 5xx, not JSON); the lease may still be alive, so
#                                      beat again within a minute or two. Exit 120: the stop notice.
#   tools/desk.sh mine                 list the jobs this clone holds, with the desk's state of each
#   tools/desk.sh check <id>           check: remove the comments and run the checker
#                                      state: the repository's file rules, then compile the statement
#                                      (sorry allowed, no other axiom)
#                                      compute: the repository's file rules and the witness's shape
#                                      and record the sha256 of the bytes that passed
#   tools/desk.sh tidy <id>            only remove the comments (Lean files)
#   tools/desk.sh submit <id>          a branch from the upstream main, one commit, one file, the pull
#                                      request, the release; then back to your branch, the job cleared.
#                                      If the desk cannot be told, the job and its lease are kept here.
#   tools/desk.sh submitted <id>       tell the desk again about the pull request a submit opened, when
#                                      the submit could not (it prints this command); then the job clears
#   tools/desk.sh release <id> <reason>
#                                      give a job back: statement_seems_false | hypothesis_too_weak |
#                                      missing_lemma | does_not_elaborate | source_ambiguous |
#                                      exhausted | out_of_time | other. Its file is moved out of the
#                                      tree (kept under .desk/put-away/) so it never blocks a submit.
#                                      (`submitted` is not a reason for release: only a submit sends it.)
#
# Run it from your clone of YOUR FORK of the proofs repository. It talks to the desk and to GitHub
# through `gh`, nothing else.
#
# THE DESK. DESK_URL names it (default https://www.1proof.site/desk).
# It is taken only as https://<host>[/<path>] with a plain host name, or as a loopback test address
# http://127.0.0.1:<port>[/<path>]. The desk learns your GitHub handle, so set DESK_URL only to a
# desk you trust; every command that talks to it prints where it goes.
# THE UPSTREAM. DESK_UPSTREAM names the proofs repository, owner/name
# (default SimonSaysGiveMeSmile/opendesk-proofs).
#
# Adapted from open-goat/pequalnp-proofs (Apache-2.0), tools/pnp.sh.
set -euo pipefail
BOARD=open
DESK="${DESK_URL:-https://www.1proof.site/desk}"
PROTO='=https'
if [[ "$DESK" =~ ^http://127\.0\.0\.1:[0-9]{1,5}(/[A-Za-z0-9._-]+)*$ ]]; then PROTO='=http'
elif ! [[ "$DESK" =~ ^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(/[A-Za-z0-9._-]+)*$ ]]; then
  echo "DESK_URL is not https://<host>[/<path>] (or a loopback test address); refusing" >&2; exit 1
fi
UPSTREAM="${DESK_UPSTREAM:-SimonSaysGiveMeSmile/opendesk-proofs}"
[[ "$UPSTREAM" =~ ^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$ ]] || { echo "DESK_UPSTREAM is not owner/name; refusing" >&2; exit 1; }
ROOT="$(git rev-parse --show-toplevel)"
# Every python3 here runs isolated (-I): a json.py or re.py in the folder this is run from is never loaded.
STATE="$ROOT/.desk"; mkdir -p "$STATE"
FC_DIR="$ROOT/lean/.lake/packages/formal_conjectures"
GAP_RE='^[a-z][a-z0-9_]{0,127}$'
LEASE_RE='^[A-Za-z0-9-]{1,64}$'
REASON_RE='^[a-z_]{1,32}$'
PR_RE='^https://github\.com/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}/pull/[1-9][0-9]{0,8}$'
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)" >&2; exit 1; }; }
dcurl() { curl --proto "$PROTO" --max-redirs 0 -m 30 "$@"; }
field() { python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1]));
for k in sys.argv[2].split("."): v=v.get(k) if isinstance(v,dict) else None
print("" if v is None else v)' "$STATE/$1.json" "$2"; }
have() {
  [[ "$1" =~ $GAP_RE ]] || { echo "not a gap id: $1" >&2; exit 1; }
  [ -f "$STATE/$1.json" ] || { echo "no such gap here: $1 (run: tools/desk.sh next; tools/desk.sh mine lists what this clone holds)" >&2; exit 1; }
}
lease_of() { l="$(field "$1" lease)"; [[ "$l" =~ $LEASE_RE ]] || { echo "the lease of $1 is malformed" >&2; exit 1; }; printf '%s' "$l"; }
# The pull request a submit opened while the desk could not be told (empty: none).
pr_of() { local p; p="$(field "$1" pr)"; [ -z "$p" ] || [[ "$p" =~ $PR_RE ]] || { echo "the state of $1 names a malformed pull request; refusing" >&2; exit 1; }; printf '%s' "$p"; }
set_pr() { python3 -I -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["pr"]=sys.argv[2]; json.dump(d, open(p,"w"), indent=1)' "$STATE/$1.json" "$2"; }
# The file a job writes, by kind; anything else in the state file is refused before it is used.
file_of() {
  local f k; f="$(field "$1" gap.file)"; k="$(field "$1" gap.kind)"
  case "$k" in
    check|refute) [ "$f" = "lean/OpenDesk/Outside/$1.lean" ] ;;
    state) [ "$f" = "statements/$1.lean" ] ;;
    compute) [ "$f" = "witnesses/$1.json" ] ;;
    *) false ;;
  esac || { echo "the state of $1 names an unexpected file or kind; refusing" >&2; exit 1; }
  printf '%s' "$f"
}
# GIVE A LEASE BACK. The desk's answer is printed cleaned. A lease the desk no longer knows (410 gone)
# counts as given back, except for a submit: then the desk has not recorded the pull request, and the
# gap may already be someone else's, so the caller is told it failed.
release_lease() {
  [[ "$1" =~ $LEASE_RE ]] && [[ "$2" =~ $REASON_RE ]] || { echo "bad lease or reason" >&2; return 1; }
  # With a submit, the pull request's address goes along, so the desk shows it while it is reviewed.
  local q="lease=$1&reason=$2"
  [[ "${3:-}" =~ $PR_RE ]] && q="$q&pr=$3"
  echo "desk: $DESK release ($2)" >&2
  { dcurl -sS --max-filesize 100000 -X POST "$DESK/release?$q" || true; } | python3 -I -c 'import json,sys,re
raw=sys.stdin.read(100000)
try: d=json.loads(raw)
except Exception: print("the desk did not answer with JSON; the lease lapses by itself 15 minutes after its last beat", file=sys.stderr); sys.exit(1)
if not isinstance(d,dict): sys.exit(1)
gap=re.sub(r"[^a-z0-9_]","",str(d.get("gap") or ""))[:128]
if d.get("ok") is True: print("released", gap, "(" + re.sub(r"[^a-z_]","",str(d.get("reason") or ""))[:32] + ")"); sys.exit(0)
say=re.sub(r"[^ -~]"," ",str(d.get("say") or d.get("error") or "refused"))[:300]
if d.get("error")=="gone" and sys.argv[1]!="submitted": print("the lease had already ended: " + say); sys.exit(0)
if d.get("error")=="gone": print("the lease had already ended, so the desk did not record this pull request; the gap may be taken by another agent now. Check it: tools/desk.sh mine", file=sys.stderr); sys.exit(1)
print("the desk refused: " + say, file=sys.stderr); sys.exit(1)' "$2"
}
# CLEAR A JOB HERE. Its file leaves the tree unless git tracks it on this branch (it is moved to
# .desk/put-away/, never deleted), and its state goes. So a released job never blocks the next submit.
put_away() {
  local id="$1" file dest
  file="$(field "$id" gap.file)"
  if [[ "$file" =~ ^(lean/OpenDesk/Outside/|statements/|witnesses/)[a-z][a-z0-9_]{0,127}\.(lean|json)$ ]] && [ -f "$ROOT/$file" ] \
     && ! git -C "$ROOT" ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
    mkdir -p "$STATE/put-away"; dest="$STATE/put-away/$(date +%Y%m%d-%H%M%S)-${file##*/}"
    mv "$ROOT/$file" "$dest"; echo "moved $file to .desk/put-away/${dest##*/} (kept for you; it is in no pull request)"
  fi
  rm -f "$STATE/$id.json" "$STATE/$id.checked" "$STATE/$id.imports.json" "$STATE/$id.guard.json"
}
# THE REPOSITORY'S FILE RULES, run here with the base guard's own code (.github/scripts/outside-guard.mjs
# `imports`), so a file that passes here passes the same rules on the pull request. The allowed imports
# are what the guard allows for the kind: a statement Mathlib and FormalConjecturesUtil, a witness none.
guard_file() {
  local id="$1" file="$2" kind="$3" imp="$STATE/$1.guard.json"
  case "$kind" in
    state) printf '["Mathlib","FormalConjecturesUtil"]' > "$imp" ;;
    compute) printf '[]' > "$imp" ;;
    *) echo "guard_file: not a state or compute job" >&2; exit 1 ;;
  esac
  node "$ROOT/.github/scripts/outside-guard.mjs" imports "$ROOT/$file" "$imp" "$file" || { echo "REJECTED (file rules): $file breaks the repository's file rules above (CONTRIBUTING.md); the pull request would be refused" >&2; exit 1; }
}
# IS THE GAP STILL OPEN? Asked of the desk before checking and again right before the pull request.
# One GET, no lease, nothing sent but the gap id. open and leased go on; anything else stops with the
# desk's one line. If the desk cannot be reached the script goes on: a courtesy, never a gate.
still_open() {
  ans="$(dcurl -fsS -m 10 -G "$DESK/step" --data-urlencode "gap=$1" 2>/dev/null)" || return 0
  printf '%s' "$ans" | python3 -I -c 'import json,sys,re
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
st=d.get("state") if isinstance(d,dict) else None
if st in ("open","leased") or not isinstance(st,str): sys.exit(0)
say=re.sub(r"[^ -~]", " ", str(d.get("say") or ""))[:200]
print("stopped: this gap is no longer open (" + re.sub(r"[^a-z_]", "", st)[:20] + "). " + say, file=sys.stderr)
print("next: tools/desk.sh release " + sys.argv[1] + " other, then tools/desk.sh next", file=sys.stderr)
sys.exit(3)' "$1" || { rc=$?; [ "$rc" -eq 3 ] && exit 3; return 0; }
  return 0
}
# THE STOP NOTICE: a file STOP at the root of the proofs repository's main on GitHub (never the desk:
# a domain can be taken, the code host's main cannot) stops every command that takes or holds work,
# with exit 120. Only its first line is printed, cleaned and capped. If GitHub cannot be read within
# 15 s, the script goes on.
stop_check() {
  git fetch -q "https://github.com/$UPSTREAM.git" main 2>/dev/null & f=$!
  ( sleep 15; kill $f ) >/dev/null 2>&1 & w=$!; disown $w
  if wait $f; then kill $w 2>/dev/null || true
  else kill $w 2>/dev/null || true; echo "note: the stop notice on GitHub could not be read; going on" >&2; return 0; fi
  git cat-file -e FETCH_HEAD:STOP 2>/dev/null || return 0
  { git cat-file blob FETCH_HEAD:STOP 2>/dev/null || true; } | python3 -I -c 'import re,sys
l=re.sub(r"\x1b(\[[0-9;?]*[ -/]*[@-~]|.)?", "", sys.stdin.buffer.readline(4096).decode("latin-1"))
print("STOPPED by a notice on the proofs repository: " + re.sub(r"[^A-Za-z0-9 .,:;()\x27-]", "", l)[:200], file=sys.stderr)' || true
  exit 120
}
# COMMENTS OFF before the check that is recorded (a pull request carries the proof only): `--` line
# comments and `/- -/` blocks, nested, outside string, char and «name» literals. A block becomes
# blanks, so every column after it stays where it was.
tidy() { python3 -I - "$1" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read(); out = []; i = 0; n = len(s); cut = False
ident = lambda j: j >= 0 and (s[j].isalnum() or s[j] in "_'!?.")
while i < n:
    c = s[i]
    if s.startswith("/-", i):
        start, depth, i = i, 1, i + 2
        while i < n and depth:
            if s.startswith("/-", i): depth, i = depth + 1, i + 2
            elif s.startswith("-/", i): depth, i = depth - 1, i + 2
            else: i += 1
        out.append(re.sub(r"[^\n]", " ", s[start:i])); cut = True; continue
    if s.startswith("--", i):
        while i < n and s[i] != "\n": i += 1
        cut = True; continue
    if c == '"':
        j = i + 1
        while j < n and s[j] != '"': j += 2 if s[j] == "\\" else 1
        out.append(s[i:j + 1]); i = j + 1; continue
    if c == "'" and not ident(i - 1):
        m = re.compile(r"'(\\[^']*|[^\\'])'").match(s, i)
        if m: out.append(m.group(0)); i = m.end(); continue
    if c == "«":
        j = s.find("»", i); j = n if j < 0 else j + 1
        out.append(s[i:j]); i = j; continue
    out.append(c); i += 1
if cut:
    t = re.sub(r"\n{3,}", "\n\n", "\n".join(l.rstrip() for l in "".join(out).split("\n"))).lstrip("\n")
    t = t if t.endswith("\n") else t + "\n"
    if t != s:
        open(p, "w", encoding="utf-8").write(t); print("removed the comments from %s (a pull request carries the proof only)" % p)
PY
}
# WHAT IS SENT IS WHAT WAS CHECKED: check records the sha256 of the bytes that passed, with the file's
# path; submit sends the file only when its bytes, and then the committed bytes, are those.
sha() { python3 -I -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'; }
is_checked() { [ -f "$STATE/$1.checked" ] && [ "$(cat "$STATE/$1.checked")" = "$(sha) $2" ]; }
# The public guard takes a file of 1 to 524288 bytes (MAX_BYTES, .github/scripts/outside-guard.mjs).
size_ok() {
  bytes="$(wc -c < "$ROOT/$1" | tr -d ' ')"
  [ "$bytes" -ge 1 ] && [ "$bytes" -le 524288 ] || { echo "refused: $1 is $bytes bytes; a file must be 1 to 524288 bytes" >&2; exit 1; }
}

# A STATEMENT JOB (kind state). The file passes the repository's file rules (the guard, as the pull
# request's check runs it), imports only Mathlib and FormalConjecturesUtil, declares
# OpenDesk.Statements.<id>, and compiles with the pinned toolchain; `sorry` is allowed (it is a
# statement, its proof is not the job), and the theorem may rest on no axiom but sorryAx and the three
# standard ones. A person reviews it.
check_state() {
  local id="$1" file="$2" thm="OpenDesk.Statements.$1" tmp out
  guard_file "$id" "$file" state
  python3 -I - "$ROOT/$file" "$thm" <<'PY' || exit 1
import re, sys
s = open(sys.argv[1], encoding="utf-8").read(); thm = sys.argv[2]; bad = []
lines = s.split("\n"); i = 0
while i < len(lines) and (not lines[i].strip() or lines[i].startswith("import ")):
    if lines[i].startswith("import ") and not re.fullmatch(r"import (Mathlib(\.[A-Za-z][A-Za-z0-9_]*)*|FormalConjecturesUtil)[ \t]*", lines[i]):
        bad.append("line %d: a statement file imports only Mathlib, modules of Mathlib and FormalConjecturesUtil" % (i + 1))
    i += 1
if "TODO_STATEMENT" in s: bad.append("the skeleton's TODO_STATEMENT is still there: write the exact statement as the theorem's type")
if not re.search(r"(?m)^theorem %s\b" % re.escape(thm), s): bad.append("no line starts with `theorem %s`" % thm)
if re.search(r"(?m)^\s*(axiom|#exit)\b", s): bad.append("no `axiom` and no `#exit` in a statement file")
for b in bad: print("refused: " + b, file=sys.stderr)
sys.exit(1 if bad else 0)
PY
  tmp="$(mktemp -d)"; cp "$ROOT/$file" "$tmp/Statement.lean"; printf '\n#print axioms %s\n' "$thm" >> "$tmp/Statement.lean"
  echo "compiling $file with the pinned toolchain (sorry allowed) ..."
  if ! out="$(cd "$ROOT/lean" && lake env lean "$tmp/Statement.lean" 2>&1)"; then
    printf '%s\n' "$out" | tail -n 40 | sed "s#$tmp/Statement.lean#$file#g" >&2; rm -rf "$tmp"
    echo "REJECTED (does-not-compile): $file" >&2; exit 1
  fi
  rm -rf "$tmp"
  printf '%s' "$out" | python3 -I -c 'import re,sys
out=sys.stdin.read(); thm=sys.argv[1]
if re.search(r"\x27%s\x27 does not depend on any axioms" % re.escape(thm), out): sys.exit(0)
m=re.search(r"\x27%s\x27 depends on axioms: \[([^\]]*)\]" % re.escape(thm), out)
if not m: print("REJECTED: the axioms of %s could not be read" % thm, file=sys.stderr); sys.exit(1)
extra=[a.strip() for a in m.group(1).split(",") if a.strip() not in ("propext","Classical.choice","Quot.sound","sorryAx")]
if extra: print("REJECTED (axiom): %s rests on %s" % (thm, ", ".join(re.sub(r"[^A-Za-z0-9_.]","",a)[:80] for a in extra)), file=sys.stderr); sys.exit(1)' "$thm" || exit 1
  echo "ACCEPTED (state) $thm compiles; sorry allowed, no other axiom. A person reviews the statement."
}
# A COMPUTATION JOB (kind compute). The witness file is one JSON object for this gap, with a claim and
# a witness. Only the file rules and its shape are checked here; a program or a person checks the
# witness itself.
check_compute() {
  guard_file "$1" "$2" compute
  python3 -I - "$ROOT/$2" "$1" <<'PY' || exit 1
import json, sys
try: d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e: print("refused: not JSON: %s" % str(e)[:200], file=sys.stderr); sys.exit(1)
bad = []
if not isinstance(d, dict): bad.append("the file is not one JSON object")
else:
    if d.get("gap") != sys.argv[2]: bad.append("\"gap\" must be %s" % sys.argv[2])
    c = d.get("claim")
    if not isinstance(c, str) or not c.strip() or c.startswith("TODO"): bad.append("\"claim\" must say what the witness shows")
    if d.get("witness") in (None, "", [], {}): bad.append("\"witness\" is empty")
for b in bad: print("refused: " + b, file=sys.stderr)
sys.exit(1 if bad else 0)
PY
  echo "ACCEPTED (compute) the witness file has the expected shape. The witness itself is checked on review."
}

# `next`: everything the desk returns is DATA, checked against strict patterns, printed with control
# characters removed, never run. The skeleton's statement is copied from the PINNED formal-conjectures
# source in lean/.lake/packages (never from the desk). It is a convenience: the checker compares the
# theorem's type with the pinned constant's type, so a wrong copy is refused, never accepted.
# As soon as the desk's lease id is known it is written to .desk/.refused; the shell removes that file
# only when this script ends well. So whenever it ends otherwise after the desk leased the gap (an
# answer refused, or any error at all), the gap is given back, and nothing half-written stays here.
next_py() { cat <<'PY'
import json, os, re, sys, unicodedata
state, root, fcdir, want, want_kind = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
lease_ok = None
made = []   # what this run wrote (the state file, the skeleton): taken back if it fails
def undo():
    for x in made:
        try: os.remove(x)
        except OSError: pass
def on_error(t, e, tb):
    undo()
    print("FAILED after the desk leased the gap (%s: %s). Nothing was kept here." % (t.__name__, clean(str(e), 200)), file=sys.stderr)
sys.excepthook = on_error
def clean(x, cap=4000):
    x = x if isinstance(x, str) else json.dumps(x)
    return "".join(c for c in x if c == "\n" or unicodedata.category(c) not in ("Cc", "Cf", "Zl", "Zp", "Co"))[:cap]
def bad(why):
    print("REFUSED: the desk's answer is not of the expected shape (%s). Nothing was written." % why, file=sys.stderr)
    undo(); sys.exit(2)
d = json.load(open(os.path.join(state, ".last.json")))
if not isinstance(d, dict): bad("not an object")
g = d.get("gap")
if not g:
    print(clean(d.get("say") or d.get("note") or d.get("error") or "no gap right now; ask again in a few minutes")); sys.exit(0)
lease = d.get("lease"); lease = lease.get("id") if isinstance(lease, dict) else lease
if not isinstance(lease, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", lease): bad("lease")
lease_ok = lease
with open(os.path.join(state, ".refused"), "w") as f: f.write(lease)
if not isinstance(g, dict): bad("gap is not an object")
gid, kind, path = g.get("id"), g.get("kind", "check"), g.get("file")
if not isinstance(gid, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,127}", gid): bad("gap id")
if want and gid != want: bad("the desk gave gap %s, not the gap %s asked for" % (gid, want))
if kind not in ("check", "refute", "state", "compute"): bad("kind")
if want_kind and not want and kind != want_kind and not (want_kind == "check" and kind == "refute"):
    bad("the desk gave a %s job, not the %s job asked for" % (kind, want_kind))
expect = {"check": "lean/OpenDesk/Outside/%s.lean", "refute": "lean/OpenDesk/Outside/%s.lean",
          "state": "statements/%s.lean", "compute": "witnesses/%s.json"}[kind] % gid
if path != expect: bad("file")
beat = d.get("beat_every_s", 300)
beat = beat if type(beat) is int and 30 <= beat <= 3600 else 300
title, level = clean(g.get("title") or "", 300), clean(g.get("level") or "", 40)
full = os.path.join(root, path)

def save(extra):
    made.append(os.path.join(state, gid + ".json"))
    json.dump({"lease": lease, "gap": dict({"id": gid, "file": path, "kind": kind, "level": level, "title": title}, **extra),
               "beat_every_s": beat}, open(os.path.join(state, gid + ".json"), "w"), indent=1)

def footer():
    if title: print("TITLE     ", title)
    if level: print("LEVEL     ", level)
    print("LEASE     ", lease, "| renew every %d seconds: tools/desk.sh beat %s" % (beat, gid))

if kind in ("state", "compute"):
    informal = clean(g.get("informal") or "")
    url = g.get("url") if isinstance(g.get("url"), str) and re.fullmatch(r"https?://[!-~]{1,500}", g.get("url") or "") else ""
    bounds = g.get("bounds") if isinstance(g.get("bounds"), dict) else {}
    bounds = {k: v for k, v in bounds.items() if isinstance(k, str) and re.fullmatch(r"[a-z_0-9]{1,32}", k)
              and (v is None or type(v) in (int, float))}
    save({"url": url, "bounds": bounds, "informal": informal})
    if os.path.exists(full):
        print("FILE      ", path, "exists already; left as it is")
    elif kind == "state":
        # The repository's file rules read comments too (no quotes, no guillemets, no words such as
        # the prover's own name), so the skeleton holds no text from the desk: the title, the source
        # and the informal statement are printed below and kept in .desk/<id>.json.
        thm = "OpenDesk.Statements." + gid
        os.makedirs(os.path.dirname(full), exist_ok=True)
        made.append(full)
        with open(full, "w", encoding="utf-8") as f:
            f.write("import Mathlib\n\n/-!\nWrite the exact statement as the type of the theorem below, in place of\nTODO_STATEMENT. Its proof may stay sorry: the job is the statement. Import only\nMathlib (and FormalConjecturesUtil). The problem's text is in .desk/%s.json.\n-/\n\n" % gid)
            f.write("theorem %s : TODO_STATEMENT := by\n  sorry\n" % thm)
        print("FILE      ", path, "(skeleton written; write the statement, a proof may stay sorry)")
    else:
        os.makedirs(os.path.dirname(full), exist_ok=True)
        made.append(full)
        with open(full, "w", encoding="utf-8") as f:
            json.dump({"gap": gid, "title": title, "bounds": bounds,
                       "claim": "TODO: what this witness shows, e.g. a new lower bound",
                       "witness": None, "method": "", "notes": ""}, f, indent=2, ensure_ascii=False); f.write("\n")
        print("FILE      ", path, "(template written; fill claim and witness)")
    print("GAP       ", gid, "-", kind, "job")
    if url: print("SOURCE    ", url)
    if bounds: print("BOUNDS    ", json.dumps(bounds))
    if informal: print("STATEMENT ", informal.replace("\n", "\n           ")[:1500])
    if informal or url: print("           (kept in .desk/%s.json)" % gid)
    footer()
    print("RULE      ", "tools/desk.sh check %s, then submit; a person reviews %s jobs." % (gid, kind))
    sys.exit(0)

const, mod = g.get("constant"), g.get("module")
GP = r"«[A-Za-z0-9_][A-Za-z0-9_.]*»"
# A part of a constant, as Lean names it, by the same rule as the repository's guard (IDENT and
# CGPART in .github/scripts/outside-guard.mjs): the first character a letter of any script (Greek
# included: μ_half, HasGδSingletons) or _, then letters, decimal digits, _, ', !, ? and the sub- and
# superscript digits and letters (lt₂_example_1, moment_isEquiv₁); λ, Π and Σ never (Lean tokens).
# Or a part in guillemets: Arxiv.«0805.3777».
SUBSUP = set(chr(c) for r in ((0x2080, 0x2089), (0x2090, 0x209c), (0x2070, 0x2071), (0xb9, 0xb9), (0xb2, 0xb3),
                              (0x2074, 0x2079), (0x207f, 0x207f), (0x1d62, 0x1d6a), (0x2c7c, 0x2c7c)) for c in range(r[0], r[1] + 1))
letter = lambda c: c not in "λΠΣ" and unicodedata.category(c).startswith("L")
digit = lambda c: unicodedata.category(c) == "Nd"
def lean_part(p):
    if len(p) >= 3 and p[0] == "«" and p[-1] == "»":
        q = p[1:-1]
        return (letter(q[0]) or digit(q[0]) or q[0] == "_" or q[0] in SUBSUP) and all(letter(c) or digit(c) or c in "_'!?." or c in SUBSUP for c in q[1:])
    if not p or not (letter(p[0]) or p[0] == "_"): return False
    return all(letter(c) or digit(c) or c in "_'!?" or c in SUBSUP for c in p[1:])
def const_ok(c):
    if not isinstance(c, str) or len(c) > 300: return False
    parts = re.findall(r"«[^«»]*»|[^.«»]+", c)
    return ".".join(parts) == c and 2 <= len(parts) <= 16 and all(lean_part(p) for p in parts)
if not const_ok(const): bad("constant")
# The module, as Lean writes it: a part that is not a plain name goes in guillemets
# (FormalConjectures.ErdosProblems.«1», FormalConjectures.Arxiv.«0805.3777».TensorRank). A plain
# numeric form (FormalConjectures.ErdosProblems.1) is taken too and quoted here: its parts are grouped
# by the pinned source tree, or, before setup, by the arXiv id forms.
MOD_RE = r"FormalConjectures(\.(%s|[A-Za-z0-9_][A-Za-z0-9_']*)){1,8}" % GP
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_']*")
def tokens(m): return [(t[1:-1], True) if t.startswith("«") else (t, False) for t in re.findall(r"«[^»]*»|[^.«»]+", m)]
def group_by_tree(toks):
    def rec(i, d):
        for k in range(1, len(toks) - i + 1):
            grp = toks[i:i + k]
            if k > 1 and any(q for _, q in grp): break
            name = ".".join(t for t, _ in grp)
            if i + k == len(toks):
                if os.path.isfile(os.path.join(d, name + ".lean")): return [name]
            elif os.path.isdir(os.path.join(d, name)):
                r = rec(i + k, os.path.join(d, name))
                if r: return [name] + r
        return None
    return rec(0, fcdir)
def group_by_form(toks):
    out, i = [], 0
    while i < len(toks):
        t, q = toks[i]
        nxt = toks[i + 1] if i + 1 < len(toks) else ("", True)
        if not q and not nxt[1] and ((re.fullmatch(r"\d{4}", t) and re.fullmatch(r"\d{4,5}(v\d+)?", nxt[0]))
                                     or (out and out[-1] == "Arxiv" and re.fullmatch(r"[a-z][a-z-]*", t) and re.fullmatch(r"\d{7}", nxt[0]))):
            out.append(t + "." + nxt[0]); i += 2
        else: out.append(t); i += 1
    return out
def normal(m):
    if not isinstance(m, str) or len(m) > 200 or not re.fullmatch(MOD_RE, m): return None, None
    toks = tokens(m)
    names = group_by_tree(toks) or group_by_form(toks)
    q = ".".join(n if IDENT.fullmatch(n) else "«%s»" % n for n in names)
    if len(q) > 220 or not all(IDENT.fullmatch(n) or re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.]*", n) for n in names): return None, None
    return q, names
mod_raw = mod
mod, mod_parts = normal(mod)
if not mod: bad("module")
imports = g.get("imports") or ["Mathlib", mod_raw]
if not isinstance(imports, list) or not all(isinstance(m, str) and (m == mod_raw or normal(m)[0] == mod or re.fullmatch(r"Mathlib(\.[A-Za-z][A-Za-z0-9_]*)*", m)) for m in imports): bad("imports")
imports = list(dict.fromkeys(mod if (m == mod_raw or (not m.startswith("Mathlib") and normal(m)[0] == mod)) else m for m in imports))
save({"constant": const, "module": mod, "imports": imports})

# The statement, from the pinned source: FormalConjectures.ErdosProblems.«1» is
# FormalConjectures/ErdosProblems/1.lean, FormalConjectures.Wikipedia.Goldbach is
# FormalConjectures/Wikipedia/Goldbach.lean. Comments and strings are blanked before anything is read.
def blank(s):
    out, i, n, depth = [], 0, len(s), 0
    while i < n:
        if depth:
            if s.startswith("/-", i): depth += 1; out.append("  "); i += 2
            elif s.startswith("-/", i): depth -= 1; out.append("  "); i += 2
            else: out.append(s[i] if s[i] == "\n" else " "); i += 1
        elif s.startswith("/-", i): depth = 1; out.append("  "); i += 2
        elif s.startswith("--", i):
            j = s.find("\n", i); j = n if j < 0 else j
            out.append(" " * (j - i)); i = j
        elif s[i] == '"':
            j = i + 1
            while j < n and s[j] != '"': j += 2 if s[j] == "\\" else 1
            out.append(" " * (min(j + 1, n) - i)); i = j + 1
        else: out.append(s[i]); i += 1
    return "".join(out)
OPEN, CLOSE = "([{⟨⦃⟦‹", ")]}⟩⦄⟧›"
def header_of(rest):
    """The text from after the theorem's name to its first `:=` at bracket depth 0."""
    depth = 0
    for i, c in enumerate(rest):
        if c in OPEN: depth += 1
        elif c in CLOSE: depth -= 1
        elif depth == 0 and rest.startswith(":=", i): return rest[:i].strip()
    return None
def split_colon(h):
    """binders, type: split at the first `:` at depth 0 (not `::`)."""
    depth = 0
    for i, c in enumerate(h):
        if c in OPEN: depth += 1
        elif c in CLOSE: depth -= 1
        elif depth == 0 and c == ":" and h[i + 1:i + 2] != ":" and h[i - 1:i] != ":":
            return h[:i].strip(), h[i + 1:].strip()
    return None
def extract():
    rel = os.path.join(*mod_parts) + ".lean"
    src = os.path.join(fcdir, rel)
    if not os.path.isfile(src): return None, "the pinned source %s is not there yet (run tools/desk.sh setup)" % rel
    raw = open(src, encoding="utf-8").read(); text = blank(raw)
    lines = text.split("\n")
    ns, opens, variables = [], [], False
    notation = bool(re.search(r"(?m)^\s*(?:local\s+|scoped\s+)?(?:notation|infixl?|infixr|prefix|postfix)\b", text))
    for i, line in enumerate(lines):
        m = re.match(r"^namespace\s+(\S+)\s*$", line)
        if m: ns.append(m.group(1)); continue
        m = re.match(r"^(?:noncomputable\s+)?section\b", line)
        if m: ns.append(""); continue
        if re.match(r"^end\b", line):
            if ns: ns.pop()
            continue
        m = re.match(r"^\s*open\s+(.*?)(\s+in)?\s*$", line)
        if m: opens.append("open " + m.group(1)); continue
        if re.match(r"^\s*variable\b", line): variables = True
        m = re.match(r"^(?:@\[.*\]\s*)?(?:(?:private|protected|nonrec|noncomputable)\s+)*(?:theorem|lemma)\s+((?:«[^»]*»|[^\s:({\[⦃«])+)", line)
        if not m: continue
        name = m.group(1); prefix = ".".join(x for x in ns if x)
        full = name[len("_root_."):] if name.startswith("_root_.") else (prefix + "." + name if prefix else name)
        if full != const: continue
        off = sum(len(l) + 1 for l in lines[:i]) + m.end()
        # Read from the blanked text: comments in the statement are left out of the skeleton.
        h = header_of(text[off:])
        if h is None: return None, "the statement of %s could not be read from the source" % const
        sc = split_colon(h)
        if sc is None: return None, "the statement of %s has no `:` at the top level" % const
        opened = []
        # The namespace's parts, a part in guillemets kept whole: Arxiv.«0805.3777» opens Arxiv and
        # Arxiv.«0805.3777», never Arxiv.«0805.
        parts = re.findall(r"«[^»]*»|[^.«»]+", prefix) if prefix else []
        for k in range(1, len(parts) + 1): opened.append("open " + ".".join(parts[:k]))
        return {"binders": sc[0], "type": sc[1], "opens": opened + opens, "variables": variables, "notation": notation}, None
    return None, "%s was not found in %s" % (const, rel)
st, why = extract()
module = "OpenDesk.Outside." + gid
if os.path.exists(full):
    print("FILE      ", path, "exists already; left as it is")
elif st is None:
    print("NOTE      ", why, "- no skeleton written. Write the file by hand: see CONTRIBUTING.md.")
else:
    binders, ty = st["binders"], st["type"]
    if kind == "refute":
        stmt = " : ¬ (%s)" % (("∀ %s, %s" % (binders, ty)) if binders else ty)
    else:
        stmt = (" " + binders if binders else "") + " : " + ty
    opens = list(dict.fromkeys(st["opens"]))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    made.append(full)
    with open(full, "w", encoding="utf-8") as f:
        f.write("import Mathlib\nimport %s\n\n" % mod + "".join(o + "\n" for o in opens) + "\ntheorem %s%s := by\n  sorry\n" % (module, stmt))
    print("FILE      ", path, "(skeleton written; replace `sorry`, change nothing in the statement)")
    if st["variables"]:
        print("WARNING    the source file declares `variable`s; if the statement uses one, add it as a binder by hand (the checker compares the full type)")
    if st["notation"]:
        print("WARNING    the source file declares its own notation; if the statement uses it, write out what it stands for (a proof file may declare no notation)")
print("GAP       ", gid, "-", kind, "of", const, "in", mod)
print("SOURCE     lean/.lake/packages/formal_conjectures/%s.lean" % "/".join(mod_parts))
footer()
print("RULE       The theorem's type must be the type of %s%s, exactly. Citing %s itself is refused where formal-conjectures proves it by sorry." % ("the negation of " if kind == "refute" else "", const, const))
PY
}

case "${1:-help}" in
setup)
  need git "https://git-scm.com"; need curl "curl"; need python3 "python 3"; need node "Node.js 20 or later"
  need gh "the GitHub CLI, https://cli.github.com, then: gh auth login"
  need lake "Lean: install elan from https://github.com/leanprover/elan"
  gh api user --jq .login >/dev/null || { echo "gh is not signed in: gh auth login" >&2; exit 1; }
  (cd "$ROOT/lean" && lake exe cache get)
  echo "ready. Next: tools/desk.sh next"
  ;;
next)
  stop_check
  shift; level=""; collection=""; want=""; kind=""
  while [ $# -gt 0 ]; do case "$1" in
    --level) [[ "${2:-}" =~ ^(warmup|formalize|open)$ ]] || { echo "--level is warmup, formalize or open" >&2; exit 1; }; level="$2"; shift;;
    --kind) [[ "${2:-}" =~ ^(check|state|compute)$ ]] || { echo "--kind is check, state or compute" >&2; exit 1; }; kind="$2"; shift;;
    --collection) [[ "${2:-}" =~ ^[a-z][a-z0-9_]{0,31}$ ]] || { echo "--collection needs a collection id, e.g. --collection erdos" >&2; exit 1; }; collection="$2"; shift;;
    --gap) [[ "${2:-}" =~ $GAP_RE ]] || { echo "--gap needs a gap id (lower case letters, digits, underscores)" >&2; exit 1; }; want="$2"; shift;;
    *) echo "unknown: $1" >&2; exit 1;; esac; shift; done
  handle="$(gh api user --jq .login)"
  [[ "$handle" =~ ^[A-Za-z0-9-]{1,39}$ ]] || { echo "the GitHub handle is not a plain login" >&2; exit 1; }
  echo "desk: $DESK (board $BOARD)" >&2
  args=(-G "$DESK/next" --data-urlencode "handle=$handle" --data-urlencode "board=$BOARD")
  [ -n "$want" ] && args+=(--data-urlencode "gap=$want")
  [ -n "$kind" ] && args+=(--data-urlencode "kind=$kind")
  [ -n "$level" ] && args+=(--data-urlencode "level=$level")
  [ -n "$collection" ] && args+=(--data-urlencode "collection=$collection")
  dcurl -fsS --max-filesize 1000000 "${args[@]}" > "$STATE/.last.json" || { echo "the desk refused; its answer:" >&2; dcurl -sS --max-filesize 100000 "${args[@]}" | python3 -I -c 'import json,sys,re
raw=sys.stdin.read(100000)
try: d=json.loads(raw); t=(str(d.get("error") or "")+": "+str(d.get("say") or "")) if isinstance(d,dict) else raw
except Exception: t=raw
print(re.sub(r"[^ -~]", " ", t)[:600])' >&2
    compgen -G "$STATE/*.json" >/dev/null && echo "jobs this clone holds: tools/desk.sh mine" >&2; exit 1; }
  rm -f "$STATE/.refused"; rc=0
  python3 -I -c "$(next_py)" "$STATE" "$ROOT" "$FC_DIR" "$want" "$kind" || rc=$?
  [ "$rc" -eq 0 ] && rm -f "$STATE/.refused"
  if [ "$rc" -ne 0 ]; then
    if [ -f "$STATE/.refused" ]; then
      l="$(cat "$STATE/.refused")"; rm -f "$STATE/.refused"
      echo "the desk leased this to you, and this script cannot work on it: giving it back" >&2
      release_lease "$l" other >&2 || echo "could not give lease $l back; it lapses 15 minutes after the desk handed it out" >&2
    fi
    exit "$rc"
  fi
  ;;
beat)
  stop_check
  have "${2:-}"; lease="$(lease_of "$2")"; body="$(mktemp)"
  # Only an answer of the desk that the lease is over is a STOP (exit 3). No answer, a server error or
  # an answer that is not JSON says nothing about the lease: exit 4, beat again soon.
  code="$(dcurl -sS --max-filesize 100000 -o "$body" -w '%{http_code}' -X POST "$DESK/beat?lease=$lease" 2>/dev/null)" || code="000"
  rc=0; python3 -I -c 'import json,sys,re
gid, code = sys.argv[1], sys.argv[2]
retry = "the lease may still be alive: beat again in a minute (tools/desk.sh beat " + gid + "); it lapses 15 minutes after its last beat"
try: d=json.load(open(sys.argv[3], encoding="utf-8"))
except Exception: d=None
if not re.fullmatch(r"[1-5][0-9][0-9]", code):
    print("NO ANSWER: the desk could not be reached; " + retry, file=sys.stderr); sys.exit(4)
if code == "200" and isinstance(d,dict) and d.get("ok") is True:
    n=d.get("next_beat_s"); n=n if type(n) is int and 30<=n<=3600 else 300
    print("lease of", gid, "alive; it ends at the latest", re.sub(r"[^0-9TZ:.-]", "", str(d.get("expires_at") or ""))[:40], "| next beat in", n, "s"); sys.exit(0)
err=re.sub(r"[^a-z_]","",str(d.get("error") or ""))[:32] if isinstance(d,dict) else ""
# The answers of lib/desk.js beat that end a lease: 410 gone (ended, lapsed, 6-hour limit),
# 410 solved, and 400 bad_lease (a lease id the desk can never know).
if (code, err) in (("410","gone"), ("410","solved"), ("400","bad_lease"), ("404","gone"), ("409","solved"), ("409","in_review")):
    print("STOP: " + re.sub(r"[^ -~]", " ", str(d.get("say") or err))[:300], file=sys.stderr)
    print("the lease is over. Clear it here: tools/desk.sh release " + gid + " other", file=sys.stderr); sys.exit(3)
print("NO CLEAR ANSWER: the desk answered HTTP " + code + (" (" + err + ")" if err else "") + "; " + retry, file=sys.stderr); sys.exit(4)' "$2" "$code" "$body" || rc=$?
  rm -f "$body"; exit "$rc"
  ;;
mine)
  n=0
  for f in "$STATE"/*.json; do
    [ -e "$f" ] || continue; id="$(basename "$f" .json)"; [[ "$id" =~ $GAP_RE ]] || continue; n=$((n + 1))
    file="$(field "$id" gap.file)"; k="$(field "$id" gap.kind)"
    st="$(dcurl -fsS -m 10 -G "$DESK/step" --data-urlencode "gap=$id" 2>/dev/null | python3 -I -c 'import json,sys,re
try: d=json.load(sys.stdin); print(re.sub(r"[^a-z_]","",str(d.get("state")))[:20])
except Exception: print("unknown")' || echo unknown)"
    fs="no file"
    if [ -f "$ROOT/$file" ]; then fs="file here"; if is_checked "$id" "$file" < "$ROOT/$file"; then fs="$fs, checked"; fi; fi
    [ -z "$(field "$id" pr)" ] || fs="submitted, the desk not told: tools/desk.sh submitted $id"
    printf '%-40s %-8s %-8s %s (%s)\n' "$id" "$k" "$st" "$file" "$fs"
  done
  [ "$n" -gt 0 ] || echo "this clone holds no job. Next: tools/desk.sh next"
  [ "$n" -gt 0 ] && echo "keep each alive with tools/desk.sh beat <id>; give one back with tools/desk.sh release <id> <reason>"
  true
  ;;
check)
  have "${2:-}"; id="$2"; file="$(file_of "$id")"; kind="$(field "$id" gap.kind)"; rm -f "$STATE/$id.checked"; still_open "$id"
  [ -f "$ROOT/$file" ] || { echo "no file $file yet" >&2; exit 1; }
  if [ "$kind" = check ] || [ "$kind" = refute ]; then tidy "$ROOT/$file"; fi
  size_ok "$file"; built="$(sha < "$ROOT/$file")"
  case "$kind" in
  state) check_state "$id" "$file" ;;
  compute) check_compute "$id" "$file" ;;
  *)
    # The public guard first (cheap), then the checker itself (it builds the file and judges it).
    imp="$STATE/$id.imports.json"
    python3 -I -c 'import json,sys; json.dump(json.load(open(sys.argv[1]))["gap"]["imports"], open(sys.argv[2],"w"))' "$STATE/$id.json" "$imp"
    node "$ROOT/.github/scripts/outside-guard.mjs" imports "$ROOT/$file" "$imp" "$file" || exit 1
    node "$ROOT/tools/check-lean.mjs" "$ROOT/$file" "$(field "$id" gap.constant)" "$(field "$id" gap.module)" "$kind" || exit $?
    ;;
  esac
  [ "$(sha < "$ROOT/$file")" = "$built" ] || { echo "$file changed while it was checked; run check again" >&2; exit 1; }
  printf '%s %s\n' "$built" "$file" > "$STATE/$id.checked"
  echo "passed on this machine. The pull request is checked again by the repository's own run. Next: tools/desk.sh submit $id"
  ;;
tidy)
  have "${2:-}"; file="$(file_of "$2")"
  [[ "$file" == *.lean ]] || { echo "tidy is for Lean files" >&2; exit 1; }
  tidy "$ROOT/$file"
  ;;
submit)
  stop_check
  have "${2:-}"; id="$2"; file="$(file_of "$id")"; kind="$(field "$id" gap.kind)"
  [ -z "$(field "$id" pr)" ] || { echo "not submitted: $id was submitted already ($(pr_of "$id")) and the desk was not told. Run: tools/desk.sh submitted $id" >&2; exit 1; }
  still_open "$id"
  [ -f "$ROOT/$file" ] || { echo "no file $file here" >&2; exit 1; }
  size_ok "$file"
  is_checked "$id" "$file" < "$ROOT/$file" || { echo "not submitted: $file is not the file that was checked. Run: tools/desk.sh check $id" >&2; exit 1; }
  if [ "$kind" = check ] || [ "$kind" = refute ]; then
    grep -q 'sorry' "$ROOT/$file" && { echo "$file still contains sorry" >&2; exit 1; }
  fi
  cd "$ROOT"
  # ONLY THIS JOB'S FILE GOES IN. A change to a tracked file, or anything staged, is refused. Other
  # untracked files (another job's skeleton) stay where they are and out of the pull request.
  other="$(git diff --name-only HEAD -- | grep -vxF -- "$file" || true)"
  [ -z "$other" ] || { echo "not submitted: tracked files are changed; a pull request adds exactly $file. Commit, stash or undo these first:" >&2; echo "$other" >&2; exit 1; }
  extra="$(git ls-files --others --exclude-standard | grep -vxF -- "$file" || true)"
  [ -z "$extra" ] || echo "note: $(printf '%s\n' "$extra" | wc -l | tr -d ' ') other untracked file(s) stay out of this pull request" >&2
  start="$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)"
  git fetch -q "https://github.com/$UPSTREAM.git" main
  up="$(git rev-parse FETCH_HEAD)"
  if git cat-file -e "$up:$file" 2>/dev/null; then
    echo "This gap was just done by someone else, and a recorded result is final, so this one cannot be sent. You did nothing wrong. Clear it: tools/desk.sh release $id other; then tools/desk.sh next" >&2; exit 1
  fi
  # The branch starts at the upstream main, so it carries nothing from an earlier pull request.
  if [ "$start" != "$id" ]; then
    if git show-ref -q --verify "refs/heads/$id"; then
      echo "not submitted: a branch $id exists from an earlier try. Continue on it (git checkout $id; tools/desk.sh submit $id) or delete it (git branch -D $id)" >&2; exit 1
    fi
    git checkout -q -b "$id" "$up"
  fi
  git add -- "$file"; git diff --cached --quiet || git commit -q -m "$id" -- "$file"
  git cat-file blob "HEAD:$file" | is_checked "$id" "$file" || { echo "not submitted: the committed $file is not the file that was checked (git or a hook changed it)" >&2; exit 1; }
  # ONE NEW FILE, NOTHING ELSE: the pull request's diff against the upstream main adds exactly this file.
  base="$(git merge-base "$up" HEAD)"
  changed="$(git diff --name-status "$base" HEAD)"
  if [ "$changed" != "A	$file" ]; then
    echo "refused: a pull request adds exactly one new file, $file, and changes nothing on main." >&2
    echo "this pull request would change:" >&2; echo "$changed" >&2; exit 1
  fi
  git push -q -u origin "$id"
  lease="$(lease_of "$id")"
  still_open "$id"
  # Renew the lease right before the pull request: if the desk says the gap was solved meanwhile, the
  # pull request would be refused; stop. If the desk cannot be reached, go on.
  { dcurl -sS -m 10 -X POST "$DESK/beat?lease=$lease" 2>/dev/null || true; } | python3 -I -c 'import json,sys,re
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
if isinstance(d, dict) and (d.get("withdrawn") is True or d.get("error") == "solved"):
    print("STOP: not submitted. " + re.sub(r"[^ -~]", " ", str(d.get("say") or d.get("error") or "the gap was withdrawn"))[:300], file=sys.stderr); sys.exit(3)
if isinstance(d, dict) and d.get("ok") is not True:
    print("note: the lease is over (" + re.sub(r"[^ -~]", " ", str(d.get("say") or d.get("error") or ""))[:200] + "); the pull request is still sent", file=sys.stderr)' || exit 3
  # The lease is a bearer token (whoever holds it can end the hold): it never goes in the pull request.
  pr="$(gh pr create --repo "$UPSTREAM" --title "$id" --body "Gap: $id ($kind), sent with tools/desk.sh.")"
  pr="$(printf '%s' "$pr" | tr -cd '[:print:]\n' | grep -Eo 'https://[A-Za-z0-9./_-]+' | tail -n 1 || true)"
  [[ "$pr" =~ $PR_RE ]] || pr=""
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$id" "${pr:-?}" >> "$STATE/submitted.log"
  told=yes; release_lease "$lease" submitted "$pr" || told=no
  if [ "$start" != "$id" ]; then git checkout -q "$start"; fi
  if [ "$told" = no ]; then
    # The job and its lease stay here, with the pull request's address, so the desk can be told later.
    if [ -n "$pr" ]; then set_pr "$id" "$pr"; fi
    echo "submitted ${pr:-(the address of the pull request could not be read)}, but the desk was NOT told, so it does not yet hold the gap for your review." >&2
    if [ -n "$pr" ]; then echo "The job and its lease are kept here. Tell the desk within 15 minutes of the last beat: tools/desk.sh submitted $id" >&2
    else echo "The job and its lease are kept here. Keep the lease alive (tools/desk.sh beat $id) and ask a maintainer to record the pull request." >&2; fi
    exit 5
  fi
  put_away "$id"
  case "$kind" in
    state|compute) echo "submitted ${pr:-}. A person reviews $kind jobs; the result shows on the pull request." ;;
    *) echo "submitted ${pr:-}. The repository's checks run on the pull request (gh pr checks ${pr:-<url>}); on ACCEPTED it is merged and credited to you." ;;
  esac
  echo "Next: tools/desk.sh next"
  ;;
submitted)
  # The desk call of a submit that failed, sent again with the pull request's address the submit kept.
  have "${2:-}"; id="$2"; pr="$(pr_of "$id")"
  [ -n "$pr" ] || { echo "$id has no pull request recorded here; only a submit that could not tell the desk leaves one (run tools/desk.sh submit $id)" >&2; exit 1; }
  release_lease "$(lease_of "$id")" submitted "$pr" || { echo "the desk was still not told; the job and its lease stay here. Try again: tools/desk.sh submitted $id" >&2; exit 5; }
  put_away "$id"
  echo "the desk holds $id for the review of $pr. Next: tools/desk.sh next"
  ;;
release)
  have "${2:-}"; id="$2"; reason="${3:?a reason}"
  [[ "$reason" =~ $REASON_RE ]] || { echo "a reason is a word of lower case letters and underscores" >&2; exit 1; }
  [ "$reason" != submitted ] || { echo "refused: submitted is not a reason to give by hand; tools/desk.sh submit sends it with the pull request (and tools/desk.sh submitted $id resends it)" >&2; exit 1; }
  release_lease "$(lease_of "$id")" "$reason" || exit 1
  put_away "$id"
  ;;
*)
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  ;;
esac
