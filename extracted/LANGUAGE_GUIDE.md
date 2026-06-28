# The Reksio / BlooMoo Scripting Language — A Practical Guide

> A tutorial for the custom scripting language used by _Przygody Reksia_ (Reksio i Ufo),
> reconstructed from the **ReksioEngine** reimplementation (`src/fileFormats/cnv/*`,
> `src/interpreter/*`) and verified against decrypted game data in `GamesFiles/`.
>
> Everything below is grounded in the actual parser/interpreter source and real,
> decrypted scene files. Two complete extracted scenes accompany this guide:
>
> -   `s31_0_ziemia.decrypted.cnv` — a simple cutscene (good first read)
> -   `s73_0_kod.decrypted.cnv` — a keypad mini-game (variables, events, conditionals)

The engine is internally called **BlooMoo**, and its scripting VM is referred to in
the source as **CMC** (e.g. `CMC_Behaviour`, `CMC_Expression`, `CMC_Condition`). The
language has two layers that are easy to confuse, so we treat them separately:

1. **The CNV object/scene format** — a line-based `KEY=VALUE` declaration format that
   defines the objects in a scene (images, sounds, timers, variables, behaviours…).
2. **The behaviour code language ("CMC code")** — the imperative `;`-separated
   statement language that lives inside `CODE={…}` blocks and event handlers.

---

## Part 0 — Getting the text out: CNV decryption

Scene scripts ship as `.cnv` files. Most are encrypted. An encrypted file starts with a
header like:

```
{<C:6>}
```

Format: `{<` _direction_ `:` _movement_ `>}` where _direction_ ∈ `c C d D` and
_movement_ is an integer. If the header is absent the file is plain text (only `\r\n`→`\n`
normalisation is applied).

The cipher (see `src/fileFormats/cnv/decryptor.ts`) is a Caesar-style byte shift whose
amount **oscillates** as you walk the payload:

-   A running `step` counter cycles `1..movement` (`step = step % movement + 1`).
-   `shift = ceil(step/2)`, negated on odd steps → the shift sequence is
    `-1, +1, -2, +2, -3, +3, …` capped by `movement`.
-   Direction `c/C` adds the shift; `d/D` subtracts it.
-   `\r` and `\n` bytes are skipped (not decrypted, not emitted).
-   The literal 3-byte sequence `<E>` is decoded as a newline (this is the _real_ line
    separator inside the ciphertext).

A faithful ~30-line JavaScript reimplementation is included as `decrypt.js` logic in the
guide's companion notes; the canonical implementation is `decryptCNV()`.

After decryption you get UTF-8 text in the line-based format described next.

---

## Part 1 — The CNV object format

Decrypted text is a flat list of lines. Parsing rules (`src/fileFormats/cnv/parser.ts`):

-   Lines beginning with `#`, or blank lines, are **ignored** (comments).
-   Every other line is split **once** on the first `=` into `KEY=VALUE`.
-   `OBJECT=Name` **declares a new object** named `Name` with `TYPE=unknown` until typed.
-   Any other key has the shape `ObjectName:FIELD` and assigns a field on that object.
-   `ObjectName:FIELD^param` is a **parametrised** field assignment (used for keyed event
    callbacks — see below).

### A minimal object

```
OBJECT=MUSIC
MUSIC:TYPE=MUSIC
MUSIC:FILENAME=LOT3.WAV
```

`TYPE` selects the object class. Each type has a known set of fields with typed
_processors_ (`structureDefinitions` in `src/fileFormats/cnv/types.ts`). A value's text is
coerced according to its field type:

| Field type     | Meaning / coercion                                                           |
| -------------- | ---------------------------------------------------------------------------- |
| `string`       | raw text (`""` → empty string)                                               |
| `number`       | parsed number, NaN→0 with a warning                                          |
| `boolean`      | `TRUE`/`FALSE`/`0`/`1`                                                       |
| `reference`    | name of another object: `{ objectName }`                                     |
| `array(T)`     | comma-separated list of `T`                                                  |
| `callback`     | a behaviour reference **or** an inline `{…}` code block                      |
| `callbacks(K)` | a map of parametrised callbacks keyed by `^param`, plus one non-parametrised |
| `code`         | raw expression text kept verbatim (single-statement)                         |

