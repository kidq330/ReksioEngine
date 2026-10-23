// Text whose characters remember where they came from in the document. The engine rewrites CNV text a lot before it
// runs it (line folding, `:`/`=` splitting, brace stripping, space removal), so every step here keeps a parallel array
// of document offsets to report positions in the file the user edits.

export interface Span {
    start: number
    end: number
}

export interface MappedText {
    text: string
    // Document offset of each character of `text`
    offsets: number[]
    // Document offset used for an empty text or the position right after the last character
    endOffset: number
}

export const mapped = (text: string, offsets: number[], endOffset: number): MappedText => ({ text, offsets, endOffset })

export const slice = (source: MappedText, start: number, end: number = source.text.length): MappedText => {
    start = Math.max(0, Math.min(start, source.text.length))
    end = Math.max(start, Math.min(end, source.text.length))
    return {
        text: source.text.slice(start, end),
        offsets: source.offsets.slice(start, end),
        endOffset: end < source.text.length ? source.offsets[end] : source.endOffset,
    }
}

export const filterChars = (source: MappedText, keep: (char: string) => boolean): MappedText => {
    let text = ''
    const offsets: number[] = []
    for (let i = 0; i < source.text.length; i++) {
        if (keep(source.text[i])) {
            text += source.text[i]
            offsets.push(source.offsets[i])
        }
    }
    return { text, offsets, endOffset: source.endOffset }
}

// Like String.trim(), keeping the offsets
export const trim = (source: MappedText): MappedText => {
    const start = source.text.length - source.text.trimStart().length
    const end = source.text.trimEnd().length
    return end <= start ? slice(source, start, start) : slice(source, start, end)
}

// Document span of characters [start, end) of a mapped text
export const spanOf = (source: MappedText, start: number, end: number): Span => {
    start = Math.max(0, Math.min(start, source.text.length))
    end = Math.max(start, Math.min(end, source.text.length))
    const startOffset = start < source.text.length ? source.offsets[start] : source.endOffset
    if (end === start) {
        return { start: startOffset, end: startOffset }
    }
    return { start: startOffset, end: source.offsets[end - 1] + 1 }
}

export const wholeSpan = (source: MappedText): Span => spanOf(source, 0, source.text.length)

// Index into the mapped text of the character at a document offset, or -1
export const indexAtOffset = (source: MappedText, offset: number): number => {
    for (let i = 0; i < source.offsets.length; i++) {
        if (source.offsets[i] === offset) {
            return i
        }
        if (source.offsets[i] > offset) {
            return i
        }
    }
    return source.offsets.length
}

export const contains = (span: Span, offset: number) => span.start <= offset && offset <= span.end

export class LineIndex {
    private readonly starts: number[]

    constructor(text: string) {
        this.starts = [0]
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') {
                this.starts.push(i + 1)
            }
        }
    }

    positionAt(offset: number): { line: number; character: number } {
        let low = 0
        let high = this.starts.length - 1
        while (low < high) {
            const mid = (low + high + 1) >> 1
            if (this.starts[mid] <= offset) {
                low = mid
            } else {
                high = mid - 1
            }
        }
        return { line: low, character: offset - this.starts[low] }
    }

    offsetAt(position: { line: number; character: number }): number {
        const line = Math.max(0, Math.min(position.line, this.starts.length - 1))
        return this.starts[line] + position.character
    }

    rangeOf(span: Span) {
        return { start: this.positionAt(span.start), end: this.positionAt(span.end) }
    }

    lineStart(line: number) {
        return this.starts[Math.max(0, Math.min(line, this.starts.length - 1))]
    }

    get lineCount() {
        return this.starts.length
    }
}
