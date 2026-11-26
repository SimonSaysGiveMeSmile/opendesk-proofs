import Mathlib
import FormalConjectures.ErdosProblems.«1»

open Filter
open scoped Topology Real
open Erdos1

theorem OpenDesk.Outside.case_sorry : ¬ ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ)
    (_ : Erdos1.IsSumDistinctSet A N), N ≠ 0 → C * 2 ^ A.card < N := by sorry
