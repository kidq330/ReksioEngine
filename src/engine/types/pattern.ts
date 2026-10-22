import { DisplayType, Type } from './index'
import { PatternDefinition } from '../../fileFormats/cnv/types'
import { Container } from 'pixi.js'
import { AdvancedSprite } from '../rendering'
import { method, int } from '../../common/types'
import { assert } from '../../common/errors'
import { Animo } from './animo'

type PatternEntry = {
    alias: string
    cellX: number
    cellY: number
    layer: number
    object: DisplayType<any>
    sprite: AdvancedSprite
}

// A large scrollable layer made of graphics placed on a grid (Czarodzieje minigames).
// Each entry shows the current frame of another ANIMO or IMAGE, so animated entries stay animated
// and hidden entries (e.g. collision masks) can still be hit-tested.
export class Pattern extends Type<PatternDefinition> {
    private container = new Container()
    private entries: PatternEntry[] = []

    async init() {
        this.container.name = `${this.name} (PATTERN)` // For PIXI Devtools
        this.container.visible = this.definition.VISIBLE ?? true
        this.container.sortableChildren = true
        this.container.zIndex = this.definition.PRIORITY ?? 0
    }

    async ready() {
        if (this.definition.TOCANVAS ?? true) {
            this.engine.rendering.addToStage(this.container, this)
            this.engine.rendering.putAtZindex(this.container, this.container.zIndex)
            this.engine.rendering.sortObjects()
        }
        await this.callbacks.run('ONINIT')
    }

    destroy() {
        this.engine.rendering.removeFromStage(this.container)
        this.container.destroy({ children: true })
    }

    async tick(elapsedMS: number) {
        for (const entry of this.entries) {
            this.syncEntry(entry)
        }
    }

    @method()
    ADD(alias: string, cellX: int, cellY: int, objectName: string, layer: int = 0) {
        const object = this.getObject<DisplayType<any>>(objectName)
        assert(object instanceof DisplayType, `PATTERN^ADD: '${objectName}' is not a graphics object`)

        const sprite = new AdvancedSprite()
        sprite.eventMode = 'none'
        sprite.name = `${alias} -> ${objectName}` // For PIXI Devtools
        sprite.zIndex = layer
        this.container.addChild(sprite)

        const entry = { alias, cellX, cellY, layer, object, sprite }
        this.entries.push(entry)
        this.syncEntry(entry)
    }

    @method()
    REMOVE(alias: string) {
        for (const entry of this.entries.filter((entry) => entry.alias === alias)) {
            this.container.removeChild(entry.sprite)
            entry.sprite.destroy()
        }
        this.entries = this.entries.filter((entry) => entry.alias !== alias)
    }

    @method()
    MOVE(xOffset: int, yOffset: int) {
        this.container.x += xOffset
        this.container.y += yOffset
    }

    @method()
    SETPOSITION(x: int, y: int) {
        this.container.x = x
        this.container.y = y
    }

    @method()
    SHOW() {
        this.container.visible = true
    }

    @method()
    HIDE() {
        this.container.visible = false
    }

    // Arguments after the position are a guess: (x, y, check alpha, only visible, first layer[, last layer])
    @method()
    GETGRAPHICSAT(
        x: int,
        y: int,
        checkAlpha: boolean = true,
        onlyVisible: boolean = false,
        firstLayer: int = 0,
        lastLayer: int = firstLayer
    ): string {
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const entry = this.entries[i]
            if (entry.layer < firstLayer || entry.layer > lastLayer) {
                continue
            }
            if (onlyVisible && !entry.sprite.visible) {
                continue
            }
            if (this.entryContainsPoint(entry, x, y, checkAlpha)) {
                return entry.object.name
            }
        }
        return 'NULL'
    }

    private syncEntry(entry: PatternEntry) {
        const source = entry.object.getRenderObject()
        if (source === null) {
            entry.sprite.visible = false
            return
        }

        const offset = entry.object instanceof Animo ? entry.object.getFrameOffset() : { x: 0, y: 0 }
        entry.sprite.texture = source.texture
        entry.sprite.hitmap = source.hitmap
        entry.sprite.anchor.copyFrom(source.anchor)
        entry.sprite.width = source.width
        entry.sprite.height = source.height
        entry.sprite.alpha = source.alpha
        entry.sprite.visible = source.visible
        entry.sprite.x = entry.cellX * this.gridX + offset.x + source.width * source.anchor.x
        entry.sprite.y = entry.cellY * this.gridY + offset.y + source.height * source.anchor.y
    }

    // Computed by hand, because hidden sprites don't get their world transform updated
    private entryContainsPoint(entry: PatternEntry, x: number, y: number, checkAlpha: boolean) {
        const sprite = entry.sprite
        const width = Math.round(sprite.width)
        const height = Math.round(sprite.height)
        const left = this.container.x + sprite.x - width * sprite.anchor.x
        const top = this.container.y + sprite.y - height * sprite.anchor.y
        const px = Math.trunc(x - left)
        const py = Math.trunc(y - top)
        if (px < 0 || py < 0 || px >= width || py >= height) {
            return false
        }
        if (!checkAlpha || sprite.hitmap === undefined) {
            return true
        }
        return (sprite.hitmap[py * width + px] ?? 0) > 0
    }

    private get gridX() {
        return this.definition.GRIDX ?? 1
    }

    private get gridY() {
        return this.definition.GRIDY ?? 1
    }
}
