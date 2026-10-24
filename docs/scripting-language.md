# Piklib / BlooMoo Scripting Language and Script File Formats — Draft Specification

Status: **DRAFT v0.1**. Written from a reading of the ReksioEngine TypeScript sources (commit `da5edbf`), the decrypted scripts of _Reksio i Skarb Piratów_, _Reksio i Ufo_ and the _Reksio i Ufo_ demo, and the symbol and string tables of the original engine DLLs shipped with those games. It describes the language and the file formats, not the TS code. Source citations sit in square brackets so they can be removed later.

The companion document [`architecture-plan.md`](architecture-plan.md) explains how this spec is meant to be used. Each rule should get a stable ID and at least one data-driven conformance case, and the open questions should be settled against the original binaries (§8.3).

## 0. Conventions

### 0.1 Confidence markers

Each normative rule carries one of these markers:

| Marker  | Meaning                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[F]** | Believed faithful to the original engine. A unit test backs it (tests are treated as verified original behaviour), or the source says it mirrors a named original routine (`CMElementsLoader::getLine`, `CMC_Behaviour::runLine`, `CMC_Expression`, `CMC_Condition::valid`, …). |
| **[G]** | An engine guess or approximation. It is plausible, but neither a test nor a comment ties it to the original. It may be wrong.                                                                                                                                                   |
| **[?]** | Open question. Behaviour is unknown, unimplemented, or the implementation is visibly inconsistent.                                                                                                                                                                              |

### 0.2 Citations

`[path:line]` paths are relative to `src/` in the ReksioEngine repo. `T:` names a test, for example `T:interpreter.test.ts "bracket expression is evaluated left to right"`.

### 0.3 Grammar notation

Grammars use EBNF: `|` alternation, `[...]` optional, `{...}` repetition, `"x"` literal. `ANY` is any character. `EOL` is end of logical line.

### 0.4 Terminology

| Term                | Meaning                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- |
| object              | A named, typed entity declared in a CNV file (`OBJECT=NAME`).                       |
| type                | The object's `TYPE` (ANIMO, INTEGER, BEHAVIOUR, …).                                 |
| property            | A `NAME:PROP=VALUE` assignment in a CNV file.                                       |
| code block / script | Text in the scripting language, usually `{...}`.                                    |
| callback            | A property whose value is code or a behaviour reference, run on an event (`ONxxx`). |
| value               | A runtime datum: INTEGER, DOUBLE, STRING, BOOL, NULL, or a reference to an object.  |

---

## 1. Overview

A game is a tree of definition files:

```
DANE/Application.def          (root: APPLICATION, EPISODE(s), SCENE(s))
  └─ DANE/<APP.PATH>/<APPNAME>.cnv        (application-level objects)
       └─ DANE/<EP.PATH>/<EPNAME>.cnv     (episode-level objects, optional)
            └─ DANE/<SCENE.PATH>/<SCENENAME>.cnv   (scene objects, loaded on scene entry)
```

Each file is a flat list of objects with typed properties. Behaviour is attached through **callbacks** (`ONINIT`, `ONFINISHED^WALK`, `ONCLICK`, …) and **BEHAVIOUR** objects. Both hold code in a small, line-oriented, untyped-ish command language. Its statements look like this:

```
ANIMOREKSIO^PLAY("WCHODZI");VARLEVEL2^SET("S21_0_WARSZTAT");@IF("VAR_KOD","!_","2288","BFITMP0","BFITMP1");
```

There are no assignment operators, infix comparison operators or user-defined functions. All computation is done by method calls on objects (`OBJ^METHOD(args)`), a handful of `@` built-ins, and bracketed left-to-right arithmetic `[a+b*c]`.

---

## 2. File layer

### 2.1 Character encoding

-   The original files are 8-bit text, almost certainly Windows-1250 (Polish). **[G]**
    -   ARR and DTA readers decode Windows-1250 [fileFormats/archive/array.ts:3, engine/types/database.ts:7].
    -   The CNV decryptor emits each decrypted byte as a Latin-1 code point (`String.fromCharCode(byte+shift)`) [fileFormats/cnv/decryptor.ts:87]. Non-ASCII letters therefore come out as Latin-1, not CP1250. **[?]**
    -   SEQ files are decoded as UTF-8 [filesystem/index.ts:70-74]. **[?]**
-   Line terminators are CRLF. Plain-text (unencrypted) CNV has `\r\n` normalised to `\n` [fileFormats/cnv/decryptor.ts:63].

### 2.2 CNV/DEF encryption

An encrypted file starts with a header [fileFormats/cnv/decryptor.ts:4]:

```
header    = "{<" direction ":" movement ">}" ;
direction = "C" | "c" | "D" | "d" ;
movement  = digit { digit } ;          (* decimal, N >= 1 *)
```

The payload starts immediately after the header. A file without a header is plain text. The TS engine searches for the header anywhere in the file but always slices the payload at offset `len(header)`, so it assumes the header is at offset 0. **[G]**

**Decryption algorithm** [fileFormats/cnv/decryptor.ts:29-91] **[F]** (it round-trips real game files):

```
sign  := (direction ∈ {d, D}) ? -1 : +1
step  := 0
for each payload byte position p:
    if bytes[p..p+2] == "<E>":    emit "\n"; p += 2; continue    -- encrypted line break
    if bytes[p] ∈ {CR, LF}:       continue                        -- physical newlines ignored, step not advanced
    step  := (step mod N) + 1                                     -- cycles 1..N
    k     := ceil(step / 2)
    shift := (step odd) ? -k : +k                                 -- -1,+1,-2,+2,-3,+3,...
    emit  char(bytes[p] + sign*shift)
```

The `<E>` marker is matched on the **raw (encrypted)** bytes. CR/LF and `<E>` do not advance the key schedule.

-   **[?]** Overflow: the TS engine does not reduce `byte+shift` modulo 256. The original most likely does arithmetic on an unsigned byte.
-   **[?]** In the decrypted Ufo samples a few lines show characters off by exactly 0x20: `CODE=[THIS^PLAY("PLAY");}`, `THIS>HIDE()`, `VAR?KOD` (expected `{`, `^`, `_`). See `s24d_0_chmury/s24_0_chmury.cnv`, `kontrola/kontrola.cnv`, `s64_Brama/s01.cnv`, `s44_511_Podkop/cnv_12.cnv` and `61_Ladowanie/s61_Ladowanie0.cnv`. The first four also fail to load, because a corrupted `TYPE` line leaves objects with an unknown type. None of these files is ever loaded. A scene always loads `<SCENENAME>.cnv` from its `PATH`, and these are differently named leftovers next to the real scene files (for example `s64_Brama/s01.cnv` beside `s64_Brama.cnv`). The defect is therefore most likely in the data, not in the decryption, but this is unconfirmed.

### 2.3 Logical lines

After decryption the text is split into physical lines on `\n`, then folded into logical lines. This mirrors `CMElementsLoader::getLine` [fileFormats/cnv/parser.ts:12-32]. **[F]** (comment and `T:parser.test.ts "continuation lines"`)

1. For each physical line, remove all TAB characters, then trim leading and trailing spaces.
2. **Continuation:** if the physical line _contains_ `/` anywhere, the next physical line is appended (no separator), and so on until a line without `/`.
3. All `/` characters are then removed from the logical line.
4. Logical lines that start with `#` are **comments** and are dropped. Empty or blank lines are dropped.

Consequences:

-   `/` can never appear in a CNV value. The language uses `@` for division (§3.5), presumably for this reason.
-   A `#` only starts a comment at the beginning of a logical line.

Example (T:parser.test.ts):

```
TEST:CODE={ /
    OTHER^CALL(); /
    ANOTHER^CALL(); /
}
→  TEST:CODE={ OTHER^CALL(); ANOTHER^CALL(); }
```

### 2.4 CNV statement grammar

Each logical line is tokenised by splitting on **every** `:` and `=` character and discarding empty tokens [fileFormats/cnv/parser.ts:167]. **[F]** (explicit comment and tests)

```
line        = object-decl | property ;
object-decl = "OBJECT" sep NAME [ sep property-tokens ] ;
property    = NAME sep PROPNAME [ "^" PARAM ] sep VALUE-TOKENS ;
sep         = ( ":" | "=" ) { ":" | "=" } ;
```

**Tokenisation rules** **[F]** (tests in `fileFormats/cnv/parser.test.ts`):

-   A line with fewer than 2 tokens is ignored.
-   `OBJECT=NAME` creates object `NAME` with `TYPE=unknown` if it does not already exist. Re-declaring an existing object is a no-op.
-   **Leftover-token quirk.** When an `OBJECT` line has more than 2 tokens, tokens 3.. are reprocessed as if they were a new line [fileFormats/cnv/parser.ts:46-49]. This is recursive, so it can declare another object:

    ```
    OBJECT=TEST1:TEST1:TYPE=ANIMO           ≡ OBJECT=TEST1 / TEST1:TYPE=ANIMO
    OBJECT=TEST2=TEST2:TYPE=ANIMO           ≡ (same)
    OBJECT=TEST3:OBJECT=TEST4:TEST4:TYPE=ANIMO   declares TEST3 and TEST4
    ```

-   In a property line, token 1 is the object name and token 2 is `PROPNAME[^PARAM]`. The **value is tokens 3..n joined with a single space** [fileFormats/cnv/parser.ts:52]. A value that contains `:` or `=` therefore has those characters replaced by spaces, and runs of them collapse:

    ```
    TEST1:TYPE=ANIMO=TEST1:VISIBLE=TRUE   → TYPE = "ANIMO TEST1 VISIBLE TRUE"
    OBJ:ONINIT={THIS^PLAY("2"):;}         → code "{THIS^PLAY("2") ;}"   (space later removed, §3.1)
    APP:CREATIONTIME=2002-09-26 14:02:01  → "2002-09-26 14 02 01"
    ```

    The language has no `=` or `:` operators, so code survives this.

-   `PROPNAME^PARAM`: the part after the first `^` is the **callback parameter** (§2.5.3). Text after a second `^` is dropped. **[G]**
-   A property line for an undeclared object is silently ignored [fileFormats/cnv/parser.ts:56].
-   Property names, `OBJECT` and type names are case-sensitive upper case as written. **[G]**
-   The value is trimmed before type processing [fileFormats/cnv/parser.ts:96].

### 2.5 Property schema and value types

Each TYPE has a schema of known properties, each with a value kind [fileFormats/cnv/types.ts:562]. Section 5 lists the schemas.

-   Property names can be patterns: `%s` matches `[a-zA-Z]+` and `%d` matches `[0-9]+`. For example FONT has `DEF_%s_%s_%d`, as in `DEF_ARIAL_STANDARD_14` [fileFormats/cnv/parser.ts:66-90]. **[G]**
-   **Order dependency.** The `TYPE` property must be assigned before any other property of the object. Any other property on a `TYPE=unknown` object (or on an unknown TYPE) is a fatal error, and the whole file fails to load [fileFormats/cnv/parser.ts:60-62]. **[G]** The SEQ loader is lenient in the same situation (§2.8).
-   An unknown property on a known type is kept as a raw string, with a warning [fileFormats/cnv/parser.ts:132-155]. Unknown `ONxxx` properties are therefore never dispatched. This includes `ONSIGNAL`, which does appear in game data (§4.11).
-   A missing non-optional property only produces a warning [fileFormats/cnv/parser.ts:175-186].

#### 2.5.1 Scalar kinds

[fileFormats/common/index.ts:28-96]

| Kind                 | Rule                                                                                                                                                                                                         | Marker |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `string`             | Raw text. The exact value `""` becomes the empty string. Any other quotes are kept literally (`VALUE="abc"` stores `"abc"` with quotes).                                                                     | [G]    |
| `number`             | If the value starts with `"`, strip the first and last character. Parse as a JS number (decimal, optional `.`/exponent). A non-numeric value warns and becomes 0. Ufo examples: `VALUE="0.0"`, `VALUE=NULL`. | [G]    |
| `boolean`            | `TRUE` → true, `FALSE` → false, `0`/`1` → number 0/1. Anything else warns and becomes false. Case-sensitive.                                                                                                 | [G]    |
| `reference`          | The value is an object name, resolved lazily at use time.                                                                                                                                                    | [G]    |
| `code`               | The value is a single-statement code string, without braces. Used by CONDITION and EXPRESSION operands, e.g. `OPERAND1=ANIMOREKSIO^ISPLAYING()`.                                                             | [G]    |
| `array(k)`           | Split on `,`, each part parsed as kind `k`. No trimming and no quote handling. Example: `EPISODES=A,B`.                                                                                                      | [G]    |
| `rect` (BUTTON.RECT) | Exactly 4 comma-separated parts → `array(number)`; otherwise a reference to an object whose bounds are used [fileFormats/cnv/types.ts:143-153].                                                              | [G]    |
| `map(k)`             | SEQ only: `PROP:KEY=VALUE` accumulates a key→value map.                                                                                                                                                      | [G]    |

#### 2.5.2 Callback values

A `callback` property value is one of the following [fileFormats/common/index.ts:143-165]:

```
callback-value = code-block | behaviour-ref ;
code-block     = "{" CODE [ "}" { ";" } ] ;        (* leading "{" and a trailing "}" followed by any ";" are stripped *)
behaviour-ref  = BEHNAME [ "(" CONSTARGS ")" ] ;   (* BEHNAME = [A-Za-z0-9_]+ *)
CONSTARGS      = ANY* ;                            (* split on every ",", no trimming, quotes kept verbatim *)
```

-   A value that starts with `{` is inline code. **[F]** (comment: `CODE={...}` vs reference; tests use both forms)
-   Otherwise, if the value matches `NAME(args)`, it is a **behaviour reference** with _constant arguments_, e.g. `ANIMOLINA:ONCLICK=BEHADDITEMTOMENU("LINA")`. The arguments are kept as raw source text, quotes included, and are substituted textually for `$1..$9` (§3.1).
-   Anything else (for example the corrupt `[THIS^PLAY("PLAY");}`) yields no callback. The property is then left unset. **[G]**
-   `BEHAVIOUR:CODE` is itself a callback-kind property, so `CODE=OTHERBEH` makes a behaviour an alias that runs `OTHERBEH`. **[G]**

#### 2.5.3 Parametrised callbacks

A `callbacks(k)` property can be assigned many times. The form `NAME:ONEVENT=…` sets the **default (non-parametrised)** handler. The form `NAME:ONEVENT^PARAM=…` adds a handler keyed by `PARAM`, converted with kind `k` (string, number, or boolean) [fileFormats/common/index.ts:120-141]. **[F]** (the shape is confirmed by game data; dispatch is in §4.11)

