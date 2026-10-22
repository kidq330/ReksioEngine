import { TestEngine } from '../../common/testUtils'
import { World } from './world'

// Builds a SEK file with one waypoint graph (Sekai coordinates: origin in the screen centre, y up)
const buildSek = (nodes: Array<[number, number]>, edges: Array<[number, number]>) => {
    const ints = (values: number[]) => values.flatMap((value) => [...new Uint8Array(new Int32Array([value]).buffer)])
    const floats = (values: number[]) =>
        values.flatMap((value) => [...new Uint8Array(new Float32Array([value]).buffer)])
    const bytes = [
        ...[...'SEKAI81080701915004'].map((c) => c.charCodeAt(0)),
        ...ints([1, 4, 176, 9000, ...Array(11).fill(0), nodes.length, edges.length]),
        ...floats(nodes.flatMap(([x, y]) => [x, y, 0, 0])),
        ...ints(edges.flatMap(([from, to]) => [from, to, 3])),
    ]
    return new Uint8Array(bytes).buffer
}

describe('WORLD', () => {
    let engine: TestEngine
    let world: World

    const step = async (seconds: number) => {
        await world.tick(seconds * 1000)
        await world.MOVEOBJECTS()
    }

    beforeEach(async () => {
        engine = new TestEngine()
        world = await engine.create<World>({ TYPE: 'WORLD', NAME: 'W' })
    })

    test('positions use screen coordinates and velocities point up', async () => {
        await engine.run('W^SETPOSITION(1,400,300,0);W^SETVELOCITY(1,100,100,0);W^START();')
        await step(0.1)

        expect(world.GETPOSITIONX(1)).toBeCloseTo(410)
        expect(world.GETPOSITIONY(1)).toBeCloseTo(290)
        expect(world.GETANGLE(1)).toBeCloseTo(45)
    })

    test('gravity centers attract bodies', async () => {
        await engine.run(
            'W^SETPOSITION(1,400,300,0);W^SETPOSITION(2,500,300,0);W^SETGRAVITYCENTER(1,TRUE);W^SETG(1,1000000);W^ADDGRAVITYEX(2,1,TRUE);W^START();'
        )
        await step(0.1)

        expect(world.GETPOSITIONX(2)).toBeLessThan(500)
        expect(world.GETPOSITIONX(1)).toBe(400)
    })

    test('nothing moves until START', async () => {
        await engine.run('W^SETPOSITION(1,400,300,0);W^SETVELOCITY(1,100,0,0);')
        await step(0.1)

        expect(world.GETPOSITIONX(1)).toBe(400)
        expect(world.GETMOVEDISTANCE(1)).toBe(0)
    })

    test('FINDPATH walks around obstacles along the waypoint graph', async () => {
        // An L-shaped corridor: (0,0) -> (100,0) -> (100,-100) in Sekai coordinates
        const nodes: Array<[number, number]> = []
        for (let i = 0; i <= 10; i++) {
            nodes.push([i * 10, 0])
        }
        for (let i = 1; i <= 10; i++) {
            nodes.push([100, -i * 10])
        }
        const edges = nodes.slice(1).map((_, i): [number, number] => [i, i + 1])
        engine.addFile('DANE/SCENE/PATH.SEK', buildSek(nodes, edges))

        await engine.run('W^LOAD("PATH.SEK");W^SETPOSITION(1,400,300,0);W^START();W^FINDPATH(1,9000,500,400,0,FALSE);')
        await engine.run('W^FOLLOWPATH(1,20,0.5,100);')

        // Animations are picked from 45 degree sectors, 0 is right and 6 is down
        const sector = () => Math.round(world.GETANGLE(1) / 45) % 8

        await step(0.1)
        expect(sector()).toBe(0)
        for (let i = 0; i < 30; i++) {
            await step(0.1)
        }

        expect(world.GETPOSITIONX(1)).toBeCloseTo(500)
        expect(world.GETPOSITIONY(1)).toBeCloseTo(400)
        expect(sector()).toBe(6)
    })
})
