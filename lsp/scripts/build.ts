// Builds the language server: extracts the script vocabulary from the engine sources and bundles lsp/src into
// lsp/dist with esbuild. Run with `yarn build-lsp`.
import * as fs from 'fs'
import * as path from 'path'
import * as esbuild from 'esbuild'
import { extractVocabulary } from '../src/vocabulary/extract'

const lspRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(lspRoot, '..')
const outDir = path.join(lspRoot, 'dist')

const vocabulary = extractVocabulary(repoRoot)

// The interpreter's parser imports valueAsBool from src/common/types, which pulls in the whole engine (pixi.js…).
// The parser only uses it for the literals TRUE/FALSE, so the bundle gets the one function it needs.
const parserShim: esbuild.Plugin = {
    name: 'parser-shim',
    setup(build) {
        build.onResolve({ filter: /^\.\.\/common\/types$/ }, (args) => {
            if (args.importer.replaceAll('\\', '/').endsWith('src/interpreter/parser.ts')) {
                return { path: 'parser-common-types', namespace: 'reksio-shim' }
            }
            return undefined
        })
        build.onLoad({ filter: /.*/, namespace: 'reksio-shim' }, () => ({
            contents: `export const valueAsBool = (value) => typeof value === 'string' ? value.toUpperCase() === 'TRUE' : Boolean(value)`,
            loader: 'js',
        }))
    },
}

const vocabularyModule: esbuild.Plugin = {
    name: 'vocabulary',
    setup(build) {
        build.onResolve({ filter: /^reksio-vocabulary$/ }, () => ({
            path: 'vocabulary',
            namespace: 'reksio-vocabulary',
        }))
        build.onLoad({ filter: /.*/, namespace: 'reksio-vocabulary' }, () => ({
            contents: JSON.stringify(vocabulary),
            loader: 'json',
        }))
    },
}

const main = async () => {
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'vocabulary.json'), JSON.stringify(vocabulary, null, 2))

    const result = await esbuild.build({
        entryPoints: {
            server: path.join(lspRoot, 'src', 'server.ts'),
            check: path.join(lspRoot, 'src', 'check.ts'),
        },
        outdir: outDir,
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        sourcemap: true,
        banner: { js: '#!/usr/bin/env node' },
        plugins: [parserShim, vocabularyModule],
        metafile: true,
        logLevel: 'warning',
    })

    // The bundle must not drag the engine runtime in
    const inputs = Object.keys(result.metafile!.inputs)
    const leaked = inputs.filter((input) => /pixi|src[\\/]engine[\\/](index|rendering)/.test(input))
    if (leaked.length > 0) {
        throw new Error(`Engine runtime modules ended up in the bundle: ${leaked.join(', ')}`)
    }

    for (const output of ['server.js', 'check.js']) {
        fs.chmodSync(path.join(outDir, output), 0o755)
    }
    const methods = Object.values(vocabulary.classes).reduce((sum, info) => sum + info.methods.length, 0)
    console.log(
        `Built ${path.relative(repoRoot, outDir)}: ${Object.keys(vocabulary.types).length} types, ${methods} methods, ${vocabulary.globals.length} globals`
    )
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
