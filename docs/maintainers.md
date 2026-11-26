# Running the proofs repository

This is for the maintainers of the public proofs repository (planned: `SimonSaysGiveMeSmile/opendesk-proofs`).
It covers what to set up once, what each workflow does, and how to accept or reject a pull request.

## The workflows

| Workflow | Trigger | Runs code from | Credentials | What it does |
|---|---|---|---|---|
| `outside-guard.yml` | `pull_request_target` (opened, synchronize, reopened) | base branch only | read-only token | The rules, in seconds: one added file at an allowed path, a plain file, a gap the desk posts, and the import, plain-file and own-namespace rules. Nothing is built. |
| `check.yml` | `pull_request` | the base commit's checker, run on the pull request's one file, which it fetches by blob hash | none (read-only token, no secrets) | Installs the pinned toolchain, restores the Lean packages cache, runs `tools/check-lean.mjs` from the base commit on the one file, and uploads the verdict (`opendesk-verdict-<run attempt>`, one small `verdict.txt`) as an artifact. Each attempt of a run uploads its own, so a re-run never collides with the first attempt's artifact. State and compute files are not compiled; their verdict is `REVIEW`. |
| `verdict.yml` | `workflow_run` of `check` | default branch only | may comment, label and set statuses | Reads the artifact as data and binds it to the pull request's current head. It runs the base branch's guard again on the file, fetched through the API, checks that the accepted bytes are that file's (sha256), then sets the commit status **`opendesk/check`**, labels the pull request and posts one comment (and updates it on later runs). It reads only the artifact of the attempt it was started for. If it cannot read what it checks (the desk's gap list, the pull request's file list or tree, the file's bytes), the verdict is `FAULT`, never `REFUSED`. |
| `credit.yml` | `pull_request_target` (closed) | base branch only | `OPENDESK_ADMIN_TOKEN` | **Merged:** calls `POST <desk>/accepted` with `{gap, handle: author login, pr: url, board}`. A proof file is credited only if the newest `opendesk/check` status on its head is `success`, set by `github-actions[bot]` and saying `ACCEPTED <gap id>`, and the pull request has the label `opendesk:accepted`. A statement or witness is credited when it is merged, because merging it is the reviewer's approval. **Closed without merge** (a file under `lean/OpenDesk/Outside/`, `statements/` or `witnesses/`): calls `POST <desk>/rejected` with `{gap, pr: url, reason: pull_request_closed, board}`, so the gap is free again at once, but only if the desk's review of that gap names this pull request. The desk reads `gap`, `board` and `reason`. If the desk cannot be read or does not answer `ok`, the job fails, and you re-run it. It never checks out the pull request. |
| `lean-cache.yml` | push to `main` (manifest, toolchain or lakefile), weekly, by hand | default branch only | read-only token | Fetches the Lean packages and Mathlib's prebuilt files and saves `lean/.lake/packages` to the Actions cache. No other workflow writes this cache. `check.yml` only restores it. |

The verdict that counts is the commit status `opendesk/check`. Only `verdict.yml` can set it. A fork's
`pull_request` run has a read-only token and cannot set it. `check.yml` going green or red is only that
job finishing, and it is not the verdict.

Verdicts: `ACCEPTED` (success), `REVIEW` (success, so a person reviews it), `REJECTED` and `REFUSED`
(failure), `FAULT` (error: the check could not reach a verdict, and this says nothing about the proof).
Labels: `opendesk:accepted`, `opendesk:review`, `opendesk:rejected`, `opendesk:fault`. GitHub creates
each label the first time it is added. You can also create them in advance and give them colours.

