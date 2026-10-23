import { Position } from 'vscode-languageserver'
import { ScriptVocabulary } from '../src/vocabulary'
import { Workspace } from '../src/workspace'
import { LanguageService, ServiceOptions } from '../src/service'
import { getVocabulary } from './fixtures'

export { getVocabulary, lines } from './fixtures'

export const uri = (name: string) => `file:///game/${name}`

/** A workspace of in-memory files: { 'DANE/Application.def': '…' } */
export const createService = (files: Record<string, string>, options: ServiceOptions = {}) => {
    const workspace = new Workspace(new ScriptVocabulary(getVocabulary()))
    for (const [name, text] of Object.entries(files)) {
        workspace.setFile(uri(name), text)
    }
    return new LanguageService(workspace, options)
}

/** Removes the `|` cursor marker from a text and returns the cursor position. */
export const cursor = (textWithCursor: string): { text: string; position: Position } => {
    const offset = textWithCursor.indexOf('|')
    if (offset === -1) {
        throw new Error('No | in text')
    }
    const text = textWithCursor.slice(0, offset) + textWithCursor.slice(offset + 1)
    const before = text.slice(0, offset).split('\n')
    return { text, position: { line: before.length - 1, character: before[before.length - 1].length } }
}

/** Position of the first occurrence of `needle` (plus `delta` characters) in `text`. */
export const positionOf = (text: string, needle: string, delta = 0): Position => {
    const offset = text.indexOf(needle)
    if (offset === -1) {
        throw new Error(`${needle} not found`)
    }
    const before = text.slice(0, offset + delta).split('\n')
    return { line: before.length - 1, character: before[before.length - 1].length }
}