### Object types you will meet most

(Defined in `types.ts`.)

-   **Display:** `ANIMO` (sprite/animation), `IMAGE`, `TEXT`, `BUTTON`, `SEQUENCE`
-   **Audio:** `SOUND`, `MUSIC`
-   **Variables / data:** `INTEGER`, `STRING`, `BOOL`, `DOUBLE`, `VECTOR`, `ARRAY`,
    `MULTIARRAY`, `STRUCT`
-   **Logic:** `BEHAVIOUR` (the code carrier), `CONDITION`, `COMPLEXCONDITION`,
    `EXPRESSION`, `TIMER`, `GROUP`, `RAND`
-   **Structure / system:** `SCENE`, `EPISODE`, `APPLICATION`, `CLASS`, `MOUSE`,
    `KEYBOARD`, `CNVLOADER`, `CANVAS_OBSERVER`, `SYSTEM`

### Where code lives

Code text shows up in two places:

1. **`BEHAVIOUR.CODE`** — a named, reusable block of statements:

    ```
    OBJECT=THISPLAY
    THISPLAY:TYPE=BEHAVIOUR
    THISPLAY:CODE={THIS^PLAY("PLAY");}
    ```

2. **Event-handler fields** on any object — e.g. `ONINIT`, `ONCLICK`, `ONFINISHED`,
   `ONTICK`, `ONCHANGED`. Their value is a **callback**, which can be:

    - an **inline block**: `ONCLICK={S_KOT63_2_6^PLAY();}`
    - a **behaviour reference**: `ONINIT=THISPLAY` (run behaviour `THISPLAY`)
    - a **behaviour reference with constant args**: `ONCLICKED=B_WPIS(0)`
      (run `B_WPIS`, passing `0`, available inside as `$1`)

    `createCallback()` (`src/fileFormats/common/index.ts`) decides which form: a leading
    `{` → inline code; otherwise `NAME` or `NAME(arg,arg)`.

### Parametrised event callbacks

`^param` keys a callback by a value. This is how the game dispatches on _which_ value
fired the event:

```
VAR_CYFRA:ONCHANGED^2=B_CYFRA_2          # when VAR_CYFRA becomes 2 → run B_CYFRA_2
VAR_CYFRA:ONCHANGED^3=B_CYFRA_3
VAR_CYFRA:ONCHANGED^5={B_CYFRA_4^RUN();VAR_CYFRA^SET(6);}   # inline, keyed by 5
TIMER1:ONTICK^1=REKSIOKOLKO              # on tick #1
V_ETAP:ONBRUTALCHANGED^1=B_PIERWSZE_WEJSCIE
```

A field defined as `callbacks(K)` collects these into
`{ nonParametrized, parametrized: Map<param, callback> }`.

### The `__INIT__` behaviour

A behaviour literally named `__INIT__` is **run automatically when the scene loads**
(`Behaviour.ready()` in `src/engine/types/behaviour.ts`). It is the scene's entry point:

```
OBJECT=__INIT__
__INIT__:TYPE=BEHAVIOUR
__INIT__:CODE={VARLEVEL7^SET("S73_0_KOD");GR_KLAW^ADD("BUT_0","BUT_1",...);V_ETAP^SET(VAR_BRAMA);}
```

(Similarly, a `CONSTRUCTOR` behaviour runs when a `CLASS` instance is created, receiving
the constructor args.)

---

## Part 2 — The behaviour code language (CMC code)

This is the actual programming language. A `CODE={…}` block (braces stripped) or an
inline handler body is a **list of statements separated by `;`**. Whitespace and newlines
are insignificant; `;` is the terminator. `(` / `)` nesting is respected when splitting,
so a `;` inside parentheses does not end the statement (`parseCode` in
`src/interpreter/parser.ts`).

```
{ statement1; statement2; statement3; }
```

