import { GameClock, seededRandom } from './clock'

describe('GameClock', () => {
    test('a seed repeats the random numbers, in [0, 1)', () => {
        const a = seededRandom(42)
        const b = seededRandom(42)
        const values = Array.from({ length: 1000 }, () => a())
        expect(values).toEqual(Array.from({ length: 1000 }, () => b()))
        expect(values.every((v) => v >= 0 && v < 1)).toBe(true)
        expect(new Set(values).size).toBe(1000)
        expect(seededRandom(43)()).not.toBe(values[0])
    })

    test('manual time moves only when advanced', () => {
        const clock = new GameClock({ manual: true })
        expect(clock.now()).toBe(0)
        clock.advance(16.5)
        expect(clock.now()).toBe(16.5)
        expect(() => new GameClock().advance(1)).toThrow()
    })
})