```
ANIMOREKSIO:ONFINISHED^WYCHODZI={PRZYGODA^GOTO("S14_3_PODWORKO");}
IWAV:ONCHANGED^1={NARR1^PLAY();}
KEYBOARD:ONKEYDOWN^UP=BEHSKOKPODCZASCHODZENIA
```

A plain `callback` property (not `callbacks`) ignores the `^PARAM` part. **[G]**

### 2.6 Hierarchy, loading and file location

#### 2.6.1 Loading sequence

[engine/index.ts:70-87; engine/types/application.ts:24-36; engine/types/episode.ts:10-21; engine/index.ts:149-254]

1. `DANE/Application.def` (an ordinary CNV) is loaded into the **root** scope. In Ufo it declares the APPLICATION (`UFO`), the EPISODE (`PRZYGODA`) and **every SCENE object**. A scene's properties include `PATH`, `BACKGROUND`, `MUSIC` and `DLLS`. **[F]** (structure follows the real file)
2. APPLICATION init: if `PATH` is set, `DANE/<PATH>/<APPNAME>.cnv` is loaded into a new **application** scope (Ufo: `DANE/REKSIOUFO/UFO.cnv`). **[G]**
3. EPISODE init: if `PATH` is set, `DANE/<PATH>/<EPNAME>.cnv` is loaded into a new **episode** scope. **[G]**
4. The first scene is `EPISODE.STARTWITH`. Entering scene `S` does the following:

    - destroys the previous scene's scope;
    - sets the background image `DANE/<S.PATH>/<S.BACKGROUND>`;
    - starts `S.MUSIC` looping if it differs from the current music;
    - loads `DANE/<S.PATH>/<S>.cnv` into a new **scene** scope.

    **[G]**

5. Paths use `\` in the data. Matching is case-insensitive (`normalizePath` lower-cases everything and converts `\` to `/`) [filesystem/index.ts:11-13]. **[G]** This follows the original's case-insensitive Windows file system.

#### 2.6.2 Object initialisation order

Within one file [filesystem/definitionLoader.ts:131-223]:

1. Instantiate every object.
2. Run an _init_ phase (asset loading) in priority order:
    - BEHAVIOUR;
    - INTEGER, STRING, BOOL, DOUBLE;
    - ARRAY, CONDITION;
    - ANIMO, IMAGE, SOUND, VECTOR;
    - TIMER, SEQUENCE, GROUP, BUTTON;
    - FONT;
    - TEXT;
    - all other types.
3. Run a _ready_ phase in the same order. Most types run their `ONINIT` callback here.
4. A BEHAVIOUR named **`__INIT__`** is placed last and **RUN automatically** at ready. A BEHAVIOUR named **`CONSTRUCTOR`** runs last inside a CLASS instance, with the `NEW` arguments [engine/types/behaviour.ts:11-20].
5. An object whose init fails is removed from the scope and the rest continue.

The priority table is explicitly partly guessed (`// todo: this was just placed at random priority`). **[G]**

#### 2.6.3 Asset path resolution

[engine/index.ts:268-284; engine/types/scene.ts:110-113]

-   A path relative to a scene resolves against `DANE/<SCENE.PATH>/`. This covers ANIMO, IMAGE, SEQUENCE, ARRAY^LOAD, DATABASE, CNVLOADER and CANVAS_OBSERVER files.
-   **Language directory:** `<base>/<LANG>/<path>` is tried first, then `<base>/<path>`. `LANG` defaults to `POL`. `APPLICATION^SETLANGUAGE(lcid)` maps Windows LCIDs:

    | LCID | LANG |
    | ---- | ---- |
    | 0415 | POL  |
    | 0405 | CZE  |
    | 0402 | BUL  |
    | 0418 | ROM  |
    | 0419 | RUS  |
    | 040E | HUN  |
    | 041B | SLO  |

    [engine/types/application.ts:11-19]. **[G]**

-   A path starting with `$` discards the base and resolves from the game root (e.g. `$\WAVS\X.WAV`). **[G]**
-   Default base directories:

    | Asset                                  | Base                                         |
    | -------------------------------------- | -------------------------------------------- |
    | SOUND.FILENAME                         | `Wavs/` [engine/types/sound.ts:15]           |
    | ANIMO sound effects named in ANN files | `wavs/sfx/` [engine/types/animo.ts:147]      |
    | SEQ speech files                       | `Wavs/` [engine/types/sequence.ts:117]       |
    | CLASS.DEF                              | `common/classes/` [engine/types/class.ts:20] |

    **[G]**

-   CLASS definition files use the extension `.class` (`MAINMENU.class`) and are encrypted and structured like CNV files. Czarodzieje ships 5, Wehikuł Czasu 3 and Kapitan Nemo 10.
-   Scene MUSIC is loaded relative to the game root. **[G]**

### 2.7 Binary and auxiliary data files

**ARR** (ARRAY^LOAD / ARRAY^SAVE) [fileFormats/archive/array.ts:6-86], little-endian:

```
u32 count
repeat count:
   u32 type   ; 1=INTEGER, 2=STRING, 3=BOOL, 4=DOUBLE
   type 1: i32 value
   type 2: u32 len, len bytes (CP1250)
   type 3: u32 (1 = TRUE)
   type 4: i32 value*1000   (fixed point, 3 decimals; writing truncates)
```

**[G]** (round-trip tests only). **[?]** The writer encodes strings as UTF-8 while the reader decodes CP1250.

**DTA** (DATABASE) [engine/types/database.ts:94-140]:

-   CP1250 text with one row per CRLF line. Fields are separated by `|` and map in order to the MODEL STRUCT's fields.
-   **Empty cells are dropped, so later fields shift left** (`T:database.test.ts "LOAD shifts fields left"`).
-   `NULL` stays the text `NULL` in STRING fields and resets fields of other types to their default (`T:database.test.ts "LOAD keeps NULL in STRING fields"`). Czarodzieje relies on this: ARCADE finds a location's default start position with `ARRSTARTNAME0^FIND("NULL")` over STRING cells read from DTA files. Turning them into empty strings would also break SAVE/LOAD round trips, because an empty cell shifts the following fields. **[G]**
-   SAVE writes `toString` of each field. DOUBLE uses the Piklib double format (§4.2).

**[F]** for the tested parts.

**SEK** (WORLD^LOAD, `FILENAME` of WORLD) [fileFormats/sek/index.ts] are scenes of the Sekai library behind the WORLD plugin (§8.2). Little-endian, starting with the 19-byte magic `SEKAI81080701915004`, an object count and the objects. An object starts with `i32 type, i32 flags, i32 id`. Coordinates are Sekai's: origin in the screen centre, **y pointing up**.

-   **Waypoint graphs** (type 4) are what Czarodzieje's ARCADE walks Reksio and Kretes on. Every location has one with id 9000 (KROLOWA also has 9001). The nodes form a grid 10 units apart over the walkable area, and the edges join neighbouring nodes. **[F]** (read from all 60 location files)

    ```
    i32 type = 4, i32 flags, i32 id, 11 x i32 (zero in all files)
    i32 nodesCount, i32 edgesCount
    nodesCount x { f32 x, f32 y, f32 z, f32 unused }
    edgesCount x { i32 from, i32 to, i32 flags }    ; flags = 3 in all files
    ```

-   **Entities** (type 1) are bodies and colliders. After the header come an `i32`, position, rotation and size (3 x f32 each), and, when present (flags 0x80?), text properties: `name\0, i32 type (2 = string), value\0`, e.g. `entityDef` = `maxVel( 10000 ); limit( -400, -300, 0, 400, 300, 0 ); friction( 2500 );` and `entityName` = `Reksio`. Then a collision model follows: an `i32`, a triangle count and triangles of `material\0` (`Default`), 3 vertices of 8 floats (position, normal, UV) and 3 floats. **[?]** Not decoded by the TS engine; the physics minigames (CAT, BARANDALF) need it for collisions.

**IMG** compression 5 (Wehikuł Czasu) stores the colour data as a baseline JPEG and the alpha channel compressed with CLZW, like compression 4. The TS engine decodes the JPEG with `jpeg-js` and reduces it to RGB565, so the result matches the other compressions [fileFormats/img/index.ts] (`T:img.test.ts`). **[G]**

**INI persistence:** a value object with `TOINI=TRUE` persists to a save store keyed by `[<parent scene/episode/application name>] <object name>=<value>` [engine/saveFile.ts:39-51]. On creation the stored value overrides `VALUE` [engine/types/index.ts:174]. **[G]** **[?]** The TS engine restores INTEGER, DOUBLE and BOOL values as strings.

### 2.8 SEQ (sequence) files

A SEQUENCE object's `FILENAME` points at a `.seq` file. It is plain text; the TS engine applies no decryption [filesystem/index.ts:70-75]. **[?]** It is not known whether SEQ files can be encrypted.

```
seq-line   = comment | blank | name-line | field-line ;
name-line  = "NAME" ws-or-eq ENTRY ;
field-line = ENTRY ":" FIELD [ ":" SUBKEY ] ws-or-eq VALUE ;
ws-or-eq   = ( WS | "=" ) { WS | "=" } ;
comment    = "#" ANY* ;
```

[fileFormats/seq/index.ts:11-44] **[G]**

-   Only the first two whitespace- or `=`-separated tokens of a line are used, so values cannot contain spaces.
-   The `=` is optional. The Ufo data uses `ENTRE_1:ADD ENTRE`.
-   Fields that appear before `TYPE` are stored as raw strings.

Entry types and their fields:

| TYPE       | Fields                                                                                                      | Meaning                   |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| `SEQUENCE` | `MODE` = `PARAMETER` / `SEQUENCE` / `RANDOM`; `SEQEVENT:<name>=<idx-char>` (PARAMETER only); `ADD=<parent>` | Container.                |
| `SIMPLE`   | `FILENAME` (ANN), `EVENT`, `ADD`                                                                            | Play one animation event. |
| `SPEAKING` | `ANIMOFN` (ANN), `PREFIX`, `WAVFN`, `STARTING`, `ENDING`, `ADD`                                             | Lip-synced speech.        |

The TS schema names the SPEAKING animation field `ANIMOFX`, but data and runtime use `ANIMOFN`. **[?]**

Semantics [engine/types/sequence.ts] **[G]** throughout:

-   `ADD=P` appends the entry to parent `P`'s child list, in file order.
-   **PARAMETER root:** `SEQUENCE^PLAY(name)` looks up `SEQEVENT:name`. It takes the _first character_ of the value and finds its index in `123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz{|}~`. That index selects one of the root's children (0-based) [engine/types/sequence.ts:21,88]. A code comment notes that a stray extra character in `S56_0_WIOSKA` still works.
-   **MODE=SEQUENCE** plays all children in order, recursively. **MODE=RANDOM** plays one random child.
-   **SIMPLE** plays `EVENT` on the ANIMO whose file is `FILENAME`. The ANIMO is found by object name, then by an existing ANIMO with that FILENAME, otherwise it is created. If the event does not exist, the first event is played.
-   `ANIMOFN` and `WAVFN` can name objects instead of files: Czarodzieje's `BLANK.SEQ` speaks with the ANIMO `ANNCHARACTER` and the SOUND `SNDATGOAL`, which the scripts LOAD before playing the sequence. **[G]**
-   **SPEAKING** plays `WAVFN`. It plays `<PREFIX>_START` if `STARTING`, then loops `<PREFIX>_1`, `<PREFIX>_2`, … while the sound plays, then `<PREFIX>_STOP` if `ENDING`.
-   At the end the SEQUENCE object fires `ONFINISHED^<name passed to PLAY>`.
-   **Every finished element also fires `ONFINISHED^<element name>`**, when the object has a handler with that parameter. Wehikuł Czasu drives its cutscenes this way: `CS_INTRO1` plays `PIRACI` from `INTROMAIN1.SEQ`, and handlers such as `MAINSEQCS:ONFINISHED^ASEQ1={PROJEKTOR^SETFRAME("PLAY",1);}` react to its child elements while `ONFINISHED^PIRACI` starts the next part. **[G]**
-   `PLAY(name)` accepts the name of any element, not only a SEQEVENT of the root. Wehikuł Czasu plays nested SEQUENCE and SPEAKING elements directly. **[G]**
-   `PAUSE` pauses the element being played, and `PLAY` starts its element running, so `PLAY` after `PAUSE` plays. Wehikuł Czasu's `CS_INTRO2` does `SEQCS^PAUSE();VAR_UJECIE^SET(7);SEQCS^PLAY("PLAY2");` when an element finishes. `CSequencedPlayable::pause` pauses the current child and sets a paused flag; `play` leaves the flag but starts a new child, and the flag only matters to `resume`. **[F]** (disassembly)
-   `PAUSE` holds the sequence after the current element finishes; `RESUME` continues with the next one. SCENE^PAUSE/RESUME pause and resume the sequences and timers that were running. **[G]**

---

## 3. Code blocks: lexical structure and syntax

### 3.1 Pre-processing pipeline

Running a code string goes through these steps in order [interpreter/interpreter.ts:459-489]:

1. **Brace stripping** happens at CNV load (§2.5.2). The executed string has no outer `{}`.
2. **All space characters (U+0020) are deleted**, including those inside string literals. **[F]** (`T:"spaces are removed from the code"`: `MY VAR ^ SET(5 2)` ≡ `MYVAR^SET(52)`; `T:"52 == \"5 2\""`.)
3. **Argument substitution** replaces `$d` (exactly one digit) textually with the d-th argument. **[F]** (`T:"only one digit after $ is the argument number"`: `$12` is `$1` followed by `2`.) The replacement depends on the argument:

    | Argument                                                  | Replacement text            |
    | --------------------------------------------------------- | --------------------------- |
    | STRING value (named or anonymous), or any anonymous value | Its value as text, unquoted |
    | Named non-STRING object                                   | Its **name**                |
    | Raw constant argument (from `BEH(args)`)                  | Verbatim, including quotes  |
    | `$0`, or an index past the end                            | `$d` is left in place       |

    Substituted text is **not** space-stripped. **[F]** (`T:"spaces of substituted arguments stay"`)

    The substitution is textual, so a STRING argument `WCHODZI` turns `PLAY($1)` into `PLAY(WCHODZI)`. That is an identifier, which normally evaluates back to the string `WCHODZI` (§4.3), but it would resolve to an object if one had that name. **[G]**

4. **Statement split** on `;` at parenthesis depth 0 (quotes are _not_ tracked). Empty statements are skipped [interpreter/parser.ts:35-62]. **[F]** (mirrors `runLine` loop; tests)
5. Each statement is classified and parsed (§3.2–3.4), then executed in order.
    - A **single-statement** code value (the `code` kind: CONDITION and EXPRESSION operands) executes only the first statement and yields its value [interpreter/interpreter.ts:473-474]. **[G]**

