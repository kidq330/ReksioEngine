import { mergeAlpha, pixelAsRgb565 } from './rendering'

describe('mergeAlpha', () => {
    test('lowers alpha where the mask covers the pixels and clips the mask', () => {
        // 3x2 opaque RGBA pixels
        const pixels = new Uint8Array(3 * 2 * 4).fill(255)
        // 2x2 mask placed at (2, -1): only its bottom-left pixel lands on the image, at (2, 0)
        const mask = new Uint8Array([10, 20, 30, 40])
        mergeAlpha(pixels, 3, 2, 2, -1, mask, 2, 2)

        const alpha = Array.from({ length: 6 }, (_, i) => pixels[i * 4 + 3])
        expect(alpha).toEqual([255, 255, 30, 255, 255, 255])
        expect(pixels[2 * 4]).toBe(255)
    })
})

describe('pixelAsRgb565', () => {
    test('returns the signed 16-bit colour, 0 outside the image', () => {
        // 2x1: pure red, white
        const pixels = new Uint8Array([255, 0, 0, 255, 255, 255, 255, 255])
        expect(pixelAsRgb565(pixels, 2, 1, 0, 0)).toBe(-2048)
        expect(pixelAsRgb565(pixels, 2, 1, 1.7, 0)).toBe(-1)
        expect(pixelAsRgb565(pixels, 2, 1, 2, 0)).toBe(0)
        expect(pixelAsRgb565(new Uint8Array([0, 128, 8, 255]), 1, 1, 0, 0)).toBe((32 << 5) | 1)
    })
})
