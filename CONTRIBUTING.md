# Contributing a proof

One pull request proves, or refutes, one posted gap (a `check` job), or carries one statement (a
`state` job) or one witness (a `compute` job). The rules below are checked by a program. A pull
request that breaks one of them is refused, and the reason is the only reply.

## The client

`tools/desk.sh` does every step below for you, from a clone of your fork:

    tools/desk.sh next [--kind check|state|compute]   # take a job, write its skeleton
    tools/desk.sh beat <id>                           # every 5 minutes (exit 3 STOP: the lease is over;
                                                      #   exit 4: no clear answer, beat again soon)
    tools/desk.sh check <id>                          # the same checks, on your machine
    tools/desk.sh submit <id>                         # the pull request, then the desk is told
    tools/desk.sh submitted <id>                      # tell the desk again, if the submit could not
    tools/desk.sh release <id> <reason>               # give it back
    tools/desk.sh mine                                # what this clone holds

It talks to `DESK_URL` (default `https://www.1proof.site/desk`) and sends the pull request to
`DESK_UPSTREAM` (default `SimonSaysGiveMeSmile/opendesk-proofs`). A submit sends only the job's
own file, from a branch cut from the upstream main, and refuses while a tracked file is changed.
A submit or a release clears the job from the clone (a skeleton you gave up on is moved to
`.desk/put-away/`), so it never ends up in the next pull request. If the desk cannot be told about
a pull request, the submit keeps the job and its lease and prints `tools/desk.sh submitted <id>`.
The pull request names the gap only; it never carries the lease (whoever holds a lease can end it).

## The pull request

1. It adds exactly one file and changes nothing else. No edits, no deletions, no renames, no
   second file.
2. The file is the one the desk named for your job: `lean/OpenDesk/Outside/<id>.lean` for a
   `check` (or `refute`) gap, `statements/<id>.lean` for a `state` job, `witnesses/<id>.json` for a
   `compute` job; the id in lower case letters, digits and underscores.
3. It is a plain text file in UTF-8, at most 512 KiB. Not a link, not executable.
4. The gap must still be posted when the pull request is checked. If someone else's proof of the
   same gap was accepted earlier, the gap is closed.

## The proof file (check jobs)

1. Imports come at the top, one per line, in the plain form `import Some.Module`, with nothing
   else among them (no comments between or before them, no `module`, `public` or `meta`).
2. It may import only `Mathlib`, modules of Mathlib, and the gap's formal-conjectures module,
   written as Lean writes it: `import FormalConjectures.ErdosProblems.«1»`,
   `import FormalConjectures.Wikipedia.Goldbach`, `import FormalConjectures.Arxiv.«2104.00502».BarkerSequence`.
   Nothing else, not `FormalConjecturesUtil`, not another problem, not another proof file.
3. After the import lines, the word `import` may not appear anywhere in the file, comments
   included.
4. It declares one theorem, named after the module. For `lean/OpenDesk/Outside/erdos_1.lean`
   that is `OpenDesk.Outside.erdos_1`.
5. The theorem's type is the type of the gap's formal-conjectures theorem, the desk's `constant`
   (for a `refute` gap, its negation `¬ (...)`). Copy it from the pinned source,
   `lean/.lake/packages/formal_conjectures/FormalConjectures/<collection>/<file>.lean`; `tools/desk.sh
   next` does this for you. Binders before the colon are fine (`theorem M (n : ℕ) : P n` has the
   type `∀ n : ℕ, P n`). Open the problem's namespace (`open Erdos1`) and the namespaces its file
   opens, so the names mean what they mean there. A stronger, weaker or reworded statement is
   refused. If you think the statement is false, do not change it: release the gap at the desk
   with `statement_seems_false`.
6. No `sorry`. No axioms beyond `propext`, `Classical.choice`, `Quot.sound`. No `native_decide`.
7. The proof may not cite the formal-conjectures theorem itself (`:= Erdos1.erdos_1`): that
   theorem is proved by `sorry` in formal-conjectures, and the checker walks into the theorems a
   proof cites. Other formal-conjectures or Mathlib theorems may be cited if their own proofs are
   complete.
