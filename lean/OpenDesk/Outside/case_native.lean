import Mathlib
import FormalConjectures.ErdosProblems.«1»

-- native_decide on a decidable statement. The axiom walk comes before the statement rule, so
-- the statement need not be the gap's: what must refuse it is Lean.ofReduceBool.
theorem OpenDesk.Outside.case_native : (12345 : ℕ) * 6789 = 83810205 := by native_decide
