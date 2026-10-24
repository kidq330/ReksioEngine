import { TestEngine } from '../../common/testUtils'
import { Animo } from './animo'
import { Episode } from './episode'
import { allLogs } from '../logging'

describe('ANIMO', () => {
    test('SETFRAME resolves its event like the original: unknown names fall back to the first event', () => {
        const engine = new TestEngine()
        const animo = new Animo(engine.asEngine(), null, { TYPE: 'ANIMO', NAME: 'ANCNT' } as any)
        const events = [{ name: 'licz' }, { name: 'IDLE' }]
        ;(animo as any).annFile = { events }
        ;(animo as any).currentEvent = events[1]
        const find = (arg: string | number) => (animo as any).findEventForSetFrame(arg)

        expect(find('LICZBY')).toBe(events[0])
        expect(find('idle')).toBe(events[1])
        expect(find(0)).toBe(events[0])
        expect(find(-1)).toBe(events[1])
        expect(find(5)).toBeNull()
    })

    test('PLAY and SHOW accept and ignore extra arguments, as the original does', async () => {
        const engine = new TestEngine()
        engine.add(new Animo(engine.asEngine(), engine.currentScene, { TYPE: 'ANIMO', NAME: 'ANSLON' } as any))
        await engine.run('ANSLON^SHOW("BABELKI");ANSLON^PLAY("RUN",0);')
        expect(allLogs.map((log) => log.text)).not.toContain('More arguments given than method accepts')
    })

    test('ISAT checks the frame rectangle, and with TRUE its pixel', () => {
        const engine = new TestEngine()
        const animo = new Animo(engine.asEngine(), null, { TYPE: 'ANIMO', NAME: 'ANMAP' } as any)
        // A 3x2 frame at (10, 20) whose left column is transparent
        ;(animo as any).sprite = {
            x: 10,
            y: 20,
            anchor: { x: 0, y: 0 },
            texture: { orig: { width: 3, height: 2 } },
            hitmap: new Uint8Array([0, 255, 255, 0, 255, 255]),
        }

        expect(animo.ISAT(10, 20, false)).toBe(true)
        expect(animo.ISAT(10, 20, true)).toBe(false)
        expect(animo.ISAT(12, 21, true)).toBe(true)
        expect(animo.ISAT(13, 21, false)).toBe(false)
        expect(animo.ISAT(9, 20, false)).toBe(false)
    })

    test('GETPOSITIONX with any argument is the position set with SETPOSITION', async () => {
        const engine = new TestEngine()
        const animo = new Animo(engine.asEngine(), null, { TYPE: 'ANIMO', NAME: 'ANLOCO' } as any)
        await animo.SETPOSITION(120, 45)
        expect(animo.GETPOSITIONX(true)).toBe(120)
        expect(animo.GETPOSITIONX(false)).toBe(120)
        expect(animo.GETPOSITIONY(true)).toBe(45)
    })

    test('before any scene, files are looked up beside the episode script that declared the object', async () => {
        const engine = new TestEngine()
        ;(engine as any).currentScene = null
        const episode = new Episode(engine.asEngine(), null, {
            TYPE: 'EPISODE',
            NAME: 'PRZYGODA',
            PATH: 'game/przygoda',
        } as any)
        const animo = new Animo(engine.asEngine(), episode, { TYPE: 'ANIMO', NAME: 'ANNFADE' } as any)
        expect(await (animo as any).resolveFilePath('G_FADE.ANN')).toBe('dane/game/przygoda/g_fade.ann')
    })
})
