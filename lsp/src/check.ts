// Runs the diagnostics over a folder of scripts and reports counts, e.g. to see false positives on a game's data:
//   node lsp/dist/check.js <folder> [--list CODE[,CODE…]] [--limit N] [--no-hints] [--json]
import * as path from 'path'
import { fileURLToPath } from 'url'
import { ScriptVocabulary, Vocabulary } from './vocabulary'
import { Workspace } from './workspace'
import { LanguageService } from './service'
import { loadFolder } from './files'
import { Severity } from './code/analyze'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vocabularyData: Vocabulary = require('reksio-vocabulary')

const args = process.argv.slice(2)
const option = (name: string) => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
}
const folders = args.filter((arg, i) => !arg.startsWith('--') && !['--list', '--limit'].includes(args[i - 1]))
if (folders.length === 0) {
    console.error('Usage: check.js <folder>… [--list CODE[,CODE…]|all] [--limit N] [--no-hints] [--json]')
    process.exit(2)
}

const listed = option('--list')?.split(',')
const limit = Number(option('--limit') ?? 20)
const severities: Severity[] = ['error', 'warning', 'information', 'hint']

const report: Record<string, unknown> = {}
for (const folder of folders) {
    const workspace = new Workspace(new ScriptVocabulary(vocabularyData))
    const service = new LanguageService(workspace, { undeclaredHints: !args.includes('--no-hints') })
    const started = Date.now()
    const fileCount = loadFolder(workspace, path.resolve(folder))

    const bySeverity: Record<string, number> = {}
    const byCode: Record<string, { severity: Severity; count: number; samples: string[] }> = {}
    // Calls, and calls whose target TYPE is known so the method can be checked
    let calls = 0
    let typedCalls = 0
    for (const file of workspace.allFiles) {
        for (const occurrence of workspace.analysis(file).occurrences) {
            if (occurrence.kind === 'method') {
                calls++
                if (workspace.targetType(occurrence.target, file, occurrence.block?.thisType) !== undefined) {
                    typedCalls++
                }
            }
        }
        for (const problem of service.problems(file.uri)) {
            bySeverity[problem.severity] = (bySeverity[problem.severity] ?? 0) + 1
            const entry = (byCode[problem.code] ??= { severity: problem.severity, count: 0, samples: [] })
            entry.count++
            if (listed && (listed.includes('all') || listed.includes(problem.code)) && entry.samples.length < limit) {
                const position = file.document.lineIndex.positionAt(problem.span.start)
                const filePath = path.relative(folder, fileURLToPath(file.uri))
                const text = file.text.slice(problem.span.start, Math.min(problem.span.end, problem.span.start + 60))
                entry.samples.push(
                    `${filePath}:${position.line + 1}:${position.character + 1} ${problem.message} [${text}]`
                )
            }
        }
    }

    const elapsed = Date.now() - started
    report[folder] = { files: fileCount, calls, typedCalls, bySeverity, byCode, elapsedMs: elapsed }
    if (!args.includes('--json')) {
        console.log(
            `\n== ${folder}: ${fileCount} files, ${calls} method calls (${typedCalls} on objects of a known TYPE), ${elapsed} ms`
        )
        console.log('   ' + severities.map((severity) => `${severity}: ${bySeverity[severity] ?? 0}`).join(', '))
        const codes = Object.entries(byCode).sort(
            ([, a], [, b]) => severities.indexOf(a.severity) - severities.indexOf(b.severity) || b.count - a.count
        )
        for (const [code, entry] of codes) {
            console.log(`   ${entry.severity.padEnd(11)} ${String(entry.count).padStart(6)}  ${code}`)
            entry.samples.forEach((sample) => console.log(`        ${sample}`))
        }
    }
}
if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
}
