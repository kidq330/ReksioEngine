import { parseEvent, parseHeader } from '../../src/fileFormats/ann'
import { BinaryBuffer } from '../../src/fileFormats/utils'

// Event names of an ANN file, without decoding its images
export const readAnnEventNames = (data: Uint8Array): string[] => {
    const buffer = new BinaryBuffer(new DataView(data.buffer, data.byteOffset, data.byteLength))
    const header = parseHeader(buffer)
    const names: string[] = []
    for (let i = 0; i < header.eventsCount; i++) {
        names.push(parseEvent(buffer).name)
    }
    return names
}
