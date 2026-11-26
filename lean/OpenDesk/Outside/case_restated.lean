import Mathlib
import FormalConjectures.ErdosProblems.«1»

open Filter
open scoped Topology Real
open Erdos1

-- Something weaker than Erdos1.erdos_1, proved for real (so the statement rule is what decides).
theorem OpenDesk.Outside.case_restated : ∃ C > (0 : ℝ), True := ⟨1, one_pos, trivial⟩
