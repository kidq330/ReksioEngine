import { TestEngine } from '../../common/testUtils'

describe('CLASS', () => {
    let engine: TestEngine

    beforeEach(() => {
        engine = new TestEngine()
    })

    test('a method of an instance returns the value of its @RETURN', async () => {
        engine.addFile(
            'common/classes/CLSSAVE.CLASS',
            `
OBJECT=GET
GET:TYPE=BEHAVIOUR
GET:CODE={@INT("N",$1);@IF("N",">","0","FOUND","");@RETURN(-1);}

OBJECT=FOUND
FOUND:TYPE=BEHAVIOUR
FOUND:CODE={@RETURN([N*2]);}
`
        )
        await engine.load(`
OBJECT=CLSSAVEOBJ
CLSSAVEOBJ:TYPE=CLASS
CLSSAVEOBJ:DEF=CLSSAVE.CLASS
`)
        const a = engine.integer('A')
        const b = engine.integer('B')
        await engine.run('CLSSAVEOBJ^NEW("GSAVE");A^SET(GSAVE^GET(21));B^SET(GSAVE^GET(0));')
        expect(a.getValue()).toBe(42)
        expect(b.getValue()).toBe(-1)
    })

    test('the constructor gets the instance name as $1', async () => {
        engine.addFile(
            'common/classes/CLSENEMY.CLASS',
            `
OBJECT=CONSTRUCTOR
CONSTRUCTOR:TYPE=BEHAVIOUR
CONSTRUCTOR:CODE={OUT^SET(["$1_"+$2]);}
`
        )
        await engine.load(`
OBJECT=CLSENEMYOBJ
CLSENEMYOBJ:TYPE=CLASS
CLSENEMYOBJ:DEF=CLSENEMY.CLASS
`)
        const out = engine.string('OUT')
        await engine.run('CLSENEMYOBJ^NEW("ENEMY4",7);')
        expect(out.getValue()).toBe('ENEMY4_7')
    })
})
