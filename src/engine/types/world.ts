import { Type } from './index'
import { WorldDefinition } from '../../fileFormats/cnv/types'
import { method, int, double } from '../../common/types'
import { loadSekGraphs, SekGraph } from '../../fileFormats/sek'
import { Animo } from './animo'
import { logger } from '../logging'

// WORLD is provided by the World.dll plugin, a script binding of the Sekai physics and path-finding library.
// Only what Czarodzieje needs is reproduced: bodies with simple kinematics linked to ANIMOs, and walking
// along the waypoint graphs of SEK files.
//
// Sekai works in its own frame: origin in the screen centre and y pointing up. Positions in the script API
// are in screen-like coordinates (FINDPATH gets the mouse position), while velocities, forces and gravity
// are passed in Sekai's frame (Dragon pushes y up after hitting something below, GETANGLE 90 means "up").

const SCREEN_CENTER_X = 400
const SCREEN_CENTER_Y = 300
const SCREEN_WIDTH = 800
const SCREEN_HEIGHT = 600

// Longest simulation step, so that a stalled tab doesn't make objects jump
const MAX_STEP_SECONDS = 0.1

type Vec3 = { x: number; y: number; z: number }

type Body = {
    id: number
    position: Vec3
    velocity: Vec3
    force: Vec3
    mass: number
    maxSpeed: number
    limits: { min: Vec3; max: Vec3 } | null
    active: boolean
    linked: Animo | null
    path: Vec3[]
    followSpeed: number
    lastMoveDistance: number
    angle: number
    // Strength of the attraction of a gravity center (SETG), and the centers that attract this body
    gravityStrength: number
    attractors: number[]
}

// A joint keeps a body (the child) next to another (the parent). Bodies here don't rotate, so a joint either keeps
// the child's offset from the parent (rigid) or only its distance (a free hinge)
type Joint = {
    child: number
    parent: number
    rigid: boolean
    offset: Vec3
    length: number
}

// Passes over the joints per step, so that chains of joints settle
const JOINT_ITERATIONS = 4

type Graph = {
    nodes: Vec3[]
    neighbours: number[][]
    cells: Map<string, number[]>
}

// Waypoints of all known graphs are 10 units apart (or further for tiny graphs)
const GRAPH_CELL_SIZE = 10
const WALKABLE_DISTANCE = GRAPH_CELL_SIZE * 1.5

const toWorld = (x: number, y: number, z: number): Vec3 => ({
    x: x - SCREEN_CENTER_X,
    y: SCREEN_CENTER_Y - y,
    z,
})

