# reksio-lsp

A language server for the Piklib/BlooMoo scripts of the Reksio games: `.cnv`, `.def` and `.class` files, and the code blocks inside them. The language is described in [`docs/scripting-language.md`](../docs/scripting-language.md).

It reuses the engine instead of reimplementing the language:

-   code blocks are parsed with the interpreter's parser (`src/interpreter/parser.ts`, and `src/interpreter/expression` for the 3-argument `@IF`), after the same space removal the interpreter does;
-   the CNV layer follows `getLines`/`processTokens` of `src/fileFormats/cnv/parser.ts` (a test checks the line folding against `getLines`), keeping document positions;
-   property schemas come from `structureDefinitions` in `src/fileFormats/cnv/types.ts`, bundled into the server;
-   methods, `@` globals and built-in objects are extracted from the engine sources at build time (`src/vocabulary/extract.ts`, TypeScript compiler API): the upper-case methods of `src/engine/types/*.ts` with their parameters (read like `transformers.ts` reads `@method()`), the `TYPE` → class switch of `src/filesystem/definitionLoader.ts`, and `createGlobalHandlers`/`createGlobalInstances` of `src/interpreter/interpreter.ts`.

## Build and run

From the repository root:

```sh
yarn install
yarn build-lsp              # writes lsp/dist/server.js, lsp/dist/check.js and lsp/dist/vocabulary.json
node lsp/dist/server.js --stdio
```

The server is a single bundled file (esbuild) with no runtime dependencies; it is not part of the engine's webpack bundles. Rebuild it after changing the engine so the vocabulary follows.

The tests run with the engine's: `yarn test lsp/test`.

### Checking a whole game

`lsp/dist/check.js` runs the diagnostics over a folder and prints counts per diagnostic code, which is how false positives show:

```sh
yarn build-lsp
yarn lsp-check path/to/game                       # counts per code
yarn lsp-check path/to/game --list unknown-method  # with locations (--list all, --limit N)
yarn lsp-check path/to/game --no-hints --json
```

`node lsp/scripts/stdio-smoke.cjs <game folder> <file> [line] [character]` starts the server over stdio, opens a file and prints the diagnostics, symbols, hover, completion, definition and references the server returns.

## Editor setup

The server indexes every `.cnv`, `.def` and `.class` file under the workspace folders when it starts (encrypted files are decrypted for indexing) and follows open documents as they change.

The scripts are Windows-1250 text; open them with that encoding (VS Code: `"files.encoding": "windows1250"` for these files) so the columns of non-ASCII lines match.

### Neovim (0.10+)

```lua
vim.filetype.add({ extension = { cnv = 'piklib', def = 'piklib', class = 'piklib' } })
vim.api.nvim_create_autocmd('FileType', {
    pattern = 'piklib',
    callback = function(args)
        vim.lsp.start({
            name = 'reksio',
            cmd = { 'node', '/path/to/ReksioEngine/lsp/dist/server.js', '--stdio' },
            root_dir = vim.fs.root(args.buf, { 'Application.def', 'application.def', 'DANE', 'Dane', 'dane' }),
        })
    end,
})
```

Set `root_dir` to the folder that holds the game's `DANE` (and `common/classes`) so the server sees the whole game.

### VS Code

VS Code needs a small client extension to start a language server. In a folder with this `package.json`:

```json
{
    "name": "reksio-scripts",
    "version": "0.0.1",
    "engines": { "vscode": "^1.80.0" },
    "main": "extension.js",
    "activationEvents": ["onLanguage:piklib"],
    "contributes": {
        "languages": [{ "id": "piklib", "extensions": [".cnv", ".def", ".class"], "aliases": ["Piklib"] }],
        "configurationDefaults": { "[piklib]": { "files.encoding": "windows1250" } }
    },
    "dependencies": { "vscode-languageclient": "^9.0.1" }
}
```

and this `extension.js`:

```js
const { LanguageClient, TransportKind } = require('vscode-languageclient/node')

let client
exports.activate = () => {
    const server = {
        command: 'node',
        args: ['/path/to/ReksioEngine/lsp/dist/server.js', '--stdio'],
        transport: TransportKind.stdio,
    }
    client = new LanguageClient('reksio', 'Reksio scripts', server, {
        documentSelector: [{ language: 'piklib' }],
        initializationOptions: { undeclaredHints: true },
    })
    return client.start()
}
exports.deactivate = () => client?.stop()
```

run `npm install` and start it with _Run Extension_ (F5), or package it with `vsce`. Any generic LSP client extension that can start a stdio command works too.

### Options

`initializationOptions.undeclaredHints` (default `true`): hint at calls on objects that no file in scope declares. Scope is dynamic (spec §4.4), so these are hints only.

