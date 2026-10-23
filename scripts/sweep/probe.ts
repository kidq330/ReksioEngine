// Runs script code in a game and prints the values of variables afterwards. See scripts/README.md.
import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from 'util'
import { captureLogs, changeScene, launchBrowser, openGame, runScript, waitForSceneChange } from './browser'
import { loadConfig, resolveGameRoot } from './config'
import { startServer } from './server'

const { values: options, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        root: { type: 'string' },
        config: { type: 'string', default: path.join(__dirname, 'games.json') },
        app: { type: 'string', default: 'dist/app' },
        scene: { type: 'string' },
        code: { type: 'string', default: '' },
        vars: { type: 'string', default: '' },
        wait: { type: 'string', default: '3' },
        logs: { type: 'boolean', default: false },
    },
})

const main = async () => {
    const game = positionals[0]
    const config = loadConfig(options.config!)[game]
    const root = resolveGameRoot(game, options.root)
    if (!config || root === null || !fs.existsSync(root)) {
        console.error(
            'Usage: yarn probe <game> [--root DIR] [--scene S] [--code "A^SET(1);"] [--vars A,B] [--wait SECONDS] [--logs]'
        )
        process.exit(2)
    }

    const server = await startServer(options.app!, root)
    const browser = await launchBrowser()
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
        const logs = captureLogs(page)
        if (config.prelude) {
            await openGame(page, server.url, config.prelude)
            await waitForSceneChange(page, config.prelude)
            await page.waitForTimeout(3000)
            if (config.setup) {
                await runScript(page, config.setup)
            }
            if (options.scene) {
                await changeScene(page, options.scene)
            }
        } else {
            await openGame(page, server.url, options.scene)
        }
        await page.waitForTimeout(Number(options.wait) * 1000)
        logs.length = options.logs ? logs.length : 0
        if (options.code) {
            await runScript(page, options.code)
        }

        const values = await page.evaluate((names) => {
            const engine = (globalThis as any).engine
            const result: Record<string, string | null> = { scene: engine.currentScene?.name ?? null }
            for (const name of names) {
                const object = engine.getObject(name)
                result[name] =
                    object === null ? null : object.getValue ? String(object.getValue()) : object.constructor.name
            }
            return result
        }, options.vars!.split(',').filter(Boolean))
        console.log(JSON.stringify(values, null, 2))
        if (logs.length > 0) {
            console.log(logs.join('\n'))
        }
    } finally {
        await browser.close()
        await server.close()
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
