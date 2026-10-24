// Time and random numbers as the game sees them. By default they are real: performance.now() and Math.random().
// With a manual clock, time moves only through Engine.step, and with a seed the random numbers repeat, so a
// run of a game can be repeated exactly (walkthrough tests, sweeps).
export class GameClock {
    private virtualTimeMS: number | null
    public readonly random: () => number

    constructor(options: { manual?: boolean; seed?: number } = {}) {
        this.virtualTimeMS = options.manual ? 0 : null
        this.random = options.seed !== undefined ? seededRandom(options.seed) : Math.random
    }

    get isManual() {
        return this.virtualTimeMS !== null
    }

    // Milliseconds since an arbitrary start
    now(): number {
        return this.virtualTimeMS ?? performance.now()
    }

    advance(ms: number) {
        if (this.virtualTimeMS === null) {
            throw new Error('The clock is not manual')
        }
        this.virtualTimeMS += ms
    }
}

// mulberry32: a small, fast generator with good enough distribution for game logic
export const seededRandom = (seed: number) => {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}
