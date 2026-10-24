import { reference } from '../fileFormats/common'
import { ScriptingManager } from './scripting'
import { loadDefinition, doReady } from '../filesystem/definitionLoader'
import { Application, DisplayObject, Rectangle, Sprite, Texture } from 'pixi.js'
import { Scene } from './types/scene'
import { loadSound, loadTexture } from '../filesystem/assetsLoader'
import { SaveFile, SaveFileManager } from './saveFile'
import { Debugging } from './debugging'
import { assert, CancelTick, IrrecoverableError } from '../common/errors'
import { initDevtools } from '@pixi/devtools'
import { RenderingManager } from './rendering'
import { BUILD_VARS, GamePlayerOptions } from '../index'
import { Scope, ScopeManager } from './scope'
import { Episode } from './types/episode'
import { Type } from './types'
import Filesystem, { pathJoin } from '../filesystem'
import { globalAudio, SoundInstance } from './audio'
import { GameClock } from './clock'
import { logger } from './logging'
import { setFormatsLogger } from '../fileFormats/logger'

export class Engine {
    public debug: Debugging
    public speed: number = 1

    public scopeManager: ScopeManager

    public rendering: RenderingManager
    public scripting: ScriptingManager

    public currentScene: Scene | null = null
    public previousScene: Scene | null = null

    public saveFile: SaveFile

    public filesystem: Filesystem
    public music: SoundInstance | null = null

    constructor(
        public readonly app: Application,
        public readonly options: GamePlayerOptions
    ) {
        setFormatsLogger(logger)
        this.rendering = new RenderingManager(app)
        this.scripting = new ScriptingManager(this)
        this.scopeManager = new ScopeManager()
        this.debug = new Debugging(this, this.options.debug ?? false, options.debugContainer ?? null)
        this.filesystem = new Filesystem(this.options.fileLoader, this.options.storage)
        this.saveFile = this.options.saveFile ?? SaveFileManager.empty(undefined)
        this.clock = new GameClock({ manual: this.options.manualClock, seed: this.options.randomSeed })
    }

    public readonly clock: GameClock

    async init() {
        try {
            // @ts-expect-error no engine in globalThis
            globalThis.engine = this
            await initDevtools({ app: this.app })

            this.rendering.init()

            if (this.clock.isManual) {
                globalAudio.useVirtualClock()
                // Frames are drawn by step() only, not by the ticker on every animation frame
                this.app.ticker.remove(this.app.render, this.app)
            } else if (!BUILD_VARS.manualTick) {
                this.app.ticker.add(() => this.tick(this.app.ticker.elapsedMS))
            }
            this.app.ticker.stop()

            this.debug.setupDebugTools()
        } catch (err) {
            logger.error('Unhandled error occurred during initialization', null, err)
        }
    }

    start() {
        return this.whileLoading(this.loadGame())
    }

    private async loadGame() {
        try {
            await this.filesystem.init()

            const applicationDef = await this.filesystem.getCNVFile('DANE/Application.def')
            const rootScope = this.scopeManager.newScope('root')
            await loadDefinition(this, rootScope, applicationDef, null)
            await doReady(rootScope)

            const episode: Episode | null = this.scopeManager.findByType('EPISODE')
            if (episode === null) {
                logger.error("Starting episode doesn't exist")
                return
            }

            await this.debug.fillSceneSelector()
            await this.changeScene(this.options.startScene ?? episode.definition.STARTWITH)

            this.app.ticker.start()
        } catch (err) {
            if (err instanceof CancelTick) {
                await err.callback?.()
                return
            }

            logger.error(
                'Unhandled error occurred during start',
                {
                    scopes: this.scopeManager.scopes,
                },
                err
            )
        }
    }

    destroy() {
        this.app.destroy()
        if (this.music !== null) {
            this.music.stop()
        }
        globalAudio.stopAll()
    }

    // Starting the game and changing scenes. The game doesn't run meanwhile (the ticker is stopped), so a manual
    // clock waits for them too: otherwise how long files take to load would change what happens in the game.
    private loading = new Set<Promise<unknown>>()

