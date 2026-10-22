import { TestEngine } from '../../common/testUtils'
import { Timer } from './timer'

describe('SCENE', () => {
    let engine: TestEngine

    beforeEach(() => {
        engine = new TestEngine()
    })

    test('PAUSE stops running objects and RESUME continues only those', async () => {
        await engine.load(`
OBJECT=RUNNING
RUNNING:TYPE=TIMER
RUNNING:ELAPSE=100
RUNNING:ENABLED=TRUE

OBJECT=STOPPED
STOPPED:TYPE=TIMER
STOPPED:ELAPSE=100
STOPPED:ENABLED=FALSE
`)
        const running = engine.getObject<Timer>('RUNNING')!
        const stopped = engine.getObject<Timer>('STOPPED')!

        await engine.run('SCENE^PAUSE();')
        expect(running.isEnabled).toBe(false)
        expect(stopped.isEnabled).toBe(false)

        await engine.run('SCENE^RESUME();')
        expect(running.isEnabled).toBe(true)
        expect(stopped.isEnabled).toBe(false)
    })
})
