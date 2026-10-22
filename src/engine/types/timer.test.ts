import { TestEngine } from '../../common/testUtils'
import { Timer } from './timer'

describe('TIMER', () => {
    let engine: TestEngine

    beforeEach(() => {
        engine = new TestEngine()
    })

    test('GETTICKS returns the current tick', async () => {
        await engine.load(`
OBJECT=TIMER1
TIMER1:TYPE=TIMER
TIMER1:ELAPSE=100
TIMER1:ENABLED=TRUE
`)
        const timer = engine.getObject<Timer>('TIMER1')!
        await timer.tick(250)
        const ticks = engine.integer('TICKS')
        await engine.run('TICKS^SET(TIMER1^GETTICKS());')
        expect(ticks.getValue()).toBe(2)
    })
})
