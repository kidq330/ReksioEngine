// Starts the built server over stdio, opens one file of a game folder and prints what the server answers:
//   node lsp/scripts/stdio-smoke.cjs <game folder> <file in it> [line] [character]
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { pathToFileURL } = require('url')
const rpc = require('vscode-jsonrpc/node')

const [folder, file, line = '0', character = '0'] = process.argv.slice(2)
if (!folder || !file) {
    console.error('Usage: node lsp/scripts/stdio-smoke.cjs <game folder> <file> [line] [character]')
    process.exit(2)
}

const main = async () => {
    const server = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'server.js'), '--stdio'])
    const connection = rpc.createMessageConnection(
        new rpc.StreamMessageReader(server.stdout),
        new rpc.StreamMessageWriter(server.stdin)
    )
    const diagnostics = new Promise((resolve) =>
        connection.onNotification('textDocument/publishDiagnostics', (params) => resolve(params))
    )
    connection.onNotification('window/logMessage', (params) => console.log(`[server] ${params.message}`))
    connection.listen()

    const rootUri = pathToFileURL(path.resolve(folder)).toString()
    const uri = pathToFileURL(path.resolve(folder, file)).toString()
    const position = { line: Number(line), character: Number(character) }

    const init = await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'game' }],
        capabilities: {},
    })
    console.log('capabilities:', Object.keys(init.capabilities).join(', '))
    connection.sendNotification('initialized', {})
    connection.sendNotification('textDocument/didOpen', {
        textDocument: {
            uri,
            languageId: 'piklib',
            version: 1,
            text: fs.readFileSync(path.resolve(folder, file), 'latin1'),
        },
    })

    const published = await diagnostics
    const bySeverity = {}
    published.diagnostics.forEach((d) => (bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1))
    console.log(`diagnostics (by LSP severity): ${JSON.stringify(bySeverity)}`)
    published.diagnostics.slice(0, 5).forEach((d) => console.log(`  ${d.range.start.line + 1}: ${d.message}`))

    const symbols = await connection.sendRequest('textDocument/documentSymbol', { textDocument: { uri } })
    console.log(
        `symbols: ${symbols.length}, first: ${symbols
            .slice(0, 5)
            .map((s) => s.name)
            .join(', ')}`
    )
    const hover = await connection.sendRequest('textDocument/hover', { textDocument: { uri }, position })
    console.log('hover:', hover ? hover.contents.value : null)
    const completion = await connection.sendRequest('textDocument/completion', { textDocument: { uri }, position })
    console.log(
        `completion: ${completion.length} items, e.g. ${completion
            .slice(0, 8)
            .map((c) => c.label)
            .join(', ')}`
    )
    const definition = await connection.sendRequest('textDocument/definition', { textDocument: { uri }, position })
    console.log('definition:', JSON.stringify(definition))
    const references = await connection.sendRequest('textDocument/references', {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
    })
    console.log(`references: ${references.length}`)

    await connection.sendRequest('shutdown')
    connection.sendNotification('exit')
    connection.dispose()
    server.kill()
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
