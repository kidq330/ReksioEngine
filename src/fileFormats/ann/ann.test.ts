import { loadAnn } from './index'

// Little-endian byte writer for building test files
class Writer {
    private bytes: number[] = []

    u8(value: number) {
        this.bytes.push(value & 0xff)
        return this
    }
    u16(value: number) {
        return this.u8(value).u8(value >> 8)
    }
    u32(value: number) {
        return this.u16(value).u16(value >>> 16)
    }
    f32(value: number) {
        const buffer = new DataView(new ArrayBuffer(4))
        buffer.setFloat32(0, value, true)
        return this.u32(buffer.getUint32(0, true))
    }
    zeros(count: number) {
        for (let i = 0; i < count; i++) {
            this.u8(0)
        }
        return this
    }
    text(value: string, size: number) {
        for (let i = 0; i < size; i++) {
            this.u8(i < value.length ? value.charCodeAt(i) : 0)
        }
        return this
    }
    block(value: string) {
        return this.u32(value.length + 1).text(value, value.length + 1)
    }
    get buffer() {
        return new Uint8Array(this.bytes).buffer
    }
}

type TestFrame = { name?: string; floats?: [number, number, number]; sounds?: string; x: number; y: number }

// An ANN with one event and no images. The frame record's pointers are junk values like in real files.
const buildAnn = (frames: TestFrame[]) => {
    const pointer = 0x4a9f94
    const file = new Writer().u32(0x50564e).u16(0).u16(16).u16(1).zeros(0xd).u32(16).u32(0).u8(0).u16(0).zeros(0xa)
    file.block('author').block('description')

    file.text('EVENT', 0x20).u16(frames.length).u32(0).u16(0).u16(0).u16(0).zeros(2).u32(16).u32(0).u8(255)
    file.zeros(0xc)
    frames.forEach(() => file.u16(0))
    for (const frame of frames) {
        file.u32(frame.name ? pointer : 0)
            .u32(frame.floats ? pointer : 0)
            .u16(frame.x)
            .u16(frame.y)
        file.u32(0xffffffff)
            .u32(frame.sounds ? pointer : 0)
            .u32(0)
            .u8(255)
            .u8(0)
            .u32(0)
        if (frame.name) {
            file.block(frame.name)
        }
        if (frame.floats) {
            file.u32(12)
            frame.floats.forEach((value) => file.f32(value))
        }
        if (frame.sounds) {
            file.block(frame.sounds)
        }
    }
    return file.buffer
}

describe('ANN', () => {
    test('reads the floats some frames carry after the name and before the sounds', () => {
        const ann = loadAnn(
            buildAnn([
                { name: 'Clone', floats: [-0.5, 1, 1], sounds: 'A.WAV;B.WAV', x: -117, y: 72 },
                { name: 'Layer 2', x: 3, y: 4 },
                { floats: [-1.5, 1, 1], x: 5, y: 6 },
            ])
        )

        const [first, second, third] = ann.events[0].frames
        expect(first).toMatchObject({ name: 'Clone', floats: [-0.5, 1, 1], sounds: ['A.WAV', 'B.WAV'] })
        expect(first).toMatchObject({ positionX: -117, positionY: 72 })
        expect(second).toMatchObject({ name: 'Layer 2', sounds: [], positionX: 3, positionY: 4 })
        expect(second.floats).toBeUndefined()
        expect(third).toMatchObject({ name: '', floats: [-1.5, 1, 1], positionX: 5, positionY: 6 })
    })
})