Execution is strictly sequential and **asynchronous**: each statement is awaited before
the next runs (`Interpreter.execute`). The value of the block is the value of its last
statement.

### 2.1 The one core construct: the call

Almost every statement is a **method call** on an object:

```
TARGET^METHOD(arg1, arg2, ...)
```

-   `^` separates the **object** from the **method**. (Read `Object^Method` as
    "send Method to Object".)
-   Arguments are comma-separated parameters (depth-aware on parentheses).
-   A trailing `()` may be omitted when there are no args: `THIS^HIDE` ≡ `THIS^HIDE()`.

Real examples:

```
RAKIETA^PLAY("RAKIETA1");        # call PLAY("RAKIETA1") on object RAKIETA
TIMER1^ENABLE();                 # call ENABLE() on TIMER1
KALKULATOR1^SETFRAME("PLAY", $1);
PRZYGODA^GOTO("S35_0_WRAKIECIE");# scene transition via the episode runner
```

### 2.2 Call targets and prefixes

How the _object_ part is resolved (`parseLine` / `_splitObjectMethod`):

| Form        | Meaning                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `NAME^M()`  | Look up object `NAME` in scope, call method `M`.                                                                                 |
| `THIS^M()`  | `THIS` = the object that owns the currently-running behaviour (the caller).                                                      |
| `@M(...)`   | **Global runner**: a built-in control-flow primitive (no object).                                                                |
| `*EXPR^M()` | **Indirect**: evaluate `EXPR` to a _name_, look that object up, then call `M`. (Dereference / "call by computed name".)          |
| `#N^M()`    | **Direct ref**: object identified by a 7-bit id byte `N`. (Rare; `resolveObjectRef` does not fully implement it in the JS port.) |
| `M()`       | No target — a bare value/identifier; not a normal method dispatch.                                                               |

`THIS` matters because the same behaviour is reused by many objects. `THISPLAY` does
`THIS^PLAY("PLAY")`, so whichever ANIMO references it as `ONINIT=THISPLAY` plays _itself_.

### 2.3 Parameters — the value grammar

Each argument is classified by `parseParameter`, in this **priority order**:

1. **`[ … ]` bracket expression** — arithmetic / concatenation (see 2.4).
2. **`CONV…`** — a conversion call (engine-specific; rare).
3. **contains `^` and not a string** — a **nested call** used as a value:
   `KALKULATOR1^GETFRAME()` evaluates and passes its result.
4. **`"…"`** — string literal.
5. **starts with `-` or a digit** — number literal.
6. **contains `|`** — **field access** `object|field` (reads a field of a STRUCT).
7. **`TRUE` / `FALSE`** — boolean literal.
8. **anything else** — an **identifier**.

#### Identifier auto-dereference (important!)

When an identifier names a _value object_ (`INTEGER`, `STRING`, `BOOL`, …), evaluating it
returns that object's **current value**, not its name (`Interpreter.evaluateParameter`,
`Identifier` case). If it isn't a value object, the identifier evaluates to the literal
**name string**.

```
V_ETAP^SET(VAR_BRAMA);   # passes the *value* held in VAR_BRAMA, not the text "VAR_BRAMA"
```

This is why variables can be used bare as arguments and why method names like animation
labels (`"PLAY"`) are written as quoted strings — a bare `PLAY` would be looked up as an
object/identifier.

### 2.4 Expressions: `[ … ]`

Brackets introduce a `CMC_Expression`. It is a **flat, left-to-right** evaluation with
**no operator precedence** (`src/interpreter/ast.ts`, `evaluateExpression`). Operators:

| Symbol | Op  | Meaning                          |
| :----: | --- | -------------------------------- |
|  `+`   | ADD | add, **or string concatenation** |
|  `-`   | SUB | subtract                         |
|  `*`   | MUL | multiply                         |
|  `@`   | DIV | **divide** (not `/`!)            |
|  `%`   | MOD | modulo                           |

Because there is no precedence, `[1+2*3]` is `(1+2)*3 = 9`. **Group with nested
brackets**, e.g. `[1+[2*3]]`.

