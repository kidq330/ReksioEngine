import { getLines } from '../../src/fileFormats/cnv/parser'
import { foldLines, parseCnvDocument } from '../src/cnv/document'
import { analyzeCode, prepareCode, stripBraces } from '../src/code/analyze'
import { lines } from './fixtures'

const textAt = (text: string, span: { start: number; end: number }) => text.slice(span.start, span.end)

describe('CNV document layer', () => {
    test('folds lines exactly like the engine', () => {
        const samples = [
            lines('OBJECT=A', 'A:TYPE=INTEGER', '# comment', '', '   ', 'A:VALUE=1'),
            lines('TEST:CODE={ /', '    OTHER^CALL(); /', '\tANOTHER^CALL(); /', '}'),
            lines('  \tOBJECT=B  ', 'B:TYPE=BEHAVIOUR', 'B:CODE={A^SET(1);}/', '#not a comment after continuation'),
            'OBJECT=C\r\nC:TYPE=STRING\r\nC:VALUE=a/b\r\nnext\r\n',
        ]
        for (const sample of samples) {
            const engine = getLines(sample.replaceAll('\r\n', '\n'))
            expect(foldLines(sample).map((line) => line.text.text)).toEqual(engine)
        }
    })

    test('keeps document positions through folding', () => {
        const text = lines('A:CODE={ /', '    B^CALL(); /', '}')
        const [line] = foldLines(text)
        expect(line.text.text).toBe('A:CODE={ B^CALL(); }')
        const index = line.text.text.indexOf('CALL')
        expect(text.slice(line.text.offsets[index], line.text.offsets[index] + 4)).toBe('CALL')
    })

    test('reads objects and properties like processTokens', () => {
        const text = lines(
            'OBJECT=ANIMOREKSIO',
            'ANIMOREKSIO:TYPE=ANIMO',
            'ANIMOREKSIO:ONFINISHED^WYCHODZI={PRZYGODA^GOTO("S14");}',
            'OBJECT=TEST1:TEST1:TYPE=ANIMO',
            'APP:CREATIONTIME=2002-09-26 14:02:01',
            'OBJECT=APP',
            'APP:TYPE=APPLICATION',
            'APP:CREATIONTIME=2002-09-26 14:02:01'
        )
        const document = parseCnvDocument('file:///a.cnv', text)
        expect([...document.objects.keys()]).toEqual(['ANIMOREKSIO', 'TEST1', 'APP'])

        const finished = document.objects.get('ANIMOREKSIO')!.properties[1]
        expect(finished.name).toBe('ONFINISHED')
        expect(finished.param).toBe('WYCHODZI')
        expect(textAt(text, finished.paramSpan!)).toBe('WYCHODZI')
        expect(finished.value.text).toBe('{PRZYGODA^GOTO("S14");}')
        expect(textAt(text, finished.valueSpan)).toBe('{PRZYGODA^GOTO("S14");}')

        // The leftover tokens of an OBJECT line are another line
        expect(document.objects.get('TEST1')!.type).toBe('ANIMO')

        // `:` and `=` in values become spaces; a property before OBJECT is ignored
        expect(document.objects.get('APP')!.properties[1].value.text).toBe('2002-09-26 14 02 01')
        expect(document.strayProperties.map((property) => property.status)).toEqual(['undeclared-object'])
    })

    test('maps parser offsets of space-stripped code back to the document', () => {
        const text = 'B:CODE={ OBJ ^ PLAY ( "X" ) ; @IF("A","_","1","BEH","") }\n'
        const [line] = foldLines(text)
        const value = line.text
        const code = stripBraces({
            ...value,
            text: value.text.slice(7),
            offsets: value.offsets.slice(7),
        })
        expect(prepareCode(code).text).toBe('OBJ^PLAY("X");@IF("A","_","1","BEH","")')

        const analysis = analyzeCode(code, { globals: new Map([['IF', undefined]]) })
        const method = analysis.occurrences.find((occurrence) => occurrence.kind === 'method')!
        expect(textAt(text, method.span)).toBe('PLAY')
        const behaviour = analysis.occurrences.find(
            (occurrence) => occurrence.kind === 'object' && occurrence.role === 'behaviour'
        )!
        expect(textAt(text, behaviour.span)).toBe('BEH')
        const operand = analysis.occurrences.find(
            (occurrence) => occurrence.kind === 'object' && occurrence.name === 'A'
        )!
        expect(textAt(text, operand.span)).toBe('A')
    })
})
