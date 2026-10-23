import * as path from 'path'
import { extractVocabulary } from '../src/vocabulary/extract'
import { Vocabulary } from '../src/vocabulary'

let vocabulary: Vocabulary | null = null

export const repoRoot = path.resolve(__dirname, '..', '..')

// The vocabulary of this checkout's engine, extracted once per test file
export const getVocabulary = () => {
    if (vocabulary === null) {
        vocabulary = extractVocabulary(repoRoot)
    }
    return vocabulary
}

export const lines = (...parts: string[]) => parts.join('\n') + '\n'
