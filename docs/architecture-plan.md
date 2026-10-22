# Architecture audit and plan

Status: proposal, October 2026. Based on `master` at `57871e8` (the types rewrite) plus the Reksio i Ufo fixes on this branch.

This document covers two things. First, what makes the engine hard to test, and hard to run anywhere other than a browser tab with a WebGL canvas. Second, a staged plan to fix that without halting game-compatibility work. The companion document [`scripting-language.md`](scripting-language.md) specifies the scripting language. This plan treats that spec, and a conformance suite derived from it, as the main tool for keeping refactors honest.

## 1. Summary

The project's core pieces are in good shape:

-   the file-format parsers (`src/fileFormats`)
-   the new interpreter, written to mirror the original
-   the value-type semantics, which have about 140 unit tests.

Most of the friction comes from five structural problems:

1. **Nothing below the Engine is headless.** `Engine` needs a real `PIXI.Application` and renderer. Game state for display objects lives in PIXI sprites. Input comes from PIXI and `window`. Sound and sequence progress is driven by WebAudio `ended` events. `TestEngine` exists only because the real `Engine` cannot be constructed in Node.
2. **No layering.** About 60 modules form one import cycle. Even the pure text parser (`interpreter/parser.ts`) pulls in pixi.js through `common/types.ts`.
3. **A compile-time magic step.** The `@method()` decorator only works when the custom TypeScript transformer (`transformers.ts`) has rewritten it. Without the transformer, every method silently loses argument conversion and return wrapping. This ties the build to ts-loader and ts-jest, and rules out vitest, esbuild, vite, swc and bun.
4. **Global, non-deterministic runtime.** The project uses:
    - real-time `elapsedMS`
    - `Math.random` in four places
    - `Date.now` and `new Date`
    - module-level singletons: `globalAudio`, the stack-trace stack, the `allLogs` log buffer, the local-scope stack and `globalThis.engine`
    - an async tick that can re-enter itself, controlled by `ticker.stop()`/`start()` hacks.
5. **No single source of truth for types.** Adding a type touches four places. Script methods are dispatched to any JS member with that name.

None of this needs a rewrite. The plan below is a sequence of small, independently mergeable steps. The first steps deliver a Node-based script runner and game-archive backends (ZIP or a plain directory) almost immediately.

## 2. What exists today

