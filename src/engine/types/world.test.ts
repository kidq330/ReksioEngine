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

    test('a joint with an empty angle range keeps the child at its offset from the parent', async () => {
        // Wehikuł Czasu's car and one of its wheels
        await engine.run(
            'W^SETPOSITION(501,100,100,6);W^SETPOSITION(502,112,115,6);W^JOIN(502,501,112,110,0,0,0,0,0,0,0);' +
                'W^SETVELOCITY(501,100,0,0);W^START();'
        )
        await step(0.1)

        expect(world.GETPOSITIONX(501)).toBeCloseTo(110)
        expect(world.GETPOSITIONX(502)).toBeCloseTo(122)
        expect(world.GETPOSITIONY(502)).toBeCloseTo(115)
    })

    test('a free hinge keeps the distance between the bodies, the lighter one moving further', async () => {
        // Czarodzieje's MIOTLY chain: bodies 20 apart joined at the child's position
        await engine.run(
            'W^ADDBODY(1,1);W^ADDBODY(2,3);W^SETPOSITION(1,400,300,0);W^SETPOSITION(2,420,300,0);' +
                'W^JOIN(1,2,400,300,0,0,-180,180);W^SETVELOCITY(1,-400,0,0);W^START();'
        )
        await step(0.1)

        const dx = world.GETPOSITIONX(2) - world.GETPOSITIONX(1)
        const dy = world.GETPOSITIONY(2) - world.GETPOSITIONY(1)
        expect(Math.hypot(dx, dy)).toBeCloseTo(20)
        // Body 1 was pulled back by 3/4 of the stretch, body 2 forward by 1/4
        expect(world.GETPOSITIONX(1)).toBeCloseTo(390)
        expect(world.GETPOSITIONX(2)).toBeCloseTo(410)
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
