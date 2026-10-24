// Disassembles exported functions of the games' engine DLLs (PIKLIB*.dll, BlooMooDLL.dll and the plugins),
// labelling calls with the exports they reach. Needs objdump with PE support; llvm-undname is used to
// demangle names when present. See scripts/README.md.
import { execFileSync } from 'child_process'
import { parseArgs } from 'util'

export type Exports = { imageBase: number; byAddress: Map<number, string>; byName: Map<string, number> }

// Reads the export table from `objdump -p` output
export const parseExports = (dump: string): Exports => {
    const imageBase = parseInt(/ImageBase\s+([0-9a-f]+)/i.exec(dump)?.[1] ?? '0', 16)
    const rvaByOrdinal = new Map<number, number>()
    for (const match of dump.matchAll(/\[\s*(\d+)\] \+base\[\s*\d+\]\s+([0-9a-f]+) Export RVA/g)) {
        rvaByOrdinal.set(Number(match[1]), parseInt(match[2], 16))
    }
    // The name table runs until the next section of the dump (e.g. the relocations, whose lines look alike)
    const namesStart = dump.indexOf('[Ordinal/Name Pointer] Table')
    const namesEnd = dump.indexOf('\n\n', namesStart)
    const names = dump.slice(namesStart, namesEnd === -1 ? undefined : namesEnd)
    const byAddress = new Map<number, string>()
    const byName = new Map<string, number>()
    for (const match of names.matchAll(/\[\s*(\d+)\] (\S+)/g)) {
        const rva = rvaByOrdinal.get(Number(match[1]))
        if (rva !== undefined) {
            byAddress.set(imageBase + rva, match[2])
            byName.set(match[2], imageBase + rva)
        }
    }
    return { imageBase, byAddress, byName }
}

const objdump = (args: string[]) => execFileSync('objdump', args, { encoding: 'utf8', maxBuffer: 1 << 28 })

const demangle = (name: string) => {
    try {
        const out = execFileSync('llvm-undname', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .trim()
            .split('\n')
        const demangled = out[out.length - 1]
        return demangled && !demangled.startsWith('error') && demangled !== 'HIGHLOW' ? demangled : name
    } catch {
        return name
    }
}

type Instruction = { address: number; text: string }

const disassemble = (dll: string, start: number, length: number): Instruction[] =>
    objdump(['-d', '--no-show-raw-insn', `--start-address=${start}`, `--stop-address=${start + length}`, dll])
        .split('\n')
        .map((line) => /^\s*([0-9a-f]+):\s+(.*)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({ address: parseInt(match[1], 16), text: match[2].trim() }))

// Incremental linking puts a `jmp` stub at each export; returns where it leads, or the address itself
const followThunk = (dll: string, address: number) => {
    const [first] = disassemble(dll, address, 5)
    const jump = first && /^jmp\s+0x([0-9a-f]+)$/.exec(first.text)
    return jump ? parseInt(jump[1], 16) : address
}

const main = () => {
    const { values: options, positionals } = parseArgs({
        allowPositionals: true,
        options: { length: { type: 'string', default: '0x200' }, list: { type: 'boolean', default: false } },
    })
    const [dll, query] = positionals
    if (!dll || !query) {
        console.error('Usage: yarn disasm <dll> <export name part | 0xADDRESS> [--length 0x200] [--list]')
        process.exit(2)
    }

    const table = parseExports(objdump(['-p', dll]))
    let address: number
    if (/^0x[0-9a-f]+$/i.test(query)) {
        address = parseInt(query, 16)
    } else {
        const entries = [...table.byName.entries()]
        const caseSensitive = entries.filter(([name]) => name.includes(query))
        const found =
            caseSensitive.length > 0
                ? caseSensitive
                : entries.filter(([name]) => name.toLowerCase().includes(query.toLowerCase()))
        if (found.length !== 1 || options.list) {
            for (const [name, at] of found) {
                console.log(`0x${at.toString(16)}  ${demangle(name)}`)
            }
            if (found.length !== 1) {
                console.error(found.length === 0 ? 'No export matches.' : 'Several exports match; pick one by address.')
                process.exit(found.length === 0 ? 1 : 0)
            }
            return
        }
        console.log(`; ${demangle(found[0][0])}`)
        address = found[0][1]
    }

    const body = followThunk(dll, address)
    const label = (target: number) => {
        const name = table.byAddress.get(target) ?? table.byAddress.get(followThunk(dll, target))
        return name ? `  ; ${demangle(name)}` : ''
    }
    let padding = 0
    for (const instruction of disassemble(dll, body, parseInt(options.length!, 16))) {
        // A run of int3 is the padding after the function
        padding = instruction.text === 'int3' ? padding + 1 : 0
        if (padding >= 3) {
            break
        }
        const call = /^(call|jmp)\s+0x([0-9a-f]+)$/.exec(instruction.text)
        console.log(
            `${instruction.address.toString(16)}:  ${instruction.text}${call ? label(parseInt(call[2], 16)) : ''}`
        )
    }
}

if (require.main === module) {
    main()
}