Numeric/string mixing: if the left side is a number and the right is a string, the string
is coerced to a number (`ForceNumber`). With a string on the left, `+` concatenates:

```
# Build the 4-digit code as a string, then compare it:
VAR_KOD^SET([KALKULATOR1000^GETFRAMENAME() + KALKULATOR100^GETFRAMENAME()]);
VAR_KOD^ADD([KALKULATOR10^GETFRAMENAME() + KALKULATOR1^GETFRAMENAME()]);
```

(See `s73_B_CHECK.ast.json` for the exact parse tree of this line.)

### 2.5 Field access: `object|field`

`obj|field` reads `field` off a `STRUCT` instance (`FieldAccess`,
`Struct.getField`). Distinct from `^` (method call).

### 2.6 Argument substitution: `$1`, `$2`, …

Before a callback's code is parsed, `$n` tokens are textually replaced by the n-th
argument (1-based) passed to the behaviour (`substituteArguments`). Strings substitute
their value; objects substitute their `name`.

```
# Definition:
B_WPIS:CODE={VAR_CYFRA^INC();KALKULATOR1^SHOW();KALKULATOR1^SETFRAME("PLAY",$1);}

# Call site (a digit button):
BUT_5:ONCLICKED=B_WPIS(5)     # inside B_WPIS, $1 → 5
```

---

## Part 3 — Control flow: the `@` globals

There are exactly four global control-flow primitives, dispatched by name
(`Interpreter.createGlobalHandlers`): `@IF`, `@WHILE`, `@LOOP`, `@BREAK`. They are _not_
methods on an object; they take their then/else/body as **behaviour names or inline
blocks**.

### 3.1 `@IF`

Two arities:

**5-argument form** — `@IF(left, op, right, ifTrue, ifFalse)`:

```
@IF("VAR_KOD","!_","2288","BFITMP0","BFITMP1");
```

If the comparison is **true**, run behaviour `ifTrue`; otherwise run `ifFalse`. Either may
be a behaviour name or an inline `{…}`. They are run via `executeConditionalCallback`, so
the target behaviour's own `CONDITION` (if any) is still honoured.

Operands that are strings are themselves parsed and executed as code first, so you can
write expressions there. Comparison operators (the `op` string):

| `op` | meaning          |
| :--: | ---------------- |
| `_`  | equal            |
| `!_` | not equal        |
| `>`  | greater          |
| `<`  | less             |
| `>_` | greater-or-equal |
| `<_` | less-or-equal    |

Worked example (from `s73`): the keypad reads `VAR_KOD`; if it is **not** `"2288"`, run
`BFITMP0` (→ `B_LOST`), else run `BFITMP1` (→ `B_WIN`).

**3-argument form** — `@IF(condExpr, ifTrue, ifFalse)`: here the first argument is a full
**logic expression string** (see 3.5).

### 3.2 `@WHILE`

`@WHILE(left, op, right, body)` — re-evaluates `left op right` each iteration and runs
`body` (behaviour or inline) while true. Same comparison operators as `@IF`'s 5-arg form.

### 3.3 `@LOOP`

`@LOOP(body, start, len, step)` — counts `i` from `start` to `start+len` (exclusive) by
`step`, running `body` each time. The counter is exposed to the body as a special integer
object named **`_I_`**.

### 3.4 `@BREAK`

Aborts the nearest enclosing `@LOOP` / `@WHILE` / behaviour loop (implemented by throwing
`InterruptScriptExecution`, caught by the loop). A "break-one" variant acts like
`continue`.

### 3.5 Logic-expression strings (conditions)

The 3-arg `@IF`, and `CONDITION`/`COMPLEXCONDITION` objects, use a compact condition
syntax parsed by `src/interpreter/expression/index.ts`. **Comparison** operators here are
different from the 5-arg `op` codes — they are punctuation glued to the operands:

| token | meaning                              |
| :---: | ------------------------------------ |
|  `'`  | equal                                |
| `!'`  | not equal                            |
|  `<`  | less                                 |
| `<'`  | less-or-equal                        |
|  `>`  | greater                              |
| `>'`  | greater-or-equal                     |
|  `?`  | "has" — right is a substring of left |

