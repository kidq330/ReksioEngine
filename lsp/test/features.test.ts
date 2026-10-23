import { MarkupContent } from 'vscode-languageserver'
import { createService, cursor, lines, positionOf, uri } from './helpers'

const BASE = lines(
    'OBJECT=ANIMOREKSIO',
    'ANIMOREKSIO:TYPE=ANIMO',
    'ANIMOREKSIO:FILENAME=REKSIO.ANN',
    'ANIMOREKSIO:ONFINISHED^WALK={THIS^PLAY("STAND");}',
    'OBJECT=VARCOUNT',
    'VARCOUNT:TYPE=INTEGER',
    'OBJECT=KEYS',
    'KEYS:TYPE=KEYBOARD',
    'OBJECT=BEHSTOP',
    'BEHSTOP:TYPE=BEHAVIOUR',
    'BEHSTOP:CODE={ANIMOREKSIO^STOP();}'
)

const complete = (textWithCursor: string, extraFiles: Record<string, string> = {}) => {
    const { text, position } = cursor(textWithCursor)
    const service = createService({ 'scene.cnv': text, ...extraFiles })
    return service.completion(uri('scene.cnv'), position).map((item) => item.label)
}

const hoverText = (text: string, needle: string, delta = 0, extraFiles: Record<string, string> = {}) => {
    const service = createService({ 'scene.cnv': text, ...extraFiles })
    const hover = service.hover(uri('scene.cnv'), positionOf(text, needle, delta))
    return hover ? (hover.contents as MarkupContent).value : null
}

describe('completion', () => {
    test('methods after NAME^ by the TYPE of the object', () => {
        const labels = complete(BASE + 'OBJECT=B\nB:TYPE=BEHAVIOUR\nB:CODE={VARCOUNT^|')
        expect(labels).toEqual(expect.arrayContaining(['INC', 'CLAMP', 'GETNAME', 'RESETINI']))
        expect(labels).not.toContain('PLAY')
    })

    test('methods of THIS in an event callback', () => {
        const labels = complete(BASE + 'ANIMOREKSIO:ONSTARTED^WALK={VARCOUNT^INC(); THIS ^ |')
        expect(labels).toContain('PLAY')
        expect(labels).not.toContain('INC')
    })

    test('behaviours of a CLASS instance', () => {
        const text =
            BASE + lines('OBJECT=CLS', 'CLS:TYPE=CLASS', 'CLS:DEF=MENU.CLASS', 'BEHSTOP:CODE={CLS^NEW("M1");M1^|')
        const classFile = lines('OBJECT=SHOWMENU', 'SHOWMENU:TYPE=BEHAVIOUR', 'SHOWMENU:CODE={}')
        expect(complete(text, { 'menu.class': classFile })).toEqual(['SHOWMENU'])
    })

    test('property names after NAME:', () => {
        const labels = complete(BASE + 'ANIMOREKSIO:|')
        expect(labels).toEqual(expect.arrayContaining(['TYPE', 'VISIBLE', 'FILENAME', 'ONFINISHED', 'ONCLICK']))
        expect(labels).not.toContain('ELAPSE')
    })

    test('TYPE names and boolean values', () => {
        expect(complete('OBJECT=X\nX:TYPE=|')).toEqual(
            expect.arrayContaining(['ANIMO', 'BEHAVIOUR', 'CANVAS_OBSERVER'])
        )
        expect(complete(BASE + 'ANIMOREKSIO:VISIBLE=|')).toEqual(['TRUE', 'FALSE'])
    })

    test('globals after @', () => {
        expect(complete(BASE + 'BEHSTOP:CODE={@|')).toEqual(
            expect.arrayContaining(['IF', 'LOOP', 'WHILE', 'RETURN', 'INT'])
        )
    })

    test('object names in scope, including other files', () => {
        const files = {
            'DANE/Application.def': lines(
                'OBJECT=APP',
                'APP:TYPE=APPLICATION',
                'APP:PATH=GAME',
                'OBJECT=S1',
                'S1:TYPE=SCENE',
                'S1:PATH=GAME\\S1'
            ),
            'DANE/GAME/APP.cnv': lines('OBJECT=VARGLOBAL', 'VARGLOBAL:TYPE=STRING'),
        }
        const { text, position } = cursor(BASE + 'BEHSTOP:CODE={ANIMOREKSIO^PLAY(|')
        const service = createService({ ...files, 'DANE/GAME/S1/S1.cnv': text })
        const labels = service.completion(uri('DANE/GAME/S1/S1.cnv'), position).map((item) => item.label)
        expect(labels).toEqual(expect.arrayContaining(['ANIMOREKSIO', 'VARCOUNT', 'VARGLOBAL', 'APP', 'S1', 'RANDOM']))
    })

    test('behaviour names in strings of @IF', () => {
        const labels = complete(BASE + 'ANIMOREKSIO:ONCLICK={@IF("VARCOUNT","_","1","|')
        expect(labels).toContain('BEHSTOP')
    })

    test('event parameters for callbacks', () => {
        expect(complete(BASE + 'KEYS:ONKEYDOWN^|')).toEqual(expect.arrayContaining(['UP', 'DOWN', 'SPACE']))
        // events named in calls and other handlers of the object
        const labels = complete(BASE + 'BEHSTOP:CODE={ANIMOREKSIO^PLAY("JUMP");}\nANIMOREKSIO:ONFINISHED^|')
        expect(labels).toEqual(expect.arrayContaining(['WALK', 'JUMP']))
    })

    test('event names from the ANN file', () => {
        const { text, position } = cursor(BASE + 'ANIMOREKSIO:ONSTARTED^|')
        const ann = annWithEvents(['RUN', 'SIT'])
        const service = createService(
            { 'scene.cnv': text },
            { readFile: (filePath) => (filePath.endsWith('REKSIO.ANN') ? ann : null) }
        )
        const labels = service.completion(uri('scene.cnv'), position).map((item) => item.label)
        expect(labels).toEqual(expect.arrayContaining(['RUN', 'SIT']))
    })
})

