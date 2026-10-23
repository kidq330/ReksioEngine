import { TestEngine } from '../../common/testUtils'

describe('DOUBLE', () => {
    let engine: TestEngine

    beforeEach(() => {
        engine = new TestEngine()
    })

    test('SQRT replaces the value with its square root', async () => {
        const d = engine.double('D', 3)
        engine.double('E', 4)
        await engine.run('D^SET([[D*D]+[E*E]]);D^SQRT();')
        expect(d.getValue()).toBe(5)
    })

    test('CLAMP keeps the value within bounds', async () => {
        const d = engine.double('D', 7.5)
        await engine.run('D^CLAMP(0,5);')
        expect(d.getValue()).toBe(5)
        await engine.run('D^CLAMP(6,10);')
        expect(d.getValue()).toBe(6)
    })
})