Both `check.yml` and `credit.yml` are adapted from
[open-goat/pequalnp-proofs](https://github.com/open-goat/pequalnp-proofs) (Apache-2.0). pequalnp-proofs
runs its authoritative check by hand (`workflow_dispatch`) and builds the outside file as a separate,
locked-down account. This template splits the check into `pull_request` and `workflow_run` so that the
check runs on its own (see the limits below).

## One-time setup

### Repository variables (Settings > Secrets and variables > Actions > Variables)

| Variable | Default when unset | Purpose |
|---|---|---|
| `OPENDESK_GAPS_URL` | `https://www.1proof.site/desk/gaps.json` | The desk's public list of gaps, read by `outside-guard.yml`, `check.yml`, `verdict.yml` and `credit.yml`. |
| `OPENDESK_DESK_URL` | `https://www.1proof.site/desk` | The desk API, used by `credit.yml` for `/accepted`, `/rejected` and `/step`. It must be a plain `https://host/path` address with no query and no `user@`. |

### Repository secret (Settings > Secrets and variables > Actions > Secrets)

| Secret | Purpose |
|---|---|
| `OPENDESK_ADMIN_TOKEN` | The desk's admin token, the same value as `DESK_ADMIN_TOKEN` on the site. Only `credit.yml` reads it, from base-branch code that runs nothing of the pull request. Rotate it on the site and here together. |

Do not add any other secret. `check.yml` runs a file nobody has vouched for and must never receive one.

### Actions settings (Settings > Actions > General)

- **Workflow permissions:** "Read repository contents and packages permissions". Each workflow asks
  for exactly what it needs in its own `permissions:` block.
- **Fork pull request workflows:** keep "Require approval for first-time contributors", or the
  stricter "for all outside collaborators". Approving a run lets `check.yml` compile the file, with no
  secrets. Do not enable "Send write tokens to workflows from fork pull requests" or "Send secrets to
  workflows from fork pull requests".
- Run `lean-cache` once by hand (Actions > lean-cache > Run workflow) after you create the repository
  and whenever you change the pinned toolchain. `check.yml` also works without the cache, just more
  slowly.

### Branch protection on `main` (Settings > Branches, or a ruleset)

- Require a pull request before merging, with **1 approving review** from a maintainer. A person
  merges every pull request. Nothing merges by itself.
- **Required status checks:** `opendesk/check` (the status that `verdict.yml` sets) and
  `guard` (the job in `outside-guard.yml`). Do not make `check` (the job in `check.yml`) required on
  its own, because it is the pull request's own run.
- Require branches to be up to date before merging: optional. The check reads the base commit at the
  time of the push.
- Block force pushes and deletions. Restrict who can push to `main` to the maintainers.
- Optional: CODEOWNERS for `.github/`, `tools/` and `lean/` (everything except `lean/OpenDesk/Outside/`,
  `statements/` and `witnesses/`), so that a change to the checker needs a maintainer's review.

`verdict.yml` and `credit.yml` run from the default branch only (GitHub's rule for `workflow_run`
and `pull_request_target`), so they must be on `main` before the first pull request arrives.

## Reviewing and merging

**A proof** (`lean/OpenDesk/Outside/<gap id>.lean`):

1. Wait for `opendesk/check`. `ACCEPTED` means the base branch's checker built the file in the pinned
   environment. It also means the theorem has the formal-conjectures statement's type (or its negation
   for `refute`) and rests only on `propext`, `Classical.choice` and `Quot.sound`.
2. Read the file anyway. It is small, and the comment links to the run. Look for anything strange that
   the plain-file rule did not catch (see the limits below).
3. Merge it. Squash and rebase both work, because the credit reads the pull request's head. `credit.yml`
   then calls `/desk/accepted`, and the site credits the pull request's author.

**A statement** (`statements/<gap id>.lean`) or **a witness** (`witnesses/<gap id>.json`): `opendesk/check`
says `REVIEW` once the file rules hold. Check the statement against its source, or check the witness
against the problem. Merging it credits the author.

**If the credit step fails** (the desk was down, or the secret was missing): re-run the failed
`credit` job from the Actions tab. `/desk/accepted` is idempotent. A second call answers
`already: true`. A re-run also works after the desk has recorded the gap: the guard then finds it in
the desk's `checked` list, whose rows are only `{id, file}`, and reads the kind from the file's path.
The same goes for a failed hand-back of a closed pull request: re-run the `credit` job.

