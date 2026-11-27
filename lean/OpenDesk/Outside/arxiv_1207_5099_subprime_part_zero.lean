import Mathlib
import FormalConjectures.Arxiv.«1207.5099».SubprimeFibonacci

open Arxiv
open Arxiv.«1207.5099»

theorem OpenDesk.Outside.arxiv_1207_5099_subprime_part_zero : subprimePart 0 = 0 := by
  norm_num [subprimePart]
