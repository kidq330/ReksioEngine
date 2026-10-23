// Piklib/BlooMoo language server over stdio.
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
    CompletionItem,
    DidChangeWatchedFilesNotification,
    FileChangeType,
    InitializeParams,
    InitializeResult,
    ProposedFeatures,
    TextDocumentSyncKind,
    TextDocuments,
    createConnection,
} from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { ScriptVocabulary, Vocabulary } from './vocabulary'
import { Workspace } from './workspace'
import { LanguageService } from './service'
import { SCRIPT_FILE, loadFolder, readFileCaseInsensitive, readScriptFile } from './files'

if (process.argv.includes('--version')) {
    console.log('reksio-lsp')
    process.exit(0)
}

// Generated from the engine sources by lsp/scripts/build.ts and bundled as a virtual module
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vocabularyData: Vocabulary = require('reksio-vocabulary')

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments(TextDocument)
const workspace = new Workspace(new ScriptVocabulary(vocabularyData))

// The repository root when running from lsp/dist of a checkout, to link methods to the engine sources
const engineRoot = (() => {
    const candidate = path.resolve(__dirname, '..', '..')
    return fs.existsSync(path.join(candidate, 'src', 'engine', 'types')) ? candidate : undefined
})()

let service = new LanguageService(workspace, { engineRoot, readFile: readFileCaseInsensitive })
let watchFiles = false

connection.onInitialize((params: InitializeParams): InitializeResult => {
    const options = params.initializationOptions ?? {}
    service = new LanguageService(workspace, {
        engineRoot,
        readFile: readFileCaseInsensitive,
        undeclaredHints: options.undeclaredHints !== false,
    })

    const folders = params.workspaceFolders?.map((folder) => folder.uri) ?? (params.rootUri ? [params.rootUri] : [])
    for (const folder of folders) {
        try {
            const count = loadFolder(workspace, fileURLToPath(folder))
            connection.console.log(`Indexed ${count} script files in ${folder}`)
        } catch (err) {
            connection.console.error(`Failed to index ${folder}: ${err}`)
        }
    }
    watchFiles = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: { triggerCharacters: ['^', '@', ':', '=', '"', '(', ',', '{', ';'] },
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            documentSymbolProvider: true,
        },
    }
})

connection.onInitialized(() => {
    if (watchFiles) {
        void connection.client.register(DidChangeWatchedFilesNotification.type, {
            watchers: [{ globPattern: '**/*.{cnv,CNV,def,DEF,class,CLASS}' }],
        })
    }
})

let validationTimer: NodeJS.Timeout | null = null
const scheduleValidation = () => {
    if (validationTimer) {
        clearTimeout(validationTimer)
    }
    validationTimer = setTimeout(() => {
        validationTimer = null
        // Other files can change what an open file sees, so all open files are checked again
        for (const document of documents.all()) {
            try {
                void connection.sendDiagnostics({
                    uri: document.uri,
                    diagnostics: service.diagnostics(document.uri),
                })
            } catch (err) {
                connection.console.error(`Diagnostics failed for ${document.uri}: ${err}`)
            }
        }
    }, 200)
}

documents.onDidChangeContent((change) => {
    workspace.setFile(change.document.uri, change.document.getText())
    scheduleValidation()
})

documents.onDidClose((event) => {
    // Back to the version on disk
    const uri = event.document.uri
    try {
        const { text, decrypted } = readScriptFile(fileURLToPath(uri))
        workspace.setFile(uri, text, decrypted)
    } catch {
        workspace.removeFile(uri)
    }
    void connection.sendDiagnostics({ uri, diagnostics: [] })
    scheduleValidation()
})

connection.onDidChangeWatchedFiles((params) => {
    for (const change of params.changes) {
        if (!SCRIPT_FILE.test(change.uri) || documents.get(change.uri)) {
            continue
        }
        if (change.type === FileChangeType.Deleted) {
            workspace.removeFile(change.uri)
        } else {
            try {
                const { text, decrypted } = readScriptFile(fileURLToPath(change.uri))
                workspace.setFile(change.uri, text, decrypted)
            } catch {
                workspace.removeFile(change.uri)
            }
        }
    }
    scheduleValidation()
})

const safely =
    <P, R>(fallback: R, handler: (params: P) => R) =>
    (params: P): R => {
        try {
            return handler(params)
        } catch (err) {
            connection.console.error(`${err instanceof Error ? err.stack : err}`)
            return fallback
        }
    }

connection.onCompletion(
    safely([] as CompletionItem[], (params) => service.completion(params.textDocument.uri, params.position))
)
connection.onHover(safely(null, (params) => service.hover(params.textDocument.uri, params.position)))
connection.onDefinition(safely([], (params) => service.definition(params.textDocument.uri, params.position)))
connection.onReferences(
    safely([], (params) =>
        service.references(params.textDocument.uri, params.position, params.context.includeDeclaration)
    )
)
connection.onDocumentSymbol(safely([], (params) => service.documentSymbols(params.textDocument.uri)))

documents.listen(connection)
connection.listen()