const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export class World extends Type<WorldDefinition> {
    private bodies = new Map<number, Body>()
    private joints: Joint[] = []
    private graphs = new Map<number, Graph>()
    private gravity: Vec3 = { x: 0, y: 0, z: 0 }
    private running = false
    private pendingMS = 0

    private referenceObject: number | null = null
    private backgroundBounds: { xMin: number; xMax: number; yMin: number; yMax: number } | null = null
    private backgroundMoves = { x: false, y: false }
    private backgroundPosition = { x: 0, y: 0 }

    async init() {
        if (this.definition.FILENAME !== undefined) {
            try {
                await this.LOAD(this.definition.FILENAME)
            } catch (err) {
                logger.warn(`Failed to load WORLD file '${this.definition.FILENAME}'`, { world: this }, err)
            }
        }
    }

    async tick(elapsedMS: number) {
        this.pendingMS += elapsedMS * this.engine.speed
    }

    @method()
    async LOAD(filename: string) {
        const path = this.engine.currentScene
            ? await this.engine.currentScene.getRelativePath(filename)
            : await this.engine.resolvePath(filename)
        const data = await this.engine.filesystem.getFile(path)
        for (const graph of loadSekGraphs(data)) {
            this.graphs.set(graph.id, this.buildGraph(graph))
        }
    }

    @method()
    START() {
        this.running = true
    }

    @method()
    STOP() {
        this.running = false
    }

    @method()
    SETGRAVITY(x: double, y: double, z: double) {
        this.gravity = { x, y, z }
    }

    @method()
    ADDBODY(id: int, mass: double, ...rest: double[]) {
        const body = this.getBody(id)
        body.mass = mass > 0 ? mass : 1
        // The 6th parameter is the maximum velocity in all calls
        const maxSpeed = rest[4]
        if (maxSpeed !== undefined && maxSpeed > 0) {
            body.maxSpeed = maxSpeed
        }
    }

    @method()
    REMOVEOBJECT(id: int) {
        this.bodies.delete(id)
        this.joints = this.joints.filter((joint) => joint.child !== id && joint.parent !== id)
    }

    @method()
    LINK(id: int, animoName: string, mode?: int) {
        const animo = this.getObject<Animo>(animoName)
        if (!(animo instanceof Animo)) {
            logger.warn(`WORLD^LINK: '${animoName}' is not an ANIMO`, { world: this })
            return
        }
        this.getBody(id).linked = animo
    }

    // JOIN(child, parent, anchorX, anchorY, ?, ?, minAngle, maxAngle, …) pins the child to the parent at the anchor
    // (in SETPOSITION's coordinates). Wehikuł Czasu's car holds its wheels with an empty angle range, so they keep
    // their offsets from it; Czarodzieje's MIOTLY chains bodies with free hinges (-180 to 180), which keep their
    // distance. The anchor itself isn't used, as bodies don't rotate around it.
    @method()
    JOIN(child: int, parent: int, anchorX: double, anchorY: double, ...args: double[]) {
        const [, , minAngle = 0, maxAngle = 0] = args
        const childBody = this.getBody(child)
        const parentBody = this.getBody(parent)
        const offset = {
            x: childBody.position.x - parentBody.position.x,
            y: childBody.position.y - parentBody.position.y,
            z: childBody.position.z - parentBody.position.z,
        }
        this.joints.push({
            child,
            parent,
            rigid: minAngle === maxAngle,
            offset,
            length: distance(childBody.position, parentBody.position),
        })
    }

    @method()
    UNLINK(id: int) {
        this.getBody(id).linked = null
    }

    // SETACTIVE(id, active) for bodies. SETACTIVE(graphId, ?, active) is accepted but ignored
    @method()
    SETACTIVE(id: int, active: boolean, graphActive?: boolean) {
        if (graphActive === undefined) {
            this.getBody(id).active = active
        }
    }

    @method()
    SETPOSITION(id: int, x: double, y: double, z: double = 0) {
        this.getBody(id).position = toWorld(x, y, z)
    }

    @method()
    SETVELOCITY(id: int, x: double, y: double, z: double = 0) {
        this.getBody(id).velocity = { x, y, z }
    }

    @method()
    ADDFORCE(id: int, x: double, y: double, z: double = 0) {
        const force = this.getBody(id).force
        force.x += x
        force.y += y
        force.z += z
    }

    // Gravity centers attract other bodies with SETG / distance² (Wehikuł Czasu's NUREK and SAMOCHODZIK)
    @method()
    SETGRAVITYCENTER(id: int, enabled: boolean) {
        if (!enabled) {
            this.getBody(id).gravityStrength = 0
        }
    }

    @method()
    SETG(id: int, strength: double) {
        this.getBody(id).gravityStrength = strength
    }

    @method()
    ADDGRAVITYEX(id: int, centerId: int, enabled: boolean = true) {
        const body = this.getBody(id)
        body.attractors = body.attractors.filter((attractor) => attractor !== centerId)
        if (enabled) {
            body.attractors.push(centerId)
        }
    }

    // Mass, friction and damping parameters of the physics engine aren't simulated
    @method()
    SETBODYDYNAMICS(id: int, ...args: double[]) {}

    @method()
    SETMAXSPEED(id: int, speed: double) {
        this.getBody(id).maxSpeed = speed
    }

    @method()
    SETSPEED(id: int, speed: double) {
        this.getBody(id).followSpeed = speed
    }

    @method()
    SETLIMIT(id: int, x1: double, y1: double, z1: double, x2: double, y2: double, z2: double) {
        const a = toWorld(x1, y1, z1)
        const b = toWorld(x2, y2, z2)
        this.getBody(id).limits = {
            min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
            max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
        }
    }

    @method()
    GETPOSITIONX(id: int): double {
        return this.getBody(id).position.x + SCREEN_CENTER_X
    }

    @method()
    GETPOSITIONY(id: int): double {
        return SCREEN_CENTER_Y - this.getBody(id).position.y
    }

    @method()
    GETPOSITIONZ(id: int): double {
        return this.getBody(id).position.z
    }

    @method()
    GETSPEED(id: int): double {
        const { x, y, z } = this.getBody(id).velocity
        return Math.hypot(x, y, z)
    }

    // Direction of the last movement in degrees, 0 is right and 90 is up
    @method()
    GETANGLE(id: int): double {
        return this.getBody(id).angle
    }

    // Bodies don't rotate on their own, report the direction of movement
    @method()
    GETROTATIONZ(id: int): double {
        return this.getBody(id).angle
    }

    @method()
    GETMOVEDISTANCE(id: int): double {
        return this.getBody(id).lastMoveDistance
    }

    @method()
    SETBKGSIZE(xMin: double, xMax: double, yMin: double, yMax: double) {
        this.backgroundBounds = { xMin, xMax, yMin, yMax }
    }

    // Non-zero values allow the background to scroll horizontally/vertically
    @method()
    SETMOVEFLAGS(x: double, y: double) {
        this.backgroundMoves = { x: x !== 0, y: y !== 0 }
    }

    @method()
    SETREFOBJECT(id: int) {
        this.referenceObject = id
        this.updateBackgroundPosition()
    }

    @method()
    GETBKGPOSX(): double {
        return this.backgroundPosition.x
    }

    @method()
    GETBKGPOSY(): double {
        return this.backgroundPosition.y
    }

    @method()
    async FINDPATH(id: int, graphId: int, x: double, y: double, z: double = 0, ...flags: any[]) {
        const body = this.getBody(id)
        const graph = this.graphs.get(graphId) ?? this.graphs.values().next().value
        const target = toWorld(x, y, z)

        const path = graph ? this.findPath(graph, body.position, target) : null
        if (path === null) {
            body.path = []
            await body.linked?.signal('NOPATH')
            return
        }
        body.path = path
    }

    // Called every frame for objects walking along a path, the speed is the walking speed for the next step
    @method()
    FOLLOWPATH(id: int, lookAhead: double, tolerance: double, speed: double): double {
        const body = this.getBody(id)
        body.followSpeed = speed
        return body.path.length
    }

    @method()
    async MOVEOBJECTS(): Promise<double> {
        const seconds = Math.min(this.pendingMS / 1000, MAX_STEP_SECONDS)
        this.pendingMS = 0

        const arrived: Body[] = []
        const positionsBefore = new Map<Body, Vec3>()
        for (const body of this.bodies.values()) {
            positionsBefore.set(body, { ...body.position })
            if (this.running && body.active) {
                if (body.path.length > 0) {
                    if (this.walk(body, body.followSpeed * seconds)) {
                        arrived.push(body)
                    }
                } else {
                    this.integrate(body, seconds)
                }
            }
        }
        if (this.running) {
            this.applyJoints()
        }

        for (const [body, before] of positionsBefore) {
            body.lastMoveDistance = distance(before, body.position)
            if (body.lastMoveDistance > 0) {
                const angle = (Math.atan2(body.position.y - before.y, body.position.x - before.x) * 180) / Math.PI
                body.angle = (angle + 360) % 360
            }
        }

        this.updateBackgroundPosition()
        for (const body of this.bodies.values()) {
            await this.syncLinked(body)
        }
        for (const body of arrived) {
            await body.linked?.signal('ATGOAL')
        }

        return seconds * 1000
    }

    private getBody(id: number): Body {
        let body = this.bodies.get(id)
        if (body === undefined) {
            // Bodies of SEK entities aren't decoded, they are created when first referenced
            body = {
                id,
                position: { x: 0, y: 0, z: 0 },
                velocity: { x: 0, y: 0, z: 0 },
                force: { x: 0, y: 0, z: 0 },
                mass: 1,
                maxSpeed: 0,
                limits: null,
                active: true,
                linked: null,
                path: [],
                followSpeed: 0,
                lastMoveDistance: 0,
                angle: 0,
                gravityStrength: 0,
                attractors: [],
            }
            this.bodies.set(id, body)
        }
        return body
    }

    // Moves the body along its path, returns true when it reached the end
    private walk(body: Body, stepLength: number) {
        let remaining = stepLength
        while (remaining > 0 && body.path.length > 0) {
            const waypoint = body.path[0]
            const toWaypoint = distance(body.position, waypoint)
            if (toWaypoint <= remaining) {
                body.position = { ...waypoint }
                body.path.shift()
                remaining -= toWaypoint
            } else {
                const t = remaining / toWaypoint
                body.position = {
                    x: body.position.x + (waypoint.x - body.position.x) * t,
                    y: body.position.y + (waypoint.y - body.position.y) * t,
                    z: body.position.z + (waypoint.z - body.position.z) * t,
                }
                remaining = 0
            }
        }
        return body.path.length === 0
    }

    private integrate(body: Body, seconds: number) {
        for (const centerId of body.attractors) {
            const center = this.bodies.get(centerId)
            if (center === undefined || center.gravityStrength === 0) {
                continue
            }
            const dx = center.position.x - body.position.x
            const dy = center.position.y - body.position.y
            const dz = center.position.z - body.position.z
            const distance = Math.max(Math.hypot(dx, dy, dz), GRAPH_CELL_SIZE)
            const acceleration = center.gravityStrength / (distance * distance)
            body.force.x += (dx / distance) * acceleration * body.mass
            body.force.y += (dy / distance) * acceleration * body.mass
            body.force.z += (dz / distance) * acceleration * body.mass
        }

        const v = body.velocity
        v.x += (this.gravity.x + body.force.x / body.mass) * seconds
        v.y += (this.gravity.y + body.force.y / body.mass) * seconds
        v.z += (this.gravity.z + body.force.z / body.mass) * seconds
        body.force = { x: 0, y: 0, z: 0 }

        const speed = Math.hypot(v.x, v.y, v.z)
        if (body.maxSpeed > 0 && speed > body.maxSpeed) {
            const scale = body.maxSpeed / speed
            v.x *= scale
            v.y *= scale
            v.z *= scale
        }

        const p = body.position
        p.x += v.x * seconds
        p.y += v.y * seconds
        p.z += v.z * seconds

        if (body.limits !== null) {
            for (const axis of ['x', 'y', 'z'] as const) {
                if (p[axis] < body.limits.min[axis] || p[axis] > body.limits.max[axis]) {
                    p[axis] = Math.min(Math.max(p[axis], body.limits.min[axis]), body.limits.max[axis])
                    v[axis] = 0
                }
            }
        }
    }

    private applyJoints() {
        for (let iteration = 0; iteration < JOINT_ITERATIONS; iteration++) {
            for (const joint of this.joints) {
                const child = this.bodies.get(joint.child)
                const parent = this.bodies.get(joint.parent)
                if (child === undefined || parent === undefined) {
                    continue
                }

                if (joint.rigid) {
                    child.position = {
                        x: parent.position.x + joint.offset.x,
                        y: parent.position.y + joint.offset.y,
                        z: parent.position.z + joint.offset.z,
                    }
                    child.velocity = { ...parent.velocity }
                    continue
                }

                // Both ends move back to the joint's length, the lighter one further; inactive bodies stay
                const length = distance(child.position, parent.position)
                const childShare = child.active ? 1 / child.mass : 0
                const parentShare = parent.active ? 1 / parent.mass : 0
                if (length === 0 || childShare + parentShare === 0) {
                    continue
                }
                const correction = (length - joint.length) / length / (childShare + parentShare)
                for (const axis of ['x', 'y', 'z'] as const) {
                    const delta = (child.position[axis] - parent.position[axis]) * correction
                    child.position[axis] -= delta * childShare
                    parent.position[axis] += delta * parentShare
                }
            }
        }
    }

    private async syncLinked(body: Body) {
        if (body.linked === null) {
            return
        }
        const x = Math.round(body.position.x + SCREEN_CENTER_X - this.backgroundPosition.x)
        const y = Math.round(SCREEN_CENTER_Y - body.position.y - this.backgroundPosition.y)
        await body.linked.SETPOSITION(x, y)
    }

    // Scrolls the background so that the reference object stays in the middle of the screen
    private updateBackgroundPosition() {
        const body = this.referenceObject !== null ? this.bodies.get(this.referenceObject) : undefined
        if (body === undefined || this.backgroundBounds === null) {
            return
        }

        const bounds = this.backgroundBounds
        if (this.backgroundMoves.x) {
            const x = body.position.x + SCREEN_CENTER_X - SCREEN_WIDTH / 2
            this.backgroundPosition.x = Math.round(Math.min(Math.max(x, bounds.xMin), bounds.xMax - SCREEN_WIDTH))
        }
        if (this.backgroundMoves.y) {
            const y = SCREEN_CENTER_Y - body.position.y - SCREEN_HEIGHT / 2
            this.backgroundPosition.y = Math.round(Math.min(Math.max(y, bounds.yMin), bounds.yMax - SCREEN_HEIGHT))
        }
    }

    private buildGraph(graph: SekGraph): Graph {
        const neighbours: number[][] = graph.nodes.map(() => [])
        for (const edge of graph.edges) {
            neighbours[edge.from].push(edge.to)
            neighbours[edge.to].push(edge.from)
        }

        const cells = new Map<string, number[]>()
        graph.nodes.forEach((node, index) => {
            const key = this.cellKey(node.x, node.y)
            cells.set(key, [...(cells.get(key) ?? []), index])
        })

        return { nodes: graph.nodes.map((node) => ({ ...node })), neighbours, cells }
    }

    private cellKey(x: number, y: number) {
        return `${Math.floor(x / GRAPH_CELL_SIZE)},${Math.floor(y / GRAPH_CELL_SIZE)}`
    }

    private nearestNode(graph: Graph, point: Vec3) {
        let best = -1
        let bestDistance = Infinity
        graph.nodes.forEach((node, index) => {
            const d = Math.hypot(node.x - point.x, node.y - point.y)
            if (d < bestDistance) {
                best = index
                bestDistance = d
            }
        })
        return { index: best, distance: bestDistance }
    }

    private isWalkable(graph: Graph, x: number, y: number) {
        const cx = Math.floor(x / GRAPH_CELL_SIZE)
        const cy = Math.floor(y / GRAPH_CELL_SIZE)
        for (let dx = -2; dx <= 2; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
                for (const index of graph.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
                    const node = graph.nodes[index]
                    if (Math.hypot(node.x - x, node.y - y) <= WALKABLE_DISTANCE) {
                        return true
                    }
                }
            }
        }
        return false
    }

    private isStraightWalkable(graph: Graph, from: Vec3, to: Vec3) {
        const steps = Math.ceil(distance(from, to) / (GRAPH_CELL_SIZE / 2))
        for (let i = 1; i < steps; i++) {
            const t = i / steps
            if (!this.isWalkable(graph, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)) {
                return false
            }
        }
        return true
    }

    // A* from the node nearest to the start to the node nearest to the target, smoothed into straight segments
    private findPath(graph: Graph, start: Vec3, target: Vec3): Vec3[] | null {
        const startNode = this.nearestNode(graph, start)
        const goalNode = this.nearestNode(graph, target)
        if (startNode.index < 0 || goalNode.index < 0) {
            return null
        }

        const nodePath = this.aStar(graph, startNode.index, goalNode.index)
        if (nodePath === null) {
            return null
        }

        const points = nodePath.map((index) => ({ ...graph.nodes[index], z: start.z }))
        // Walk to the exact target when it's on the walkable area
        if (goalNode.distance <= WALKABLE_DISTANCE) {
            points.push({ x: target.x, y: target.y, z: start.z })
        }

        const smoothed: Vec3[] = []
        let current = start
        let i = 0
        while (i < points.length) {
            let farthest = i
            for (let j = points.length - 1; j > i; j--) {
                if (this.isStraightWalkable(graph, current, points[j])) {
                    farthest = j
                    break
                }
            }
            smoothed.push(points[farthest])
            current = points[farthest]
            i = farthest + 1
        }
        return smoothed
    }

    private aStar(graph: Graph, from: number, to: number): number[] | null {
        const nodes = graph.nodes
        const heuristic = (index: number) => Math.hypot(nodes[index].x - nodes[to].x, nodes[index].y - nodes[to].y)
        const cost = new Map<number, number>([[from, 0]])
        const previous = new Map<number, number>()
        const open = new MinHeap()
        open.push(from, heuristic(from))
        const closed = new Set<number>()

        while (open.size > 0) {
            const current = open.pop()
            if (closed.has(current)) {
                continue
            }

            if (current === to) {
                const path = [current]
                while (previous.has(path[0])) {
                    path.unshift(previous.get(path[0])!)
                }
                return path
            }

            closed.add(current)
            for (const next of graph.neighbours[current]) {
                if (closed.has(next)) {
                    continue
                }
                const nextCost =
                    cost.get(current)! + Math.hypot(nodes[next].x - nodes[current].x, nodes[next].y - nodes[current].y)
                if (nextCost < (cost.get(next) ?? Infinity)) {
                    cost.set(next, nextCost)
                    previous.set(next, current)
                    open.push(next, nextCost + heuristic(next))
                }
            }
        }
        return null
    }
}

class MinHeap {
    private items: Array<{ value: number; priority: number }> = []

    get size() {
        return this.items.length
    }

    push(value: number, priority: number) {
        const items = this.items
        items.push({ value, priority })
        let i = items.length - 1
        while (i > 0) {
            const parent = (i - 1) >> 1
            if (items[parent].priority <= items[i].priority) {
                break
            }
            ;[items[parent], items[i]] = [items[i], items[parent]]
            i = parent
        }
    }

    pop(): number {
        const items = this.items
        const top = items[0]
        const last = items.pop()!
        if (items.length > 0) {
            items[0] = last
            let i = 0
            for (;;) {
                const left = i * 2 + 1
                const right = left + 1
                let smallest = i
                if (left < items.length && items[left].priority < items[smallest].priority) {
                    smallest = left
                }
                if (right < items.length && items[right].priority < items[smallest].priority) {
                    smallest = right
                }
                if (smallest === i) {
                    break
                }
                ;[items[smallest], items[i]] = [items[i], items[smallest]]
                i = smallest
            }
        }
        return top.value
    }
}
