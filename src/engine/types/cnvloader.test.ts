import { TestEngine } from '../../common/testUtils'
import { CNVLoader } from './cnvloader'

describe('CNVLOADER', () => {
    test('RELEASE removes the objects a file declared', async () => {
        const engine = new TestEngine()
        const loader = engine.add(
            new CNVLoader(engine.asEngine(), engine.currentScene, { TYPE: 'CNVLOADER', NAME: 'L' })
        )
        engine.integer('KEEP')
        engine.addFile('DANE/SCENE/PART.CNV', 'OBJECT=A\nA:TYPE=INTEGER\nA:VALUE=1\n')

        await engine.run('L^LOAD("PART.CNV");')
        expect(engine.getObject('A')).not.toBeNull()

        await loader.RELEASE('part.cnv')
        expect(engine.getObject('A')).toBeNull()
        expect(engine.getObject('KEEP')).not.toBeNull()
    })
})
