// Reading script files from disk.
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { decryptCNV } from '../../src/fileFormats/cnv/decryptor'
import { isEncrypted } from './cnv/document'
import { Workspace } from './workspace'

export const SCRIPT_FILE = /\.(cnv|def|class)$/i

export const listScriptFiles = (dir: string): string[] => {
    const result: string[] = []
    const visit = (current: string) => {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name)
            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
                    visit(fullPath)
                }
            } else if (SCRIPT_FILE.test(entry.name)) {
                result.push(fullPath)
            }
        }
    }
    visit(dir)
    return result.sort()
}

/**
 * The text of a script file. The games use Windows-1250, read here as Latin-1 so every byte stays one character.
 * Encrypted files (`{<C:N>}` header) are decrypted; their positions then don't match the file on disk.
 */
export const readScriptFile = (filePath: string): { text: string; decrypted: boolean } => {
    const data = fs.readFileSync(filePath)
    const text = data.toString('latin1')
    if (isEncrypted(text)) {
        const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
        return { text: decryptCNV(buffer), decrypted: true }
    }
    return { text, decrypted: false }
}

export const fileUri = (filePath: string) => pathToFileURL(filePath).toString()

export const loadFolder = (workspace: Workspace, dir: string): number => {
    const files = listScriptFiles(dir)
    for (const filePath of files) {
        try {
            const { text, decrypted } = readScriptFile(filePath)
            workspace.setFile(fileUri(filePath), text, decrypted)
        } catch {
            // unreadable file
        }
    }
    return files.length
}

// Reads a file, matching each path segment case-insensitively like the games' Windows file system
export const readFileCaseInsensitive = (filePath: string): Uint8Array | null => {
    const resolved = resolveCaseInsensitive(filePath)
    if (resolved === null) {
        return null
    }
    try {
        return fs.readFileSync(resolved)
    } catch {
        return null
    }
}

const resolveCaseInsensitive = (filePath: string): string | null => {
    if (fs.existsSync(filePath)) {
        return filePath
    }
    const parent = path.dirname(filePath)
    if (parent === filePath) {
        return null
    }
    const resolvedParent = resolveCaseInsensitive(parent)
    if (resolvedParent === null) {
        return null
    }
    const name = path.basename(filePath).toLowerCase()
    try {
        const match = fs.readdirSync(resolvedParent).find((entry) => entry.toLowerCase() === name)
        return match ? path.join(resolvedParent, match) : null
    } catch {
        return null
    }
}
