import { TestEngine } from '../../common/testUtils'
import { Animo } from './animo'

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

    test('GETPOSITIONX with any argument is the position set with SETPOSITION', async () => {
        const engine = new TestEngine()
        const animo = new Animo(engine.asEngine(), null, { TYPE: 'ANIMO', NAME: 'ANLOCO' } as any)
        await animo.SETPOSITION(120, 45)
        expect(animo.GETPOSITIONX(true)).toBe(120)
        expect(animo.GETPOSITIONX(false)).toBe(120)
        expect(animo.GETPOSITIONY(true)).toBe(45)
    })
})