### 3.2 Statement grammar

`parseLine` mirrors `CMC_Behaviour::runLine` [interpreter/parser.ts:74-155]. **[F]** for the structure; details are noted where they differ.

```
code        = [ statement ] { ";" [ statement ] } ;
statement   = global-call | indirect-call | method-call | parameter ;

global-call = "@" GNAME [ "(" arglist ")" ] ;               (* GNAME = text up to "(" *)
method-call = target "^" { ANY-but-"^" "^" } METHOD [ "(" arglist ")" ] ;
indirect-call = "*" target-expr [ "^" METHOD ] [ "(" arglist ")" ] ;
target      = "THIS" | "#" CHAR [ CHAR ] | NAME ;
arglist     = [ parameter ] { "," [ parameter ] } ;         (* split at paren depth 0, quote-unaware *)
```

Classification of a statement (after trimming) takes the **first** rule that matches:

1. It starts with `@` → **global call**. `GNAME` is the text between `@` and the first `(`. The arguments are the text from the first `(` to the **last character** of the statement, minus that last character [interpreter/parser.ts:86-109, 528-530]. A missing `)` therefore eats one character. **[G]**
2. It starts with `*` → **indirect call** (§3.6).
3. It has neither `(` nor `^` → it is a bare **parameter** (§3.4), evaluated for its value. Examples: `1234`, `TRUE`, `"x"`, `S|FIELD`, `THIS`.
4. It has `^` but no `(` → method call with no arguments, e.g. `OBJ^HIDE`.
5. Otherwise it is a method call. The **target is the text before the first `^`**. The **method is the text after the last `^`** (before `(`); anything between is discarded [interpreter/parser.ts:491-513].

    | Target text                                         | Meaning                                                                                 |
    | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
    | empty (statement starts with `^`), or no `^` at all | No target: a _bare method_ (§4.7)                                                       |
    | `THIS`                                              | The current THIS binding                                                                |
    | `#…`                                                | A **direct reference** by object ID: `(code[2] or code[1]) & 0x7F`, per `resolveObject` |
    | anything else                                       | An object name                                                                          |

-   A method name starting with `#` is flagged as a "hash method" (method addressed by hash) [interpreter/parser.ts:105]. **[?]** It has no runtime semantics.

### 3.3 Lexical notes

| Item                | Rule                                                                                                                                                                                                                                                                                   | Marker                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Identifiers / names | Any run of characters that does not trigger another rule. Names are case-sensitive in lookup. Object names in data use `[A-Z0-9_]`.                                                                                                                                                    | [G]                                                               |
| Numbers             | A parameter starting with `-` or a digit. The value is the longest numeric prefix (C `atof` semantics): `5A` → 5, `-` → 0. It is an INTEGER unless the source text contains `.` [interpreter/interpreter.ts:379-382]. `1e3` is an INTEGER 1000.                                        | [F] (atof/atoi tests)                                             |
| Strings             | `"` … `"`. **Malformed-quote behaviour:** a parameter starting with `"` drops the first character and drops the last character _only if_ it is `"`. No escapes. Inner quotes are kept: `""OPEN""` → string `"OPEN"` (quotes included), `"abc` → `abc` [interpreter/parser.ts:253-264]. | [F] (`""OPEN""` is used deliberately in Ufo `@IF` operands, §4.8) |
| Booleans            | Exactly `TRUE` or `FALSE` (case-sensitive).                                                                                                                                                                                                                                            | [F]                                                               |
| `NULL`              | No literal. `NULL` is an identifier that (normally) does not resolve, so it evaluates to the string `"NULL"`. The NULL value appears only as a method result.                                                                                                                          | [F] (`T:"0 == NULL"`, `T:"NULL == \"NULL\""`)                     |
| Comments            | None inside code.                                                                                                                                                                                                                                                                      | [G]                                                               |
| Whitespace          | Spaces are removed (§3.1). Tabs are removed at CNV load.                                                                                                                                                                                                                               | [F]                                                               |

### 3.4 Parameter (argument) classification

This mirrors `CMC_Behaviour::resolveParameter` [interpreter/parser.ts:210-301]. **[F]** (priority chain documented as original; the CONV and `#` semantics are unknown)

Rules are tried in this order:

| #   | Pattern                                  | Result                                                                                                                                                                                                                 |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Starts with `[`                          | **Bracket expression** (§3.5). The closing `]` is optional.                                                                                                                                                            |
| 2   | Upper-cased text starts with `CONV`      | **Conversion call**. Per the comments, the original prepends `@` and re-dispatches through the global runner. **[?]** Semantics unknown; unsupported at runtime. Any identifier beginning with `CONV` is captured too. |
| 3   | Contains `^` and does not start with `"` | **Nested call**, parsed as a statement and evaluated for its return value.                                                                                                                                             |
| 4   | Starts with `"`                          | **String literal**                                                                                                                                                                                                     |
| 5   | Starts with `-` or a digit               | **Number literal**                                                                                                                                                                                                     |
| 6   | Contains `\|`                            | **Struct field access** `OBJ\|FIELD`                                                                                                                                                                                   |
| 7   | Exactly `TRUE` or `FALSE`                | **Boolean literal**                                                                                                                                                                                                    |
| 8   | Otherwise                                | **Identifier**                                                                                                                                                                                                         |

-   Rule 5 takes any text starting with a digit. The TS engine keeps such text as a string when it isn't a whole number, so a substituted `$2` = `1_ENEMY0.ANN` (Kapitan Nemo's `ANNENEMY^LOAD($2)`) stays a file name. An integer parameter still reads the leading number. (`T:"a substituted argument starting with a digit stays text unless it is a number"`) **[G]**
-   `OBJ|FIELD` also works as the target of a call: `STLINE|VALUE^SET(STMPVALUE)` calls SET on the field (`T:"a method can be called on a STRUCT field"`). Kapitan Nemo's save class depends on it. **[F]** for the usage.

### 3.5 Bracket arithmetic

This mirrors `CMC_Expression(CXString)` [interpreter/ast.ts:27-45; interpreter/parser.ts:303-377]. **[F]**

```
bracket   = "[" expr [ "]" ] ;
expr      = operand { op operand } ;
op        = "+" | "-" | "*" | "@" | "%" ;      (* ADD SUB MUL DIV MOD *)
operand   = parameter ;                         (* any §3.4 form, incl. nested [..] and calls *)
```

-   The text is split on operator characters at **bracket depth 0**. It is evaluated **strictly left to right with no precedence**: `[A+1*3]` with A=2 is `(2+1)*3 = 9`. **[F]** (`T:"bracket expression is evaluated left to right"`) Use nested brackets to group: `[SC_CLONE_EMPTY+[I_FIELD_INDEX+1]]`.
-   `@` is **division**: `[I_FIELD_INDEX@I_LEVEL_WIDTH]`.
-   The splitter does **not** track parentheses or quotes. **[?]** `[F(-1)]` and `["A-B"+X]` are therefore split inside the call or string. It is not known whether the original behaves the same way.
-   A leading or doubled operator yields an empty operand, which is a parse error. **[?]** Consequently `[-1+X]` and `[A*-1]` cannot be written. The original's treatment is unknown.
-   Division or modulo by zero is a runtime error. **[G]**
-   The typing rules are in §4.5.

### 3.6 Indirect references `*`

[interpreter/parser.ts:398-489; interpreter/interpreter.ts:443-444]

-   `*REF^METHOD(args)` evaluates `REF` as a parameter, converts the result to a string, and uses that string as the target object's name. **[F]** (`T:"indirect object reference"`: `REF="A"`, `*REF^SET(3)` sets A.)
-   `*[expression]^METHOD(args)` does the same with a bracket expression, as a statement or an argument: `*["A"+N]^SET(3)` with `N=1` sets A1. Czarodzieje, Wehikuł Czasu and Kapitan Nemo use this form 670 times (e.g. `*["BEHINITPLAN"+IPLANSZALAST]^RUN()`). Until this was fixed the TS parser took `["A"+N]` as a name, so these calls silently did nothing, and Kapitan Nemo's TUNEL hung in a `@WHILE` that waited for `*["ART"+TEMP]^GET(…)` to change a value. **[F]** (`T:"indirect object reference by a bracket expression…"`)
-   `*NAME` and `*NAME(args)`, with no `^`, produce a call whose target is `*NAME` and whose method is also `NAME`. **[?]** Probably not the original meaning; unused in Ufo.

### 3.7 Logic-expression mini-language (3-argument `@IF`)

