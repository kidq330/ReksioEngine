import { loadSekGraphs, SEK_MAGIC } from './index'

const buildSek = (parts: Array<{ ints?: number[]; floats?: number[]; text?: string }>) => {
    const bytes: number[] = [...SEK_MAGIC].map((c) => c.charCodeAt(0))
    const push32 = (write: (view: DataView) => void) => {
        const view = new DataView(new ArrayBuffer(4))
        write(view)
        bytes.push(...new Uint8Array(view.buffer))
    }
    for (const part of parts) {
        part.ints?.forEach((value) => push32((view) => view.setInt32(0, value, true)))
        part.floats?.forEach((value) => push32((view) => view.setFloat32(0, value, true)))
        if (part.text !== undefined) {
            bytes.push(...[...part.text].map((c) => c.charCodeAt(0)), 0)
        }
    }
    return new Uint8Array(bytes).buffer
}

describe('SEK', () => {
    test('reads a waypoint graph', () => {
        const data = buildSek([
            { ints: [1, 4, 176, 9000, ...Array(11).fill(0), 2, 1] },
            { floats: [-395, -155, 0, 0, -385, -155, 0, 0] },
            { ints: [0, 1, 3] },
        ])

        expect(loadSekGraphs(data)).toEqual([
            {
                id: 9000,
                nodes: [
                    { x: -395, y: -155, z: 0 },
                    { x: -385, y: -155, z: 0 },
                ],
                edges: [{ from: 0, to: 1, flags: 3 }],
            },
        ])
    })

    test('skips entities before the graph', () => {
        const data = buildSek([
            { ints: [2, 1, 1408, 100, 3], floats: [330, -220, 0, 0, 0, 0, 40, 40, 20] },
            { ints: [1], text: 'entityName' },
            { ints: [2], text: 'Reksio' },
            { ints: [4, 176, 9000, ...Array(11).fill(0), 1, 0] },
            { floats: [10, 20, 0, 0] },
        ])

        const graphs = loadSekGraphs(data)
        expect(graphs).toHaveLength(1)
        expect(graphs[0].nodes).toEqual([{ x: 10, y: 20, z: 0 }])
    })

    test('rejects other files', () => {
        expect(() => loadSekGraphs(new TextEncoder().encode('{<C:6>}').buffer)).toThrow()
    })
})
