// Plays a game from a JSON walkthrough on a manual clock with a fixed seed, so the run is repeatable, and checks
// expectations along the way. See scripts/README.md.
import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from 'util'
import { Page } from 'playwright-core'
import { captureLogs, launchBrowser } from '../sweep/browser'
import { resolveGameRoot } from '../sweep/config'
import { startServer } from '../sweep/server'
import { isError } from '../sweep/summary'

export type Condition = { scene?: string; vars?: Record<string, string | number | boolean> }

export type Step =
    | { wait: number }
    | { waitFor: Condition; timeout?: number }
    | { click: [number, number] }
    | { clickObject: string }
    | { key: string }
    | { run: string }
    | { expect: Condition }
    | { screenshot: string }

export type Walkthrough = {
    game: string
    title: string
    start?: string
    seed?: number
    // Errors logged by the game that the walkthrough accepts, as substrings
    allowedErrors?: string[]
    steps: Step[]
}

const FRAME_MS = 1000 / 60

// Advances the game by whole frames
const advance = async (page: Page, ms: number) => {
    const frames = Math.max(1, Math.round(ms / FRAME_MS))
    await page.evaluate(
        async ([frames, frameMs]) => {
            const engine = (globalThis as any).engine
            for (let i = 0; i < frames; i++) {
                await engine.step(frameMs)
            }
        },
        [frames, FRAME_MS]
    )
}

// What failed in a condition, or null when it holds
const checkCondition = (page: Page, condition: Condition): Promise<string | null> =>
    page.evaluate((condition) => {
        const engine = (globalThis as any).engine
        const problems: string[] = []
        const scene = engine.currentScene?.name ?? null
        if (condition.scene !== undefined && scene !== condition.scene) {
            problems.push(`scene is ${scene}, expected ${condition.scene}`)
        }
        for (const [name, expected] of Object.entries(condition.vars ?? {})) {
            const object = engine.getObject(name)
            const value = object?.getValue ? object.getValue() : null
            if (String(value) !== String(expected)) {
                problems.push(`${name} is ${value}, expected ${expected}`)
            }
        }
        return problems.length > 0 ? problems.join('; ') : null
    }, condition)

// The centre of an object on screen: a button's rectangle, or the bounds of its graphic
const objectCentre = (page: Page, name: string): Promise<[number, number] | null> =>
    page.evaluate((name) => {
        const engine = (globalThis as any).engine
        const object = engine.getObject(name)
        if (object === null) {
            return null
        }
        const area = object.interactArea?.hitArea
        if (area) {
            return [area.x + area.width / 2, area.y + area.height / 2]
        }
        const graphic = object.gfxStandard ?? object
        const sprite = graphic.getRenderObject?.()
        if (!sprite) {
            return null
        }
        const bounds = sprite.getBounds()
        return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
    }, name)

const describe = (step: Step) => JSON.stringify(step)

