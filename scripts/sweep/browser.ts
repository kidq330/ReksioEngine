import { Browser, chromium, Page } from 'playwright-core'

export const launchBrowser = (): Promise<Browser> =>
    chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    })

// Collects console errors and warnings, and uncaught page errors, as "[type] text" lines
export const captureLogs = (page: Page): string[] => {
    const logs: string[] = []
    page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
            logs.push(`[${message.type()}] ${message.text().slice(0, 1500)}`)
        }
    })
    page.on('pageerror', (error) => logs.push(`[pageerror] ${error.stack ?? error}`))
    return logs
}

// How the game's time passes: in real time, or on a manual clock that moves only when the tools step it, with
// seeded random numbers. A manual clock makes runs repeatable and is faster, as only the last frame of a wait
// is drawn.
export type Clock = { manual: boolean; seed?: number }
export const REAL_TIME: Clock = { manual: false }

// Without a scene the game starts where its episode's STARTWITH says
export const gameUrl = (serverUrl: string, scene?: string, clock: Clock = REAL_TIME) =>
    `${serverUrl}/app/?loader=listingjson&source=${serverUrl}/game/listing.json&debug=false` +
    (clock.manual ? `&manualClock=true&seed=${clock.seed ?? 1}` : '') +
    (scene ? `&scene=${scene}` : '')

// Opens the game in a scene and waits until the engine has entered it
export const openGame = async (page: Page, serverUrl: string, scene?: string, clock: Clock = REAL_TIME) => {
    await page.goto(gameUrl(serverUrl, scene, clock))
    await page.click('#game')
    await page.waitForFunction(() => (globalThis as any).engine?.currentScene, null, { timeout: 60000 })
}

const FRAME_MS = 1000 / 60

// Advances a game on a manual clock by whole frames, drawing only the last one
export const advanceGame = async (page: Page, ms: number) => {
    const frames = Math.max(1, Math.round(ms / FRAME_MS))
    await page.evaluate(
        async ([frames, frameMs]) => {
            const engine = (globalThis as any).engine
            for (let i = 0; i < frames; i++) {
                await engine.step(frameMs, i === frames - 1)
            }
        },
        [frames, FRAME_MS]
    )
}

// Lets `ms` of game time pass
export const wait = (page: Page, ms: number, clock: Clock = REAL_TIME) =>
    clock.manual ? advanceGame(page, ms) : page.waitForTimeout(ms)

// Waits until the game leaves the given scene by itself, e.g. an intro handing over to the menu
export const waitForSceneChange = async (page: Page, from: string, clock: Clock = REAL_TIME) => {
    if (!clock.manual) {
        await page.waitForFunction(
            (scene) => {
                const current = (globalThis as any).engine?.currentScene
                return current && current.name !== scene
            },
            from,
            { timeout: 60000 }
        )
        return
    }
    for (let waited = 0; (await currentScene(page)) === from; waited += 250) {
        if (waited >= 60000) {
            throw new Error(`still in ${from} after 60 s of game time`)
        }
        await advanceGame(page, 250)
    }
}

// Runs script code in the game as if from a callback, logging (not throwing) script failures
export const runScript = (page: Page, code: string) =>
    page.evaluate(async (code) => {
        const engine = (globalThis as any).engine
        try {
            await engine.scripting.executeCallback(null, null, { code, isSingleStatement: false })
        } catch (error) {
            console.error(`Setup code failed: ${error}`)
        }
    }, code)

export const changeScene = (page: Page, scene: string) =>
    page.evaluate((scene) => {
        const engine = (globalThis as any).engine
        // A scene change cancels the running tick by throwing; its callback finishes the change
        engine.changeScene(scene).catch(async (error: any) => {
            if (error.callback) {
                await error.callback()
            } else {
                console.error(String(error))
            }
        })
    }, scene)

export const currentScene = (page: Page) => page.evaluate(() => (globalThis as any).engine?.currentScene?.name ?? null)

// The scenes of the running episode, from its definition
export const episodeScenes = (page: Page): Promise<string[]> =>
    page.evaluate(() => (globalThis as any).engine.scopeManager.findByType('EPISODE').definition.SCENES)

// Deterministic pseudo-random clicks and key presses over the 800x600 canvas
export const interact = async (page: Page, rounds = 40, clock: Clock = REAL_TIME) => {
    const box = await page.locator('#game canvas').first().boundingBox()
    if (box === null) {
        return
    }
    let seed = 12345
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']
    for (let i = 0; i < rounds && !page.isClosed(); i++) {
        if (i % 3 === 0) {
            const key = keys[Math.floor(random() * keys.length)]
            await page.keyboard.down(key)
            await wait(page, 300, clock)
            await page.keyboard.up(key)
        } else {
            await page.mouse.move(box.x + 20 + random() * 760, box.y + 20 + random() * 560)
            await wait(page, 150, clock)
            await page.mouse.down()
            await wait(page, 80, clock)
            await page.mouse.up()
        }
        await wait(page, 400, clock)
    }
}
