import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { AddressInfo } from 'net'

const contentTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.css': 'text/css',
}

const walk = (dir: string): string[] =>
    fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))

// The listing the engine's ListingJSONUrlFileLoader reads: lowercase relative path -> URL
export const buildListing = (root: string, baseUrl: string): Record<string, string> => {
    const listing: Record<string, string> = {}
    for (const file of walk(root)) {
        const relative = path.relative(root, file).split(path.sep).join('/')
        listing[relative.toLowerCase()] = `${baseUrl}/${relative.split('/').map(encodeURIComponent).join('/')}`
    }
    return listing
}

// Resolves a URL path inside root, or null when it would escape it
export const resolveInside = (root: string, urlPath: string): string | null => {
    const resolved = path.resolve(root, '.' + decodeURIComponent(urlPath))
    return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null
}

export type GameServer = { url: string; close: () => Promise<void> }

// Serves the built app under /app/ and a game folder under /game/, with the listing at /game/listing.json
export const startServer = async (appDir: string, gameRoot: string): Promise<GameServer> => {
    appDir = path.resolve(appDir)
    gameRoot = path.resolve(gameRoot)
    let listing: string | null = null

    const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        response.setHeader('Access-Control-Allow-Origin', '*')

        let file: string | null = null
        if (url.pathname === '/game/listing.json') {
            listing ??= JSON.stringify(buildListing(gameRoot, `${serverUrl()}/game`))
            response.writeHead(200, { 'Content-Type': 'application/json' })
            response.end(listing)
            return
        } else if (url.pathname.startsWith('/game/')) {
            file = resolveInside(gameRoot, url.pathname.slice('/game'.length))
        } else if (url.pathname.startsWith('/app/')) {
            const inApp = url.pathname.slice('/app'.length)
            file = resolveInside(appDir, inApp === '/' ? '/index.html' : inApp)
        }

        if (file === null || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            response.writeHead(404)
            response.end()
            return
        }
        response.writeHead(200, {
            'Content-Type': contentTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        })
        fs.createReadStream(file).pipe(response)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const serverUrl = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    return {
        url: serverUrl(),
        close: () => new Promise((resolve) => server.close(() => resolve())),
    }
}
