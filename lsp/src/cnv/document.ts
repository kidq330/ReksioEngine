// The CNV/DEF/CLASS file layer, read the way src/fileFormats/cnv/parser.ts reads it (getLines + processTokens) but
// keeping document positions. A test checks that the folded lines equal getLines() of the engine.
import { MappedText, Span, filterChars, mapped, slice, spanOf, trim, LineIndex } from './text'

export interface LogicalLine {
    text: MappedText
    // Document span of the physical lines it was folded from
    span: Span
    firstLine: number
    lastLine: number
}

export interface CnvProperty {
    objectName: string
    objectSpan: Span
    name: string
    nameSpan: Span
    // The `^PARAM` of parametrised callbacks
    param?: string
    paramSpan?: Span
    // The third and later tokens, joined with a space and trimmed like the engine builds the value
    value: MappedText
    valueSpan: Span
    line: LogicalLine
    // How the engine treats this line
    status: 'ok' | 'undeclared-object' | 'before-type' | 'malformed'
}

export interface CnvObject {
    name: string
    nameSpan: Span
    line: LogicalLine
    type?: string
    typeSpan?: Span
    properties: CnvProperty[]
    // From the OBJECT line to its last property line
    span: Span
}

export interface CnvDocument {
    uri: string
    text: string
    lineIndex: LineIndex
    lines: LogicalLine[]
    objects: Map<string, CnvObject>
    // Property lines the engine ignores: of undeclared objects, or neither objects nor properties
    strayProperties: CnvProperty[]
    encrypted: boolean
}

/**
 * Folds physical lines into logical ones like `CMElementsLoader::getLine` (src/fileFormats/cnv/parser.ts getLines):
 * tabs removed, spaces trimmed, a `/` anywhere continues the line, every `/` is dropped, `#` lines and blank lines
 * are skipped.
 */
export const foldLines = (text: string): LogicalLine[] => {
    const physical: { text: string; start: number }[] = []
    let start = 0
    for (let i = 0; i <= text.length; i++) {
        if (i === text.length || text[i] === '\n') {
            let end = i
            // The engine normalises CRLF before folding
            if (end > start && text[end - 1] === '\r') {
                end--
            }
            physical.push({ text: text.slice(start, end), start })
            start = i + 1
        }
    }

    const result: LogicalLine[] = []
    let index = 0
    while (index < physical.length) {
        let lineText = ''
        const offsets: number[] = []
        const firstLine = index
        let lastEnd = physical[index].start
        while (index < physical.length) {
            const sub = physical[index]
            index++
            // remove tabs, then trim spaces at both ends
            let chars = ''
            const charOffsets: number[] = []
            for (let i = 0; i < sub.text.length; i++) {
                if (sub.text[i] !== '\t') {
                    chars += sub.text[i]
                    charOffsets.push(sub.start + i)
                }
            }
            const leading = chars.length - chars.replace(/^ +/, '').length
            const trailing = chars.length - chars.replace(/ +$/, '').length
            const kept = Math.max(0, chars.length - leading - trailing)
            lineText += chars.slice(leading, leading + kept)
            offsets.push(...charOffsets.slice(leading, leading + kept))
            lastEnd = sub.start + sub.text.length
            if (!sub.text.includes('/')) {
                break
            }
        }

        const folded = filterChars(mapped(lineText, offsets, lastEnd), (char) => char !== '/')
        if (folded.text.startsWith('#') || !folded.text.trim()) {
            continue
        }
        result.push({
            text: folded,
            span: { start: physical[firstLine].start, end: lastEnd },
            firstLine,
            lastLine: index - 1,
        })
    }
    return result
}

interface Token {
    text: string
    start: number
    end: number
}

// Split on every `:` and `=`, dropping empty tokens
const tokenize = (line: string): Token[] => {
    const tokens: Token[] = []
    const pattern = /[^:=]+/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(line)) !== null) {
        tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length })
    }
    return tokens
}

// Tokens joined with a single space: the separators between them become one space
const joinValue = (line: MappedText, tokens: Token[]): MappedText => {
    if (tokens.length === 0) {
        return slice(line, line.text.length)
    }
    let text = ''
    const offsets: number[] = []
    tokens.forEach((token, i) => {
        if (i > 0) {
            text += ' '
            offsets.push(line.offsets[token.start - 1])
        }
        text += token.text
        offsets.push(...line.offsets.slice(token.start, token.end))
    })
    return trim(mapped(text, offsets, offsets[offsets.length - 1] + 1))
}

export const isEncrypted = (text: string) => /^\{<[cCdD]:\d+>\}/.test(text)

export const parseCnvDocument = (uri: string, text: string): CnvDocument => {
    const document: CnvDocument = {
        uri,
        text,
        lineIndex: new LineIndex(text),
        lines: [],
        objects: new Map(),
        strayProperties: [],
        encrypted: isEncrypted(text),
    }
    if (document.encrypted) {
        return document
    }

    document.lines = foldLines(text)
    for (const line of document.lines) {
        const tokens = tokenize(line.text.text)
        if (tokens.length < 2) {
            continue
        }
        processTokens(document, line, tokens)
    }
    return document
}

const processTokens = (document: CnvDocument, line: LogicalLine, tokens: Token[]) => {
    const text = line.text
    if (tokens[0].text === 'OBJECT') {
        if (tokens.length < 2) {
            return
        }
        const name = tokens[1].text
        if (!document.objects.has(name)) {
            document.objects.set(name, {
                name,
                nameSpan: spanOf(text, tokens[1].start, tokens[1].end),
                line,
                properties: [],
                span: { start: line.span.start, end: line.span.end },
            })
        }
        // The rest of an OBJECT line is processed like another line
        if (tokens.length > 2) {
            processTokens(document, line, tokens.slice(2))
        }
        return
    }

    const [objectToken, variableToken] = tokens
    const object = document.objects.get(objectToken.text)

    const property: CnvProperty = {
        objectName: objectToken.text,
        objectSpan: spanOf(text, objectToken.start, objectToken.end),
        name: '',
        nameSpan: spanOf(text, objectToken.end, objectToken.end),
        value: joinValue(text, tokens.slice(2)),
        valueSpan: { start: 0, end: 0 },
        line,
        status: 'ok',
    }
    property.valueSpan = spanOf(property.value, 0, property.value.text.length)

    if (variableToken !== undefined) {
        // NAME^PARAM; text after a second `^` is dropped
        const [name, param] = variableToken.text.split('^')
        property.name = name
        property.nameSpan = spanOf(text, variableToken.start, variableToken.start + name.length)
        if (param !== undefined) {
            const paramStart = variableToken.start + name.length + 1
            property.param = param
            property.paramSpan = spanOf(text, paramStart, paramStart + param.length)
        }
    }

    if (variableToken === undefined) {
        property.status = 'malformed'
    } else if (object === undefined) {
        property.status = 'undeclared-object'
    } else if (property.name !== 'TYPE' && object.type === undefined) {
        property.status = 'before-type'
    }

    if (object === undefined || property.status === 'malformed') {
        document.strayProperties.push(property)
        return
    }

    object.properties.push(property)
    object.span.end = Math.max(object.span.end, line.span.end)
    if (property.name === 'TYPE') {
        object.type = property.value.text
        object.typeSpan = property.valueSpan
    }
}
