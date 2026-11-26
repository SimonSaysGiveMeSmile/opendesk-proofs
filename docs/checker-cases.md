# Checker cases

The cases the checker (`tools/check-lean.mjs` and `lean/CheckLemma.lean`) must decide as written.
All of them were run on 2026-11-25 (Lean v4.33.1, formal-conjectures 9097e2f, Mathlib from its
prebuilt cache, nothing compiled from source but the case files and the formal-conjectures modules
they import; `LEAN_NUM_THREADS=4`, `nice -n 10`, one case at a time). Every actual verdict below
is the class the case expects. No checker bug was found, and neither `tools/check-lean.mjs` nor
`lean/CheckLemma.lean` was changed for this run. Two cases were corrected (4 and 14, see there),
and case 6c's expected text was out of date for this Lean version. Full logs:
`opendesk/.cache/checker-run/` (`r1-*` first round, `r2-14-*` the corrected case 14).

Each case is one file `lean/OpenDesk/Outside/<id>.lean`, run as

    node tools/check-lean.mjs lean/OpenDesk/Outside/<id>.lean <constant> '<module>' <kind>

All cases use the gap `Erdos1.erdos_1` in `FormalConjectures.ErdosProblems.«1»` unless they say
otherwise. Its type is

    ¬ ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ) (_ : IsSumDistinctSet A N), N ≠ 0 → C * 2 ^ A.card < N

The checker refuses for a sorry or a bad axiom before it compares statements. So a case that must
be refused on its STATEMENT needs a real, axiom-clean proof. Where `Erdos1.erdos_1` has none here
(it is a research disproof), the case uses the proved gap `Erdos1.erdos_1.variants.weaker`.

Wall times are for the whole checker run of the case (lock, verifier build check, file build,
verifier). The first run of a module that has not been built yet is the slow one.

## Must be refused

### 1. Citing the original theorem (sorry by citation)

The formal-conjectures theorem is itself proved by `sorry`. A proof that cites it rests on
`sorryAx`, and the axiom walk goes through pinned theorems, so it is refused.

    import Mathlib
    import FormalConjectures.ErdosProblems.«1»

    open Erdos1

    theorem OpenDesk.Outside.case_cite : ¬ ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ)
        (_ : IsSumDistinctSet A N), N ≠ 0 → C * 2 ^ A.card < N :=
      Erdos1.erdos_1

Kind `check`. Expected: `REJECTED (sorry): OpenDesk.Outside.case_cite rests on sorry ...`.

(The guard does not refuse this file: the word `sorry` is not in it. The checker must.)

Actual (`case_cite.lean`): `REJECTED (sorry): OpenDesk.Outside.case_cite rests on sorry (read from the compiled proof and from every pinned theorem it cites; ...)`, exit 1. Wall time 181.3 s.

### 2. Citing a sorry-proved variant through a helper

    namespace OpenDesk.Outside.case_cite2
    theorem h : ¬ ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ)
        (_ : Erdos1.IsSumDistinctSet A N), N ≠ 0 → C * 2 ^ A.card < N := Erdos1.erdos_1
    end OpenDesk.Outside.case_cite2

    theorem OpenDesk.Outside.case_cite2 : <the type> := OpenDesk.Outside.case_cite2.h

Expected: `REJECTED (sorry)`.

Actual (`case_cite2.lean`): `REJECTED (sorry): OpenDesk.Outside.case_cite2 rests on sorry ...`, exit 1. Wall time 270.5 s.

### 3. A restated statement

The theorem proves something weaker, for example `∃ C > (0 : ℝ), True`, or the same statement
with `≤` for `<`. Expected: `REJECTED (statement): ... does not state Erdos1.erdos_1 ...`.

Run as two files, both with real proofs. (The `≤` form has no proof here, and with `sorry` it
would be refused as `sorry` first.)

- 3a `case_restated.lean`, `∃ C > (0 : ℝ), True := ⟨1, one_pos, trivial⟩`. Actual:
  `REJECTED (statement): OpenDesk.Outside.case_restated does not state Erdos1.erdos_1: its type is neither syntactically equal to it nor equal at reducible transparency. ...`, exit 1. Wall time 69.8 s.
- 3b `case_restated2.lean`, the proved variant `erdos_1.variants.weaker` (a different statement,
  proof copied from formal-conjectures) sent in against `Erdos1.erdos_1`. Actual:
  `REJECTED (statement): OpenDesk.Outside.case_restated2 does not state Erdos1.erdos_1 ...`, exit 1. Wall time 57.4 s.

### 4. A statement through the file's own definition

    namespace OpenDesk.Outside.case_own
    def S (A : Finset ℕ) (N : ℕ) : Prop := Erdos1.IsSumDistinctSet A N
    end OpenDesk.Outside.case_own

    theorem OpenDesk.Outside.case_own : ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ)
        (_ : OpenDesk.Outside.case_own.S A N), N ≠ 0 → C * 2 ^ A.card / A.card < N := by
      <the proof of erdos_1.variants.weaker from formal-conjectures, copied>

