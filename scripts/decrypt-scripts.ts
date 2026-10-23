// Copies a game's script files (.cnv, .def, .class, .seq) to another folder, decrypted, keeping the tree.
// The language server and grep work on the decrypted copy. See scripts/README.md.
import * as fs from 'fs'
import * as path from 'path'
import { decryptCNV } from '../src/fileFormats/cnv/decryptor'

const walk = (dir: string): string[] =>
    fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))

const [source, target] = process.argv.slice(2)
if (!source || !target) {
    console.error('Usage: yarn decrypt-scripts <game folder> <output folder>')
    process.exit(2)
}

let count = 0
for (const file of walk(source)) {
    if (!/\.(cnv|def|class|seq)$/i.test(file)) {
        continue
    }
    const data = fs.readFileSync(file)
    let text: string
    try {
        text = decryptCNV(data.buffer.slice(data.byteOffset, data.byteOffset + data.length))
    } catch {
        // Not encrypted
        text = data.toString('latin1')
    }
    const output = path.join(target, path.relative(source, file))
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, text, 'latin1')
    count++
}
console.log(`Wrote ${count} script files to ${target}`)