**Logical** combinators: `&&` (and), `||` (or). Note the engine does **not** mix `&&` and
`||` in one expression — it splits on whichever appears first and uses only that.

```
VARSITEMON'"TARGET" || VARSITEMON^FIND("GOTO_") > -1
```

(`VARSITEMON` equals `"TARGET"`, OR `VARSITEMON^FIND("GOTO_")` is greater than `-1`.)

---

## Part 4 — Variables, events, and the runtime model

There is **no `if`/`for` keyword and no assignment operator**. State and control are
expressed through _objects_ and the _methods_ you call on them. The mental model:

-   A scene is a bag of objects. Variables are objects (`INTEGER`, `STRING`, `BOOL`).
-   You mutate a variable by calling a method: `VAR_CYFRA^INC()`, `V_ETAP^SET(2)`,
    `VAR_KOD^ADD("88")`.
-   Mutations **fire events**. `INTEGER.ONCHANGED^2` runs when the value becomes `2`. This
    is the language's main "control flow" — state changes trigger behaviours.
-   UI objects fire input events: `BUTTON.ONCLICKED`, `ANIMO.ONCLICK`/`ONFOCUSON`,
    `MOUSE.ONCLICK`, `KEYBOARD.ONKEYDOWN`.
-   Animations/sounds fire lifecycle events: `ONINIT`, `ONSTARTED`, `ONFINISHED`,
    `ONFRAMECHANGED`, `ONCOLLISION`; timers fire `ONTICK`.
-   `BEHAVIOUR` is the reusable subroutine. Invoke one with `NAME^RUN(args…)`, or
    `NAME^RUNC()` to run only if its `CONDITION` passes, or `NAME^RUNLOOPED(start,len,step)`.

So a typical interaction is an **event → behaviour → method calls → variable change →
more events** cascade. The keypad scene is a clean end-to-end example:

```
button click → B_WPIS($digit)        # show digit, VAR_CYFRA^INC()
VAR_CYFRA becomes 2/3/4 → B_CYFRA_*   # reveal the next calculator wheel
"yes" button → B_CHECK                # assemble VAR_KOD, @IF compare to "2288"
   equal  → BFITMP1 → B_WIN → set VAR_BRAMA, play success, PRZYGODA^GOTO(next scene)
   not eq → BFITMP0 → B_LOST → disable keys, play failure, B_RESET
```

### Common methods seen in the wild

These are object methods (engine builtins), not language keywords:

-   **Display:** `SHOW`, `HIDE`, `PLAY("label")`, `STOP`, `SETFRAME("label", n)`,
    `GETFRAME`, `GETFRAMENAME`, `SETASBUTTON`, `SETPRIORITY`
-   **Variables:** `SET(v)`, `GET`, `INC`, `DEC`, `ADD(v)` (numeric add / string concat),
    `SUB`, `RESETINI`
-   **Sound/music:** `PLAY`, `PAUSE`, `STOP`, `RESUME`
-   **Button/group:** `ENABLE`, `DISABLE`, `DISABLEBUTVISIBLE`, `ADD(names…)` (group
    membership)
-   **Behaviour:** `RUN`, `RUNC`, `RUNLOOPED`
-   **String:** `FIND("sub")`, `LENGTH`, `SUB`, `UPPER`/`LOWER`
-   **Flow / scene:** `PRZYGODA^GOTO("SCENE_NAME")` (episode runner: load another scene)

### Built-in global instances

A few names resolve without being declared in the scene (`createGlobalInstances`):
`RANDOM` (RAND), `SYSTEM`, `CNVLOADER`. `THIS` resolves to the running behaviour's owner.
`PRZYGODA` is the episode/adventure object providing `GOTO` (scene navigation).

---

## Part 5 — A fully annotated mini-scene (`s31_0_ziemia`)

This cutscene needs no conditionals; it is pure event chaining. Annotated highlights:

```
# An animation that plays itself on load and loops on finish:
KSIEZYC:ONINIT=THISPLAY            # THISPLAY = {THIS^PLAY("PLAY");}
KSIEZYC:ONFINISHED=THISPLAY        # → loops forever

# A sound that, when it finishes, triggers the next story beat:
KRE31_0_2:ONINIT=THISPLAYSOUND     # {THIS^PLAY();} → play on load
KRE31_0_2:ONFINISHED=UFOLECI       # UFOLECI = {UFOLE^PLAY("PLAY");}

# A timer, disabled at init, that fires once and plays a sound:
TIMER1:ONINIT=DISABLE              # {TIMER1^DISABLE();}
TIMER1:ONTICK^1=REKSIOKOLKO        # on tick 1 → {REKS31_0_3^PLAY();}

# The chain of "behaviours" is just named one-liners wiring objects together:
RAKIETA1:CODE={RAKIETA^PLAY("RAKIETA1");TIMER1^ENABLE();}
DOS35_0:CODE={PRZYGODA^GOTO("S35_0_WRAKIECIE");}   # advance to next scene
__INIT__:CODE={VARLEVEL3^SET("S31_0_ZIEMIA");}     # record progress on entry
```

Read it as a state machine made of objects: `ONINIT` kicks things off, each
`ONFINISHED`/`ONTICK` hands off to the next behaviour, and eventually `PRZYGODA^GOTO`
moves to the next scene.

---

## Quick reference card

```
CNV format
  #comment / blank             ignored
  OBJECT=Name                  declare object
  Name:FIELD=value             set field
  Name:FIELD^param=value       parametrised (keyed) field / event callback
  Name:TYPE=ANIMO|IMAGE|...    object class

Callbacks (event field values)
  {code;code;}                 inline block
  BEHAVIOURNAME                run that behaviour
  BEHAVIOURNAME(a,b)           run with constant args ($1,$2 inside)

CMC code (inside {...})
  stmt; stmt; stmt;            sequential, awaited, ; terminated
  OBJ^METHOD(args)             method call (^ = send)
  THIS^METHOD()                caller object
  @IF / @WHILE / @LOOP / @BREAK control flow globals (no object)
  *EXPR^METHOD()               indirect: call on computed object name
  $1 $2 ...                    callback argument substitution

Parameters
  "text"                       string
  123  -5                      number
  TRUE / FALSE                 boolean
  NAME                         identifier (value object → its value; else the name)
  obj|field                    STRUCT field read
  OBJ^M()                      nested call as a value
  [ a + b @ c ]                expression: + - * @(div) %(mod), L→R, NO precedence

@IF / @WHILE comparison ops (5-arg form)
  _  !_  >  <  >_  <_           eq ne gt lt ge le

Condition-string ops (3-arg @IF, CONDITION objects)
  '  !'  <  <'  >  >'  ?        eq ne lt le gt ge has(substr)   joined by && / ||

Auto-run behaviours
  __INIT__                     runs on scene load
  CONSTRUCTOR                  runs on CLASS instantiation
```

---

## Source map (where each rule comes from)

| Topic                                           | File                                               |
| ----------------------------------------------- | -------------------------------------------------- |
| Decryption cipher                               | `ReksioEngine/src/fileFormats/cnv/decryptor.ts`    |
| CNV line parser, object/field model             | `ReksioEngine/src/fileFormats/cnv/parser.ts`       |
| Object types & field schemas                    | `ReksioEngine/src/fileFormats/cnv/types.ts`        |
| Field-type processors, `createCallback`         | `ReksioEngine/src/fileFormats/common/index.ts`     |
| Statement/parameter/expression parser           | `ReksioEngine/src/interpreter/parser.ts`           |
| AST node definitions, operator table            | `ReksioEngine/src/interpreter/ast.ts`              |
| Condition (logic-expression) parser             | `ReksioEngine/src/interpreter/expression/index.ts` |
| Interpreter: dispatch, `@IF/@WHILE/@LOOP`, eval | `ReksioEngine/src/interpreter/interpreter.ts`      |
| Behaviour `RUN/RUNC/RUNLOOPED`, `__INIT__`      | `ReksioEngine/src/engine/types/behaviour.ts`       |
