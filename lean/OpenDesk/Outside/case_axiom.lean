import Mathlib
import FormalConjectures.ErdosProblems.«1»

open Filter
open scoped Topology Real
open Erdos1

namespace OpenDesk.Outside.case_axiom
axiom a : False
end OpenDesk.Outside.case_axiom

theorem OpenDesk.Outside.case_axiom : ¬ ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ)
    (_ : Erdos1.IsSumDistinctSet A N), N ≠ 0 → C * 2 ^ A.card < N := OpenDesk.Outside.case_axiom.a.elim