    private whileLoading<T>(work: Promise<T>): Promise<T> {
        this.loading.add(work)
        work.finally(() => this.loading.delete(work)).catch(() => undefined)
        return work
    }

    // Advances a manual clock by `ms` and runs one tick of the game, then draws the frame unless told not to
    // (drawing is the slow part of a headless run, and the game's logic doesn't depend on it)
    async step(ms: number, draw: boolean = true) {
        while (this.loading.size > 0) {
            await Promise.allSettled(this.loading)
        }
        this.clock.advance(ms)
        globalAudio.advance(ms / 1000)
        await this.tick(ms)
        if (draw) {
            this.app.render()
        }
    }

    // Scripts run to completion like in the original engine. A tick still waiting for something (e.g. a file
    // loaded by a script) must not let the next frame start other scripts that change the same variables.
    private tickInProgress = false
    private skippedTicksMS = 0

    async tick(elapsedMS: number) {
        if (this.tickInProgress) {
            this.skippedTicksMS += elapsedMS
            return
        }

        this.tickInProgress = true
        try {
            await this.tickObjects(elapsedMS + this.skippedTicksMS)
        } finally {
            this.tickInProgress = false
        }
    }

    private async tickObjects(elapsedMS: number) {
        this.skippedTicksMS = 0
        for (const scope of this.scopeManager.scopes) {
            for (const object of scope.objects.filter((object) => object.isReady)) {
                try {
                    await object.tick(elapsedMS)
                } catch (err) {
                    if (err instanceof CancelTick) {
                        await err.callback?.()
                        return
                    } else if (err instanceof IrrecoverableError) {
                        logger.error(
                            'Irrecoverable error occurred. Execution paused\n' + 'Call "engine.resume()" to resume',
                            {
                                scopes: this.scopeManager.scopes,
                            },
                            err
                        )
                    } else {
                        logger.error(
                            'Unhandled error occurred during tick. Execution paused\n' +
                                'Call "engine.resume()" to resume',
                            {
                                scopes: this.scopeManager.scopes,
                            },
                            err
                        )
                    }
                    this.pause()
                }
            }
        }

        this.rendering.flushDirty()
        this.debug.updateXRay()
    }

    changeScene(sceneName: string) {
        return this.whileLoading(this.loadScene(sceneName))
    }

