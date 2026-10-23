import { getVocabulary } from './fixtures'
import { ScriptVocabulary, formatMethodSignature } from '../src/vocabulary'

describe('vocabulary extracted from the engine sources', () => {
    const vocabulary = new ScriptVocabulary(getVocabulary())

    test('maps TYPEs to engine classes, following import aliases', () => {
        expect(vocabulary.className('ANIMO')).toBe('Animo')
        expect(vocabulary.className('STRING')).toBe('String')
        expect(vocabulary.className('CANVASOBSERVER')).toBe('CanvasObserver')
    })

    test('reads method signatures like the @method() transformer', () => {
        const play = vocabulary.method('ANIMO', 'PLAY')!
        expect(play.decorated).toBe(true)
        expect(play.params).toEqual([{ name: 'name', types: ['string'], optional: true, rest: false }])
        expect(formatMethodSignature('ANIMO', vocabulary.method('ANIMO', 'GETPOSITIONX')!)).toBe(
            'ANIMO^GETPOSITIONX(objectPosition?: boolean): int'
        )
        expect(vocabulary.method('INTEGER', 'CLAMP')!.params.map((param) => param.types)).toEqual([['int'], ['int']])
    })

    test('includes inherited methods', () => {
        // Type, DisplayType and ValueType
        expect(vocabulary.method('ANIMO', 'GETNAME')?.owner).toBe('Type')
        expect(vocabulary.method('ANIMO', 'SETPRIORITY')?.owner).toBe('DisplayType')
        expect(vocabulary.method('INTEGER', 'RESETINI')?.owner).toBe('ValueType')
        expect(vocabulary.method('BEHAVIOUR', 'SETPRIORITY')).toBeUndefined()
    })

    test('knows which types forward unknown calls', () => {
        expect(vocabulary.forwardsUnknownCalls('GROUP')).toBe(true)
        expect(vocabulary.forwardsUnknownCalls('ANIMO')).toBe(false)
    })

    test('reads the globals and built-in objects of the interpreter', () => {
        const globals = getVocabulary().globals
        expect(globals.map((global) => global.name)).toEqual(
            expect.arrayContaining([
                'IF',
                'LOOP',
                'WHILE',
                'BREAK',
                'RETURN',
                'MSGBOX',
                'INT',
                'STRING',
                'BOOL',
                'DOUBLE',
            ])
        )
        expect(vocabulary.global('INT')?.declares).toBe('INTEGER')
        expect(getVocabulary().builtins).toEqual({ RANDOM: 'RAND', SYSTEM: 'SYSTEM', CNVLOADER: 'CNVLOADER' })
    })

    test('reads key names of KEYBOARD and MOUSE events', () => {
        expect(getVocabulary().classes.Keyboard.eventKeys).toEqual(expect.arrayContaining(['UP', 'SPACE', '1']))
        expect(getVocabulary().classes.Mouse.eventKeys).toEqual(['LEFT', 'MIDDLE', 'RIGHT'])
    })

    test('reads property schemas, including patterns', () => {
        expect(vocabulary.property('ANIMO', 'ONFINISHED')).toMatchObject({ kind: 'callbacks', subKind: 'string' })
        expect(vocabulary.property('BEHAVIOUR', 'CONDITION')).toMatchObject({ kind: 'reference', optional: true })
        expect(vocabulary.property('FONT', 'DEF_ARIAL_STANDARD_14')?.name).toBe('DEF_%s_%s_%d')
        expect(vocabulary.property('ANIMO', 'NOPE')).toBeUndefined()
    })
})
