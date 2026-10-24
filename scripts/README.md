# Test and research tools

Tools for running the games headlessly, checking scripts and reading the original engine DLLs. Game files are not part of the repository: point the tools at your own copies.

## Game folders

Each game is a folder as installed or unpacked (for example the patched releases from zagrajwreksia.pl), with `Dane`/`dane`, `Common`/`common` and the DLLs at the top. The tools find a game's folder from, in order:

1. `--root <folder>`;
2. the environment variable `REKSIO_GAME_<KEY>`, e.g. `REKSIO_GAME_RIKN=/games/RiKN`;
3. `<REKSIO_GAMES_DIR>/<key>`, e.g. `REKSIO_GAMES_DIR=/games` with `/games/rikn`.

The keys and per-game settings are in [`sweep/games.json`](sweep/games.json): `ufodemo`, `risp`, `ufo`, `ric` (Czarodzieje), `riwc` (Wehikuł Czasu) and `rikn` (Kapitan Nemo).

## Sweeping scenes: `yarn sweep`

Runs each scene of a game in headless Chromium with the built app (`yarn build` first) and records script errors, warnings and a screenshot per scene.

```sh
yarn build
yarn sweep rikn                          # every scene of the episode
yarn sweep rikn --scenes SLON,DOROZKA    # some scenes
yarn sweep rikn --interact               # plus 40 deterministic clicks and key presses per scene
yarn sweep riwc --locations              # every ARCADE location instead of the scenes
yarn sweep riwc --locations --only STAW,ZAMEK5
```

Options: `--seconds N` (time in each scene, default 12), `--out <dir>` (default `sweep-results/<game>`), `--baseline <summary.json>`, `--config`, `--app` (default `dist/app`). Chromium comes from `playwright-core`; set `CHROMIUM_PATH` to use another binary (run `npx playwright-core install chromium` if none is installed).

The output folder gets `<scene>.log`, `<scene>.png`, `summary.json` (errors, warnings and the scene the game ended in, per scene) and `errors.txt` (each distinct error with the scenes it happened in; script stack traces are reduced to the failing call).

**How scenes are entered.** Most scenes need the state a real game has, such as a loaded save slot. When a game's config has a `prelude`, the tool opens that scene, waits until the game moves on by itself, runs the `setup` script (e.g. Kapitan Nemo's `SGSLOTNAME^SET(0);…;GSAVE^DBLOAD();`) and then switches to the scene under test. Locations work the same way, with the location's `code` (`%LOC%` replaced by its name) run before switching to the location scene. Games without a prelude load each scene directly.

**Regressions.** Keep the `summary.json` of a good run and pass it as `--baseline`. The tool then lists the scenes that got more errors (or new scenes with errors) and exits with status 1 if there are any:

```sh
yarn sweep rikn --out sweep-results/rikn-base
# …change the engine, yarn build…
yarn sweep rikn --baseline sweep-results/rikn-base/summary.json
```

## Running script code in a game: `yarn probe`

Starts a game like `sweep` does, optionally switches scene, runs script code and prints variables:

```sh
yarn probe rikn --code 'S1^SET(GSAVE^GET("ARCADE_SCENE_NAME"));' --vars S1
yarn probe rikn --scene LOTBALONEM --wait 5 --vars AMF,ILE --logs
```

## Checking scripts statically

`yarn decrypt-scripts <game folder> <out folder>` writes decrypted copies of all `.cnv`, `.def`, `.class` and `.seq` files, keeping the folder tree and the original bytes (Windows-1250). Then `yarn build-lsp` and `yarn lsp-check <out folder>` report unknown methods and properties, call shape problems and more across the whole game (see [`lsp/README.md`](../lsp/README.md)). The language server only reports diagnostics for decrypted files.

## Reading the original engine: `yarn disasm`

Disassembles exported functions of `PIKLIB*.dll`, `BlooMooDLL.dll` and the plugin DLLs, following the incremental-linking jump stubs and labelling calls with the exports they reach. Needs `objdump` with PE support (GNU binutils); `llvm-undname` is used to demangle names when installed.

```sh
yarn disasm RiKN/bloomoodll.dll SetEventFrame              # list the matching exports
yarn disasm RiKN/bloomoodll.dll '?getFrameNo@CAnimo'       # disassemble the one match
yarn disasm RiKN/bloomoodll.dll 0x100ab3d0 --length 0x400  # disassemble from an address
```

Call labels name the export at the call's target. `PIKLIB8.dll` was linked with identical-code folding, so a label there can name another function with the same body (e.g. `CMC_Mouse::getPosY` for `CMC_Animo::getAnimo`); BlooMoo DLLs call through per-function stubs, so their labels are exact. Virtual calls (`call *0xd4(%eax)`) aren't labelled: read the class's vtable, whose exported `??_7…` symbols `--list` shows. An object pointer may point at a secondary vtable, e.g. the `{for CXObject}` one.

The script runners are `CMC_<Type>_Runner::<method>` (e.g. `?setFrame@CMC_Animo_Runner`); they unpack the arguments and call the `C<Type>` class. This is how `docs/scripting-language.md` settles questions marked **[F]** (disassembly), such as how `SETFRAME` resolves event names.