Expected: `REJECTED (statement): the type of ... mentions OpenDesk.Outside.case_own.S, which is
not a constant of the pinned packages ...` (even though it would unfold to the right type).

Corrected case: the case used to state `Erdos1.erdos_1` through `S` with `by ...`. That statement
has no proof here, and a `sorry` proof is refused as `sorry` before the statement rule is reached.
So the case now uses gap `Erdos1.erdos_1.variants.weaker` with its real proof.

Actual (`case_own.lean`, gap `Erdos1.erdos_1.variants.weaker`): `REJECTED (statement): the type of OpenDesk.Outside.case_own mentions OpenDesk.Outside.case_own.S, which is not a constant of the pinned packages; state the gap with the pinned definitions only`, exit 1. Wall time 58.7 s.

### 5. Wrong kind

A proof of the statement run with kind `refute` (or of its negation with `check`). Expected:
`REJECTED (statement)`.

Run: `case_kind.lean`, a real proof of `Erdos1.erdos_1.variants.weaker`, kind `refute`. (The other
half, a proof of a negation run with `check`, was not run: no gap used here has a provable
negation.) Actual: `REJECTED (statement): OpenDesk.Outside.case_kind does not state the negation of Erdos1.erdos_1.variants.weaker ...`, exit 1. Wall time 53.9 s.

### 6. sorry, an axiom, native_decide

- `:= by sorry`: `REJECTED (sorry)`.
- `axiom a : False` in the helper namespace, cited: `REJECTED (axiom)` (and the guard refuses the
  word `axiom` first).
- `by native_decide` on a decidable helper: `REJECTED (axiom)` (the guard refuses `native` first).
  The axiom it names is not `Lean.ofReduceBool`: Lean v4.33.1 writes an auxiliary axiom
  for each use, `<decl>._native.native_decide.ax_<n>`, in the proof module, and the walk finds
  that axiom.

Actual:

- 6a `case_sorry.lean`: `REJECTED (sorry): OpenDesk.Outside.case_sorry rests on sorry ...`, exit 1. Wall time 70.9 s.
- 6b `case_axiom.lean` (`axiom a : False`, then `:= OpenDesk.Outside.case_axiom.a.elim`): `REJECTED (axiom): OpenDesk.Outside.case_axiom rests on axioms outside the allowlist: [OpenDesk.Outside.case_axiom.a]`, exit 1. Wall time 69.7 s.
- 6c `case_native.lean` (`(12345 : ℕ) * 6789 = 83810205 := by native_decide`; the axiom walk comes before the statement rule): `REJECTED (axiom): OpenDesk.Outside.case_native rests on axioms outside the allowlist: [OpenDesk.Outside.case_native._native.native_decide.ax_1_1]`, exit 1. Wall time 88.6 s.

### 7. A gap that rests on sorry (gap-excluded)

Gap `Erdos170.erdos170` in `FormalConjectures.ErdosProblems.«170»`: its type mentions
`erdos170.answer`, defined `:= sorry`. Any file, kind `check`. Expected:
`REJECTED (gap-excluded): the statement of Erdos170.erdos170 itself rests on sorry ...`, before
the file's proof is read. The same holds for any statement that contains `answer(sorry)`.

Actual (`case_gap170.lean`, `import FormalConjectures.ErdosProblems.«170»`, `theorem ... : True := trivial`): `REJECTED (gap-excluded): the statement of Erdos170.erdos170 itself rests on sorry (an answer(sorry), or a placeholder definition written := sorry). ...`, exit 1. Wall time 77.4 s.
(The file imports the gap's module. A file that does not import it was not tried. In that case the
checker does not build the gap's module, so the verdict depends on whether it is already built.)

### 8. Imports

- `import FormalConjecturesUtil`: `REJECTED (imports)` (the guard refuses it first).
- `import FormalConjectures.ErdosProblems.«2»` for the gap of problem 1: `REJECTED (imports)`.

Actual:

- 8a `case_import_util.lean`: `REJECTED (imports): OpenDesk.Outside.case_import_util imports FormalConjecturesUtil; a proof file may import only Mathlib, modules of Mathlib, and the gap's module FormalConjectures.ErdosProblems.«1»`, exit 1. Wall time 67.4 s.
- 8b `case_import2.lean` (imports «1» and «2»): `REJECTED (imports): OpenDesk.Outside.case_import2 imports FormalConjectures.ErdosProblems.«2»; ...`, exit 1. Wall time 94.9 s.

### 9. The wrong theorem name, or the wrong place

- `theorem OpenDesk.Outside.other ...` in `case_name.lean`: `REJECTED (no-theorem)`.
- A file outside `lean/OpenDesk/Outside/`: `REJECTED (not-an-outside-module)`.

Actual:

- 9a `case_name.lean` (a real proof of the weaker variant, named `OpenDesk.Outside.other`, gap `Erdos1.erdos_1.variants.weaker`): `REJECTED (no-theorem): the file declares no theorem named OpenDesk.Outside.case_name ...`, exit 1. Wall time 105.9 s.
- 9b `lean/OpenDesk/case_outside.lean`: `REJECTED (not-an-outside-module): lean/OpenDesk/case_outside.lean is not lean/OpenDesk/Outside/<gap id>.lean ...`, exit 1, before any build. Wall time 0.7 s.

### 10. The constant from another module

Constant `Erdos1.erdos_1` with module `FormalConjectures.ErdosProblems.«2»`: `REJECTED (gap)`.

Actual (`case_module.lean`, imports «1» and «2», `True := trivial`): `REJECTED (gap): FormalConjectures.ErdosProblems.«2» declares no constant Erdos1.erdos_1`, exit 1. Wall time 90.7 s.

## Must be accepted

### 11. A complete proof of a solved variant, syntactically equal

Gap `Erdos1.erdos_1.variants.weaker` (proved in formal-conjectures; the case reproves it):

    import Mathlib
    import FormalConjectures.ErdosProblems.«1»

    open Erdos1

    theorem OpenDesk.Outside.case_weaker : ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ)
        (_ : IsSumDistinctSet A N), N ≠ 0 → C * 2 ^ A.card / A.card < N := by
      <the proof from formal-conjectures, copied>

