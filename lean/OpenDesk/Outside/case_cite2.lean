import Mathlib
import FormalConjectures.ErdosProblems.«1»

open Filter
open scoped Topology Real
open Erdos1

namespace OpenDesk.Outside.case_cite2
theorem h : ¬ ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ)
    (_ : Erdos1.IsSumDistinctSet A N), N ≠ 0 → C * 2 ^ A.card < N := Erdos1.erdos_1
end OpenDesk.Outside.case_cite2

theorem OpenDesk.Outside.case_cite2 : ¬ ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ)
    (_ : Erdos1.IsSumDistinctSet A N), N ≠ 0 → C * 2 ^ A.card < N := OpenDesk.Outside.case_cite2.h
