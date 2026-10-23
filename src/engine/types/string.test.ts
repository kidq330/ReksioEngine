import { TestEngine } from '../../common/testUtils'

describe('STRING', () => {
    let engine: TestEngine

    beforeEach(() => {
        engine = new TestEngine()
    })

    test('CUT keeps the given part of the string', async () => {
        const text = engine.string('TEXT', 'ENEMY_3_FIELD')
        await engine.run('TEXT^CUT(0,TEXT^FIND("_"));')
        expect(text.getValue()).toBe('ENEMY')

        text.setValue('ABCDEF')
        await engine.run('TEXT^CUT(2,3);')
        expect(text.getValue()).toBe('CDE')
    })

    test('REPLACEAT overwrites characters and UPPER uppercases', async () => {
        const text = engine.string('TEXT', '0110')
        engine.integer('N', 1)
        await engine.run('TEXT^REPLACEAT(2,N);TEXT^REPLACEAT(0,"ab");TEXT^UPPER();')
        expect(text.getValue()).toBe('AB10')
    })
})
