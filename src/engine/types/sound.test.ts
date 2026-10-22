import { TestEngine } from '../../common/testUtils'
import { Sound } from './sound'

describe('SOUND', () => {
    let engine: TestEngine

    beforeEach(() => {
        engine = new TestEngine()
    })

    test('PLAY of a sound whose file is missing does nothing', async () => {
        await engine.load(`
OBJECT=SFX
SFX:TYPE=SOUND
SFX:FILENAME=MISSING.WAV
`)
        const ok = engine.boolean('OK')
        await engine.run('SFX^PLAY();OK^SET(TRUE);')
        expect(ok.getValue()).toBe(true)
        expect(engine.getObject<Sound>('SFX')!.ISPLAYING()).toBe(false)
    })
})
