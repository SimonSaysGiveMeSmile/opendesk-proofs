/-
The verifier half of the checker. Run by tools/check-lean.mjs, after the proof file has been
built, as:

  lake exe checklemma <module> <gap file> <check|refute>

The gap file holds two lines: the fully qualified name of the formal-conjectures theorem and the
module that declares it, each written as its parts joined by `/` (a part may hold a dot): for
example `Erdos1/erdos_1` and `FormalConjectures/ErdosProblems/1` (Lean writes the module
`FormalConjectures.ErdosProblems.«1»`), or `FormalConjectures/Arxiv/2104.00502/BarkerSequence`.
The gap's module may be any module below `FormalConjectures`, in every collection.

It never trusts what the proof file printed or how it was elaborated. It reads the compiled
result and decides these things:

1. GAP. The statement environment is the whole pinned Mathlib and the gap's module, read from
   the pinned formal-conjectures package, and nothing of this project. The gap's constant is
   declared in exactly that module, and its type is a proposition. The type itself rests on no
   `sorry` and no axiom outside the allowlist: a statement with `answer(sorry)`, or with a
   placeholder definition such as `def erdos170.answer : ℝ := sorry`, cannot be proved as stated,
   and is refused here as `gap-excluded` (the desk does not post such problems).
2. IMPORTS. The proof module imports only `Init`, `Mathlib`, modules of Mathlib, and the gap's
   module, and rests on no other project module and on no module outside the statement
   environment.
3. KERNEL. Every constant of the proof module is sent to the kernel again, on top of the
   statement environment. A declaration that carries a name the statement environment already
   uses is refused (but for a second copy of one of its theorems, same statement, which is left
   out: see `sameTheorem`).
4. THEOREM. The module declares a theorem whose name is the module's name.
5. AXIOMS. The theorem's transitive axioms, walked over the re-checked constants and the pinned
   constants (not read from any cache the file could write), are inside the allowlist. `sorry`
   is the axiom `sorryAx`, so a `sorry` anywhere under the theorem is caught here. The walk goes
   through pinned theorems too: the formal-conjectures theorem itself is proved by `sorry`, so a
   proof that only cites it (`:= Erdos1.erdos_1`) rests on `sorryAx` and is refused (`sorry`).
   `native_decide` rests on `Lean.ofReduceBool`, which is outside the allowlist.
6. STATEMENT. The theorem's type speaks only of constants of the statement environment, and it
   is the type of the ORIGINAL constant (its negation for `refute`), with the universe
   parameters put in by position: syntactically equal (`exact`), or else definitionally equal
   at reducible transparency only (`reducible-defeq`). The submitter never writes the statement
   the checker compares against: it is read from the pinned package. The kernel then checks
   that the theorem is a proof of the original type (of its negation), in an environment that
   extends the statement environment.

On acceptance it also prints `MODULES` (the proof module) and `MATCH` (exact or
reducible-defeq), which the wrapper records.

Exit 0: accepted. Exit 1: rejected, with one REJECTED line naming the class. Exit 3: the
verifier itself could not run.

Adapted from open-goat/pequalnp-proofs (Apache-2.0), lean/CheckLemma.lean. Written against the
Lean core API of v4.33.1 (src/Lean/Environment.lean, src/Lean/Replay.lean at that tag).
-/
import Lean
open Lean

namespace OpenDeskChecker

def allowedAxioms : List Name := [``propext, ``Classical.choice, ``Quot.sound]