[interpreter/expression/index.ts] **[F]** (comments state the original's `CMC_Condition::valid` order and the no-mixing rule)

```
logic     = cond { "&&" cond } | cond { "||" cond } ;  (* operator kind = whichever occurs first; no mixing, no precedence *)
cond      = operand cmp operand ;
cmp       = "'" | "!'" | "<'" | ">'" | "<" | ">" | "?" ;   (* EQ NE LE GE LT GT HAS *)
```

-   The scan is quote-aware (`"` with `\` escape) and parenthesis-aware.
-   Operator detection: the first `'` at depth 0 wins, checking the preceding character for `!`, `<` or `>`. Otherwise the first `<`, `>` or `?` found scanning left to right wins.
-   Example: `VARSITEMON'"TARGET"||VARSITEMON^FIND("GOTO_")>-1`.
-   **[?]** The comment claims the order is "`<`, then `>`, then `?`", but the code takes whichever comes first. Note also the inconsistency: this sub-parser is quote-aware, the main parser is not.

---

## 4. Evaluation semantics

### 4.1 Values

A runtime value is one of:

| Kind             | Notes                                                    |
| ---------------- | -------------------------------------------------------- |
| INTEGER          | Signed integer. Stored values are truncated toward zero. |
| DOUBLE           | IEEE double.                                             |
| STRING           | Text.                                                    |
| BOOL             | TRUE/FALSE.                                              |
| NULL             | The absence of a value. Its string form is `NULL`.       |
| object reference | Any declared object.                                     |

Value-typed objects are INTEGER, DOUBLE, STRING, BOOL, EXPRESSION, ARRAY, MULTIARRAY and VECTOR. Literals and method results are **anonymous** values (no name). Named variables are the declared objects.

**Identifiers evaluate as follows** [interpreter/interpreter.ts:389-395; 450-456]. **[F]** (`T:"value references"`, `T:"unknown value reference becomes a string"`)

1. If the name resolves (§4.4) to a **value-typed** object, the result is **that object itself**, by reference. Passing `A` to a method passes the variable.
2. If it resolves to a non-value object (ANIMO, SOUND, …) or to nothing, the result is the **string of the name**. This is why `VALUE^SET(TEST)` sets `"TEST"` and `UFO^RUN(VARSTRINGTEMP,"SHOW")` passes an object name.

Method results and arithmetic always create **fresh** values. A value returned from `A^GET()` does not follow later changes of A. **[F]** (`T:"returned value does not follow later changes"`)

### 4.2 Conversions

Primitive conversions [common/types.ts:9-121]:

| To \ From  | STRING s                                                                  | INTEGER/DOUBLE n                    | BOOL b         | NULL   | object      |
| ---------- | ------------------------------------------------------------------------- | ----------------------------------- | -------------- | ------ | ----------- |
| **string** | s                                                                         | integer: decimal; double: see below | `TRUE`/`FALSE` | `NULL` | object name |
| **int**    | `atoi(s)` (leading `[+-]digits`, else 0; `"1e3"`→1, `" +5"`→5, `"5.7"`→5) | trunc(n)                            | 1/0            | 0      | —           |
| **double** | `atof(s)` (`"1e3"`→1000, `".5"`→0.5, `"5.7abc"`→5.7, `"abc"`→0)           | n                                   | 1/0            | 0      | —           |
| **bool**   | `upper(s)=="TRUE"`                                                        | n≠0                                 | b              | FALSE  | —           |

**[F]** (`common/types.test.ts`). Arrays and other composites cannot be converted (error).

**DOUBLE → string** ("Piklib double format") [common/types.ts:31-56]. **[F]** (`T:"double as string"`, database tests)

-   Fixed-point with 5 decimals: `1234.5` → `1234.50000`, `5` → `5.00000`, `-12.34` → `-12.34000`.
-   **Zero** prints as `00000`.
-   **Values in (−1, 1)** print as `0.` followed by digits. For negatives the minus sign comes _after_ `0.` and the leading fractional zeros are dropped: `-0.34` → `0.-34000`, `-0.05` → `0.-5000`, `-0.005` → `0.-500`.

This format is used when a DOUBLE is passed to a `string` parameter and in DOUBLE `toString` (string comparison and database save). It is _not_ used by bracket string concatenation or `$n` substitution, which use the short form (`6.5`). **[?]**

### 4.3 Method-call argument conversion

Every method has a declared parameter list. Each parameter is one of `int`, `double`, `string`, `boolean`, a union of these, or "any/value/object" (passed through) [common/types.ts:178-300]. **[F]** (`common/types.test.ts`)

1. Arguments are evaluated left to right **before** the target is resolved, so their side effects happen even if the target is missing. **[G]**
2. An EXPRESSION object argument is evaluated first.
3. A value-typed argument is unwrapped to its primitive.
4. For a primitive parameter:

    - Single declared type: convert per §4.2. DOUBLE → string uses the Piklib format.
    - Union of types:

        - NULL stays NULL.
        - Otherwise the target is the first declared type whose kind matches the primitive's own kind.
        - Otherwise the first type the value "looks like". A boolean looks like `TRUE`/`FALSE`/`0`/`1`/NULL; a number looks like any non-string or a string with a numeric prefix.
        - Otherwise the first declared type.

        Examples: `(string|double)` given INTEGER 5 → 5. `(string|int)` given DOUBLE 2.5 → 2. `(boolean|int)` given `"5"` → 5.

5. Composite values (e.g. arrays) passed to a primitive parameter are an error.
6. Missing required arguments are an error. Extra arguments are accepted with a warning.
7. Example: `A^ADD("5")` on INTEGER A=1 gives 6. **[F]**

**Return values.**

-   A method declared to return `int`, `double`, `string` or `boolean` returns a fresh anonymous value of that type. **[F]** (`T:"SCENE^RUN returns a primitive result as an engine value"`)
-   A method with no result returns NULL.
-   A method returning an undeclared primitive is an engine error, and the script is aborted (§4.10). **[G]**

### 4.4 Name resolution and scopes

There are five kinds of scope [engine/scope.ts; engine/index.ts:257-266; interpreter/interpreter.ts:450-456]:

| Scope          | Contents                                |
| -------------- | --------------------------------------- |
| root           | Application.def                         |
| application    | The application CNV                     |
| episode        | The episode CNV                         |
| scene          | The current scene's CNV (one at a time) |
| class instance | One per CLASS `NEW`                     |

Scopes form a stack, root at the bottom. Every object records its _parent_ (the APPLICATION, EPISODE, SCENE or class instance whose file declared it). A **caller** is the object on whose behalf code runs: the object owning the callback, the BEHAVIOUR being run, or the CONDITION or EXPRESSION.

**Local scopes** are pushed for each callback or code invocation. They hold `THIS` (when bound) and `_I_` (in `@LOOP`).

To resolve `NAME` for a given caller:

1. Look in the caller's own parent scope.
2. Search **all live local scopes**, newest first. This is _dynamic_ scoping.
3. Search the scope stack **starting at the caller's parent scope and going toward root**. A caller with no known scope starts from the newest scope (the current scene).
4. As a final fallback, use the built-in singletons `RANDOM` (RAND), `SYSTEM` and `CNVLOADER`.

**[F]** for steps 2 and 3 (`engine/scope.test.ts`: "searches from the newest scope", "stops at the parent scope", "local scopes take precedence"). **[G]** for step 1 and step 4.

Consequence **[?]**: code owned by an application-level object cannot see scene objects by name, except through local scopes. It is unverified whether the original works this way.

**THIS** [engine/scripting.ts:17-56; engine/components/callbacks.ts:62-101]:

-   An event callback binds `THIS` to the object raising the event.
-   An EXPRESSION binds `THIS` to itself.
-   BEHAVIOUR `RUN`, `@IF`/`@LOOP`/`@WHILE` branches and CONDITION operands do **not** rebind THIS. Inside a behaviour, `THIS` is the THIS of the dynamically enclosing callback.
-   The behaviour's _own_ name resolution is relative to where the behaviour is declared (its parent scope).

**[G]** This lexical/dynamic split is an inference from the code, not a test.

**Clones:** `OBJ^CLONE(n)` creates n copies named `OBJ_1`, `OBJ_2`, … (numbered by the total clone count) in OBJ's parent scope. `GETCLONEINDEX` returns 1.. for clones and 0 for the original [engine/types/index.ts:49-72]. **[G]** (the naming matches game data usage)

Kapitan Nemo also addresses the original as `OBJ_0`: `ANNNAKLADKI^CLONE([I1-1]);@LOOP("{*["ANNNAKLADKI_"+_I_]^SETFRAME("IDLE",_I_);}",0,I1,1);GENEMIES^ADDCLONES("ANNNAKLADKI",0,[I1-1])`. WYKOPALISKA even plays `ANNEXPLOSION_0` before any CLONE, and finds its slot again with `GETCLONEINDEX`, which is 0 for the original. So a name `OBJ_0` that doesn't exist resolves to `OBJ` (`T:"NAME_0 is the original object, even without clones"`). **[G]**

**Block-local variables** declared with `@INT`/`@STRING`/`@BOOL`/`@DOUBLE` (§4.8) go into the innermost local scope, so step 2 finds them from the declaring block and from every behaviour it runs. Step 1 comes first, so an object of the same name in the caller's own file would win; no shipped file declares a local named like one of its objects. **[G]**

**CLASS instances.** The constructor behaviour gets the instance name as `$1` and NEW's arguments from `$2` on: every Kapitan Nemo constructor reads them so, e.g. `NEW("LOG",FALSE)` with `{@IF("$2","_","FALSE",…)}`, and the earlier titles' constructors take no arguments. A method call on an instance runs the instance's behaviour of that name and returns its value (`T:class.test.ts`). **[F]** for the usage.

### 4.5 Arithmetic typing (bracket expressions and EXPRESSION objects)

**The result type follows the left operand** [engine/types/values.ts:103-123]. **[F]** (tests: `0+6.5→6`, `0.0+6.5→6.5`, `6.5+TRUE→7.5`, `TRUE+6.5→TRUE(1)`, `FALSE+1→FALSE`, `TRUE+FALSE→FALSE`, `S^LENGTH()+1→4`)

| Left operand                       | Result                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| INTEGER                            | `trunc(double(L) op double(R))` → INTEGER                                                     |
| DOUBLE                             | `L op double(R)` → DOUBLE                                                                     |
| BOOL                               | If R is BOOL → FALSE; otherwise → L unchanged (the operator is ignored)                       |
| STRING (or NULL, or another value) | `+` → string concatenation `str(L)+str(R)`; other operators → DOUBLE `double(L) op double(R)` |

-   MOD follows C semantics: the sign follows the dividend.
-   **[?]** An EXPRESSION object as the _left_ operand of a bracket expression falls into the STRING/other row and concatenates. This is almost certainly an engine artefact.

### 4.6 Comparison

Comparison is used by `@IF`, `@WHILE`, CONDITION and the logic expressions [engine/types/values.ts:61-84 and each type's `equals`/`compare`]. **[F]** (many tests). Rules:

-   NULL operands are replaced by the string `"NULL"`. EXPRESSION operands are evaluated first.
-   **The right operand is converted to the type of the left one.**

| Left    | Equality                                                                                                                                | Ordering                                                             |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| INTEGER | `L == atoi-ish int(R)`: `5=="5A"`, `5=="5a51"`, `52==52.3`, `0=="A"`, `0=="NULL"`                                                       | `sign(L − int(R))`: `52<52.3` is false, `52<_52.3` is true           |
| DOUBLE  | `L == double(R)`: `52.3 != 52`, `0.0 == NULL`                                                                                           | numeric                                                              |
| STRING  | **case-insensitive** equality with `R`'s string form: `"abc"=="ABC"`, `NULL=="NULL"`, `"NULL" != 0`. A DOUBLE R uses the Piklib format. | **case-sensitive** code-unit order: `"abc" < "abd"`, `"abc" > "ABD"` |
| BOOL    | `L == bool(R)`                                                                                                                          | FALSE < TRUE                                                         |

-   **HAS** (`?`): substring test on the string forms.

### 4.7 Statement execution and calls

[interpreter/interpreter.ts:85-373]

-   A statement is executed for effect. A block's value is discarded unless it is single-statement (§3.1 step 5) or `@RETURN` is used.
    -   **The last statement's value is not a behaviour's return value.** **[F]** (`T:"last result is not used as behavior return value"`)
-   `OBJ^M(args)`:

    -   If OBJ does not resolve, the call is **silently skipped** and yields NULL. **[F]** (`T:"call on missing object is skipped"`)
    -   If OBJ has no method M, the error is logged and the call yields NULL.

        -   GROUP forwards unknown methods to every member.
        -   A CLASS instance treats the method name as the name of a BEHAVIOUR in its own scope and RUNCs it.

        **[G]**

-   **Bare method** (no target, e.g. `FOO()`): unimplemented, a fatal runtime error. **[?]** In the original this probably calls a method on THIS or a global.
-   **`#` direct references** and **`CONV…`** are unimplemented. **[?]**

### 4.8 Global operations (`@NAME(...)`)

The TS engine implements `IF`, `LOOP`, `WHILE`, `BREAK`, `RETURN`, `MSGBOX`, `INT`, `STRING`, `BOOL` and `DOUBLE` [interpreter/interpreter.ts]. An unknown `@NAME` is a fatal error. **[F]** for the tested behaviour.

**`@IF(a, op, b, then, else)`** — five-argument form. **[F]** (tests)

-   `op` is one of `_` (EQ), `!_` (NE), `<`, `>`, `<_` (LE), `>_` (GE).
-   **If `a` or `b` is a STRING value, it is executed as code and its last statement's value is used.** This applies to a literal or a STRING variable. So `"VARSTEMP1"` evaluates the variable VARSTEMP1, `""OPEN""` evaluates the literal `"OPEN"` → `OPEN`, and `"2288"` → INTEGER 2288. Non-string operands are used as they are.
-   Comparison then follows §4.6.
-   `then` and `else` are callback values (§2.5.2): `{inline code}`, a behaviour name, `BEH(args)`, or `""` for nothing.
-   Ufo example:

    ```
    @IF("VARSTEMP1","!_",""OPEN"","BFITMP0","");
    ```

**`@IF(logic, then, else)`** — three-argument form. The `logic` string is parsed as in §3.7. Its operands are evaluated as ordinary parameters, _not_ executed as code. **[G]**

**`@LOOP(code, start, count, step)`** — **[F]** (`T:"@LOOP exposes _I_ counter"`)

-   Runs `code` (a callback value) for `i = start; i < start+count; i += step`.
-   Each iteration binds a local INTEGER **`_I_`** = i.

**`@WHILE(a, op, b, code)`**

-   Re-evaluates `a op b` before each iteration, with the same operand-as-code rule and operators as the five-argument `@IF`.
-   Runs `code` while the comparison is true. **[F]** (`T:"@WHILE runs until condition fails"`)

**`@BREAK()`** raises a _break_ interrupt (§4.10). **[F]**

**`@RETURN(v)`** ends the current code block and makes `v` its value. **[F]** (`T:"@RETURN returns value from behavior"`) Inside an `@IF` branch or a `@LOOP`/`@WHILE` body, it ends the block that runs the `@IF` or loop too (`T:"@RETURN in an @IF branch returns from the behaviour running the @IF"`). Kapitan Nemo's save class returns every value this way: `GET:CODE={…;@IF("ITMPPOS",">","-1","BFITMP122","BFITMP123");}` where `BFITMP122` ends with `@RETURN(STMPVALUE)`. **[F]** for the usage.

**Branch and body execution.** `@IF`, `@LOOP` and `@WHILE` run their branch or body with **interrupt forwarding**, so a break inside them propagates to the enclosing construct (§4.10). The branch code runs with the same caller and does not rebind THIS. **[G]**

**Other globals.** In `PIKLIB8.dll` the strings next to `IF`, `LOOP`, `WHILE`, `BREAK` and `RETURN` include `ONEBREAK`, `CONTINUE`, `STRING`, `INT`, `BOOL`, `DOUBLE`, `CREATE`, `RUNONTIMER`, `GETCURRENTSCENE`, `GETAPPLICATIONNAME`, `MSGBOX`, `CONV` and `STRUCT`. Across the six analysed titles (§8.1), the following are used:

-   **`@INT(name, init)`, `@STRING(name, init)`, `@BOOL(name, init)`, `@DOUBLE(name, init)`** declare a local variable of that type. They are used heavily in Kapitan Nemo (628 calls) and a few times in Czarodzieje `.class` files. The name is a quoted string and the initial value is any parameter, for example:

    ```
    @INT("DX2",[IMGPASEK^GETWIDTH()@3]);DX2^SET([DX2-IMGKROPA^GETWIDTH()]);
    ```

    After the declaration the variable is addressed by its bare name (`DX2^SET(…)`), and it is also used inside the `BFITMPn` behaviours that the block's `@IF`s call, e.g. `@BOOL("BCZYGRA",FALSE);…;@IF("BCZYGRA","_","TRUE","BFITMP0","")`. So its scope extends at least into behaviours run from the declaring block. The TS engine puts the variable in the innermost local scope, which makes it dynamic: every callee sees it until the block ends (`T:"@INT, @STRING, @BOOL and @DOUBLE declare locals visible to called behaviours"`). Redeclaring resets the value; this is common, because each run of the handler redeclares it. **[G]**

-   **`@MSGBOX(text)`**, 36 calls in Wehikuł Czasu, e.g. `@MSGBOX("GONZO__SAVEPOINT_FAILED")`. It is a debugging message box. The TS engine logs it as a warning, as it does `STRING^MSGBOX`.

`ONEBREAK`, `CONTINUE`, `CREATE`, `RUNONTIMER`, `GETCURRENTSCENE`, `GETAPPLICATIONNAME`, `CONV` and `STRUCT` are not used as `@` calls in any of the six titles. **[?]**

### 4.9 BEHAVIOUR, CONDITION, COMPLEXCONDITION, EXPRESSION

**BEHAVIOUR** — properties `CODE` (callback) and `CONDITION` (optional reference to a CONDITION or COMPLEXCONDITION) [engine/types/behaviour.ts].

| Method                                   | Meaning                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUN(args…)`                             | Run CODE with `$1..$n` = args. **Ignores CONDITION.** Catches break interrupts, so a break ends only this behaviour. Returns the `@RETURN` value or NULL. **[F]** (tests)                                                                                                                    |
| `RUNC(args…)`                            | Run only if CONDITION is absent or `CHECK(TRUE)` succeeds. Otherwise like RUN. **[G]**                                                                                                                                                                                                       |
| `RUNLOOPED(start, count, step=1, args…)` | For `i = start; i < start+count; i += step`: if the condition holds, run with **`$1`=i (INTEGER), `$2`=step**, then `$3..`=args. A break stops the loop; a one-break continues it. **[F]** for `$1` (`T:"RUNLOOPED passes the counter as an INTEGER, like @LOOP"`); **[G]** for `$2` = step. |

-   A callback that names a behaviour (`ONCLICK=BEH("X")`) runs it as **RUNC** with the constant arguments.
-   Inside `@IF`, `@LOOP` and `@WHILE` it runs as a conditional run _without_ catching interrupts. **[G]**

**CONDITION** — properties `OPERAND1`, `OPERAND2` (single-statement code), `OPERATOR` and two optional callbacks [engine/types/condition.ts]. **[G]** unless noted.

-   `OPERATOR` is one of EQUAL, NOTEQUAL, LESS, GREATER, LESSEQUAL, GREATEREQUAL.
-   The callbacks are `ONRUNTIMESUCCESS` and `ONRUNTIMEFAILED`.
-   `check(signal)` evaluates both operands, without binding THIS, and compares them (§4.6). If `signal` is true it then fires `ONRUNTIMESUCCESS` or `ONRUNTIMEFAILED`.

| Method              | Meaning                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CHECK(signal)`     | Returns BOOL.                                                                                                        |
| `BREAK(signal)`     | If true, raises a _break_ interrupt, which stops the enclosing loop or behaviour.                                    |
| `ONE_BREAK(signal)` | If true, raises a _one-break_ interrupt, which `continue`s the enclosing loop. Outside a loop it ends the behaviour. |

-   Ufo always calls these with `TRUE`, as in `CCONDISATPOS^ONE_BREAK(TRUE)`.

**COMPLEXCONDITION** — `CONDITION1`, `CONDITION2`, `OPERATOR` = `AND` | `OR`, plus the same callbacks.

-   It **short-circuits**.
-   The sub-conditions are checked with the same `signal` flag.
-   The complex condition's own success/failure callbacks fire **regardless** of the flag. **[?]** This asymmetry with CONDITION looks accidental.

**EXPRESSION** — `OPERAND1`, `OPERAND2` (single-statement code) and `OPERATOR` = `ADD` | `SUB` | `MUL` | `DIV` | `MOD`.

-   It is a value-typed object whose value is recomputed on every read: `operand1 op operand2`, typed per §4.5.
-   The operands run with THIS = the expression.
-   Ufo example:

    ```
    EXPMASKX:OPERAND1=ANIMOMASKA^GETPOSITIONX()
    EXPMASKX:OPERATOR=ADD
    EXPMASKX:OPERAND2=VARMASKDX
    ```

-   ARRAY^ADD stores the evaluated result with its type. **[F]** (`array.test.ts`)

### 4.10 Interrupts, returns, errors

[common/errors.ts; interpreter/interpreter.ts:282-373, 459-489; engine/components/callbacks.ts:62-101]

| Signal           | Raised by                               | Caught by                                                                                                                                                                                                              |
| ---------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **break**        | `@BREAK`, `COND^BREAK(TRUE)`            | Innermost `@LOOP`, `@WHILE` or `RUNLOOPED` (stops the loop); otherwise the innermost `BEHAVIOUR^RUN`/`RUNC` (ends the behaviour); otherwise the callback dispatcher (ends the handler). Passes through `@IF` branches. |
| **one-break**    | `COND^ONE_BREAK(TRUE)`                  | Same boundaries, but loops treat it as _continue_.                                                                                                                                                                     |
| **return(v)**    | `@RETURN(v)`                            | The innermost executing code string that isn't an `@IF` branch or a loop body; its value becomes v.                                                                                                                    |
| **scene change** | `EPISODE^GOTO(scene)`, `EPISODE^BACK()` | Aborts _all_ running script (the entire tick) and then switches scene. Statements after GOTO never run. GOTO requires the scene to be listed in the episode's `SCENES`.                                                |

-   **[F]** for break, loop and return (tests).
-   **[G]** for the dispatcher boundary and for scene change.

**Script errors.** A failing method call has these effects [interpreter/interpreter.ts:342-364]. **[G]** This is engine policy.

| Failure                                                   | Effect                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Bad argument, assertion or similar                        | The error is logged and **the rest of the current code string is abandoned**. Callers' code continues. |
| Unimplemented method                                      | Logged; the call yields NULL and execution continues.                                                  |
| Parse errors, unknown `@`, bare methods, division by zero | Not contained. They propagate up and pause the TS engine.                                              |

### 4.11 Event callbacks and dispatch

[engine/components/callbacks.ts] **[G]** except where noted.

-   Every `callback` or `callbacks` property in a type's schema is registered automatically.
-   `run(EVENT, param)` dispatches as follows:
    -   If `param` is given and a parametrised handler with that key exists, run it.
    -   **Otherwise run the default (non-parametrised) handler, if any.**
    -   Only one handler runs. **[F]** (the shape is confirmed by data: e.g. `ONFINISHED^ONNOEVENT` plus default handlers)
-   The handler runs with THIS = the object and caller = the object.
    -   Handler code receives no `$n` arguments, except MATRIX `ONNEXT`/`ONLATEST` (`$1`=x, `$2`=y, `$3`=action).
    -   A behaviour-reference handler receives its constant arguments.
-   Break interrupts are swallowed at the handler boundary.
-   **Handlers run to completion.** No other callback starts while one is running, even when it waits for a file to load; the TS engine skips ticks while the previous one is still running. Scripts depend on this, because handlers share global temporaries: in Czarodzieje's ARCADE a click handler and a sequence handler both use `VARITEMP0`. **[G]**
-   **Parameter matching** is exact against the converted key:
    -   Upper-cased event name for ANIMO `ONFINISHED`, `ONSTARTED` and `ONFRAMECHANGED`.
    -   The new value for `ONCHANGED`/`ONBRUTALCHANGED`: numeric for INTEGER, string for STRING, boolean for BOOL.
    -   Tick number for TIMER `ONTICK`.
    -   Key name for KEYBOARD (`UP`, `DOWN`, `LEFT`, `RIGHT`, `SPACE`, `1`, `2`).
    -   Button name for MOUSE (`LEFT`, `RIGHT`).
    -   Played name for SEQUENCE `ONFINISHED`, and the element name for each finished element (§2.8).
    -   Colliding object's name for ANIMO `ONCOLLISION`.
-   **Value change events:**
    -   `ONCHANGED` fires when a set changes the value.
    -   `ONBRUTALCHANGED` fires on _every_ set, even when the value is unchanged. It fires after ONCHANGED.
-   **`ANIMO^ADDBEHAVIOUR("EVENT$PARAM", "BEH")`** registers a behaviour as a handler at runtime. `$` separates the parameter.
-   **[?] ONSIGNAL.** Ufo uses `IWAV:ONSIGNAL^3={THIS^SET(1);}` and `IBLA3X:ONSIGNAL^-125=BB_S("ABLA3")`. The TS engine has a `signal(name)` hook, but ONSIGNAL is in no schema and nothing raises signals. Neither the trigger (a `SIGNAL`/`SEND` method?) nor the parameter semantics are known. The WORLD plugin is one known source (§8.2).

---

## 5. Object model

The common methods are on every object; the value-object and display-object methods only on those kinds [engine/types/index.ts]:

| Applies to                     | Methods                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| All objects                    | `GETNAME()`, `CLONE(n)`, `GETCLONEINDEX()`, `ADDBEHAVIOUR(event[^ or $param], beh)`, `REMOVEBEHAVIOUR(event[^ or $param])` |
| Value objects                  | `RESETINI()` (restore DEFAULT/VALUE and persist), `COPYFILE(from,to)`                                                      |
| Display objects (ANIMO, IMAGE) | `GETPRIORITY()`, `SETPRIORITY(p)`                                                                                          |

Properties marked `?` are optional. `cb` is a callback and `cbs<k>` is a parametrised callback set keyed by kind k [fileFormats/cnv/types.ts]. Method signatures are summarised from the TS declarations. The set is complete for the TS engine but certainly incomplete for Piklib.

| TYPE                                   | Definition properties                                                                                         | Callbacks                                                                                                   | Methods (TS engine)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APPLICATION                            | DESCRIPTION, CREATIONTIME, LASTMODIFYTIME, AUTHOR, VERSION, PATH, EPISODES(list), STARTWITH                   | —                                                                                                           | SETLANGUAGE(lcid), GETLANGUAGE, RUN(obj, method, args…), RUNENV(scene, beh, args…), EXIT                                                                                                                                                                                                                                                                                                                                                                                                        |
| EPISODE                                | DESCRIPTION, CREATIONTIME, LASTMODIFYTIME, AUTHOR, VERSION, PATH?, SCENES(list), STARTWITH                    | —                                                                                                           | GOTO(scene), BACK, GETCURRENTSCENE, GETLATESTSCENE                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SCENE                                  | DESCRIPTION?, CREATIONTIME, LASTMODIFYTIME, VERSION, PATH, BACKGROUND?, MUSIC?, DLLS?(list)                   | —                                                                                                           | RUN(obj, method, args…), RUNCLONES(base, from, to, beh), STARTMUSIC(file), SETMUSICVOLUME(int), GET/SETMIN/MAXHSPRIORITY, GETPLAYINGANIMO(group), RESUME(unimpl.)                                                                                                                                                                                                                                                                                                                               |
| BEHAVIOUR                              | CODE(cb), CONDITION?(ref)                                                                                     | —                                                                                                           | RUN, RUNC, RUNLOOPED                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| CONDITION                              | OPERAND1(code), OPERATOR, OPERAND2(code)                                                                      | ONRUNTIMESUCCESS, ONRUNTIMEFAILED                                                                           | CHECK(b), BREAK(b), ONE_BREAK(b)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| COMPLEXCONDITION                       | CONDITION1(ref), CONDITION2(ref), OPERATOR(AND/OR)                                                            | ONRUNTIMESUCCESS, ONRUNTIMEFAILED                                                                           | CHECK, BREAK, ONE_BREAK                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| EXPRESSION                             | OPERAND1(code), OPERATOR(ADD/SUB/MUL/DIV/MOD), OPERAND2(code)                                                 | —                                                                                                           | (value only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| INTEGER                                | VALUE?, DEFAULT?, TOINI?, VARTYPE?                                                                            | ONINIT, ONCHANGED cbs<num>, ONBRUTALCHANGED cbs<num>                                                        | SET, GET, INC, DEC, ADD, SUB, MUL, DIV, MOD, AND, CLAMP(min,max), SWITCH(a,b), ABS(v), RANDOM(offset,range)                                                                                                                                                                                                                                                                                                                                                                                     |
| DOUBLE                                 | VALUE?, DEFAULT?, TOINI?                                                                                      | —                                                                                                           | SET, GET, ADD, SUB, MUL, DIV, MAXA(…), MINA(…), SINUS(deg), COSINUS(deg), ARCTANEX(y,x[,add]), LENGTH(x,y), CLAMP(min,max), SQRT                                                                                                                                                                                                                                                                                                                                                                |
| STRING                                 | VALUE?, DEFAULT?, TOINI?                                                                                      | ONINIT, ONCHANGED cbs<str>, ONBRUTALCHANGED cbs<str>                                                        | SET, GET([i[,len=1]]), ADD, SUB(start,len) (delete), FIND(needle[,start]) (−1 if none), LENGTH, CUT(start[,len]), REPLACEAT(i,text) (overwrites), UPPER                                                                                                                                                                                                                                                                                                                                         |
| BOOL                                   | VALUE?, DEFAULT?, TOINI?                                                                                      | ONCHANGED cbs<bool>, ONBRUTALCHANGED cbs<bool>                                                              | SET, SWITCH (toggles; args ignored)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ARRAY                                  | —                                                                                                             | ONINIT                                                                                                      | ADD(v…), GET(i), CHANGEAT, INSERTAT, REMOVEAT, REMOVEALL, GETSIZE, FIND, REVERSEFIND, CONTAINS, ADDAT/SUBAT/MULAT/MODAT/CLAMPAT, SUM, LOAD(arr), SAVE(arr), LOADINI, SAVEINI, MSGBOX, REMOVE(v) (first equal), COPYTO(array) (appends), GETSUMVALUE                                                                                                                                                                                                                                             |
| MULTIARRAY                             | DIMENSIONS                                                                                                    | —                                                                                                           | SET(y,x,v), GET(y,x)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| VECTOR                                 | SIZE, VALUE(list num)                                                                                         | —                                                                                                           | ASSIGN(…), ADD(vec), MUL(s), GET(i), NORMALIZE, REFLECT(n,out), LEN                                                                                                                                                                                                                                                                                                                                                                                                                             |
| STRUCT                                 | FIELDS (`name<TYPE>,…`)                                                                                       | —                                                                                                           | GETFIELD, SETFIELD(name, v), SET(otherStruct); `S\|FIELD` syntax                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DATABASE                               | MODEL(ref STRUCT)                                                                                             | ONINIT                                                                                                      | LOAD, SAVE, NEXT, PREV, SELECT(i), FIND(col, v, off) (searches from off, selects the match, −1 if none; strings ignore case), GETROWSNO, GETCURSORPOS, REMOVEAT, REMOVEALL; exposes `<NAME>_CURSOR`                                                                                                                                                                                                                                                                                             |
| CLASS                                  | DEF (file), BASE?                                                                                             | —                                                                                                           | NEW(name, args…) → instance; the constructor gets name as `$1`; other calls run the instance behaviour of that name and return its value                                                                                                                                                                                                                                                                                                                                                        |
| GROUP                                  | —                                                                                                             | ONINIT                                                                                                      | ADD(names…), REMOVE(names…), ADDCLONES(name, from, to) (0 = the original), GETSIZE, SETMARKERPOS/GETMARKERPOS; other calls forwarded to members, including CLASS instances                                                                                                                                                                                                                                                                                                                      |
| ANIMO                                  | VISIBLE, FILENAME, TOCANVAS, PRIORITY?, FPS?, PRELOAD?, RELEASE?, MONITORCOLLISION?, MONITORCOLLISIONALPHA?   | ONINIT, ONFINISHED/ONSTARTED/ONFRAMECHANGED/ONCOLLISION cbs<str>, ONFOCUSON, ONFOCUSOFF, ONCLICK, ONRELEASE | PLAY([ev]), STOP, PAUSE, RESUME, SHOW, HIDE, ISVISIBLE, ISPLAYING([ev]), SETFRAME, SETFPS, MOVE, SETPOSITION, GETPOSITIONX/Y([arg]) (with any arg: the SETPOSITION position; §8.1), GETCENTERX/Y, GETFRAME, GETFRAMENAME, GETEVENTNAME, GETNOF, GETNOE, GETNOFINEVENT, GETCFRAMEINEVENT, GETCURRFRAMEPOSX/Y, GETMAXWIDTH, SETANCHOR, SETOPACITY, SETASBUTTON, DISABLE, ISNEAR, MONITORCOLLISION, REMOVEMONITORCOLLISION, ADDBEHAVIOUR, LOAD, NPLAY, NEXTFRAME, PREVFRAME, MERGEALPHA, GETENDX/Y |
| IMAGE                                  | VISIBLE, FILENAME, TOCANVAS, PRIORITY?, PRELOAD?, RELEASE?, MONITORCOLLISION?, MONITORCOLLISIONALPHA?         | ONINIT                                                                                                      | SHOW, HIDE, MOVE, SETPOSITION, GETPOSITIONX/Y, SETOPACITY, GETALPHA, MERGEALPHA, SETCLIPPING, INVALIDATE, LOAD, MERGEALPHA2, GETWIDTH, GETHEIGHT, GETPIXEL(x,y) (signed RGB565)                                                                                                                                                                                                                                                                                                                 |
| BUTTON                                 | ENABLE, DRAGGABLE?, VISIBLE?, GFXSTANDARD?, GFXONCLICK?, GFXONMOVE?, SNDONMOVE?, RECT?(4 nums or ref)         | ONINIT, ONACTION, ONCLICKED, ONRELEASED, ONFOCUSON, ONFOCUSOFF, ONSTARTDRAGGING, ONDRAGGING, ONENDDRAGGING  | ENABLE, DISABLE, DISABLEBUTVISIBLE, SETPRIORITY, SETRECT(object or x1,y1,x2,y2), SETSTD                                                                                                                                                                                                                                                                                                                                                                                                         |
| TEXT                                   | VISIBLE, TOCANVAS, RECT, PRIORITY, FONT, MONITORCOLLISION, MONITORCOLLISIONALPHA, TEXT?, HJUSTIFY?, VJUSTIFY? | ONINIT                                                                                                      | SETTEXT, SETCOLOR, SETPOSITION, SHOW, HIDE, SETJUSTIFY(x1,y1,x2,y2,h,v)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| FONT                                   | `DEF_<family>_<style>_<size>`                                                                                 | ONINIT                                                                                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SOUND                                  | FILENAME, PRELOAD?, RELEASE?, FLUSHAFTERPLAYED?                                                               | ONINIT, ONSTARTED, ONFINISHED                                                                               | PLAY, STOP, PAUSE, RESUME, ISPLAYING, RELEASE, SETFREQ, LOAD, SETVOLUME                                                                                                                                                                                                                                                                                                                                                                                                                         |
| MUSIC                                  | FILENAME                                                                                                      | —                                                                                                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SEQUENCE                               | FILENAME (.seq)                                                                                               | ONINIT, ONSTARTED/ONFINISHED cbs<str>                                                                       | PLAY(name), STOP, HIDE, ISPLAYING, PAUSE, RESUME, GETEVENTNAME                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| TIMER                                  | ELAPSE (ms), ENABLED?, TICKS?                                                                                 | ONINIT, ONTICK cbs<num>                                                                                     | ENABLE, DISABLE, RESET, SET(tick), SETELAPSE, GETTICKS                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| MOUSE                                  | —                                                                                                             | ONINIT, ONMOVE, ONCLICK/ONDBLCLICK/ONRELEASE cbs<str>                                                       | ENABLE, DISABLE, ENABLESIGNAL, DISABLESIGNAL, SHOW, HIDE, SET(cursor), GETPOSX/Y, SETPOSITION, ISLBUTTONDOWN                                                                                                                                                                                                                                                                                                                                                                                    |
| KEYBOARD                               | —                                                                                                             | ONKEYDOWN/ONKEYUP cbs<str>                                                                                  | ISKEYDOWN, ISENABLED, DISABLE, SETAUTOREPEAT                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| CANVAS_OBSERVER (alias CANVASOBSERVER) | —                                                                                                             | —                                                                                                           | SETBACKGROUND, REFRESH, REDRAW, REMOVE, ADD, SETBKGPOS(x,y) (view origin), MOVEBKG(dx,dy) (moves the view), PASTE(obj,x,y), GETGRAPHICSAT, SAVE, ENABLENOTIFY                                                                                                                                                                                                                                                                                                                                   |
| CNVLOADER                              | —                                                                                                             | —                                                                                                           | LOAD(file) (loads a CNV into the current scene)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| RAND                                   | —                                                                                                             | —                                                                                                           | GET(min[,max]), GETPLENTY(arr, n, min, max, unique)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SYSTEM                                 | —                                                                                                             | —                                                                                                           | GETDATE (packed date int)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| MATRIX                                 | BASEPOS, CELLWIDTH, CELLHEIGHT, SIZE                                                                          | ONNEXT/ONLATEST cbs<str>                                                                                    | GET/SET, SETROW, SETGATE, MOVE, NEXT, TICK, CAN/IS/CALC… (game-specific)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| STATICFILTER / FILTER                  | ACTION                                                                                                        | —                                                                                                           | SETPROPERTY, LINK, UNLINK                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| WORLD (plugin, §8.2)                   | FILENAME                                                                                                      | — (raises ONSIGNAL on linked ANIMOs)                                                                        | LOAD, START/STOP, ADDBODY, LINK/UNLINK, SETPOSITION, SETVELOCITY, ADDFORCE, SETGRAVITY, SETLIMIT, SETMAXSPEED, FINDPATH, FOLLOWPATH, MOVEOBJECTS, GETPOSITIONX/Y/Z, GETANGLE, GETMOVEDISTANCE, SETBKGSIZE, SETREFOBJECT, GETBKGPOSX/Y                                                                                                                                                                                                                                                           |
| PATTERN                                | GRIDX, GRIDY, WIDTH, HEIGHT, LAYERS, PRIORITY, TOCANVAS, VISIBLE                                              | ONINIT                                                                                                      | ADD(alias, cellX, cellY, object, layer), REMOVE, MOVE, SETPOSITION, GETGRAPHICSAT → object name or `NULL`. Entries show the named object's current frame at (cellX·GRIDX, cellY·GRIDY). **[G]**                                                                                                                                                                                                                                                                                                 |

Notes:

-   **Built-in singletons:** `RANDOM` (RAND), `SYSTEM` and `CNVLOADER` exist without declaration. **[G]**
-   **Struct side effect:** STRUCT field sub-objects are registered in the parent scope under their **bare field names**, so a field can shadow other objects. **[G]**/**[?]** This is probably an engine artefact.
-   **[?] Types missing from the TS engine.** The Piklib DLL symbols reference runners that the TS engine lacks: EDITBOX, SCROLL, JOYSTICK, DIALOG, NETSERVER, NETCLIENT and CANVAS. They also list events such as ONDONE, ONCHAR, ONCOLLISIONFINISHED, ONPAUSED/ONRESUMED, ONFIRSTFRAME, ONMUSICLOOPED and ONSIGNAL. Treat these as pointers for further work.

---

## 6. Worked examples (Ufo)

**Callback with an inline block and a parametrised key:**

```
ANIMOREKSIO:ONFINISHED^WYCHODZI={PRZYGODA^GOTO("S14_3_PODWORKO");}
```

When ANIMOREKSIO finishes event `WYCHODZI`, the episode switches scene and the rest of the tick is abandoned.

**Behaviour with a guard and argument substitution:**

```
BEHADDITEMTOMENU:CONDITION=CONDMENUSIZE
BEHADDITEMTOMENU:CODE={ARRAYWARSZTATMENUPRZEDMIOTY^ADD($1);VARSTRINGTEMP^SET(["ANIMO"+$1]);UFO^RUN(["ANIMO"+$1],"SETASBUTTON",FALSE,FALSE);...}
ANIMOLINA:ONCLICK=BEHADDITEMTOMENU("LINA")
```

1. The click handler RUNCs the behaviour with the constant argument `"LINA"`.
2. CONDMENUSIZE (`ARRAYWARSZTATMENUPRZEDMIOTY^GETSIZE() LESS 6`) is checked and signalled. On failure it plays `SNDKIESZEN`.
3. `$1` is textually replaced by `"LINA"`, giving `["ANIMO"+"LINA"]` → `ANIMOLINA`.
4. `UFO^RUN` then calls `ANIMOLINA^SETASBUTTON(FALSE,FALSE)` dynamically.

**`@IF` with operand-as-code:**

```
B_CHECK:CODE={VAR_KOD^SET([KALKULATOR1000^GETFRAMENAME()+KALKULATOR100^GETFRAMENAME()]);
              VAR_KOD^ADD([KALKULATOR10^GETFRAMENAME()+KALKULATOR1^GETFRAMENAME()]);
              @IF("VAR_KOD","!_","2288","BFITMP0","BFITMP1");}
```

`"VAR_KOD"` runs as code and yields the STRING variable. `"2288"` runs as code and yields INTEGER 2288. The STRING comparison is case-insensitive on `"2288"`.

**Integer division and modulo in brackets:**

```
MAT^SET([I_FIELD_INDEX%I_LEVEL_WIDTH],[I_FIELD_INDEX@I_LEVEL_WIDTH],IC_FIELD_CODE_EMPTY);
```

---

## 7. Summary of confidence and open questions

### 7.1 Well-founded (backed by tests or "mirrors original" notes)

-   CNV decryption.
-   Line folding with `/`, comment rules, `:`/`=` tokenisation, the OBJECT leftover-token quirk and value re-joining.
-   Space removal in code. One-digit `$n` substitution.
-   Statement and parameter classification order.
-   Left-to-right bracket arithmetic with no precedence.
-   Left-operand typing of arithmetic.
-   Right-to-left-type conversion in comparisons, including `0==NULL`, `NULL!="0"` and case-insensitive string equality.
-   atoi/atof conversions and the Piklib double format, including the `0.-34000` quirk.
-   Method argument conversion and return wrapping.
-   `@IF` (5-argument), `@LOOP` with `_I_`, `@WHILE`, `@BREAK` and `@RETURN`.
-   `RUN` ignoring the last statement's value.
-   Missing-object calls skipped.
-   Scope search order.
-   ARRAY element typing; DTA field shifting.

### 7.2 Engine guesses or approximations

-   Object initialisation priority.
-   Dynamic THIS inheritance in behaviours; lexical resolution relative to the declaring scope.
-   Error containment policy.
-   RUNC, RUNLOOPED `$2`=step.
-   COMPLEXCONDITION signalling.
-   SEQ semantics and its lenient parser.
-   INI persistence types.
-   Language-directory lookup, `$` path prefix and default asset directories.
-   The CNV "TYPE must come first" fatal error.

### 7.3 Open questions

1. What do **`CONV…`**, **`#` direct references**, `#`-methods and **bare `METHOD()`** calls mean? What do the unused **`@` globals** do (ONEBREAK, CONTINUE, CREATE, RUNONTIMER, …), and what exactly is the scope of `@INT`/`@STRING` locals (§4.8)?
2. Which events does a plugin raise through **ONSIGNAL**, and what do the numeric parameters from WORLD identify (§8.2)?
3. Do the original **bracket expressions** respect parentheses and quotes, and how are negative literals written inside them?
4. Does `@BREAK` inside an `@IF` behaviour branch really escape to the enclosing loop? (`@RETURN` in a branch returns from the enclosing block: Kapitan Nemo's save class depends on it, §4.8.)
5. Is **name resolution** in the original lexical per container (as here) or dynamic (always current scene first)?
6. Which **string form of DOUBLE** is used in `+` concatenation and `$n` substitution: the Piklib 5-decimal format or the short form?
7. Is the **character encoding** CP1250 throughout? Can SEQ files be encrypted? How does decryption behave on byte overflow? Is the ±0x20 corruption (only in never-loaded files) present in the original data?
8. Is **SPEAKING's field** `ANIMOFN` (data) or `ANIMOFX` (schema)?
9. How does the original handle **properties assigned before TYPE**, and objects of **unknown TYPE**?
10. Do callbacks receive the event parameter as **`$1`**? The TS engine only passes arguments for MATRIX.
11. Do _Kretes w Akcji_ and the other BlooMoo titles need syntax beyond §3? The three later titles analysed in §8.1 do not. Do the new `GRBUFFER` and `INTERNET` types appear in any script?

---

## 8. Versions, extensions and sources of truth

### 8.1 Engine versions and how the language evolved

Six titles were analysed: the three from the GamesFiles repository and three from the patched community releases (_Czarodzieje_, _Wehikuł Czasu_, _Kapitan Nemo_). Script dates come from the `LASTMODIFYTIME` properties in the title's CNV files. DLL dates are PE link timestamps. Exports and classes come from the PE export table, demangled with `llvm-undname`.

| Title                    | Scripts up to             | Engine DLL (link date)        | Plugin DLLs                             | Exports | C++ classes |
| ------------------------ | ------------------------- | ----------------------------- | --------------------------------------- | ------- | ----------- |
| _Reksio i Ufo_ demo      | 2003-03                   | `PIKLIB71.dll` (2003-04-02)   | —                                       | 3,505   | 184         |
| _Reksio i Skarb Piratów_ | 2002                      | `PIKLIB8.dll` (2004-08-19)    | `Kolorowanka.dll`                       | 4,281   | 207         |
| _Reksio i Ufo_           | 2003, a few files 2004-08 | `PIKLIB8.dll` (2004-08-19)    | `Matrix.dll`                            | 4,281   | 207         |
| _Reksio i Czarodzieje_   | 2004-05                   | `PIKLIB8.dll` (2004-05-19)    | `World.dll` + `Sekai.dll`               | 4,223   | 204         |
| _Reksio i Wehikuł Czasu_ | 2004-12                   | `BlooMooDLL.dll` (2004-10-27) | `World.dll` + `Sekai.dll`, `sndDLL.dll` | 4,425   | 223         |
| _Reksio i Kapitan Nemo_  | 2006-09                   | `bloomoodll.dll` (2006-07-17) | `snddll.dll`                            | 4,746   | 236         |

Notes on the table:

-   The Skarb Piratów and Ufo copies carry a PIKLIB8 build from August 2004, three months _newer_ than the one shipped with Czarodzieje. The Skarb Piratów and Ufo DLLs differ in checksum but have identical export tables. A few Ufo scripts were also edited in July–August 2004. Engine DLLs were evidently updated in re-releases, so a title's engine is not necessarily the one it was written against.
-   **BlooMoo** is the renamed Piklib. It keeps the same `CMC_<Type>` / `CMC_<Type>_Runner` object model. Kapitan Nemo's build is linked against the MSVC 8 runtime and its `APPLICATION` declares `BLOOMOO_VERSION=BW.1.0.0`, a property the TS schema does not know.
-   `sndDLL.dll` exports only `sf_open`, `sf_readf_short` and `sf_close` (libsndfile), so it is an audio decoder, not a script extension.
-   Counting upper-case strings in the DLL (the "vocabulary") is noisy, because x86 code fragments such as `PQSUVW` match too. Use the export table, or the per-runner string clusters (§8.3), for exact comparisons.

**The grammar did not change.** The TS CNV parser and statement parser accept every code block of all six titles, and every file except the four corrupted Ufo leftovers. The count below is the number of `{…}` values in CNV, DEF and `.class` files. Each block is parsed with `parseCode` after the same space removal the engine performs.

| Title         | CNV/DEF/CLASS files | SEQ files | Code blocks | Parse failures                                      |
| ------------- | ------------------- | --------- | ----------- | --------------------------------------------------- |
| Ufo demo      | 21                  | 8         | 576         | 0                                                   |
| Skarb Piratów | 65                  | 76        | 2,952       | 0                                                   |
| Ufo           | 102                 | 78        | 3,909       | 4 files (the unreferenced, corrupted files of §2.2) |
| Czarodzieje   | 134                 | 42        | 5,274       | 0                                                   |
| Wehikuł Czasu | 196                 | 104       | 11,794      | 0                                                   |
| Kapitan Nemo  | 48                  | 59        | 8,228       | 0                                                   |

The parser is lenient, so "parses" means "no ParseError", not "means what the author intended" (see §8.4 for blocks that parse but are broken). The ±0x20 byte corruption of §2.2 does not occur in the three later titles.

**The API grew.**

-   Piklib 8 adds the runtime classes CLASS, DATABASE, MULTIARRAY, STRUCT (`CMC_Structure`), PATTERN, JOYSTICK, SCROLL, VIRTUALGRAPHICSOBJECT and CANVAS, plus the `CANVASOBSERVER` spelling. Piklib 7.1 has NETPEER and the older plugin interface `CDLLUnitInterface`, both absent from Piklib 8.
-   BlooMoo (Wehikuł Czasu) brings NETPEER back together with a file-transfer layer (`CFileSender_*`, `CFileReceiver_*`, `CNet*Message`).
-   Kapitan Nemo's BlooMoo adds the types `GRBUFFER` (`CMC_GrBuffer`) and `INTERNET` (`CMC_Internet`), self-extraction and upgrade machinery (`CSelfExtract`, `CDownloadManagerIfc`), and new script-visible names such as `GETFPS`, `ISLBUTTONDOWN`, `REMOVEBEHAVIOURFORCE`, `REPLACECOLOR`, `GETWORDAT` and `ISFILEEXIST`.
-   **WORLD** is not a built-in type. It is registered by the `World.dll` plugin, which scenes load with `DLLS=WORLD` (5 scenes in Czarodzieje, 6 in Wehikuł Czasu; §8.2). **RAND as a declarable TYPE** appears in no engine DLL. The single `TYPE=RAND` object in Ufo is probably ignored by the original; `RANDOM` itself is a built-in (§5).

**Idioms shifted between titles,** while the grammar stayed the same. Approximate counts from a regular-expression scan of the decrypted CNV, DEF and `.class` files:

| Construct                                         | Ufo demo   | Skarb Piratów  | Ufo          | Czarodzieje        | Wehikuł Czasu       | Kapitan Nemo       |
| ------------------------------------------------- | ---------- | -------------- | ------------ | ------------------ | ------------------- | ------------------ |
| `@IF` (5-argument / 3-argument)                   | 0          | 19 / 33        | 9 / 0        | 1,762 / 285        | 3,409 / 444         | 2,635 / 410        |
| `@BREAK` / `@LOOP` / `@WHILE` / `@RETURN`         | 0          | 34 / 1 / 0 / 0 | 0            | 373 / 168 / 7 / 24 | 528 / 292 / 15 / 31 | 56 / 239 / 37 / 29 |
| `@INT` / `@STRING` / `@BOOL` / `@DOUBLE`          | 0          | 0              | 0            | 3 / 1 / 0 / 0      | 0                   | 399 / 198 / 26 / 5 |
| `@MSGBOX`                                         | 0          | 0              | 0            | 0                  | 36                  | 0                  |
| CONDITION / COMPLEXCONDITION / EXPRESSION objects | 47 / 0 / 0 | 810 / 127 / 42 | 403 / 20 / 8 | 3 / 0 / 0          | 9 / 0 / 0           | 0                  |
| BEHAVIOUR objects                                 | 194        | 1,948          | 1,438        | 3,915              | 7,761               | 4,436              |
| CLASS / STRUCT / DATABASE objects                 | 0          | 0 / 0 / 0      | 0            | 7 / 17 / 17        | 8 / 10 / 11         | 13 / 5 / 6         |
| `[..]` bracket expressions                        | 60         | 19             | 481          | 1,073              | 4,421               | 3,616              |
| `$n` arguments                                    | 85         | 5              | 262          | 149                | 389                 | 243                |
| `*` indirect references                           | 0          | 3              | 0            | 1,665              | 3,778               | 1,263              |
| `OBJ\|FIELD` struct-field access                  | 0          | 0              | 0            | 710                | 133                 | 22                 |
| `BEH(args)` callback values                       | 92         | 6              | 391          | 6                  | 18                  | 0                  |

What the trend shows:

-   From Czarodzieje on, control flow moves from CONDITION/COMPLEXCONDITION/EXPRESSION objects to inline `@IF`. CONDITION objects all but disappear.
-   The 3-argument `@IF` with the logic mini-language of §3.7 is used 285–444 times per later title, so its **[G]** semantics matter. The scripts use `'`, `!'`, `<`, `>`, `<'`, `>'`, `&&` and `||`. No condition mixes `&&` with `||`, which is consistent with the no-mixing rule.
-   `*` indirection, `|` field access, `.class` instances and DATABASE tables carry most of the data-driven logic of the later titles.
-   Kapitan Nemo declares block-local variables with `@INT("NAME", init)`, `@STRING`, `@BOOL` and `@DOUBLE` (§4.8).
-   `BFITMPn` behaviours, the targets of nearly every `@IF`, are generated code. The authoring tool compiled structured source of the form `@IF(cond){then}ELSE{else}` into a 5- or 3-argument `@IF` plus one behaviour per branch, named `BFITMP<n>`. §8.4 lists blocks where that compilation went wrong.

An implementation that only runs one title can therefore leave whole areas untested. Examples are `@IF` semantics with Ufo, bracket arithmetic with Skarb Piratów, and local variables with anything older than Kapitan Nemo.

**What the later titles need beyond the TS engine.** These come from a static resolution of `OBJ^METHOD` calls against the objects each file can see. It is approximate: names reused across scenes can misattribute a call, and GROUP calls are excluded because GROUP forwards them.

-   **Globals.** `@INT`, `@STRING`, `@BOOL`, `@DOUBLE` and `@MSGBOX` are used. The TS engine now implements them (§4.8).
-   **Types.**
    -   WORLD needs most of `World.dll`'s methods, including `FINDPATH` (125 calls in Wehikuł Czasu), `SETACTIVE`, `ADDFORCE`, `GETPOSITIONX/Y/Z`, `JOIN`, `REMOVEOBJECT` and `SETGRAVITYCENTER`. The TS engine now has the subset the scripts call (§8.2), with joints approximated and no collisions between bodies.
    -   PATTERN (Czarodzieje: `ADD`, `MOVE`, `GETGRAPHICSAT`, and the properties `LAYERS`, `GRIDX`, `GRIDY`, `WIDTH`, `HEIGHT`) is now implemented (§5).
-   **Methods**, among others:

    -   `SEQUENCE^PAUSE`/`RESUME` (over 200 calls each in Wehikuł Czasu);
    -   `KEYBOARD^ENABLE`, `CNVLOADER^RELEASE`, `SCENE^PAUSE`, `SCENE^REMOVECLONES`;
    -   `ANIMO^NEXTFRAME`/`PREVFRAME`/`NPLAY`/`MERGEALPHA`/`GETENDX`/`GETENDY`, and `SETANCHOR(x, y)` with a pixel position;
    -   `IMAGE^MERGEALPHA2`, `SOUND^SETVOLUME`, `TEXT^SETCOLOR`/`SETPOSITION`, `TIMER^GETTICKS`;
    -   `CANVAS_OBSERVER^PASTE`/`MOVEBKG`/`SETBKGPOS`/`ADD`;
    -   `STRING^UPPER`/`REPLACEAT`/`CUT`, `ARRAY^REMOVE`, `DOUBLE^CLAMP`, `IMAGE^GETPIXEL`;
    -   `INTEGER^ADDBEHAVIOUR` and `STRING^ADDBEHAVIOUR`/`REMOVEBEHAVIOUR` (Kapitan Nemo). These bind event handlers at run time, e.g. `ICOLLBELKASEL^ADDBEHAVIOUR(["ONBRUTALCHANGED^"+I5],"BEHCOLLBELKI")`.

    The Czarodzieje, Wehikuł Czasu and Kapitan Nemo passes implemented everything in this list. Kapitan Nemo also needed `ARRAY^COPYTO` (appends: `CMC_Array_Runner::copyTo` calls the target's `add` for each element and clears nothing **[F]**)/`GETSUMVALUE`, `DOUBLE^SQRT`, `IMAGE^GETWIDTH`/`GETHEIGHT`, `GROUP^ADDCLONES`/`GETSIZE`/`SETMARKERPOS`, `MOUSE^ISLBUTTONDOWN`, `TEXT^SHOW`/`HIDE`/`SETJUSTIFY` and `BUTTON^SETRECT(x1,y1,x2,y2)`.

-   **Events and properties** the TS schema does not know:

    -   `ONSIGNAL^<param>` on ANIMO: 506 handlers in Wehikuł Czasu, with numeric parameters and `ATGOAL`/`NOPATH` (§8.2);
    -   `ONCHAR^<key>` on KEYBOARD;
    -   `ONWINDOWFOCUSON`/`ONWINDOWFOCUSOFF` on CANVAS_OBSERVER;
    -   `ONFOCUSON`/`ONFOCUSOFF` on IMAGE;
    -   `HYPERTEXT` on TEXT (`HJUSTIFY` is now read, and `VJUSTIFY` is `TOP` in Kapitan Nemo but `TRUE` in older games);
    -   `RAW` on MOUSE.

    `ONWINDOWFOCUSON`/`ONWINDOWFOCUSOFF` now run, after `CANVAS_OBSERVER^ENABLENOTIFY(TRUE)`, when the browser window gains or loses focus; Wehikuł Czasu's minigames stop their world meanwhile. `HYPERTEXT` and `RAW` are accepted and ignored: every game leaves them empty or 0.

**Piklib and BlooMoo agree where checked.** Running Kapitan Nemo first suggested two differences, and the TS engine briefly switched on `APPLICATION:BLOOMOO_VERSION` for them. Reading `PIKLIB8.dll` and Kapitan Nemo's `bloomoodll.dll` (`yarn disasm`, `scripts/README.md`) showed the same behaviour in both, and that the TS engine's earlier rules were the wrong ones. **[F]** (disassembly)

-   **`ANIMO^GETPOSITIONX/Y([arg])`.** `CMC_Animo_Runner::getPositionX` calls `CAnimo::GetPosition` without arguments and `CAnimo::getPosition` with any argument, whose value it never reads. `GetPosition` is the stored position plus the current image's and event frame's offsets, i.e. where the frame is drawn; `getPosition` is the stored position, what SETPOSITION sets. So `GETPOSITIONX(FALSE)` equals `GETPOSITIONX(TRUE)`. Kapitan Nemo computes frame offsets as `GETPOSITIONX(FALSE)-GETPOSITIONX()` (ROWNOWAGA) and copies positions to clones with `GETPOSITIONX(TRUE)` (KOLEJ); Skarb Piratów's 26SKARB aligns two frames with the argument-less form.
-   **`DATABASE^FIND(col, v, off)`.** `CMC_Database::find` checks the rows from `off` on, selects the first match (the cursor moves to it) and returns its index, or −1. Skarb Piratów, Ufo and Czarodzieje ship the same `PIKLIB8` code. Kapitan Nemo's ARCADE steps through a dialogue's lines with `I1^SET(DBDIALOGI^FIND("ID",SDIALOGNAME,IDIALOGINDEKS))` until it gets −1.

**Other semantics settled by Kapitan Nemo** (they hold for all titles):

-   **`CANVAS_OBSERVER^MOVEBKG(dx, dy)`** moves the view, so the background moves by (−dx, −dy) on screen, like SETBKGPOS. In the DLL, `SETBKGPOS(x,y)` calls the background object's `setPosition(x,y)` and `MOVEBKG(dx,dy)` its `Move(dx,dy)`, which adds to the same stored position, so `MOVEBKG(d)` is `SETBKGPOS(position + d)` **[F]**; the direction comes from the scripts. Objects lying on the background are moved the other way at the same time: `GRPLANS^MOVE([0-X+ILASTX],0);CANVASOBSERVER^MOVEBKG([X-ILASTX],0)` (Kapitan Nemo) and `GROUPPATTERN^MOVE(0,[0-ARRAYDY^GET(0)])` with `MOVEBKG(0,ARRAYDY^GET(0))` (Czarodzieje, MIOTLY).
-   **`CANVAS_OBSERVER^PASTE(obj, x, y)`** draws obj's current frame into the background image, as if obj stood at (x, y) of the background, frame offset included. `CMC_CanvasObserver_Runner::paste` saves the object's position, calls the same `setPosition(x, y)` that SETPOSITION uses, redraws the object onto the background and restores the position **[F]**. (So the cutscenes' `PASTE(S3,[0-I3],[0-I4])` with I3 = `GETPOSITIONX()`, the frame position, draws at minus the stored position, i.e. at 0,0 for an unmoved ANIMO.) WYKOPALISKA and KOLEJ build their level maps with it (`PASTE("ANNPOLA",[IX*IGRID],[IY*IGRID])`) and DOROZKA leaves explosion marks. The TS engine turns the background into a render texture on the first PASTE.
-   **`IMAGE^GETPIXEL(x, y)`** returns the colour as a signed 16-bit RGB565 number. DOROZKA and WYKOPALISKA compare it with constants such as −2048 (pure red), −1 (white) and 32377.
-   **Class methods return values**, `@RETURN` inside `@IF` branches returns from the enclosing behaviour, STRUCT fields can be call targets, and constructors get the instance name as `$1` (§4.4, §4.8, §3.4). The save class (`clssave.class`, `GSAVE^GET`/`SET`) needs all four.
-   **ANIMOs without a file.** The walker class declares `ANNCREATURE`, `ANNFRIEND` and `ANNMASK` with an empty FILENAME, then positions them, sets their priority and plays events before it LOADs an animation. The position and priority apply on LOAD, and PLAY does nothing until then.
-   **`ANIMO^SETFRAME(event, frame)` with an unknown event name uses the first event.** Read from the binaries: `CMC_Animo_Runner::setFrame` (PIKLIB8 and Kapitan Nemo's BlooMoo alike) takes an INTEGER as the event's index (−1 = the current event) and looks a name up with `CAnimo::getFrameNo`, whose result starts at 0 and only changes on a case-insensitive match. `CAnimo::SetEventFrame(int, int)` then treats frame −1 as 0 and ignores frames past the event's end. LOTBALONEM's fuel counter depends on the fallback: it calls `ANCNT^SETFRAME("LICZBY",AMF)` on `LICZBY.ANN`, whose only event is `licz`. `PLAY` differs: `CAnimo::Play(name)` resolves names with `resolveEventName`, which returns −1, and then plays nothing. **[F]** (disassembly)
-   **`ANIMO^PLAY(event, x)` ignores its second argument.** Czarodzieje and Kapitan Nemo pass one in five places (`ANSLONHEAD^PLAY("RUN",0)`, `*SNAZWA^PLAY(["SYLABA"+_I_],0)`, …). `CMC_Animo_Runner::play` in Kapitan Nemo's BlooMoo reads only the first and calls the animation's play with fixed values. **[F]** (disassembly)
-   **0-byte WAV files** (`_PUSTY_SFX0.WAV`, `_NULL_AMBIENT_SND.WAV`) are placeholders for sounds LOADed later. They load as silence.
-   **Save slots.** A new game copies `$COMMON\SAVE\SLOT_DEF.DTA` to `SLOT<n>.DTA`, and `GSAVE^DBLOAD()` reads it after `SGSLOTNAME^SET(n)`. Scenes read their state from it, e.g. `GSAVE^GET("ARCADE_SCENE_NAME")` picks ARCADE's location. Running a scene without a loaded slot gives `ERROR` or `NULL` paths.

Not yet analysed: _Kretes w Akcji_ and the other BlooMoo titles, and the non-script data formats new in these releases: `.sek` (Sekai path-finding/physics meshes, magic `SEKAI81080701915004`), `.scn` (binary, apparently an editor scene description), `.fld` (text level grids) and `.wzl`.

### 8.2 Extension types (plugin DLLs)

-   A SCENE may name plugin modules in `DLLS` (Ufo: `S44_511_PODKOP:DLLS=MATRIX`).
-   The engine loads `<name>.dll`, which registers additional object TYPEs through `CMC_DLLExModuleInterface` / `CMC_ExternObject` (Piklib 8) or `CDLLUnitInterface` (Piklib 7.1).
-   In Ufo the scene description reads `NIE_ZMIENIAC_NAZWY_SCENY__WAZNE_DLA_MATRIX_DLL` ("do not rename the scene, important for MATRIX DLL"). The plugin depends on the scene name.
-   Extension types use the ordinary object, property, callback and method syntax.
-   **`Matrix.dll` vocabulary** (a superset of what Ufo uses, §5):
    -   Properties: `SIZE`, `BASEPOS`, `CELLWIDTH`, `CELLHEIGHT`.
    -   Callbacks: `ONNEXT`, `ONLATEST`, `ONDONE`, `ONINIT`, `ONSIGNAL`.
    -   Methods:
        -   `GET`, `SET`, `SETROW`, `CLEAR`, `LOAD`, `MOVE`, `NEXT`, `TICK`, `GETWIDTH`, `GETHEIGHT`;
        -   `GETCELLOFFSET`, `GETCELLOFFSETATPOS`, `GETCELLPOSX`, `GETCELLPOSY`, `GETCELLSNO`, `GETCELLWITHGFX`;
        -   `GETCELLGFX`, `SETCELLGFX`, `GETCELLLINK`, `SETCELLLINK`, and the `GET`/`SETCELL{UP,DOWN,LEFT,RIGHT}LINK` variants;
        -   `SETGATE`, `ISINGATE`, `ISGATEEMPTY`, `CANHEROGOTO`, `CALCENEMYMOVEDIR`, `CALCENEMYMOVEDEST`.
-   Skarb Piratów ships `Kolorowanka.dll` (a colouring book), not analysed yet.
-   **`World.dll`** (Czarodzieje, Wehikuł Czasu; `DLLS=WORLD`) registers the WORLD type. It is a thin script binding over **`Sekai.dll`**, a physics and path-finding library with a C++ interface `ISekai` (`AddBody`, `AddForce`, `AddWayPoint`, `AddMeshWayPoint`, `FindPath`, `Follow`, `FollowPath`, `CollideMesh`, …). Its data files are the `.sek` meshes. WORLD's vocabulary:

    -   Properties and callbacks: `FILENAME`, `ONINIT`, `ONDONE`, `ONSIGNAL`.
    -   Bodies and forces: `ADDBODY`, `SETG`, `ADDOBJECT`, `REMOVEOBJECT`, `ADDFORCE`, `ADDGRAVITYEX`, `SETGRAVITY`, `SETGRAVITYCENTER`, `SETFORCE`, `SETOBJECTFORCE`, `SETMASS`, `SETVELOCITY`, `SETSPEED`, `SETMAXSPEED`, `SETBODYDYNAMICS`, `SETBODYPROPERTIES`, `SETOBJECTPROPERTIES`, `SETCOLLISIONTYPE`, `SETDISPERSION`, `SETLIMIT`, `ZEROALL`.
    -   Joints: `JOIN`, `JOIN2`, `JOINTSPEED`, `JOINTSTEER`, `UNLINK`, `PAUSELINK`, `RESUMELINK`, `BREAK`.
    -   Paths: `FINDPATH`, `FOLLOWPATH`, `FOLLOW`, `FOLLOWROUTE`, `GOTOPATH`, `MOVETOPATH`, `ADDTOPATH`, `ADDWAYPOINT`, `ADDMESHWAYPOINT`, `REMOVEWAYPOINT`, `REMOVEROUTE`, `ENABLEMESH`, `COLLIDEMESH`, `ISMESHENABLED`, `ISMESHCOLLIDING`.
    -   Queries and control: `GETPOSITIONX/Y/Z`, `GETROTATIONX/Y/Z`, `GETANGLE`, `GETSPEED`, `GETMOVEDISTANCE`, `GETCOLLISION`, `GETBKGPOSX/Y`, `SETBKGSIZE`, `SETREFOBJECT`, `SETMOVEFLAGS`, `SETACTIVE`, `SETALWAYSACTIVE`, `SETPOSITION`, `SETPOSITIONCOORD`, `SETANGLE`, `ROTATE`, `MOVETO`, `MOVEOBJECTS`, `USEFF`, `START`.

    `JOIN` and `SETG` are in the DLL's name table next to `BREAK` and `SETGRAVITYCENTER` (an earlier reading of the strings missed them). **[F]** (strings) The TS engine keeps joined bodies together: `JOIN(child, parent, anchorX, anchorY, ?, ?, minAngle, maxAngle, …)` with an empty angle range keeps the child's offset from the parent (Wehikuł Czasu's car and its wheels), and a free hinge keeps their distance (Czarodzieje's MIOTLY chain). Its bodies don't rotate, so this approximates Sekai. **[G]**

-   **`ONSIGNAL` is how WORLD reports back. [G]** `ONSIGNAL` is in the vocabulary of every engine build from Piklib 7.1 on, and of `Matrix.dll` and `World.dll`. It is therefore a generic event that ordinary objects can receive, and plugins can raise it. In the WORLD scenes, the scripts attach `ONSIGNAL^<param>` handlers to the ANIMO objects that the WORLD moves. The parameters are `ATGOAL` and `NOPATH` for path following, and numbers for the rest (506 handlers in Wehikuł Czasu), apparently body or contact identifiers. The TS engine accepts these handlers on ANIMO and raises `ATGOAL`/`NOPATH`.
-   **WORLD conventions, as Czarodzieje's scripts use them [G]:**
    -   **Positions** in the script API (SETPOSITION, SETLIMIT, FINDPATH targets, GETPOSITIONX/Y) are screen coordinates: FINDPATH gets `MOUSE^GETPOSX/Y` directly. Sekai's frame is centred with y up, so world = (x − 400, 300 − y). The SEK waypoints of each location lie where its floor is on screen under this mapping.
    -   **Velocities, forces and gravity** are passed in Sekai's frame, y up. DRAGON has `SETGRAVITY(0,-15,0)`, pushes `+y` after hitting something below and flaps upwards with a positive y force.
    -   **GETANGLE** is the direction of movement in degrees, 0 = right, 90 = up. ARCADE picks Reksio's walk animation from `(angle + 22.5) / 45`; events `0`…`7` of `REX*.ANN` face right, back-right, back, …, front-right.
    -   **Walking**: `FINDPATH(body, graph, x, y, z, flags…)` plans a path on the SEK graph. `FOLLOWPATH(body, 20, 0.5, speed)` runs every frame from an ELAPSE animation and sets the walking speed (units per second; Reksio's default is 300). `MOVEOBJECTS()` advances the simulation by the elapsed time, moves the linked ANIMOs, and raises `ONSIGNAL^ATGOAL` on arrival. `GETMOVEDISTANCE` (distance moved in the last step) selects walking or idle animations.
    -   **Bodies** of SEK entities (Reksio = 100, Kretes = 101) are created by LOAD in the original. The TS engine creates a body when an id is first used.
    -   **Scrolling**: `SETBKGSIZE(xMin, xMax, yMin, yMax)`, `SETMOVEFLAGS(dx, dy)` (non-zero = may scroll on that axis) and `SETREFOBJECT(body)` make the background follow a body. `GETBKGPOSX/Y` return the scroll offset that scripts subtract from the background's and objects' positions. Czarodzieje moves the background ANIMO itself. Wehikuł Czasu sets the background with `CANVAS_OBSERVER^SETBACKGROUND` and scrolls it with `CANVAS_OBSERVER^SETBKGPOS(scroll)`, while it moves the objects' GROUP by `-scroll`. So SETBKGPOS names the point of the background shown in the screen's top-left corner, and the background is drawn at its negative. Kapitan Nemo's parallax scrolling agrees with this. **[G]**
    -   `START`/`STOP` start and pause the simulation; ARCADE calls START on the first click, so Kretes' initial FINDPATH waits until then.

An implementation should treat extension types like built-in ones, with one registry entry each. The spec should describe them in per-plugin appendices.

### 8.3 Sources of truth and how to settle open questions

In decreasing order of authority:

1. **The original binaries.**
    - `PIKLIB71.dll`, `PIKLIB8.dll`, `BlooMooDLL.dll` and the plugin DLLs export MSVC-mangled C++ symbols, which `llvm-undname` demangles.
    - The object model is visible directly: `CMC_<Type>` classes hold state (e.g. `CMC_Integer::calculate/compare/convert/equals/serialize`), `CMC_<Type>_Runner` classes dispatch script methods by name, and supporting machinery includes `CMC_RunnerFactory::getRunner(int)`, `CMC_VariableFactory`, `CMC_StructureParser`, `CMC_Behaviour_Entry` and `CMElementsLoader`.
    - The script-visible strings are clustered per runner in `.rdata`. Mapping each runner's dispatch code to its strings in a disassembler yields the authoritative per-type method table, which this spec's §5 should eventually be checked against.
2. **Running the original.** Run it under Wine with scripted input, capturing `OutputDebugStringA` / `CError` output and saved INI and ARR state, for questions about timing and ordering. The `Log.log` files shipped with the games are empty, so there is no ready-made trace.
3. **Game data.** Constructs that occur in shipped scripts must be accepted. Their observable effect in the game (the puzzle works, the cutscene advances) constrains their semantics.
4. **The TS engine and its tests,** as summarised in this document.

### 8.4 Error tolerance observed in shipped data

Shipped scripts contain mistakes the original presumably survives, since the games shipped and are playable. A conforming implementation must not abort the game on them:

-   **Misspelt methods unknown to the engine vocabulary:**

    -   `BUTTON^DISABLEBUTVISIBE` and `ANIMO^MONITORCOLLISIONS` (Skarb Piratów);
    -   `ANIMO^SETEVENT` (Skarb Piratów);
    -   methods called on objects whose type lacks them, e.g. `GROUP^MONITORCOLLISION`. GROUP forwarding may explain some of these.

    Expected behaviour: the call is skipped and yields NULL (§4.7).

-   **Unbalanced string quotes,** e.g. Ufo `S66_WYBOR` has `ARRLOCALNAMES^ADD("ANNCAR0,"ANNCAR1","ANNCAR2","ANNCAR3")`. Arguments are split on commas without tracking quotes (§3.2), and a string literal only drops its closing quote when one is present (§3.3). So this still yields the four elements `ANNCAR0`, `ANNCAR1`, `ANNCAR2` and `ANNCAR3`, which is what the TS engine produces. The car-selection screen depends on this list.
-   **Wrong operator characters** in dead files (`BUT_TAK>DISABLE()`), see §2.2.
-   **Misspelt or malformed calls in the later titles:**
    -   `TIMER^DISBLE`, `IMAGE^SETPTIORITY` and `ANIMO^SEFFPS` (Czarodzieje, Wehikuł Czasu);
    -   `ANNOBJECT0^SETFRAME"STATE0",1)` with no opening parenthesis (Czarodzieje).
-   **Statement prefix `!`** (Skarb Piratów only, 125 statements, e.g. `!REKSIO15^PLAY("ZADOWOLONY")`). It looks like a way to comment out a statement. The TS engine treats `!REKSIO15` as an unknown object, so the call is skipped, which has the same effect. **[?]**
-   **Empty property name.** `SNDFIRE:={@IF(…)}` (Czarodzieje, `Dragon.cnv`) assigns to an empty property. The TS loader warns and ignores the line.
-   **Mis-compiled `ELSE` branches** (§8.1, `BFITMPn`). In Kapitan Nemo `wioska_masajow.cnv`, twelve callbacks read like this:

    ```
    {@IF(BEHGETBUDOWAKURY^RUN(10),"_","0","BFITMP1083","");}ELSE{CURSOR^SET("STD");}}
    ```

    The `ELSE` branch was left behind as text, outside the compiled `@IF`. A generated behaviour in `lotbalonem.cnv` holds only the tail of a condition that contained quotes: `BFITMP86:CODE={||SOBJ2^FIND("IMGM")>-1){SOBJT^SET(SOBJ2);}`. These blocks parse, because the statement parser is lenient (`}ELSE{CURSOR` becomes an unknown call target), but the `ELSE` code never runs. That was presumably also the case in the original.

-   **Backup and dead files shipped next to live ones.** Examples are `*old.cnv`, `*copy.cnv`, `*stary.cnv` and `!stare/` directories in the later titles, and the corrupted leftovers in Ufo (§2.2). They are never loaded, but they distort any static analysis that does not follow the load graph.
-   **Missing assets:**

    -   Ufo `S75_PORT` declares `PRAWA.ANN`, which is not shipped.
    -   Ufo `S67_WYSCIGI` uses font `ARIAL14.FNT`, which is not shipped.
    -   The ANN frame sound list in `PIOTRUS.ANN` is `SFX\00rex1.wavSFX\00rex1.wav` (two names without the `;` separator).
    -   Wehikuł Czasu's new game (`MAINMENU.class`, `NEWGAMESTART`) copies `$COMMON\<minigame>_DEF.ARR` to the save slot for every minigame, but only `NUREK_DEF.ARR` and `KRZEMIENIE_DEF.ARR` ship. The TS engine treats COPYFILE of a missing file as a warning.
    -   Wehikuł Czasu's TURNIEJ plays `SFX_TURNIEJSTART1.WAV` … `SFX_TURNIEJSTART4.WAV`, which are not shipped. PLAY of a SOUND that failed to load does nothing.
    -   Kapitan Nemo adds sound names built in loops (`GRSND^ADD(["KRET_I0"+[_I_+22]])`) to groups; some of the generated names don't exist, so GROUP^ADD warns.
    -   `ANSLONHEAD^PLAY("RUN",0)` and three similar calls pass a second argument to `ANIMO^PLAY`. It is ignored. **[?]**
    -   SLON's `ANSLON_TIMER^RUN()` calls RUN on an ANIMO (`BLANK_TIMES.ANN`), which has no such method. The call is skipped.

    Expected behaviour: the object or the sound is unavailable, and the rest of the scene runs.
