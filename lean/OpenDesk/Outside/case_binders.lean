import Mathlib
import FormalConjectures.ErdosProblems.«170»

-- Gap Erdos170.trivial_ruler_is_perfect, stated in formal-conjectures as
-- `lemma trivial_ruler_is_perfect (N : ℕ) : TrivialRuler N ∈ PerfectRulersLengthN N`
-- (binder before the colon); here the binder is after the colon. Proof copied.
theorem OpenDesk.Outside.case_binders :
    ∀ (N : ℕ), Erdos170.TrivialRuler N ∈ Erdos170.PerfectRulersLengthN N := by
  intro N
  open Erdos170 in
  simp only [PerfectRulersLengthN, Finset.mem_filter, Finset.mem_powerset, Finset.range_subset]
  exact ⟨by simp, fun k hk => ⟨0, by simp, k, hk, rfl⟩⟩