## Rejecting

- **The checker rejected it** (`REJECTED`/`REFUSED`): nothing to do. The author can push a fixed file
  and the check runs again. A new push replaces the old status.
- **You turn it down** (a statement that misreads its source, a witness that is wrong, a proof you
  will not merge): say why in a comment, then **close** the pull request. `credit.yml` sees it closed
  without a merge. If the desk's review of the gap names this pull request, it calls `/desk/rejected`,
  the gap goes back to the desk at once, and the step's history shows `pull_request_closed`. Otherwise
  the review hold lapses by itself after 72 hours.
- **Hand a gap back by hand** (for example, a review that names no pull request):
  `curl -sS -H "Authorization: Bearer $OPENDESK_ADMIN_TOKEN" -H 'Content-Type: application/json' --data '{"gap":"<id>","reason":"rejected"}' https://www.1proof.site/desk/rejected`.
  Keep the token in your shell environment, not on the command line or in your history.
- **A `FAULT`**: the verdict comment tells the author that the maintainers will re-run the check, and
  that they should not change the file. Re-run the `check` workflow for that pull request (Actions >
  the run > Re-run all jobs). The re-run uploads `opendesk-verdict-<attempt>`, and `verdict.yml` posts
  that attempt's verdict over the fault. A fault says nothing about the proof and carries the label
  `opendesk:fault`, never `opendesk:rejected`. A fault that repeats is usually the runner running out
  of memory or disk, the desk's gap list being unreachable, or a GitHub API outage. If `verdict.yml`
  itself fails before it has read the artifact (for example, the artifact list could not be read), it
  posts nothing: re-run the `verdict` run instead.
- There is no endpoint to take back a credit. Do not merge a proof whose verdict you doubt.

## What the check does not promise

- **The compile is not sandboxed.** `check.yml` compiles the one file as the job's own account. A Lean
  file can run code while it compiles. The plain-file rule in `outside-guard.mjs` refuses every known
  way to do that (`#eval`, `run_cmd`, `elab`, `macro`, `initialize`, string literals, attributes other
  than `simp`, `IO`, `Lean`, and more), but it is a filter, not a sandbox. A file that got past it could
  forge that job's artifact. Even then it could not read a secret (the job has none), write to the
  repository (the token is read-only), set `opendesk/check` for a head other than its own, or get the
  bytes of a different file accepted (`verdict.yml` checks the sha256 against the file it fetches
  itself). This is why a person still reads and merges every pull request. If you want stronger
  isolation, use pequalnp-proofs' `lake-locked.sh` pattern: build as a separate account with no
  network access and no write access to the checker.
- **The gap list is the desk's.** All four workflows trust `OPENDESK_GAPS_URL` to say which gap a file
  is for and which statement it must prove. Anyone who controls that address can change what is being
  checked.
- **Names.** The guard reads a gap's constant as a Lean identifier: each part starts with a Unicode
  letter or `_` (Greek letters included: `μ_half_eq_uniform`, `HasGδSingletons`, `Δ_elkies28`). The rest
  of the part is Unicode letters, digits, `_`, `'`, `!`, `?` and sub- or superscripts (`moment_isEquiv₁`,
  `lt₂_example_1`). A part can also be a guillemet part (`Arxiv.«1609.08688»`). `λ`, `Π` and `Σ` are Lean
  tokens and are refused. So are spaces, quotes, `$`, `;`, backslashes and every other character. A
  name that passes is inert in a shell, and the workflows pass it only as a quoted argument or a file.
  In a proof file, outside the import lines, the only guillemets allowed are a numeric name part such
  as `open Arxiv.«1207.5099»` or `Kourovka.«1.35c».x`: letters, digits, `_` and `.`, with at least one
  digit. Its contents are searched like any other text. `tools/check-lean.mjs` has its own, ASCII-only
  name pattern. Until it is widened the same way, the 20 rows with non-ASCII constants pass the guard
  but get `FAULT` from the checker ("the gap constant is not a plain dotted Lean name").
