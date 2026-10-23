import { parseExports } from './disasm'

describe('disasm', () => {
    test('exports are read from objdump -p output', () => {
        const dump = `
ImageBase		10000000
Export Address Table -- Ordinal Base 1
	[1565] +base[1566] 114f Export RVA
	[1566] +base[1567] 4089 Export RVA

[Ordinal/Name Pointer] Table
	[1565] ?GetEventNo@CAnimo@BlooMooDLL@@QAEHH@Z
	[1566] ?GetEventNo@CAnimo@BlooMooDLL@@QAEHVCXString@2@@Z
`
        const table = parseExports(dump)
        expect(table.imageBase).toBe(0x10000000)
        expect(table.byName.get('?GetEventNo@CAnimo@BlooMooDLL@@QAEHVCXString@2@@Z')).toBe(0x10004089)
        expect(table.byAddress.get(0x1000114f)).toBe('?GetEventNo@CAnimo@BlooMooDLL@@QAEHH@Z')
    })
})
