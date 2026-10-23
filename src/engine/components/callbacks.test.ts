import { TestEngine } from '../../common/testUtils'

describe('ADDBEHAVIOUR / REMOVEBEHAVIOUR', () => {
    let engine: TestEngine

    beforeEach(() => {
        engine = new TestEngine()
    })

    test('a parametrised handler matches the converted value, with ^ or $ as separator', async () => {
        engine.integer('I')
        const out = engine.string('OUT')
        engine.behaviour('ON5', '{OUT^ADD("5");}')
        engine.behaviour('ON7', '{OUT^ADD("7");}')
        await engine.run('I^ADDBEHAVIOUR("ONBRUTALCHANGED^5","ON5");I^ADDBEHAVIOUR("ONBRUTALCHANGED$7","ON7");')
        await engine.run('I^SET(5);I^SET(6);I^SET(7);I^SET(5);')
        expect(out.getValue()).toBe('575')

        await engine.run('I^REMOVEBEHAVIOUR("ONBRUTALCHANGED$5");I^SET(5);I^SET(7);')
        expect(out.getValue()).toBe('5757')
    })

    test('a STRING gets a non-parametrised handler', async () => {
        engine.string('S')
        const out = engine.integer('OUT')
        engine.behaviour('COUNT', '{OUT^INC();}')
        await engine.run('S^ADDBEHAVIOUR("ONCHANGED","COUNT");S^SET("A");S^SET("B");')
        await engine.run('S^REMOVEBEHAVIOUR("ONCHANGED");S^SET("C");')
        expect(out.getValue()).toBe(2)
    })
})
