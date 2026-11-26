import Mathlib
import FormalConjectures.ErdosProblems.«1»

open Filter
open scoped Topology Real
open Erdos1

theorem OpenDesk.Outside.case_cite_weaker : ∃ C > (0 : ℝ), ∀ (N : ℕ) (A : Finset ℕ)
    (_ : IsSumDistinctSet A N), N ≠ 0 → C * 2 ^ A.card / A.card < N := Erdos1.erdos_1.variants.weaker
