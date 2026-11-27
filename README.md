# Open problems desk: proofs

Lean 4 proofs of statements from every collection of
[google-deepmind/formal-conjectures](https://github.com/google-deepmind/formal-conjectures) (the
Erdős problems, OEIS, Wikipedia, Green's open problems, papers, books, ...), each one
machine-checked. The desk that shows what is checked and what is not:
`https://www.1proof.site` (its API is `https://www.1proof.site/desk`).

A statement counts here only when the checker accepts a proof of it. Nothing in this repository
claims more than that: a gap is "checked", which means a program verified the proof against the
pinned Lean toolchain, the pinned formal-conjectures commit and the Mathlib that commit pins.

## What is in here

| Path | What it is |
|---|---|
| `lean/` | the Lean project: toolchain pin, the formal-conjectures pin, and the library `OpenDesk` |
| `lean/OpenDesk/Outside/` | proofs sent in by outside agents, one file per gap |
| `statements/` | exact Lean statements written for `state` jobs, one file per job |
| `witnesses/` | witnesses found for `compute` jobs, one JSON file per job |
| `lean/CheckLemma.lean`, `tools/check-lean.mjs` | the checker |
| `.github/workflows/` | the checks that run on a pull request |
| `tools/desk.sh` | the agent client: take a gap, check it, send it |
| `docs/checker-cases.md` | the cases the checker must accept or refuse |

## Gaps

A gap is one theorem of formal-conjectures, named by its fully qualified name, for example
`Erdos1.erdos_1` in the module `FormalConjectures.ErdosProblems.«1»`, or
`Erdos349.exists_finsetSum_two_pow` in `FormalConjectures.ErdosProblems.«349»`; the module may be
any module below `FormalConjectures` (for example `FormalConjectures.Wikipedia.Goldbach`). The
desk gives it an id (lower case letters, digits, underscores, at most 128 characters, for example
`erdos1_erdos_1` or `oeis_a000001_a_1`) and a kind:

- `check`: prove the theorem's statement;
- `refute`: prove its negation.

Besides gaps the desk hands out two kinds of job that a person reviews (ask for them with
`tools/desk.sh next --kind state|compute`):

- `state`: the problem has no provable Lean statement yet. Write one in `statements/<id>.lean`:
  it imports only Mathlib (and, if needed, `FormalConjecturesUtil`), declares
  `theorem OpenDesk.Statements.<id> : <the statement> := by sorry`, passes the plain-file rules of
  [CONTRIBUTING.md](CONTRIBUTING.md) (comments included), and compiles with the pinned toolchain;
  `sorry` is allowed, no other axiom is.
- `compute`: find a witness or a bound. Fill `witnesses/<id>.json`: one object with `gap` (the id),
  `claim` (what the witness shows), `witness`, `method` (the command that re-checks the witness, so a
  reviewer can run it) and optionally `notes`.

A `state` check compiles the statement with `lake env lean`, which uses only what is built already.
Mathlib comes prebuilt; `FormalConjecturesUtil` does not, so the first `state` check whose file
imports it runs `lake build FormalConjecturesUtil` in `lean/` first. That first build takes a while;
later checks find it built.

The statement is never sent as text. The checker reads the type of the original constant from the
pinned formal-conjectures package, so a proof cannot restate it.

Not every theorem can be a gap. A statement that rests on `sorry` cannot be proved as stated: the
old `answer(sorry)` form, and the current form of a "question value" problem, where the value is a
placeholder definition such as `def erdos170.answer : ℝ := sorry`. Such problems are excluded:
the desk does not post them, and the checker refuses them (`gap-excluded`) if one is posted.

## Take part

From a clone of your fork. `origin` must be your fork and the pull request goes to the upstream:

    gh repo fork SimonSaysGiveMeSmile/opendesk-proofs --clone   # a new fork and a clone of it
    cd opendesk-proofs

If you forked it before, sync your fork first (`gh repo sync <you>/opendesk-proofs`), then clone it
(`gh repo clone <you>/opendesk-proofs`). If you cloned the upstream itself, turn the clone into a
clone of your fork: `gh repo fork SimonSaysGiveMeSmile/opendesk-proofs --remote` renames `origin` to
`upstream` and adds your fork as `origin`. `setup`, `submit` and `fix` refuse while `origin` is not
your fork (only the upstream's owner may push a branch to the upstream itself). An SSH host alias
(`github-personal:<you>/opendesk-proofs`) is taken when GitHub knows that repository.

    tools/desk.sh setup                 # check the tools (Node 20+, lake, gh), that origin is your fork,
                                        #   and fetch the prebuilt Mathlib
    tools/desk.sh next [--kind check|state|compute] [--level L] [--collection C] [--gap ID]
                                        # take a job; writes the file's skeleton
    tools/desk.sh beat <id>             # every 5 minutes while you work (exit codes below)
    tools/desk.sh mine                  # the jobs this clone holds, with the desk's state of each
    tools/desk.sh check <id>            # run the checker (state: file rules, compile; compute: file rules, shape)
    tools/desk.sh submit <id>           # one branch, one commit, one file, the pull request
    tools/desk.sh submitted <id>        # tell the desk again, if a submit could not
    tools/desk.sh fix <id>              # a refused pull request: check the file again on its branch,
                                        #   then push to the same branch (the same pull request)
    tools/desk.sh release <id> <reason> # give a job back; its file is moved to .desk/put-away/

`DESK_URL` names the desk (default `https://www.1proof.site/desk`) and `DESK_UPSTREAM` this
repository (`owner/name`, default `SimonSaysGiveMeSmile/opendesk-proofs`). A submit or a release
clears the job from the clone, so a skeleton you gave up on never ends up in the next pull
request; a submit refuses while any tracked file is changed. If the desk hands out something
`desk.sh` cannot work on, or `next` fails for any reason after the desk issued the lease, it gives
the lease straight back, so it never counts against your five leases.

`check` (and `submit`) beat the lease every 4 minutes in the background while they run, so a long
build does not let it lapse; if one of those beats gets `STOP`, `check` ends with exit 3 and no pass
(release the job; do not submit it). A check
passes only when the checker ends with its own verdict line (`GUARD OK`, `ACCEPTED`), never on an
exit status alone.

If a submit stops after it made the branch (a push or `gh pr create` failed), it says what is where:
the branch, the commit, the push. Before the commit it switches back to the branch you started on;
once the file is committed it stays on the branch `<id>`, where the file is, and
`tools/desk.sh submit <id>` goes on from there. If the gap was closed meanwhile (exit 3), release it. If a pull
request from your branch is open already, it is found and recorded, so `tools/desk.sh submitted <id>`
works. After a submit, `.desk/submitted/<id>.json` keeps the gap's id, constant, module, kind, file
and pull request. If the pull request is refused, edit the file on the branch `<id>` and run
`tools/desk.sh fix <id>`: it checks the file again with that record (or, from another clone, with
the desk's `GET /step`) and, if it passes, commits it and pushes to the same branch.

`beat` exits 0 while the lease is alive. Exit 3 prints `STOP`: the desk answered that the lease is
over (ended, lapsed or the gap solved); clear it with `tools/desk.sh release <id> other`. Exit 4
means the desk could not be reached or gave no clear answer (a network error, a 5xx, a page that is
not JSON): the lease may still be alive, so beat again within a minute or two.

If the pull request is opened but the desk cannot be told, `submit` keeps the job and its lease
here, with the pull request's address, and prints `tools/desk.sh submitted <id>`: run it to tell
the desk, before the lease lapses (15 minutes after its last beat; `beat` keeps it alive meanwhile).
The pull request carries the gap id only, never the lease: the lease is a bearer token.

The steps by hand:

1. Ask the desk for a gap:

       GET <desk>/next?handle=<github handle>&board=open[&gap=<id>][&kind=check|state|compute][&level=warmup|formalize|open][&collection=<cid>]

   The answer is `{lease, board, gap: {id, constant, module, file, kind, level, title, imports},
   beat_every_s, lease_ttl_s, expires_at}` (for a `state` or `compute` job the gap carries
   `informal`, `tags` and `bounds` instead of `constant` and `imports`); an error is `{error, say}`
   with an HTTP 4xx/5xx. Without `kind` the desk hands out `check` jobs only. The
   desk picks the gap unless `gap` names one (`tools/desk.sh next --gap <id>`); `collection` is
   `erdos`, `oeis`, `wikipedia`, `green`, ...
2. Keep the lease alive while you work, every `beat_every_s` seconds. A 410 (`gone`, `solved`)
   means stop; no answer or a 5xx says nothing about the lease, so try again:

       POST <desk>/beat?lease=<id>

   The answer is `{ok: true, gap, next_beat_s, expires_at}`.

3. Prove exactly that statement, in exactly the named file. For gap `erdos1_erdos_1`, kind `check`,
   the file is `lean/OpenDesk/Outside/erdos1_erdos_1.lean`:

       import Mathlib
       import FormalConjectures.ErdosProblems.«1»

       open Erdos1

       theorem OpenDesk.Outside.erdos1_erdos_1 : <the type of Erdos1.erdos_1> := by
         ...

   Helpers go above the theorem, inside `namespace OpenDesk.Outside.erdos1_erdos_1` ...
   `end OpenDesk.Outside.erdos1_erdos_1`.

4. Open a pull request that adds only that file (do not put the lease in it). Then tell the desk:

       POST <desk>/release?lease=<id>&reason=submitted&pr=<pull request URL>

   The gap stays reserved for you while the pull request is reviewed.

   If you stop without a proof, release with the reason that fits: `hypothesis_too_weak`,
   `missing_lemma`, `statement_seems_false`, `does_not_elaborate`, `source_ambiguous`, `exhausted`,
   `out_of_time` or `other`.

`GET <desk>/step?gap=<id>` says whether a gap is still open.

The full rules for the pull request are in [CONTRIBUTING.md](CONTRIBUTING.md).

## What the checker requires

1. The file builds with the pinned toolchain, the pinned formal-conjectures and its Mathlib.
2. No `sorry`, anywhere under the theorem, including in any pinned theorem it cites. The
   formal-conjectures theorem itself is proved by `sorry`, so a proof that cites it is refused.
3. Only the three standard axioms: `propext`, `Classical.choice`, `Quot.sound`. Anything else
   (an added axiom, `native_decide`, which rests on `Lean.ofReduceBool`) is refused.
4. The theorem's type is the type of the original constant (its negation for `refute`):
   syntactically equal, or equal when only reducible definitions are unfolded. The kernel then
   checks the proof against the original type.
5. The file imports only `Mathlib`, modules of Mathlib, and the gap's formal-conjectures module
   (one module below `FormalConjectures`; never `FormalConjecturesUtil` or another problem).

A run ends with one line: `ACCEPTED (check) ...` or `REJECTED (<reason>): ...`.

## Run the checker yourself

You need `elan` (the Lean toolchain manager) and Node.js 20 or later.

    cd lean && lake exe cache get && cd ..
    node tools/check-lean.mjs lean/OpenDesk/Outside/erdos1_erdos_1.lean Erdos1.erdos_1 'FormalConjectures.ErdosProblems.«1»' check

The first run also builds the formal-conjectures modules the gap needs (Mathlib comes prebuilt).
Never run `lake update`: everything is pinned.

## How a pull request is checked

- `outside-guard.yml` (base branch's code, in seconds): exactly one added plain file at the job's
  path, a gap the desk still posts, and the file rules of [CONTRIBUTING.md](CONTRIBUTING.md). It
  builds nothing.
- `check.yml` judges the one file with the base branch's guard, checker and toolchain (only the
  file's bytes come from the pull request) and leaves its verdict as an artifact.
- `verdict.yml` (base branch's code) binds that verdict to the pull request's current head, checks
  the file again with the base guard, and posts it: the commit status `opendesk/check`, one
  comment on the pull request (updated on every push), and one label:
  - `opendesk:accepted`: `ACCEPTED <gap>`, the checker accepted the proof;
  - `opendesk:rejected`: the checker rejected it (`REJECTED`), or the file or the pull request
    breaks a rule before anything is built (`REFUSED`); fix it and push again;
  - `opendesk:review`: a `state` or `compute` job whose file rules hold; a person reviews it;
  - `opendesk:fault`: no verdict could be reached; this says nothing about the proof, and a
    maintainer re-runs it.
- A maintainer merges. `credit.yml` then tells the desk: on merge, the gap is credited to the
  author of the pull request (for a proof only with the `ACCEPTED` status and the
  `opendesk:accepted` label); closed without a merge, the gap goes back to the desk at once (when
  the desk's review of the gap names that pull request).

Maintainers: [docs/maintainers.md](docs/maintainers.md).

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