/-- Roots of the libraries this project owns (lean/lakefile.toml). Everything else is pinned. -/
def projectRoots : List Name := [`OpenDesk]

def isProject (m : Name) : Bool := projectRoots.contains m.getRoot

/-- Every proof module is `OpenDesk.Outside.<gap id>`. -/
def outsideRoot : Name := `OpenDesk.Outside

/-- The pinned library a proof may import, always the whole of it in the statement environment. -/
def statementLibrary : Name := `Mathlib

/-- Every gap's module is below this root (any collection: ErdosProblems, OEIS, Wikipedia, ...).
`FormalConjecturesUtil` and `FormalConjecturesForMathlib` are other roots, never a gap's module. -/
def board : Name := `FormalConjectures

/-- No project module may declare a constant under this namespace: it is the checker's own. -/
def reserved : Name := `OpenDeskChecker

/-- One part of a dotted name, as the wrapper sends it: letters, digits, `_` and `'`. -/
def plainPart (p : String) : Bool :=
  !p.isEmpty && p.all fun c => c.isAlphanum || c == '_' || c == '\''

/-- A dotted name, every part a string component (the proof module `OpenDesk.Outside.<gap id>`). -/
def parseName (s : String) : Option Name :=
  let parts := s.splitOn "."
  if parts.all plainPart then some (parts.foldl Name.mkStr .anonymous) else none

/-- A name of the gap file: its parts joined by `/`, every part a string component of letters,
digits, `_`, `'` and `.` that does not start with a dot (`2104.00502` is one part). -/
def parseParts (s : String) : Option Name :=
  let parts := s.splitOn "/"
  let ok (p : String) := !p.isEmpty && !p.startsWith "." &&
    p.all fun c => c.isAlphanum || c == '_' || c == '\'' || c == '.'
  if parts.all ok then some (parts.foldl Name.mkStr .anonymous) else none

structure Walk where
  seen : NameSet := {}
  axioms : Array Name := #[]
  missing : Array Name := #[]

partial def walk (find : Name → Option ConstantInfo) (n : Name) : StateM Walk Unit := do
  if (← get).seen.contains n then return
  modify fun s => { s with seen := s.seen.insert n }
  match find n with
  | none => modify fun s => { s with missing := s.missing.push n }
  | some ci =>
    if ci matches .axiomInfo _ then modify fun s => { s with axioms := s.axioms.push n }
    for c in ci.getUsedConstantsAsSet do walk find c

/-- Progress on stderr, with the milliseconds since the start (the wrapper shows stderr). -/
def stage (what : String) : IO Unit := do
  IO.eprintln s!"verifier stage: {what} t={(← IO.monoMsNow)}ms"

def reject (cls msg : String) : IO UInt32 := do
  -- One line, always the last one printed: readers show the tail of the output.
  IO.println s!"REJECTED ({cls}): {msg.replace "\n" " "}"
  return 1

/-- A project constant `c` that carries the name of a constant `l` of the statement environment
is refused, with one exception: both are theorems, with the same universe parameters and the
same type. Lean writes some theorems on demand (equation lemmas `f.eq_1`, `f.eq_def`, ...) in
whichever module first needs them. Such a `c` is LEFT OUT: it never reaches the kernel, and the
name keeps meaning `l`, the pinned theorem with its pinned proof. (As in pequalnp-proofs.) -/
def sameTheorem (c l : ConstantInfo) : Bool :=
  match c, l with
  | .thmInfo c, .thmInfo l => c.levelParams == l.levelParams && c.type == l.type
  | _, _ => false

def runMetaIn {α : Type} (env : Environment) (x : MetaM α) : IO α := do
  let ctx : Core.Context := { fileName := "<statement>", fileMap := default }
  let (a, _) ← (x.run' {} {}).toIO ctx { env }
  return a

/-- Are `a` and `b` the same proposition at REDUCIBLE transparency (only `@[reducible]`
definitions and `abbrev`s unfold)? Under a small heartbeat budget. An error, an exhausted budget,
a stuck problem: no. The kernel check after it is the one that decides; this only keeps the
door narrow, so a restatement that needs real unfolding is refused even when it is true. -/
def reducibleDefEq (env : Environment) (a b : Expr) : IO Bool := do
  let r ← (runMetaIn env do
      let now ← IO.getNumHeartbeats
      withTheReader Core.Context (fun c => { c with maxHeartbeats := 20000 * 1000, initHeartbeats := now }) do
        Meta.withTransparency .reducible (Meta.isDefEq a b)).toBaseIO
  match r with
  | .ok b => return b
  | .error _ => return false

/-- Is `t` a proposition of `env`? An error: no. -/
def isPropIn (env : Environment) (t : Expr) : IO Bool := do
  let r ← (runMetaIn env do
      let ty ← Meta.whnf (← Meta.inferType t)
      return ty.isProp).toBaseIO
  match r with
  | .ok b => return b
  | .error _ => return false

unsafe def run (modStr gapPath kind : String) : IO UInt32 := do
  unless kind == "check" || kind == "refute" do
    IO.eprintln s!"kind must be check or refute, got {kind}"; return 3
  let some mod := parseName modStr
    | IO.eprintln s!"not a plain module name: {modStr}"; return 3
  unless mod.getPrefix == outsideRoot do
    return ← reject "not-an-outside-module" s!"{mod} is not a module OpenDesk.Outside.<gap id>"
  let gapText ← IO.FS.readFile gapPath
  let lines := (gapText.splitOn "\n").filter fun l => !l.isEmpty
  let [constStr, gapModStr] := lines
    | IO.eprintln "the gap file must hold two lines: the constant and its module"; return 3
  let some orig := parseParts constStr
    | IO.eprintln s!"not a plain constant name: {constStr}"; return 3
  let some gapMod := parseParts gapModStr
    | IO.eprintln s!"not a plain module name: {gapModStr}"; return 3
  unless gapMod.getRoot == board && gapMod != board do
    IO.eprintln s!"the gap's module {gapMod} is not under {board}"; return 3
  initSearchPath (← findSysroot)

  -- The statement environment: the whole pinned Mathlib and the gap's module from the pinned
  -- formal-conjectures package, and nothing of this project. The kernel environment the proof
  -- is checked in is built ON it, so a name means one thing for the statement and the proof.
  -- Extensions are loaded so that reducibility attributes are known to `reducibleDefEq`.
  stage "importing the statement environment"
  enableInitializersExecution
  let stmtEnv ← importModules #[{ module := statementLibrary }, { module := gapMod }] {}
    (trustLevel := 0) (loadExts := true)
  let stmtModules := stmtEnv.header.moduleNames
  let stmtSet : Std.HashSet Name := stmtModules.foldl (fun s m => s.insert m) {}
  for m in stmtModules do
    if isProject m then
      return ← reject "statement-env" s!"the statement environment reached the project module {m}; a pinned package may not import this project"

  -- 1. GAP: the original constant, from the pinned package.
  stage "gap"
  let some oc := stmtEnv.find? orig
    | return ← reject "gap" s!"{gapMod} declares no constant {orig}"
  match stmtEnv.getModuleIdxFor? orig with
  | some idx =>
    let home := stmtModules[idx.toNat]!
    unless home == gapMod do
      return ← reject "gap" s!"{orig} is declared in {home}, not in the gap's module {gapMod}"
  | none => return ← reject "gap" s!"{orig} is not declared by a pinned module"
  unless (← isPropIn stmtEnv oc.type) do
    return ← reject "gap" s!"the type of {orig} is not a proposition"
  let mut gw : Walk := {}
  for c in oc.type.getUsedConstantsAsSet do
    gw := ((walk (fun n => stmtEnv.find? n) c).run gw).2
  if gw.axioms.contains ``sorryAx then
    return ← reject "gap-excluded" s!"the statement of {orig} itself rests on sorry (an answer(sorry), or a placeholder definition written := sorry). It cannot be proved or refuted as stated, so it is not a gap of this desk"
  let gapExtra := gw.axioms.filter (!allowedAxioms.contains ·)
  unless gapExtra.isEmpty do
    return ← reject "gap-excluded" s!"the statement of {orig} rests on axioms outside the allowlist: {gapExtra.toList}"
  unless gw.missing.isEmpty do
    return ← reject "gap-excluded" s!"the statement of {orig} rests on constants the pinned environment does not hold: {gw.missing.toList}"

  -- 2. IMPORTS, and the constants of the proof module. The proof module's own compiled data is
  -- read alone (not imported a second time with all of Mathlib under it): its direct imports
  -- must be modules of the statement environment, which is closed under imports, so everything
  -- the proof module rests on is in the statement environment. A proof file is a plain Lean file;
  -- a `module` file (whose bodies live in other parts) is refused.
  stage "proof module"
  let oleanPath ← findOLean mod
  unless (← oleanPath.pathExists) do
    return ← reject "not-an-outside-module" s!"{mod} has no compiled file"
  let (d, _) ← readModuleData oleanPath
  if d.isModule then
    return ← reject "imports" s!"{mod} is a `module` file; a proof file is a plain Lean file"
  let libEnv := stmtEnv.toKernelEnv
  let mut consts : Std.HashMap Name ConstantInfo := {}
  for imp in d.imports do
    let ok := imp.module == `Init || statementLibrary.isPrefixOf imp.module || imp.module == gapMod
    unless ok do
      return ← reject "imports" s!"{mod} imports {imp.module}; a proof file may import only Mathlib, modules of Mathlib, and the gap's module {gapMod}"
    if isProject imp.module then
      return ← reject "imports" s!"{mod} rests on the project module {imp.module}; a proof file stands alone"
    unless stmtSet.contains imp.module do
      return ← reject "imports" s!"{mod} imports {imp.module}, which is outside the statement environment (Mathlib and {gapMod})"
  for c in d.constants do
    if reserved.isPrefixOf c.name then
      return ← reject "reserved-name" s!"{mod} declares {c.name}; names under {reserved} belong to the checker"
    if let some l := libEnv.find? c.name then
      if sameTheorem c l then continue
      return ← reject "redeclares" s!"{mod} declares {c.name}, a name the pinned packages already declare"
    consts := consts.insert c.name c

  -- 3. KERNEL: every constant of the proof module goes to the kernel again, on top of the
  -- statement environment, where a name that is already declared cannot be declared again.
  -- (v4.33.1: `Lean.Environment.replay (newConstants) (env : Environment) : IO Environment`.)
  stage "kernel replay"
  let replayed ← try
      Lean.Environment.replay consts stmtEnv
    catch e =>
      return ← reject "kernel" s!"the kernel refused a declaration under {mod}: {e}"
  let kenv := replayed.toKernelEnv
  -- What the walks below may rest on: a pinned constant, or a constant of the proof module the
  -- kernel has just accepted (the replay passes over unsafe and partial ones, so they do not count).
  let checked (n : Name) : Option ConstantInfo := do
    let ci ← kenv.find? n
    if consts.contains n && (ci.isUnsafe || ci.isPartial) then none else some ci

  -- 4. THEOREM
  let some ci := checked mod
    | return ← reject "no-theorem" s!"the file declares no theorem named {mod} (one gap, one file: the theorem carries the module's name)"
  let .thmInfo thm := ci
    | return ← reject "no-theorem" s!"{mod} is not a theorem"

  stage "axioms"
  -- 5. AXIOMS, through pinned theorems too: citing the sorry-proved original is caught here.
  let (_, w) := (walk checked mod).run {}
  unless w.missing.isEmpty do
    return ← reject "kernel" s!"{mod} rests on constants the kernel never accepted: {w.missing.toList}"
  if w.axioms.contains ``sorryAx then
    return ← reject "sorry" s!"{mod} rests on sorry (read from the compiled proof and from every pinned theorem it cites; the formal-conjectures statement {orig} is itself proved by sorry, so it cannot be cited)"
  let extra := w.axioms.filter (!allowedAxioms.contains ·)
  unless extra.isEmpty do
    return ← reject "axiom" s!"{mod} rests on axioms outside the allowlist: {extra.toList}"

  stage "statement"
  -- 6. STATEMENT: the type of the original constant, read from the pinned package.
  for c in thm.type.getUsedConstants do
    unless (stmtEnv.find? c).isSome do
      return ← reject "statement" s!"the type of {mod} mentions {c}, which is not a constant of the pinned packages; state the gap with the pinned definitions only"
  unless oc.levelParams.length == thm.levelParams.length do
    return ← reject "statement" s!"universe parameters differ: {orig} has {oc.levelParams}, {mod} has {thm.levelParams}"
  let us := thm.levelParams.map mkLevelParam
  let origTy := oc.type.instantiateLevelParams oc.levelParams us
  let goal := if kind == "refute" then mkApp (mkConst ``Not) origTy else origTy
  let what := if kind == "refute" then s!"the negation of {orig}" else s!"{orig}"
  let mut how := "exact"
  unless thm.type == goal do
    unless (← reducibleDefEq stmtEnv thm.type goal) do
      return ← reject "statement" s!"{mod} does not state {what}: its type is neither syntactically equal to it nor equal at reducible transparency. Expected: {goal}. It proves: {thm.type}"
    how := "reducible-defeq"
  let witness := Declaration.thmDecl {
    name := `OpenDeskChecker.witness, levelParams := thm.levelParams, type := goal, value := mkConst mod us }
  match kenv.addDeclCore 0 0 witness none with
  | .ok _ => pure ()
  | .error ex =>
    let why ← try (ex.toMessageData {}).toString catch _ => pure "(the kernel's message could not be printed)"
    IO.println s!"kernel: {why}"
    return ← reject "statement" s!"{mod} is not a proof of {what}. It proves: {thm.type}"

  IO.println s!"MODULES {mod}"
  IO.println s!"MATCH {how}"
  IO.println s!"ACCEPTED ({kind}): {mod} proves {what} of {gapMod} ({how}); axioms {w.axioms.toList}; kernel re-checked {consts.size} constants of {mod}"
  return 0

end OpenDeskChecker

unsafe def main (args : List String) : IO UInt32 := do
  match args with
  | [mod, gap, kind] =>
    try OpenDeskChecker.run mod gap kind
    catch e => IO.eprintln s!"checker fault: {e}"; return 3
  | _ => IO.eprintln "usage: CheckLemma <module> <gap file> <check|refute>"; return 3
