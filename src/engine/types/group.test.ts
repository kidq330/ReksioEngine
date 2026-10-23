import { TestEngine } from '../../common/testUtils'
import { Integer } from './integer'

describe('GROUP', () => {
    let engine: TestEngine

    beforeEach(() => {
        engine = new TestEngine()
    })

    test('ADDCLONES adds the original as number 0 and the clones after it', async () => {
        await engine.load(`
OBJECT=N
N:TYPE=INTEGER
N:VALUE=0

OBJECT=G
G:TYPE=GROUP
`)
        const size = engine.integer('SIZE')
        await engine.run('N^CLONE(3);G^ADDCLONES("N",0,2);SIZE^SET(G^GETSIZE());G^SET(7);N_0^ADD(1);')
        expect(size.getValue()).toBe(3)
        expect(engine.getObject<Integer>('N')!.getValue()).toBe(8)
        expect(engine.getObject<Integer>('N_2')!.getValue()).toBe(7)
        expect(engine.getObject<Integer>('N_3')!.getValue()).toBe(0)
    })
})
