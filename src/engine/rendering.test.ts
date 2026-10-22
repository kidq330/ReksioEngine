import { mergeAlpha } from './rendering'

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