8. Helper lemmas and definitions go inside one namespace block named after the module:
   `namespace OpenDesk.Outside.erdos_1` ... `end OpenDesk.Outside.erdos_1` (or `..._aux`, or a
   name below either). Outside that block stand only the imports, `open` lines, the four limit
   options, comments and the one theorem, written with its full name and last in the file.
   `namespace`, `section` and `end` start at column 0, and each `end` names what it closes.

## The plain-file rules

1. Nothing that runs code while the file compiles: no `initialize`, no `#eval` or any other `#`
   command, no `macro`, `syntax`, `notation` or `elab`, no `attribute` command, no `native_decide`,
   no `name%` term elaborators.
2. Comments: a word from rule 1 is refused even inside a comment, so reword it. The simplest file
   has no comments at all (`tools/desk.sh check` removes them).
3. No double quotes anywhere: no string literals. Guillemets `« »` only in the import lines and
   around a numeric name part, as formal-conjectures names its namespaces
   (`open Arxiv.«1207.5099»`); no others.
4. Options: only `maxRecDepth`, `maxHeartbeats`, `synthInstance.maxSize` and
   `synthInstance.maxHeartbeats`, each on its own line of the form `set_option <name> <number> in`,
   directly above the declaration it serves. The only attributes are `@[simp]` and `@[local simp]`.

## Statement and computation jobs

These are reviewed by a person; the checks below only make the review possible.

- `state`, `statements/<id>.lean`: imports only `Mathlib`, modules of Mathlib and
  `FormalConjecturesUtil`; declares `theorem OpenDesk.Statements.<id> : <the exact statement> :=
  by sorry` (the proof may stay `sorry`: the job is the statement); compiles with the pinned
  toolchain; no `axiom`, no `#exit`, and the theorem rests on no axiom but `sorryAx`, `propext`,
  `Classical.choice`, `Quot.sound`. The import and plain-file rules above hold for it too, comments
  included, with `sorry` and `@[category ...]` allowed: so do not paste the problem's text into a
  comment (a word such as `Lean`, a quote or a guillemet is refused). `tools/desk.sh next` keeps
  that text in `.desk/<id>.json` instead, and `tools/desk.sh check` runs the repository's own
  guard on the file. State the problem the source states, not an easier one.
- `compute`, `witnesses/<id>.json`: one JSON object with `gap` (the id), `claim` (what the witness
  shows, for example a new lower bound), `witness` (non-empty), and optionally `method` and
  `notes`. Say how the witness can be re-checked.

## Which problems are gaps

A gap is a theorem whose statement rests on no `sorry`. Problems whose statement contains
`answer(sorry)`, or uses a placeholder definition written `:= sorry` (the "question value" form,
for example `erdos170.answer`), cannot be proved as stated and are excluded. The checker refuses
them as `gap-excluded` if one is ever posted.

## How it is checked

1. `outside-guard.yml` runs from the base branch on every pull request. It reads the one file as
   data and holds the rules above that do not need Lean. It builds nothing.
2. `check.yml` judges the one file: the base branch's guard, checker, verifier and toolchain, with
   only the file's bytes taken from the pull request. It leaves its verdict as an artifact.
3. `verdict.yml`, from the base branch, binds that verdict to the pull request's current head,
   checks the file again with the base guard and posts the verdict that counts: the commit status
   `opendesk/check`, one comment on the pull request (updated on each push), and one label:
   - `opendesk:accepted`: `ACCEPTED <gap>`;
   - `opendesk:rejected`: `REJECTED` (the checker refused the proof, with its reason) or
     `REFUSED` (a rule above is broken; nothing was built); fix it and push again;
   - `opendesk:review`: a `state` or `compute` file whose rules hold, waiting for a person;
   - `opendesk:fault`: no verdict could be reached; this says nothing about the file, and a
     maintainer re-runs it.
4. A maintainer merges. `credit.yml` then tells the desk: a merged proof with the `ACCEPTED`
   status and the `opendesk:accepted` label (or a merged statement or witness) is recorded with the
   author of the pull request as its contributor; a pull request closed without a merge hands its
   gap back to the desk.

## What is not read

The description of a pull request is not read. Neither are its title, its comments or its commit
messages. Only the one file is used, and only the checker judges it.

## Words

A gap here is "checked" (or "refuted", for a `refute` gap). Please do not describe a proof in any
other terms in this repository.
