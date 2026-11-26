<!-- One pull request proves (or refutes) ONE gap the desk assigned. It adds exactly one file and changes nothing else. -->

**Gap id** (from the desk, for example `erdos_1`):

**The formal-conjectures theorem** (the desk's `constant`, for example `Erdos1.erdos_1`):

**Checklist**
- [ ] This pull request adds exactly one file, `lean/OpenDesk/Outside/<gap id>.lean`, and edits no other file.
- [ ] The theorem's type is the type of the formal-conjectures theorem (its negation for a `refute` gap), unchanged.
- [ ] No `sorry`, no new `axiom`, no `native_decide`, and the proof does not cite the formal-conjectures theorem itself.
- [ ] `tools/desk.sh check <gap id>` accepted it locally.

The description of a pull request is not read by the checker. Only the one file is judged.