describe('hover', () => {
    test('shows the method signature from the engine declaration', () => {
        const text = BASE + 'BEHSTOP:CODE={ ANIMOREKSIO ^ GETPOSITIONX ( TRUE ) ; }\n'
        const value = hoverText(text, 'GETPOSITIONX', 2)!
        expect(value).toContain('ANIMO^GETPOSITIONX(objectPosition?: boolean): int')
        expect(value).toContain('src/engine/types/animo.ts')
    })

    test('shows the TYPE and declaration of an object', () => {
        const text = BASE + 'BEHSTOP:CODE={VARCOUNT^INC();}\n'
        const value = hoverText(text, 'VARCOUNT^INC', 1)!
        expect(value).toContain('**VARCOUNT**: INTEGER')
        expect(value).toContain('`scene.cnv` line 5')
    })

    test('shows property kinds and globals', () => {
        expect(hoverText(BASE, 'ONFINISHED', 1)).toContain('callbacks<string>')
        expect(hoverText(BASE + 'BEHSTOP:CODE={@LOOP("{}",0,1,1);}\n', '@LOOP', 1)).toContain(
            '@LOOP(code, start, count, step)'
        )
    })
})

describe('navigation', () => {
    const files = {
        'DANE/Application.def': lines(
            'OBJECT=APP',
            'APP:TYPE=APPLICATION',
            'APP:PATH=GAME',
            'OBJECT=S1',
            'S1:TYPE=SCENE',
            'S1:PATH=GAME\\S1',
            'OBJECT=S2',
            'S2:TYPE=SCENE',
            'S2:PATH=GAME\\S2'
        ),
        'DANE/GAME/APP.cnv': lines(
            'OBJECT=BEHSHARED',
            'BEHSHARED:TYPE=BEHAVIOUR',
            'BEHSHARED:CODE={}',
            'OBJECT=BFITMP0',
            'BFITMP0:TYPE=BEHAVIOUR',
            'BFITMP0:CODE={}'
        ),
        'DANE/GAME/S1/S1.cnv': lines(
            'OBJECT=BFITMP0',
            'BFITMP0:TYPE=BEHAVIOUR',
            'BFITMP0:CODE={BEHSHARED^RUN();}',
            'OBJECT=B',
            'B:TYPE=BEHAVIOUR',
            'B:CODE={@IF("1","_","1","BFITMP0","BEHSHARED");}'
        ),
        'DANE/GAME/S2/S2.cnv': lines('OBJECT=B', 'B:TYPE=BEHAVIOUR', 'B:CODE={@IF("1","_","1","BFITMP0","");}'),
    }
    const s1 = files['DANE/GAME/S1/S1.cnv']

    test('goes to the declaration of a behaviour named in an @IF string', () => {
        const service = createService(files)
        const [location] = service.definition(uri('DANE/GAME/S1/S1.cnv'), positionOf(s1, '"BFITMP0"', 2))
        expect(location.uri).toBe(uri('DANE/GAME/S1/S1.cnv'))
        expect(location.range.start).toEqual({ line: 0, character: 7 })

        const [shared] = service.definition(uri('DANE/GAME/S1/S1.cnv'), positionOf(s1, '"BEHSHARED"', 2))
        expect(shared.uri).toBe(uri('DANE/GAME/APP.cnv'))
    })

    test('finds references of the same declaration only', () => {
        const service = createService(files)
        const app = files['DANE/GAME/APP.cnv']
        // S1 has its own BFITMP0, S2 sees the application's
        const references = service.references(uri('DANE/GAME/APP.cnv'), positionOf(app, 'BFITMP0'), true)
        expect(references.map((location) => location.uri).sort()).toEqual([
            uri('DANE/GAME/APP.cnv'),
            uri('DANE/GAME/APP.cnv'),
            uri('DANE/GAME/APP.cnv'),
            uri('DANE/GAME/S2/S2.cnv'),
        ])

        const shared = service.references(uri('DANE/GAME/S1/S1.cnv'), positionOf(s1, 'BEHSHARED'), false)
        expect(shared.map((location) => `${location.uri.split('/').pop()}:${location.range.start.line}`)).toEqual(
            expect.arrayContaining(['APP.cnv:1', 'APP.cnv:2', 'S1.cnv:2', 'S1.cnv:5'])
        )
    })

    test('lists the objects of a file as symbols', () => {
        const service = createService({ 'scene.cnv': BASE })
        const symbols = service.documentSymbols(uri('scene.cnv'))
        expect(symbols.map((symbol) => `${symbol.name}:${symbol.detail}`)).toEqual([
            'ANIMOREKSIO:ANIMO',
            'VARCOUNT:INTEGER',
            'KEYS:KEYBOARD',
            'BEHSTOP:BEHAVIOUR',
        ])
        expect(symbols[0].children!.map((child) => child.name)).toEqual(['FILENAME', 'ONFINISHED^WALK'])
        expect(symbols[0].range).toEqual({ start: { line: 0, character: 0 }, end: { line: 3, character: 49 } })
    })
})

// A minimal ANN file: header and events without frames
const annWithEvents = (names: string[]): Uint8Array => {
    const bytes: number[] = []
    const u32 = (value: number) => bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24)
    const u16 = (value: number) => bytes.push(value & 0xff, (value >> 8) & 0xff)
    const fill = (count: number) => bytes.push(...new Array(count).fill(0))
    u32(0x50564e)
    u16(0) // frames
    u16(16) // bpp
    u16(names.length)
    fill(0xd)
    u32(10) // fps
    u32(0) // flags
    bytes.push(0) // transparency
    u16(0) // random frames
    fill(0xa)
    u32(0) // author
    u32(0) // description
    for (const name of names) {
        const nameBytes = [...name].map((char) => char.charCodeAt(0))
        bytes.push(...nameBytes)
        fill(0x20 - nameBytes.length)
        u16(0) // frames
        u32(0)
        u16(0)
        u16(0)
        u16(0)
        fill(2)
        u32(10) // fps
        u32(0) // flags
        bytes.push(0) // transparency
        fill(0xc)
    }
    return new Uint8Array(bytes)
}
