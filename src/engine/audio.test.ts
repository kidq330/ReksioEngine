import { AudioManager, readWavSampleRate, Sound, SoundInstance } from './audio'

const createWav = (sampleRate: number, chunksBeforeFmt: Array<[string, number]> = []) => {
    const chunks = chunksBeforeFmt.map(([id, size]) => ({ id, size }))
    const size = 12 + chunks.reduce((acc, chunk) => acc + 8 + chunk.size + (chunk.size % 2), 0) + 8 + 16
    const view = new DataView(new ArrayBuffer(size))
    const writeFourCC = (offset: number, value: string) =>
        [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))

    writeFourCC(0, 'RIFF')
    view.setUint32(4, size - 8, true)
    writeFourCC(8, 'WAVE')

    let offset = 12
    for (const chunk of chunks) {
        writeFourCC(offset, chunk.id)
        view.setUint32(offset + 4, chunk.size, true)
        offset += 8 + chunk.size + (chunk.size % 2)
    }

    writeFourCC(offset, 'fmt ')
    view.setUint32(offset + 4, 16, true)
    view.setUint16(offset + 8, 1, true) // PCM
    view.setUint16(offset + 10, 1, true) // mono
    view.setUint32(offset + 12, sampleRate, true)
    return view.buffer
}

describe('readWavSampleRate', () => {
    test('reads the sample rate from the fmt chunk', () => {
        expect(readWavSampleRate(createWav(22050))).toBe(22050)
    })

    test('skips chunks preceding the fmt chunk, including odd-sized ones', () => {
        expect(readWavSampleRate(createWav(11025, [['LIST', 5]]))).toBe(11025)
    })

    test('returns null for non-WAV data', () => {
        expect(readWavSampleRate(new TextEncoder().encode('OggS not a wav file').buffer)).toBeNull()
    })
})

describe('Sound.setRate', () => {
    test('applies the rate multiplied by the global speed to playing instances', () => {
        const manager = { speed: 2 } as AudioManager
        const sound = new Sound(manager, { sampleRate: 44100 } as AudioBuffer, 22050)
        const instance = { speed: 1 } as SoundInstance
        sound.instances.push(instance)

        sound.setRate(0.5)

        expect(sound.rate).toBe(0.5)
        expect(instance.speed).toBe(1)
        expect(sound.sampleRate).toBe(22050)
    })
})
