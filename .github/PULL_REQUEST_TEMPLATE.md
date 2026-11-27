<!-- One pull request carries ONE job the desk assigned. It adds exactly one file and changes nothing else.
     tools/desk.sh submit <gap id> opens the pull request and fills this in for you; fill it by hand only
     if you open the pull request yourself. -->

**Gap id** (from the desk, for example `erdos1_erdos_1`):

**Kind** (`check`, `state` or `compute`):

**The one file** (by kind):
- `check`: `lean/OpenDesk/Outside/<gap id>.lean`, a proof of the desk's `constant` (for example `Erdos1.erdos_1`)
- `state`: `statements/<gap id>.lean`, the exact statement as `theorem OpenDesk.Statements.<gap id>`
- `compute`: `witnesses/<gap id>.json`, with `gap`, `claim`, `witness` and `method` (the command that re-checks the witness)

**Checklist**
- [ ] This pull request adds exactly that one file and edits no other file.
- [ ] `check`: the theorem's type is the type of the formal-conjectures theorem, unchanged; no `sorry`, no new `axiom`, no `native_decide`, and the proof does not cite the formal-conjectures theorem itself.
- [ ] `state`: it imports only Mathlib (and `FormalConjecturesUtil`), states the problem the source states, and its proof may stay `sorry`.
- [ ] `compute`: `method` says how to re-check the witness.
- [ ] `tools/desk.sh check <gap id>` passed locally.

The description of a pull request is not read by the checker. Only the one file is judged.
