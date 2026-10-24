import { TestEngine } from '../../common/testUtils'

describe('TEXT', () => {
    test('PRIORITY is the starting priority and SETPRIORITY changes it', async () => {
        const engine = new TestEngine()
        const before = engine.integer('BEFORE')
        const after = engine.integer('AFTER')
        await engine.load(`
OBJECT=LABEL
LABEL:TYPE=TEXT
LABEL:VISIBLE=TRUE
LABEL:FONT=ARIAL14
LABEL:RECT=0,0,100,20
LABEL:PRIORITY=500
`)
        await engine.run('BEFORE^SET(LABEL^GETPRIORITY());LABEL^SETPRIORITY(100);AFTER^SET(LABEL^GETPRIORITY());')
        expect(before.getValue()).toBe(500)
        expect(after.getValue()).toBe(100)
    })
})