| Area                                                | State                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fileFormats` (CNV/SEQ/ANN/IMG/ARR/DTA/compression) | Pure except `fnt/index.ts`, which builds a PIXI `BitmapFont` and installs it globally. It has an injectable logger.                                                                                                                |
| Filesystem                                          | Small interfaces: `FileLoader` (`init`, `getRawFile`, `getFilesListing`, `hasFile`) and `FileStorage`. In-memory versions exist in `common/testUtils.ts`. The upstream `test/snapshot-testing` branch has a Node directory loader. |
| Interpreter                                         | Re-derived from the original (`runLine`, `CMC_Expression` and others are named in comments) and well tested (48 tests). It re-parses every script on each call.                                                                    |
| Types                                               | 35 classes and 238 `@method`s. The value types (INTEGER, DOUBLE, STRING, BOOL, ARRAY, STRUCT, DATABASE, VECTOR, MATRIX, TIMER) are testable through `TestEngine`.                                                                  |
| Tests                                               | Jest in Node, about 140 cases. There is no CI test job: `.github/workflows/deploy.yml` only builds and deploys, so tests run only in the pre-commit hook.                                                                          |
| Tooling                                             | lint-staged runs ESLint and Prettier on `*.js` only, so TypeScript is never linted on commit. The pre-commit hook does a full webpack build plus jest. `antlr4` is an unused dependency.                                           |

## 3. Findings

### 3.1 Layering

The import graph has one 60-file cycle covering `engine/**`, `filesystem/**`, `interpreter/**` and `common/{types,errors}`. The edges that matter:

-   `common/types.ts` (value conversion, `@method`, `callMethod`) imports `engine/types` (`ValueType`), `values`, `double`, `expression`, `logging` and `interpreter/stacktrace`. Every type class imports `common/types` back.
-   `interpreter/parser.ts` imports `valueAsBool` from `common/types`, so the parser depends on the whole engine.
-   `interpreter/interpreter.ts` creates concrete type instances (`Struct`, `Rand`, `System`, `CNVLoader`, `Integer`, `String`) as globals.
-   `filesystem/definitionLoader.ts` imports all 35 type classes, and five types import it back.
-   `filesystem/assetsLoader.ts` returns PIXI textures and WebAudio sounds. It is rendering and audio code that happens to sit under `filesystem/`.
-   `engine/index.ts` imports `BUILD_VARS` from the library entry point `src/index.ts`.

### 3.2 Engine and runtime model

-   **Construction.** The constructor needs a real renderer: `RenderingManager` calls `renderer.generateTexture`, `init` awaits `initDevtools`, and `changeScene` screenshots through `renderer.extract`.
-   **Tick model:**
    -   The ticker callback calls `this.tick()` without awaiting it, so ticks can overlap.
    -   Code works around this by stopping and starting the ticker in `createObject`, `Application.init`, `Episode.init` and `changeScene`. Those `start()` calls also undo a user `pause()`.
    -   `loadDefinition` runs every object's `init()` at once through `Promise.allSettled`, so the declared initialisation priorities only order the synchronous prefix of each `init`.
    -   `CancelTick` exceptions are used for scene-change control flow.
-   **State in the view.** `Animo` and `Image` read and write their position, visibility, size and opacity directly on PIXI sprites. Collisions use `getBounds()`. A headless engine therefore needs a logic/view split, not just a null renderer.
-   **Path resolution:**
    -   It depends on `engine.currentScene`, not on the object's parent.
    -   It is applied inconsistently: SEQUENCE sounds, scene music and SFX each build paths differently.
    -   `..` is not handled.
    -   `hasFile` is an O(n) scan per lookup.

### 3.3 The type and method boundary

-   `@method()` metadata is generated by `transformers.ts`, which matches the literal text `'@method()'`. Without it, `@method` gets no parameter types, nothing is converted, and every primitive return trips the interpreter's assert "returned a primitive instead of an engine value".
-   Dispatch is `obj[name] !== undefined ? callMethod : __call`. The same logic is repeated in `Scene.RUN` and `Application.RUN`. Scripts can call any JS member: `init`, `tick`, `destroy`, `setValue`, and so on.
-   Adding a type means editing `cnv/types.ts` (a TS type, a structure object and a registry entry), adding a class, adding a `definitionLoader` switch case, optionally setting an init priority, and sometimes adding interpreter globals. `PATTERN` is defined in `cnv/types.ts` but not in the switch, so it parses and then throws.
-   Every intermediate value is a full `Type` with a callbacks component and an INI lookup.

### 3.4 Observability

-   The logger writes to `console` and to the global `allLogs` array. That array grows without bound and keeps references to large objects (for example, whole ANN files), so it leaks memory in production.
-   `debugging.ts` mixes DOM UI, engine control and PIXI X-ray overlays, and is created for every engine.
-   The interpreter contains a hard `debugger` statement.

## 4. What the original engine and the game corpus tell us

These points decide how the spec and the plan should be scoped. Methods: the scripts of six titles (the Ufo demo, Skarb Piratów, Ufo, Czarodzieje, Wehikuł Czasu and Kapitan Nemo) were decrypted and analysed, and the native engine and plugin DLLs that ship with the games were inspected.

-   **Engine versions.**
    -   The Reksio i Ufo demo ships `PIKLIB71.dll` (Piklib 7.1).
    -   Skarb Piratów, Ufo and Czarodzieje ship builds of `PIKLIB8.dll`.
    -   Wehikuł Czasu and Kapitan Nemo ship `BlooMooDLL.dll` (2004 and 2006 builds), the renamed successor with the same object model.
    -   The full table is in spec §8.1.
-   **The binaries export 3,500–4,750 MSVC-mangled C++ symbols** (3,505 in 7.1, 4,281 in the August 2004 Piklib 8, 4,746 in the 2006 BlooMoo), and `llvm-undname` demangles them. They expose the original object model:

    -   `CMC_<Type>` classes hold state, for example `CMC_Integer::calculate/compare/convert/equals/serialize/netstore`.
    -   `CMC_<Type>_Runner` classes dispatch script methods.
    -   Supporting classes include `CMC_RunnerFactory::getRunner(int)`, `CMC_VariableFactory`, `CMC_StructureParser`, `CMC_Behaviour_Entry` and `CMElementsLoader`.

    This is a far better reverse-engineering target than an anonymous binary. Every claim in the spec can be checked against a named function.

-   **Version differences are mostly API surface, not syntax.**
    -   Classes only in v8: `CMC_Class`, `CMC_Database`, `CMC_MultiArray`, `CMC_Structure`, `CMC_Pattern`, `CMC_Joystick`, `CMC_Scroll`, `CMC_VirtualGraphicsObject` and `CMC_Canvas`.
    -   Classes only in 7.1: `CMC_NetPeer`, the old plugin interface `CDLLUnitInterface`, and tree sequences.
    -   The script vocabulary (uppercase identifier strings in the binary, a noisy measure) grows from 764 to 1,296 entries.
    -   `WORLD`, which the TS engine has stubs for, is in no engine build. It is registered by the `World.dll` plugin (Czarodzieje, Wehikuł Czasu).
-   **Plugins.** A scene's `DLLS=MATRIX` loads `Matrix.dll`, which registers the `MATRIX` type through `CMC_DLLExModuleInterface`. `Matrix.dll` has its own vocabulary, a superset of what Ufo uses: `GETCELLLINK`, `SETCELLGFX`, `LOAD`, `CLEAR`, `ONDONE`, and more. Skarb Piratów ships `Kolorowanka.dll` (a colouring book). A spec-level notion of _extension types_ is therefore needed.
-   **Idioms changed between titles; the grammar did not.**
    -   Skarb Piratów uses `@IF`/`@BREAK`/`@LOOP`, `*indirect` references, CONDITION, COMPLEXCONDITION and EXPRESSION objects heavily.
    -   Ufo uses inline `[..]` arithmetic (481 uses against 19), `$N` arguments (262 against 5), parametrised behaviour callbacks `BEH(args)` (391 against 6), and the new BOOL, VECTOR, MATRIX, STATICFILTER and FILTER types.
-   **Scripts contain errors that the original tolerates:**

    -   misspelt methods (`DISABLEBUTVISIBE`, `MONITORCOLLISIONS`, `SETEVENT`)
    -   unbalanced quotes (`ARRLOCALNAMES^ADD("ANNCAR0,"ANNCAR1",…)`)
    -   methods called on objects that lack them
    -   dead CNV files with corrupted bytes.

    A useful spec has to define error recovery, not just the valid language.

-   **Later titles** (Czarodzieje, Wehikuł Czasu, Kapitan Nemo; spec §8.1). The grammar is unchanged: every code block of all six analysed titles parses. What changes is the API and the idioms:
    -   Control flow moves from CONDITION objects to inline `@IF`, together with heavy use of `*` indirection, `|` struct fields, CLASS and DATABASE.
    -   Kapitan Nemo uses the local-variable globals `@INT`/`@STRING`/`@BOOL`/`@DOUBLE`. The TS engine treats these as fatal errors, so that title cannot run today.
    -   Czarodzieje and Wehikuł Czasu depend on the WORLD physics/path-finding plugin (`World.dll` over `Sekai.dll`), which the TS engine only stubs.
    -   _Kretes w Akcji_ and the other BlooMoo titles are still unchecked.

## 5. Target architecture

```
                 ┌──────────────────────────────────────────────┐
  formats  ◄──── │ vfs          GameFiles (read-only, case-     │
  (pure)         │              insensitive index) + Storage    │
                 │              (writable overlay: saves, INI)  │
                 └──────────────────────────────────────────────┘
                                  ▲
  script   (pure: lexer, parser, interpreter, value model; talks to the world only via a Host interface)
                                  ▲
  runtime  (object model: type registry, definition loader, scopes, scheduler with a fixed-step tick,
            event queue, behaviours; depends only on ports)
                                  ▲
  ports    Renderer · Audio · Input · Clock · Rng · Logger · Storage   (interfaces)
             │            │         │
  adapters  pixi/webaudio/dom (browser)      headless (Node: records draw state, fake audio clock,
                                              scripted input)
                                  ▲
  apps      dev player · library build · CLI (run scene, trace, sweep) · test harnesses
```

Rules:

-   **Pure layers.** `formats`, `vfs`, `script` and `runtime` import nothing from pixi, the DOM or WebAudio. Enforce this with ESLint `no-restricted-imports` and `env.browser: false` for those folders, and with a build of each layer as its own TS project.
-   **Ports are narrow and data-oriented:**
    -   The **renderer** receives a display list (id, texture reference, x/y, frame, priority, visible, opacity, flips) and pushes back input hits.
    -   The **audio** port gets play/stop/rate commands and reports `ended` as events delivered on a later tick, the way the current SOUND callback queue already works.
    -   The **clock** and the **RNG** are injected.
-   **One type registry entry per type.** Each entry holds:

    -   the definition schema (one declaration that yields both the TS type and the runtime parser)
    -   a factory
    -   an init priority
    -   a method table with explicit signatures
    -   callbacks
    -   the engine version range in which the type exists.

    The interpreter dispatches only through method tables. Plugins (MATRIX, later WORLD) register the same way.

-   **Deterministic stepping.** `runtime.step(dtMs)` is awaited in sequence. Scene changes are requested and applied at the end of a step, not thrown. Real time only enters through the browser adapter.

## 6. Plan

Each step can be merged on its own, keeps the game playable, and has a clear "done" check. Steps within a phase can run in parallel. Work in small PRs against upstream, given how fast upstream moves (the types rewrite touched 50 files).

### Phase 0: Hygiene (days)

1. Add a CI job that runs `jest`, `tsc --noEmit` for each tsconfig, ESLint on `src/**/*.ts` and `prettier --check`. Make lint-staged cover `*.ts`. Slim the pre-commit hook to lint-staged plus the tests for changed files, since CI now catches the rest.
2. Remove `antlr4` and the stale `.eslintignore` and tsconfig entries. Add a shared `tsconfig.base.json`.
3. Remove the `debugger` statement. Cap `allLogs` with a ring buffer and stop logging whole ANN and CNV payloads at debug level by default.

_Done when:_ a PR that breaks a test or lint fails CI.

### Phase 1: Game files anywhere (about a week)

1. Introduce `GameFiles`: `list()`, `read(path)` and `has(path)`, backed by a case-insensitive `Map` index built once. `Filesystem` becomes a thin layer over `GameFiles` and `Storage`. Adapters for the existing loaders (GitHub, archive.org, listing JSON, ISO) wrap the current classes unchanged.
2. Add a **ZIP backend** (`fflate` or `@zip.js/zip.js`, which work in both browser and Node), a **Node directory backend** (port it from the upstream snapshot branch) and a **memory backend** (already in `testUtils`).
3. Move all path rules into one `paths` module: normalisation including `..`, the language-directory fallback, `$WAVS`-style prefixes, and the SFX, sequence and music base directories. Resolve against the owning scene, not `engine.currentScene`.
4. Move `assetsLoader.ts` out of `filesystem/` into the browser adapters.

_Done when:_ `devPlayer` accepts `?loader=zip&source=<url>` and a dropped `.zip`, and a Node test reads `Application.def` from a ZIP of a game.

### Phase 2: A pure script core (about 1–2 weeks)

1. Split `common/types.ts`. Value conversion and formatting (`valueAs*`, `doubleAsString`, `looksLike`) go into `script/values.ts`, with no engine imports. `@method` and `callMethod` move into the runtime. The parser then depends only on `script/values`.
2. Replace the transformer with explicit signatures, for example `@method(int, int)` returning `int` or `@method({ rest: string })`. Write a one-off codemod by running `transformers.ts` in "print" mode to emit the explicit forms, then delete the transformer. This unlocks vitest and esbuild, and makes signatures greppable and documentable from code.
3. Dispatch only through a per-class method table built from those decorators. JS members stop being callable from scripts. Unknown methods go to `__call`, which matches the original's tolerance.
4. Cache parsed ASTs per code string, and create interpreter globals once per engine instead of per call.
5. Publish `script` and `formats` as a package that builds in isolation, enforced by a separate tsconfig with `isolatedModules` and no pixi in its `lib`.

_Done when:_ `interpreter.test.ts` and `common/types.test.ts` run under vitest or plain `node --test` with an esbuild transform, and `src/script/**` imports nothing outside `src/script` and `src/fileFormats`.

### Phase 3: Headless runtime (about 2–4 weeks; the main investment)

1. **Ports.** Define `Renderer`, `Audio`, `Input`, `Clock`, `Rng`, `Logger` and `Storage` interfaces. Implement the browser adapters by moving existing code (rendering.ts, audio.ts, DOM keyboard and mouse wiring, IndexedDB, localStorage). Implement headless adapters:
    - The renderer records the display list.
    - Audio uses durations from the WAV headers on a virtual clock and emits `ended` at the right virtual time.
    - Input is a scripted queue.
    - The RNG is seeded.
2. **Scheduler.** Make `Engine.step(dt)` the only way time advances, with nothing re-entrant. The browser adapter calls `step` from requestAnimationFrame with real elapsed time, and the headless one with a fixed step. Turn `CancelTick` into "request scene change, apply at end of step". Remove the `ticker.stop()`/`start()` calls. Make `init` sequential in priority order, or keep the parallel loading but with an explicit two-phase load-then-init, matching the original if the spec says so.
3. **Logic/view split for display types,** in this order: Image, Animo, Button, Text, CanvasObserver, StaticFilter. Each type owns its state (position, frame, visibility, priority, opacity, flips and hit rects), and a renderer-side "view" syncs it at the end of the step. Collisions and `GETPOSITIONX` read model state. Do this type by type behind the port so the game stays playable throughout.
4. **Global state.** Move `globalAudio`, the stack-trace stack, the logs, the local-scope stack and the `globalThis.engine` debug handle onto the engine instance or into injected services. Keep `globalThis.engine` only in `devPlayer`.

_Done when:_ a Node CLI `reksio run <game.zip> --scene S44_511_PODKOP --steps 600 --input script.json --seed 1` runs the real engine and prints the log, with no browser and no jsdom.

### Phase 4: Test tiers (overlapping with Phase 3)

| Tier                | What                                                                                                                             | Where it runs                                | Ground truth                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| T1 spec conformance | Data-driven cases (`*.case` files: CNV and code snippets plus an expected trace or values), tagged with spec section IDs         | Node, milliseconds                           | the spec, checked against the native binaries        |
| T2 type unit tests  | Per-type method semantics (what `TestEngine` does today, later on the headless runtime)                                          | Node                                         | the spec and the native binaries                     |
| T3 scene smoke      | Load every scene of every available title, step N seconds with seeded random input, and assert no errors or unknown-method calls | Node + headless runtime, about 1 s per scene | "doesn't crash"; diffs against a baseline error list |
| T4 replay / golden  | Recorded input sessions per minigame and puzzle, asserting the display list and variable values at checkpoints                   | Node                                         | recorded once, then compared for changes             |
| T5 visual           | Pixel snapshots of a few scenes through the PIXI adapter                                                                         | browser (Playwright), nightly                | approved screenshots                                 |

T3 replaces the Playwright scene sweep used to check Ufo on this branch. That sweep needs a full webpack build, two local servers and Chromium with SwiftShader, and still takes 15–30 s per scene. Game assets cannot go in the repo, so T3 and T4 read them from `REKSIO_GAMES=<dir or zip>` and are skipped when it is unset. CI can fetch the `GamesFiles` branches.

### Phase 5: Spec-driven maintenance (ongoing)

-   **S1.** Keep [`scripting-language.md`](scripting-language.md) as the normative reference. Each rule gets an ID (for example `EXPR.3`) and links to at least one T1 case. Implementation references stay in footnotes only.
-   **S2.** Collect the remaining titles' data (or at least their decrypted CNV, DEF and SEQ files and engine DLLs) and run the same corpus analysis to get a per-version vocabulary and type table. Record the version in which each type and method appears in the registry, so that unsupported constructs can be reported per game.
-   **S3.** Resolve open spec questions against the binaries. Load `PIKLIB8.dll` and `PIKLIB71.dll` into Ghidra with the demangled export names, and map each `CMC_*_Runner` dispatch function to its method-name strings. That yields an authoritative per-type method and signature table to diff against the registry. Where reading code is not enough, run the original under Wine on Linux CI with scripted input and capture `OutputDebugStringA` and `CError` output as an oracle for T1 and T4.
-   **S4.** Add a `reksio lint` CLI that parses a game's scripts against the spec and the registry. It reports unknown methods and types per version, and malformed expressions or strings. It doubles as a coverage report: which `TYPE^METHOD` pairs a game uses and which of them the engine implements.

## 7. Suggested order and effort

1. Phase 0 and Phase 1.1–1.2: highest value per effort. You get ZIP and directory backends and a CI safety net in about a week.
2. Phase 2: unblocks fast tooling and a standalone interpreter package. It is low risk because the interpreter is already well tested.
3. T1 conformance cases, written alongside the spec, so that Phases 2–3 have a regression net.
4. Phase 3: the big one. Do it type by type behind ports, with T3 smoke tests running on every PR from the first step on.
5. S2–S4 in parallel. These suit contributors who prefer reverse engineering to refactoring.

## 8. Risks

-   **Divergence from upstream.** These are cross-cutting changes. Agree on Phases 0–2 with upstream maintainers before starting, and land them early, since they are mechanical and easy to review.
-   **Behaviour drift during the logic/view split.** Mitigate with T3 baselines and T4 replays recorded _before_ each type is converted.
-   **Timing semantics.** A fixed-step scheduler changes interleaving compared with today's re-entrant async tick. The spec has to say what the original does: how many callbacks per frame, and when events queued during a callback fire. Measure against the binary (S3) rather than guess.
