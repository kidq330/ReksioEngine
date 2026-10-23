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

// Without a scene the game starts where its episode's STARTWITH says
export const gameUrl = (serverUrl: string, scene?: string) =>
    `${serverUrl}/app/?loader=listingjson&source=${serverUrl}/game/listing.json&debug=false` +
    (scene ? `&scene=${scene}` : '')

// Opens the game in a scene and waits until the engine has entered it
export const openGame = async (page: Page, serverUrl: string, scene?: string) => {
    await page.goto(gameUrl(serverUrl, scene))
    await page.click('#game')
    await page.waitForFunction(() => (globalThis as any).engine?.currentScene, null, { timeout: 60000 })
}

// Waits until the game leaves the given scene by itself, e.g. an intro handing over to the menu
export const waitForSceneChange = (page: Page, from: string) =>
    page.waitForFunction(
        (scene) => {
            const current = (globalThis as any).engine?.currentScene
            return current && current.name !== scene
        },
        from,
        { timeout: 60000 }
    )

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
export const interact = async (page: Page, rounds = 40) => {
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
            await page.waitForTimeout(300)
            await page.keyboard.up(key)
        } else {
            await page.mouse.move(box.x + 20 + random() * 760, box.y + 20 + random() * 560)
            await page.waitForTimeout(150)
            await page.mouse.down()
            await page.waitForTimeout(80)
            await page.mouse.up()
        }
        await page.waitForTimeout(400)
    }
}