## Features

**Diagnostics.** Every message says what ReksioEngine does with the line.

| Code                                                         | Severity              | Meaning                                                                                                                                                                                                |
| ------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parse-error`                                                | error                 | The interpreter's parser rejects the code (e.g. `[-1+X]`), or a 3-argument `@IF` condition                                                                                                             |
| `unknown-global`, `if-arguments`, `if-operator`              | error                 | Unknown `@NAME`, `@IF` with neither 3 nor 5 arguments, unknown comparison                                                                                                                              |
| `missing-type`, `unknown-type`, `property-before-type`       | error                 | The engine fails to load the file                                                                                                                                                                      |
| `unknown-method`                                             | warning               | `OBJ^METHOD` where OBJ's TYPE has no such method. OBJ is looked up in the file, then the scene → episode → application → `Application.def` chain; GROUP, `*` indirect targets and `$n` are not checked |
| `missing-arguments` / `extra-arguments`                      | warning / information | Fewer arguments than the `@method()` declaration requires (the call fails) / more (ignored)                                                                                                            |
| `unknown-property`, `malformed-property`, `invalid-value`    | warning               | Not in the TYPE's schema; `NAME:={…}`; a boolean or number property the engine can't read                                                                                                              |
| `property-of-undeclared-object`                              | warning               | `NAME:PROP=` before `OBJECT=NAME`, ignored by the engine                                                                                                                                               |
| `invalid-callback`, `not-a-behaviour`                        | warning               | A callback value that is neither `{code}` nor a behaviour; a behaviour reference to a non-BEHAVIOUR                                                                                                    |
| `invalid-target`, `missing-target`, `unbalanced-parentheses` | warning               | Mangled code: `}ELSE{CURSOR^SET()`, `A>B()`, a missing `(` or `)`                                                                                                                                      |
| `bracket-statement`                                          | information           | A statement starting with `[`, which the interpreter runs as a call on `[NAME`                                                                                                                         |
| `undeclared`, `disabled-statement`                           | hint                  | A call target or behaviour no file in scope declares; Skarb Piratów's `!OBJ^…` statements                                                                                                              |

**Completion:** object names in scope (the file, its scene chain, `STRUCT` fields, `@INT` locals, `CLASS` instances created with `NEW("NAME")`, built-ins), methods after `NAME^` / `THIS^` / `S|FIELD^` by TYPE (behaviours for `CLASS` instances), properties after `NAME:`, `TYPE` values, `TRUE`/`FALSE`, `@` globals, behaviour names inside strings (`@IF(…,"BEH","")`), and event parameters after `NAME:ONEVENT^` (key names of KEYBOARD/MOUSE, events of the ANIMO's ANN file or the SEQUENCE's SEQ file, events used with `PLAY`/handled elsewhere).

**Hover:** method signatures with the parameter names and types of the TypeScript declaration and its comment; an object's TYPE and declaration line; property kinds; `TYPE` values (the type's properties and methods); `@` globals.

**Go to definition / find references:** object and behaviour names in code, in `@IF`/`@LOOP` string arguments, in callback values (`ONCLICK=BEH("X")`) and reference properties, across files. References only count uses that resolve to the same declaration, so the many `BFITMP0` behaviours of different scenes stay apart. `INSTANCE^BEHAVIOUR()` leads into the `.class` file; a method of a built-in TYPE leads to its engine source when the server runs from a checkout.

**Document symbols:** the objects of a file with their properties.

## How files see each other

`Application.def` is the root. Its APPLICATION, EPISODE and SCENE objects name the files `DANE/<PATH>/<NAME>.cnv` (case-insensitive), and a scene's code sees its own file, then its episode's, the application's and `Application.def`. Files loaded with `CNVLOADER^LOAD("X.CNV")` join the loading scene. A file outside this graph is treated as part of the scene in the same folder (backups, files loaded under a computed name), a `.class` file sees the files that declare a `CLASS` with that `DEF`.

## Known gaps

-   Scope is static: names that only exist at run time (objects of CNVs loaded under a computed name, clones beyond `NAME_<n>`, `DATABASE` cursors' fields) can't be checked, and a name declared in two files of one chain resolves to the nearest one.
-   `THIS` is only typed in event callbacks of the object itself; in behaviours it depends on the caller.
-   Methods called on GROUPs are not checked, because GROUP forwards them to its members.
-   The engine's vocabulary is the reference: methods and events of the original engine that ReksioEngine doesn't implement are reported (e.g. `TEXT^SETPRIORITY`, `MOUSE:RAW`).
-   Encrypted files are only indexed. Their positions don't match the encrypted text, so definitions in them point at the start of the file.