export const runWalkthrough = async (walkthrough: Walkthrough, root: string, appDir: string, outDir: string) => {
    fs.mkdirSync(outDir, { recursive: true })
    const server = await startServer(appDir, root)
    const browser = await launchBrowser()
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    const logs = captureLogs(page)
    const failures: string[] = []
    // The scenes the game went through, for the log and for writing walkthroughs
    const scenes: string[] = []

    try {
        const scene = walkthrough.start ? `&scene=${walkthrough.start}` : ''
        await page.goto(
            `${server.url}/app/?loader=listingjson&source=${server.url}/game/listing.json&debug=false` +
                `&manualClock=true&seed=${walkthrough.seed ?? 1}${scene}`
        )
        await page.click('#game')
        await page.waitForFunction(() => (globalThis as any).engine?.currentScene, null, { timeout: 60000 })
        const canvas = (await page.locator('#game canvas').first().boundingBox())!

        let lastScene: string | null = null
        const noteScene = async (index: number) => {
            const scene = await page.evaluate(() => (globalThis as any).engine.currentScene?.name ?? null)
            if (scene !== lastScene) {
                scenes.push(`after step ${index}: ${scene}`)
                lastScene = scene
            }
        }
        await noteScene(0)

        for (const [index, step] of walkthrough.steps.entries()) {
            await noteScene(index)
            const label = `step ${index + 1} ${describe(step)}`
            if ('wait' in step) {
                await advance(page, step.wait)
            } else if ('waitFor' in step) {
                const timeout = step.timeout ?? 30000
                let waited = 0
                let problem = await checkCondition(page, step.waitFor)
                while (problem !== null && waited < timeout) {
                    await advance(page, 250)
                    waited += 250
                    problem = await checkCondition(page, step.waitFor)
                }
                if (problem !== null) {
                    failures.push(`${label}: still ${problem} after ${timeout} ms`)
                    break
                }
            } else if ('click' in step || 'clickObject' in step) {
                const point = 'click' in step ? step.click : await objectCentre(page, step.clickObject)
                if (point === null) {
                    failures.push(`${label}: object not found or not on screen`)
                    break
                }
                await page.mouse.move(canvas.x + point[0], canvas.y + point[1])
                await advance(page, FRAME_MS)
                await page.mouse.down()
                await advance(page, 100)
                await page.mouse.up()
                await advance(page, FRAME_MS)
            } else if ('key' in step) {
                await page.keyboard.down(step.key)
                await advance(page, 100)
                await page.keyboard.up(step.key)
                await advance(page, FRAME_MS)
            } else if ('run' in step) {
                await page.evaluate(async (code) => {
                    const engine = (globalThis as any).engine
                    await engine.scripting.executeCallback(null, null, { code, isSingleStatement: false })
                }, step.run)
            } else if ('expect' in step) {
                const problem = await checkCondition(page, step.expect)
                if (problem !== null) {
                    failures.push(`${label}: ${problem}`)
                    break
                }
            } else if ('screenshot' in step) {
                await page.screenshot({
                    path: path.join(outDir, `${step.screenshot}.png`),
                    clip: { x: canvas.x, y: canvas.y, width: 800, height: 600 },
                })
            }
        }
    } catch (error) {
        failures.push(`harness: ${error}`)
    } finally {
        await page.screenshot({ path: path.join(outDir, 'end.png') }).catch(() => undefined)
        await browser.close()
        await server.close()
    }

    const errors = logs
        .filter(isError)
        .filter((line) => !(walkthrough.allowedErrors ?? []).some((allowed) => line.includes(allowed)))
    for (const error of errors) {
        failures.push(`game error: ${error.split('\n')[0].slice(0, 200)}`)
    }
    fs.writeFileSync(path.join(outDir, 'log.txt'), logs.join('\n'))
    fs.writeFileSync(path.join(outDir, 'scenes.txt'), scenes.join('\n'))
    return { failures, scenes }
}

const main = async () => {
    const { values: options, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            root: { type: 'string' },
            app: { type: 'string', default: 'dist/app' },
            out: { type: 'string' },
            scenes: { type: 'boolean', default: false },
        },
    })
    if (positionals.length === 0) {
        console.error('Usage: yarn walkthrough <walkthrough.json>... [--root DIR] [--app DIR] [--out DIR]')
        process.exit(2)
    }

    let failed = 0
    for (const file of positionals) {
        const walkthrough: Walkthrough = JSON.parse(fs.readFileSync(file, 'utf8'))
        const root = resolveGameRoot(walkthrough.game, options.root)
        if (root === null || !fs.existsSync(root)) {
            console.error(`${file}: game folder for ${walkthrough.game} not found (see scripts/README.md)`)
            failed++
            continue
        }
        const outDir = options.out ?? path.join('sweep-results', 'walkthroughs', path.basename(file, '.json'))
        const { failures, scenes } = await runWalkthrough(walkthrough, root, options.app!, outDir)
        console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'} ${walkthrough.title} (${file})`)
        if (options.scenes) {
            console.log(scenes.map((line) => `    ${line}`).join('\n'))
        }
        for (const failure of failures) {
            console.log(`    ${failure}`)
        }
        failed += failures.length > 0 ? 1 : 0
    }
    process.exit(failed > 0 ? 1 : 0)
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error)
        process.exit(1)
    })
}
