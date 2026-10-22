import { TestEngine } from '../../common/testUtils'
import { AdvancedSprite } from '../rendering'
import { DisplayType } from './index'
import { Pattern } from './pattern'

class StubGraphic extends DisplayType<any> {
    public sprite = new AdvancedSprite()

    getRenderObject() {
        return this.sprite
    }
}

describe('PATTERN', () => {
    let engine: TestEngine
    let pattern: Pattern

    beforeEach(async () => {
        engine = new TestEngine()
        const graphic = new StubGraphic(engine.asEngine(), engine.currentScene, { TYPE: 'STUB', NAME: 'GFX' })
        graphic.sprite.width = 10
        graphic.sprite.height = 10
        engine.add(graphic)
        pattern = await engine.create<Pattern>({ TYPE: 'PATTERN', NAME: 'P', GRIDX: 100, GRIDY: 50, TOCANVAS: false })
    })

    test('ADD places an object on the grid and GETGRAPHICSAT returns its name', async () => {
        await engine.run('P^ADD("A",2,3,"GFX",0);')

        expect(pattern.GETGRAPHICSAT(205, 155)).toBe('GFX')
        expect(pattern.GETGRAPHICSAT(5, 5)).toBe('NULL')
    })

    test('MOVE scrolls all entries', async () => {
        await engine.run('P^ADD("A",2,3,"GFX",0);P^MOVE(-100,10);')

        expect(pattern.GETGRAPHICSAT(105, 165)).toBe('GFX')
        expect(pattern.GETGRAPHICSAT(205, 155)).toBe('NULL')
    })

    test('GETGRAPHICSAT only looks at the requested layers', async () => {
        await engine.run('P^ADD("A",0,0,"GFX",1);')

        expect(pattern.GETGRAPHICSAT(5, 5, true, false, 0)).toBe('NULL')
        expect(pattern.GETGRAPHICSAT(5, 5, true, false, 0, 1)).toBe('GFX')
    })
})
