import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildListing, resolveInside, startServer } from './server'
import { listLocations } from './config'
import { formatGroups, groupErrors, regressions } from './summary'

describe('sweep tooling', () => {
    let root: string

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'))
        fs.mkdirSync(path.join(root, 'Dane', 'Game', 'Arcade'), { recursive: true })
        for (const name of ['Arcade.cnv', 'Paryz.cnv', 'c_helper.cnv', 'Egipt.CNV', 'notes.seq']) {
            fs.writeFileSync(path.join(root, 'Dane', 'Game', 'Arcade', name), name)
        }
        fs.mkdirSync(path.join(root, 'app'))
        fs.writeFileSync(path.join(root, 'app', 'index.html'), '<html></html>')
    })

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

    test('the listing maps lowercase paths to URLs of the files as they are named', () => {
        const listing = buildListing(path.join(root, 'Dane'), 'http://host/game')
        expect(listing['game/arcade/paryz.cnv']).toBe('http://host/game/Game/Arcade/Paryz.cnv')
        expect(Object.keys(listing)).toHaveLength(5)
    })

    test('paths outside the served folder are refused', () => {
        expect(resolveInside(root, '/Dane/Game')).toBe(path.join(root, 'Dane', 'Game'))
        expect(resolveInside(root, '/../etc/passwd')).toBeNull()
        expect(resolveInside(root, '/%2e%2e/etc/passwd')).toBeNull()
    })

    test('the server serves the app, the game files and the listing', async () => {
        const server = await startServer(path.join(root, 'app'), path.join(root, 'Dane'))
        try {
            expect(await (await fetch(`${server.url}/app/`)).text()).toBe('<html></html>')
            const listing = await (await fetch(`${server.url}/game/listing.json`)).json()
            expect(await (await fetch(listing['game/arcade/egipt.cnv'])).text()).toBe('Egipt.CNV')
            expect((await fetch(`${server.url}/game/missing.cnv`)).status).toBe(404)
        } finally {
            await server.close()
        }
    })

    test('locations are the .cnv files of a folder, found in any case, minus exclusions', () => {
        const locations = listLocations(root, {
            scene: 'ARCADE',
            code: '',
            dir: 'dane/game/arcade',
            exclude: ['ARCADE', 'C_*'],
        })
        expect(locations).toEqual(['EGIPT', 'PARYZ'])
    })

    test('errors are grouped by message, script stack traces by their innermost call', () => {
        const groups = groupErrors({
            A: ['[error] Failed to initialize object X', '[error] \t@ __INIT__()', '\t@ OBJ^PLAY("Y")', '[warning] w'],
            B: ['[error] Failed to initialize object X'],
        })
        expect([...groups.entries()].map(([message, scenes]) => [message, [...scenes]])).toEqual([
            ['[error] Failed to initialize object X', ['A', 'B']],
            ['  at @ OBJ^PLAY("Y")', ['A']],
        ])
        expect(formatGroups(groups).split('\n')[0]).toMatch(/^ {2}2 \[error\] Failed .* \[A,B\]$/)
    })

    test('a regression is a scene with more errors than in the baseline', () => {
        const baseline = { A: { errors: 1, warnings: 0, endScene: 'A' }, B: { errors: 0, warnings: 0, endScene: 'B' } }
        const summary = {
            A: { errors: 1, warnings: 5, endScene: 'A' },
            B: { errors: 2, warnings: 0, endScene: 'B' },
            C: { errors: 1, warnings: 0, endScene: 'C' },
            D: { errors: 0, warnings: 0, endScene: 'D' },
        }
        expect(regressions(summary, baseline)).toEqual(['B: 0 -> 2 errors', 'C: new -> 1 errors'])
    })
})
