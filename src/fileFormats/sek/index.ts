// SEK files are scenes of the Sekai physics/path-finding library used by the WORLD plugin (World.dll, Sekai.dll).
// Only the waypoint graphs are decoded. A file starts with the magic, an object count and the objects; an object
// starts with its type, a flags value and an id. Entities (type 1) also hold text properties and a collision model,
// whose layout isn't decoded, so graphs (type 4) are located by validating candidate headers instead of walking
// the objects. Coordinates are Sekai's: the origin is the screen centre and y points up.
//
// Graph object layout (little endian):
//   int32 type = 4, int32 flags, int32 id, 11 x int32 (zero in all known files),
//   int32 nodesCount, int32 edgesCount,
//   nodesCount x { float32 x, float32 y, float32 z, float32 unused },
//   edgesCount x { int32 from, int32 to, int32 flags }

export const SEK_MAGIC = 'SEKAI81080701915004'

export interface SekGraphNode {
    x: number
    y: number
    z: number
}

export interface SekGraphEdge {
    from: number
    to: number
    flags: number
}

export interface SekGraph {
    id: number
    nodes: SekGraphNode[]
    edges: SekGraphEdge[]
}

const GRAPH_TYPE = 4
const HEADER_INTS = 3 + 11 + 2
const MAX_COORDINATE = 1e6

const isPlausibleCoordinate = (value: number) =>
    Number.isFinite(value) && Math.abs(value) < MAX_COORDINATE && (value === 0 || Math.abs(value) > 1e-6)

const tryReadGraph = (view: DataView, offset: number): { graph: SekGraph; end: number } | null => {
    if (offset + HEADER_INTS * 4 > view.byteLength || view.getInt32(offset, true) !== GRAPH_TYPE) {
        return null
    }

    const id = view.getInt32(offset + 8, true)
    for (let i = 0; i < 11; i++) {
        if (view.getInt32(offset + 12 + i * 4, true) !== 0) {
            return null
        }
    }

    const nodesCount = view.getInt32(offset + 56, true)
    const edgesCount = view.getInt32(offset + 60, true)
    const nodesStart = offset + HEADER_INTS * 4
    const edgesStart = nodesStart + nodesCount * 16
    const end = edgesStart + edgesCount * 12
    if (id <= 0 || nodesCount <= 0 || edgesCount < 0 || end > view.byteLength) {
        return null
    }

    const nodes: SekGraphNode[] = []
    for (let i = 0; i < nodesCount; i++) {
        const base = nodesStart + i * 16
        const node = {
            x: view.getFloat32(base, true),
            y: view.getFloat32(base + 4, true),
            z: view.getFloat32(base + 8, true),
        }
        if (!isPlausibleCoordinate(node.x) || !isPlausibleCoordinate(node.y) || !isPlausibleCoordinate(node.z)) {
            return null
        }
        nodes.push(node)
    }

    const edges: SekGraphEdge[] = []
    for (let i = 0; i < edgesCount; i++) {
        const base = edgesStart + i * 12
        const edge = {
            from: view.getInt32(base, true),
            to: view.getInt32(base + 4, true),
            flags: view.getInt32(base + 8, true),
        }
        if (edge.from < 0 || edge.from >= nodesCount || edge.to < 0 || edge.to >= nodesCount) {
            return null
        }
        edges.push(edge)
    }

    return { graph: { id, nodes, edges }, end }
}

export const loadSekGraphs = (data: ArrayBuffer): SekGraph[] => {
    const magic = new TextDecoder('latin1').decode(new Uint8Array(data, 0, Math.min(SEK_MAGIC.length, data.byteLength)))
    if (magic !== SEK_MAGIC) {
        throw new Error('Not a SEK file')
    }

    const view = new DataView(data)
    const graphs: SekGraph[] = []
    let offset = SEK_MAGIC.length + 4
    while (offset + HEADER_INTS * 4 <= view.byteLength) {
        const result = tryReadGraph(view, offset)
        if (result !== null) {
            graphs.push(result.graph)
            offset = result.end
        } else {
            offset++
        }
    }
    return graphs
}
