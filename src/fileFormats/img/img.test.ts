import { encode as encodeJpeg } from 'jpeg-js'
import { loadImage } from './index'

// IMG file with JPEG colors (compression type 5) and no alpha
const buildJpegImg = (width: number, height: number, rgba: Uint8Array) => {
    const jpeg = encodeJpeg({ width, height, data: rgba }, 100).data
    const header = new Uint32Array([0x4b4950, width, height, 16, jpeg.length, 0, 5, 0, 0, 0])
    const data = new Uint8Array(header.byteLength + jpeg.length)
    data.set(new Uint8Array(header.buffer), 0)
    data.set(jpeg, header.byteLength)
    return data.buffer
}

describe('IMG', () => {
    test('decodes JPEG colors reduced to RGB565', () => {
        const width = 16
        const height = 16
        const rgba = new Uint8Array(width * height * 4)
        for (let i = 0; i < width * height; i++) {
            rgba.set([200, 100, 40, 255], i * 4)
        }

        const image = loadImage(buildJpegImg(width, height, rgba))
        const pixels = new Uint8Array(image.bytes)

        expect(pixels.length).toBe(width * height * 4)
        // Lossy compression and the 5/6-bit channels allow a small difference
        expect(Math.abs(pixels[0] - 200)).toBeLessThanOrEqual(10)
        expect(Math.abs(pixels[1] - 100)).toBeLessThanOrEqual(10)
        expect(Math.abs(pixels[2] - 40)).toBeLessThanOrEqual(10)
        expect(pixels[3]).toBe(255)
    })
})