Expected: `ACCEPTED (check): ... (exact); axioms [propext, Classical.choice, Quot.sound] ...`.

Actual (`case_weaker.lean`, proof copied from the pinned `FormalConjectures/ErdosProblems/1.lean`): `ACCEPTED (check): OpenDesk.Outside.case_weaker proves Erdos1.erdos_1.variants.weaker of FormalConjectures.ErdosProblems.«1» (exact); axioms [propext, Classical.choice, Quot.sound]; kernel re-checked 2 constants of OpenDesk.Outside.case_weaker`, exit 0. Wall time 35.4 s.

### 12. Citing a formal-conjectures theorem whose proof is complete

The same gap, proved as `:= Erdos1.erdos_1.variants.weaker`. Expected: `ACCEPTED (check) ...
(exact)`. (Citing is refused only when what is cited rests on sorry.)

Actual (`case_cite_weaker.lean`): `ACCEPTED (check): OpenDesk.Outside.case_cite_weaker proves Erdos1.erdos_1.variants.weaker of FormalConjectures.ErdosProblems.«1» (exact); axioms [propext, Classical.choice, Quot.sound]; kernel re-checked 1 constants of OpenDesk.Outside.case_cite_weaker`, exit 0. Wall time 35.4 s.

### 13. Binders before the colon

A theorem written `theorem M (n : ℕ) (h : ...) : P n` for a statement `∀ n, ... → P n`: the same
term, so `(exact)`.

Run the other way round, with a gap that has a proof: gap `Erdos170.trivial_ruler_is_perfect` in
`FormalConjectures.ErdosProblems.«170»`. It is declared with its binder BEFORE the colon
(`(N : ℕ) : TrivialRuler N ∈ PerfectRulersLengthN N`), and the case states it with the binder
after the colon (`∀ (N : ℕ), ...`), proof copied. Actual (`case_binders.lean`):
`ACCEPTED (check): OpenDesk.Outside.case_binders proves Erdos170.trivial_ruler_is_perfect of FormalConjectures.ErdosProblems.«170» (exact); axioms [propext, Quot.sound, Classical.choice]; kernel re-checked 4 constants of OpenDesk.Outside.case_binders`, exit 0. Wall time 39.5 s.

### 14. An abbrev unfolded

`IsSumDistinctSet` is an `abbrev`. A statement that writes its body out instead
(`A ⊆ Finset.Icc 1 N ∧ ...`) is not syntactically equal but is equal at reducible transparency.
Expected: `ACCEPTED (check) ... (reducible-defeq)`.

Corrected case. The first file copied the abbrev body word for word,
`(fun (⟨S, _⟩ : A.powerset) => S.sum id).Injective`. A pattern lambda makes Lean write a matcher
of the FILE's own (`OpenDesk.Outside.case_abbrev.match_1`) into the statement, so the checker
refused it, and was right to: `REJECTED (statement): the type of OpenDesk.Outside.case_abbrev
mentions OpenDesk.Outside.case_abbrev.match_1, which is not a constant of the pinned packages ...`
(exit 1, 71.8 s). A statement may name only pinned constants. The rule was not loosened. The case
now writes the body with a projection, `(fun (S : A.powerset) => S.1.sum id).Injective`, and names
only pinned constants. (Any statement that uses `match` or a pattern lambda is refused the same
way. Authors must state the gap through the pinned definitions or with projections.)

Actual (`case_abbrev.lean`, corrected, proof of the weaker variant copied, gap
`Erdos1.erdos_1.variants.weaker`): `ACCEPTED (check): OpenDesk.Outside.case_abbrev proves Erdos1.erdos_1.variants.weaker of FormalConjectures.ErdosProblems.«1» (reducible-defeq); axioms [propext, Classical.choice, Quot.sound]; kernel re-checked 2 constants of OpenDesk.Outside.case_abbrev`, exit 0. Wall time 157.9 s.
