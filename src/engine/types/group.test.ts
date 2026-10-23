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

    test('methods are forwarded to class instances', async () => {
        engine.addFile(
            'common/classes/CLSENEMY.CLASS',
            `
OBJECT=NEXTSTEP
NEXTSTEP:TYPE=BEHAVIOUR
NEXTSTEP:CODE={STEPS^INC();}
`
        )
        await engine.load(`
OBJECT=CLSENEMYOBJ
CLSENEMYOBJ:TYPE=CLASS
CLSENEMYOBJ:DEF=CLSENEMY.CLASS

OBJECT=G
G:TYPE=GROUP
`)
        const steps = engine.integer('STEPS')
        await engine.run('CLSENEMYOBJ^NEW("E1");CLSENEMYOBJ^NEW("E2");G^ADD("E1","E2");G^NEXTSTEP();')
        expect(steps.getValue()).toBe(2)
    })
})
