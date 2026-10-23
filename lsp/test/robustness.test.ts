import { createService, lines, uri } from './helpers'

// Text being typed is mostly broken; no request may throw on it
const SAMPLE = lines(
    'OBJECT=ANIMOREKSIO',
    'ANIMOREKSIO:TYPE=ANIMO',
    'ANIMOREKSIO:ONFINISHED^WALK={THIS^PLAY("STAND");@IF("V","_","1","BEH","{X^Y(1,[A+B@2]);}");}',
    'OBJECT=V',
    'V:TYPE=INTEGER',
    'OBJECT=S',
    'S:TYPE=STRUCT',
    'S:FIELDS=A<STRING>,B<INTEGER>',
    'OBJECT=BEH',
    'BEH:TYPE=BEHAVIOUR',
    'BEH:CODE={ /',
    '   S|A^SET("x"); *["ANIMO"+$1]^PLAY(); @IF("V\'1&&V>0","BEH",""); @LOOP("{V^ADD(_I_);}",0,3,1);/',
    '}',
    'OBJECT=C',
    'C:TYPE=CONDITION',
    'C:OPERAND1=[V^GET()+1]',
    'C:OPERAND2=V'
)

const CHARS = [
    '{',
    '}',
    '(',
    ')',
    '[',
    ']',
    '"',
    '^',
    '@',
    '*',
    '|',
    ':',
    '=',
    ';',
    ',',
    '/',
    '#',
    '$1',
    ' ',
    '\n',
    'A',
]

// Deterministic pseudo-random numbers
const random = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
}

describe('robustness', () => {
    test('requests on mangled text never throw', () => {
        const next = random(42)
        for (let round = 0; round < 150; round++) {
            let text = SAMPLE
            for (let edit = 0; edit < 3; edit++) {
                const at = Math.floor(next() * text.length)
                const remove = Math.floor(next() * 3)
                const insert = CHARS[Math.floor(next() * CHARS.length)]
                text = text.slice(0, at) + insert + text.slice(at + remove)
            }
            const service = createService({ 'scene.cnv': text })
            const fileUri = uri('scene.cnv')
            expect(() => service.diagnostics(fileUri)).not.toThrow()
            expect(() => service.documentSymbols(fileUri)).not.toThrow()
            const lineCount = text.split('\n').length
            for (let probe = 0; probe < 5; probe++) {
                const line = Math.floor(next() * lineCount)
                const character = Math.floor(next() * (text.split('\n')[line].length + 1))
                const position = { line, character }
                expect(() => service.completion(fileUri, position)).not.toThrow()
                expect(() => service.hover(fileUri, position)).not.toThrow()
                expect(() => service.definition(fileUri, position)).not.toThrow()
                expect(() => service.references(fileUri, position, true)).not.toThrow()
            }
        }
    })
})
