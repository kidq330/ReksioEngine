// Runs every scene (or ARCADE location) of a game in headless Chromium and reports script errors.
// See scripts/README.md.
import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from 'util'
import {
    captureLogs,
    changeScene,
    currentScene,
    episodeScenes,
    interact,
    launchBrowser,
    openGame,
    runScript,
    waitForSceneChange,
    wait,
    Clock,
    REAL_TIME,
} from './browser'
import { GameConfig, listLocations, loadConfig, resolveGameRoot } from './config'
import { startServer } from './server'
import { formatGroups, groupErrors, isError, regressions, Summary } from './summary'

const { values: options, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        root: { type: 'string' },
        config: { type: 'string', default: path.join(__dirname, 'games.json') },
        app: { type: 'string', default: 'dist/app' },
        scenes: { type: 'string' },
        locations: { type: 'boolean', default: false },
        only: { type: 'string' },
        seconds: { type: 'string', default: '12' },
        interact: { type: 'boolean', default: false },
        'real-clock': { type: 'boolean', default: false },
        out: { type: 'string' },
        baseline: { type: 'string' },
    },
})

const usage = `Usage: yarn sweep <game> [--root DIR] [--scenes A,B | --locations [--only A,B]] [--seconds N]
                  [--interact] [--real-clock] [--out DIR] [--baseline summary.json] [--config FILE] [--app DIR]`

const main = async () => {
    const game = positionals[0]
    const configs = loadConfig(options.config!)
    if (!game || !(game in configs)) {
        console.error(`${usage}\nGames: ${Object.keys(configs).join(', ')}`)
        process.exit(2)
    }
    const config: GameConfig = configs[game]
    const root = resolveGameRoot(game, options.root)
    if (root === null || !fs.existsSync(root)) {
        console.error(
            `Game folder not found. Pass --root, or set REKSIO_GAME_${game.toUpperCase()} or REKSIO_GAMES_DIR.`
        )
        process.exit(2)
    }
    if (!fs.existsSync(path.join(options.app!, 'main.js'))) {
        console.error(`No built app in ${options.app}. Run "yarn build" first.`)
        process.exit(2)
    }
    if (options.locations && !config.locations) {
        console.error(`${game} has no locations in the config.`)
        process.exit(2)
    }

    const seconds = Number(options.seconds)
    const clock: Clock = options['real-clock'] ? REAL_TIME : { manual: true, seed: 1 }
    const outDir = options.out ?? path.join('sweep-results', options.locations ? `${game}-locations` : game)
    fs.mkdirSync(outDir, { recursive: true })

    const server = await startServer(options.app!, root)
    const browser = await launchBrowser()
    const summary: Summary = {}
    const allLogs: Record<string, string[]> = {}

    try {
        const prelude = options.locations ? (config.locations!.prelude ?? config.prelude) : config.prelude
        let targets: string[]
        if (options.locations) {
            targets = options.only?.split(',') ?? listLocations(root, config.locations!)
        } else if (options.scenes) {
            targets = options.scenes.split(',')
        } else {
            const page = await browser.newPage()
            await openGame(page, server.url, prelude)
            targets = await episodeScenes(page)
            await page.close()
        }

        for (const target of targets) {
            const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
            const logs = captureLogs(page)
            try {
                if (prelude !== undefined) {
                    await openGame(page, server.url, prelude, clock)
                    await waitForSceneChange(page, prelude, clock)
                    await wait(page, 5000, clock)
                    logs.length = 0
                    if (config.setup) {
                        await runScript(page, config.setup)
                    }
                    if (!options.locations && config.sceneSetup?.[target]) {
                        await runScript(page, config.sceneSetup[target])
                    }
                    if (options.locations) {
                        await runScript(page, config.locations!.code.replaceAll('%LOC%', target))
                        await changeScene(page, config.locations!.scene)
                    } else {
                        await changeScene(page, target)
                    }
                } else {
                    await openGame(page, server.url, target, clock)
                }
                await wait(page, seconds * 1000, clock)
                if (options.interact) {
                    await interact(page, 40, clock)
                }
                await page.screenshot({ path: path.join(outDir, `${target}.png`) })
            } catch (error) {
                logs.push(`[harness] ${error}`)
            }

            const endScene = await currentScene(page).catch(() => null)
            const result = {
                errors: logs.filter(isError).length,
                warnings: logs.filter((line) => line.startsWith('[warning]')).length,
                endScene,
            }
            summary[target] = result
            allLogs[target] = logs
            fs.writeFileSync(path.join(outDir, `${target}.log`), logs.join('\n'))
            const harness = logs.find((line) => line.startsWith('[harness]'))
            console.log(
                `${target}: ${result.errors} errors, ${result.warnings} warnings` +
                    (harness
                        ? `, ${harness}`
                        : endScene !== (options.locations ? config.locations!.scene : target)
                          ? `, ended in ${endScene}`
                          : '')
            )
            await page.close()
        }
    } finally {
        await browser.close()
        await server.close()
    }

    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
    const grouped = formatGroups(groupErrors(allLogs))
    fs.writeFileSync(path.join(outDir, 'errors.txt'), grouped)
    console.log(`\n${grouped || 'No errors.'}\n\nResults in ${outDir}`)

    if (options.baseline) {
        const found = regressions(summary, JSON.parse(fs.readFileSync(options.baseline, 'utf8')))
        if (found.length > 0) {
            console.log(`\nRegressions against ${options.baseline}:\n${found.join('\n')}`)
            process.exit(1)
        }
        console.log(`\nNo regressions against ${options.baseline}.`)
    }
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