    private async loadScene(sceneName: string) {
        this.options.onSceneChange?.(sceneName, this.currentScene?.name)
        this.app.ticker.stop()
        this.rendering.onSceneChange()
        this.rendering.setLoadingCursor()

        const loadingFreezeOverlay = Sprite.from(
            await this.app.renderer.extract.image(
                this.app.stage,
                undefined,
                undefined,
                new Rectangle(0, 0, this.app.view.width, this.app.view.height)
            )
        )
        loadingFreezeOverlay.name = 'Loading freeze overlay'
        loadingFreezeOverlay.zIndex = 9999999
        this.app.stage.addChild(loadingFreezeOverlay)
        this.app.renderer.render(this.app.stage)

        try {
            const scopeToClear: Scope | null = this.currentScene !== null ? this.currentScene.scope : null
            if (scopeToClear) {
                this.scopeManager.removeScope(scopeToClear)
                for (const object of scopeToClear.objects) {
                    object.destroy()
                    scopeToClear.remove(object.name)
                }
            }

            // Alert when rendering stage wasn't completely cleared after all destroys.
            // For debugging purposes.
            // Objects of the application, episode and their class instances stay on stage.
            const clearedScene = this.currentScene
            const belongsToClearedScene = (obj: DisplayObject) => {
                for (let owner = this.rendering.getOwner(obj); owner !== null; owner = owner.parent) {
                    if (owner === clearedScene) {
                        return true
                    }
                }
                return this.rendering.getOwner(obj) === null
            }
            const leakedObjects = this.app.stage.children.filter(
                (obj) =>
                    ![loadingFreezeOverlay, this.rendering.canvasBackground].includes(obj as any) &&
                    belongsToClearedScene(obj)
            )
            if (scopeToClear && leakedObjects.length > 0) {
                logger.error('Display objects leak detected', {
                    leakedObjects,
                })
            }

            this.previousScene = this.currentScene
            this.currentScene = this.getObject<Scene>(sceneName)
            assert(this.currentScene !== null, 'could not find scene')

            if (this.music !== null && this.currentScene.definition.MUSIC !== this.previousScene?.definition.MUSIC) {
                this.music.stop()
                this.music = null
            }

            // Set background image
            let texturePromise: Promise<Texture> | null = null
            if (this.currentScene.definition.BACKGROUND !== undefined) {
                texturePromise = loadTexture(
                    this.filesystem,
                    await this.currentScene.getRelativePath(this.currentScene.definition.BACKGROUND)
                )
            } else {
                this.rendering.clearBackground()
            }

            // Play new scene background music.
            // We keep playing the same music if it was the same in previous scene
            let musicPromise = null
            if (this.music == null && this.currentScene.definition.MUSIC !== undefined) {
                musicPromise = loadSound(this.filesystem, this.currentScene.definition.MUSIC)
            }

            const sceneDefinitionPromise = this.filesystem.getCNVFile(
                await this.currentScene!.getRelativePath(sceneName + '.cnv')
            )
            const newScopePromise: Promise<Scope> = new Promise((resolve, reject) => {
                sceneDefinitionPromise
                    .then((sceneDefinition) => {
                        const newScope = this.scopeManager.newScope('scene')
                        assert(this.currentScene !== null, 'could not find scene')
                        this.currentScene.scope = newScope
                        const newScopePromise = loadDefinition(this, newScope, sceneDefinition, this.currentScene)
                        newScopePromise
                            .then(() => {
                                resolve(newScope)
                            })
                            .catch(reject)
                    })
                    .catch(reject)
            })

            const [texture, music, newScope] = await Promise.all([texturePromise, musicPromise, newScopePromise])
            if (texture) {
                this.rendering.setBackground(texture)
            }

            if (music) {
                this.music = music.play({
                    loop: true,
                    muted: this.debug.mutedMusic,
                })
            }

            await doReady(newScope)
        } finally {
            this.rendering.resetCursor()
            this.app.stage.removeChild(loadingFreezeOverlay)

            this.app.ticker.start()
            this.debug.updateCurrentScene()
        }
    }

    getObject<T extends Type<any>>(name: string | reference | null, parentScope: Scope | null = null): T | null {
        if (typeof name == 'string') {
            const currentScopeEntry = parentScope?.get<T>(name)
            const object = currentScopeEntry ?? this.scopeManager.findByName<T>(name, parentScope)
            // Clone number 0 is the original object, even before any CLONE: Kapitan Nemo's WYKOPALISKA plays its
            // first explosion as ANNEXPLOSION_0 and finds its slot with GETCLONEINDEX, which is 0 for the original
            if (object === null && name.endsWith('_0') && name.length > 2) {
                return this.getObject<T>(name.slice(0, -2), parentScope)
            }
            return object
        } else if (name === null) {
            return null
        } else {
            return this.getObject(name.objectName, parentScope)
        }
    }

    async resolvePath(path: string, base = '') {
        if (path.startsWith('$')) {
            base = ''
            path = path.substring(1)
        }

        const lang = this.scopeManager.APPLICATION.language
        const langPath = pathJoin(base, lang, path)
        const noLangPath = pathJoin(base, path)

        if (await this.filesystem.hasFile(langPath)) {
            return langPath
        } else {
            return noLangPath
        }
    }

    resume() {
        assert(this.currentScene !== null, 'there is no active scene')
        const sceneScope = this.currentScene.scope
        assert(sceneScope !== null, 'there is no active scope')

        globalAudio.resume()
        for (const object of sceneScope.objects) {
            object.resume()
        }
        this.app.ticker.start()
    }

    pause() {
        assert(this.currentScene !== null, 'there is no active scene')
        const sceneScope = this.currentScene.scope
        assert(sceneScope !== null, 'there is no active scope')

        this.app.ticker.stop()
        globalAudio.pause()
        for (const object of sceneScope.objects) {
            object.pause()
        }
    }
}
