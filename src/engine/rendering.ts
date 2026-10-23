import { Application, DisplayObject, Graphics, IPointData, Rectangle, Sprite, Texture } from 'pixi.js'
import { assert } from '../common/errors'
import { DisplayType, Type } from './types'
import loadingCursor from '../../static/loading-cursor.png'

export class RenderingManager {
    public displayObjectsInDefinitionOrder: DisplayType<any>[] = []
    public sameZIndexUpdateOrder = new Map<number, DisplayObject[]>() // The later in array the higher zindex

    public readonly canvasBackground: Sprite
    private readonly blackTexture

    private dirtyRects: Rectangle[] = []
    private readonly owners = new WeakMap<DisplayObject, Type<any>>()

    constructor(private app: Application) {
        this.blackTexture = createColorTexture(
            this.app,
            new Rectangle(0, 0, this.app.view.width, this.app.view.height),
            0
        )
        this.canvasBackground = new Sprite(this.blackTexture)
        this.canvasBackground.zIndex = -99999
        this.canvasBackground.name = 'Scene Background' // For PIXI Devtools
    }

    init() {
        this.app.ticker.maxFPS = 60
        this.app.stage.interactive = true

        this.app.stage.name = 'Scene' // For PIXI Devtools
        this.app.stage.addChild(this.canvasBackground)
    }

    onSceneChange() {
        this.canvasBackground.position.set(0, 0)
        this.displayObjectsInDefinitionOrder = []
        this.resetCursor()
    }

    setBackground(texture: Texture) {
        this.canvasBackground.texture = texture
    }

    setBackgroundPosition(x: number, y: number) {
        this.canvasBackground.position.set(x, y)
    }

    moveBackground(x: number, y: number) {
        this.canvasBackground.x += x
        this.canvasBackground.y += y
    }

    clearBackground() {
        this.canvasBackground.texture = this.blackTexture
    }

    setCursor(mode: string) {
        this.app.renderer.events.cursorStyles.default = mode
        this.app.renderer.events.setCursor(mode)
    }

    setLoadingCursor() {
        this.setCursor(`url('${loadingCursor}') 16 16, wait`)
    }

    resetCursor() {
        this.app.stage.eventMode = 'static'
        this.setCursor('auto')
    }

    addToStage(sprite: DisplayObject, owner: Type<any>) {
        this.owners.set(sprite, owner)
        this.app.stage.addChild(sprite)
        this.sortObjects()
    }

    getOwner(sprite: DisplayObject): Type<any> | null {
        return this.owners.get(sprite) ?? null
    }

    removeFromStage(sprite: DisplayObject) {
        this.app.stage.removeChild(sprite)
        this.sortObjects()
    }

    putAtZindex(sprite: DisplayObject, zIndex: number) {
        let objects = this.sameZIndexUpdateOrder.get(zIndex)
        if (!objects) {
            objects = []
            this.sameZIndexUpdateOrder.set(zIndex, objects)
        }

        objects = objects.filter((obj) => obj != sprite)
        objects.push(sprite)
        this.sameZIndexUpdateOrder.set(zIndex, objects)
    }

    sortObjects() {
        // Default PIXI.js sorting have problem with equal zIndex case.
        this.app.stage.children.sort((a, b) => {
            if (a.zIndex !== b.zIndex) {
                return a.zIndex - b.zIndex
            }

            const objectA = this.displayObjectsInDefinitionOrder.find((e) => e.getRenderObject() === a)
            const objectB = this.displayObjectsInDefinitionOrder.find((e) => e.getRenderObject() === b)

            if (objectA === undefined || objectB === undefined) {
                return 0
            }

            const objectsAtZIndex = this.sameZIndexUpdateOrder.get(a.zIndex)
            if (objectsAtZIndex) {
                const sameZIndexA = objectsAtZIndex?.indexOf(a)
                const sameZIndexB = objectsAtZIndex?.indexOf(b)

                if (sameZIndexA != -1 || sameZIndexB != -1) {
                    return sameZIndexA - sameZIndexB
                }
            }

            const renderingOrderA = this.displayObjectsInDefinitionOrder.indexOf(objectA)
            const renderingOrderB = this.displayObjectsInDefinitionOrder.indexOf(objectB)

            return renderingOrderA - renderingOrderB
        })
    }

    invalidate(rect: Rectangle) {
        this.dirtyRects.push(rect.clone())
    }

    flushDirty() {
        if (this.dirtyRects.length === 0) {
            return
        }

        for (const object of this.displayObjectsInDefinitionOrder) {
            const sprite = object.getRenderObject()
            if (!sprite?.visible) {
                continue
            }

            const bounds = sprite.getBounds()
            if (this.dirtyRects.some((r) => r.intersects(bounds))) {
                object.repaint?.()
            }
        }
        this.dirtyRects = []
    }

    redrawAll() {
        for (const object of this.displayObjectsInDefinitionOrder) {
            const sprite = object.getRenderObject()
            if (!sprite?.visible) {
                continue
            }

            object.repaint?.()
        }
    }
}

export class AdvancedSprite extends Sprite {
    public hitmap?: Uint8Array
    public checkPixelPerfect = false

    getAlphaAt(point: IPointData) {
        assert(this.hitmap !== undefined)

        const tempPoint = { x: 0, y: 0 }
        this.worldTransform.applyInverse(point, tempPoint)

        const width = this._texture.orig.width
        const height = this._texture.orig.height
        const x = Math.trunc(tempPoint.x + width * this.anchor.x)
        const y = Math.trunc(tempPoint.y + height * this.anchor.y)

        if (x < 0 || x > width || y < 0 || y > height) {
            return 0 // unsure
        }

        const pixelOffset = y * width + x
        if (pixelOffset > this.hitmap.length - 1) {
            return 0 // unsure
        }

        return this.hitmap[pixelOffset]
    }

    containsPoint(point: IPointData, checkAlpha = false) {
        if (checkAlpha || (this.checkPixelPerfect && this.hitmap)) {
            return this.containsPointWithAlpha(point)
        }
        return super.containsPoint(point)
    }

    containsPointWithAlpha(point: IPointData) {
        const alpha = this.getAlphaAt(point)
        return alpha !== null && alpha > 0
    }
}

export const createHitmapFromImageBytes = (bytes: Uint8Array) => {
    const hitmap = new Uint8Array(bytes.byteLength / 4)
    for (let i = 0; i < hitmap.byteLength; i++) {
        hitmap[i] = bytes[i * 4 + 3]
    }
    return hitmap
}

// The colour of an RGBA pixel as the original's 16-bit RGB565 value, signed, or 0 outside the image
export const pixelAsRgb565 = (pixels: Uint8Array, width: number, height: number, x: number, y: number) => {
    x = Math.trunc(x)
    y = Math.trunc(y)
    if (x < 0 || y < 0 || x >= width || y >= height) {
        return 0
    }
    const i = (y * width + x) * 4
    const rgb565 = ((pixels[i] >> 3) << 11) | ((pixels[i + 1] >> 2) << 5) | (pixels[i + 2] >> 3)
    return rgb565 >= 0x8000 ? rgb565 - 0x10000 : rgb565
}

// Lowers the alpha of RGBA pixels to a mask's alpha where the mask, placed at (x, y), covers them
export const mergeAlpha = (
    pixels: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
    mask: Uint8Array,
    maskWidth: number,
    maskHeight: number
) => {
    for (let my = 0; my < maskHeight; my++) {
        const py = y + my
        if (py < 0 || py >= height) {
            continue
        }
        for (let mx = 0; mx < maskWidth; mx++) {
            const px = x + mx
            if (px < 0 || px >= width) {
                continue
            }
            const alphaIndex = (py * width + px) * 4 + 3
            pixels[alphaIndex] = Math.min(pixels[alphaIndex], mask[my * maskWidth + mx])
        }
    }
}

export const drawRectangle = (
    graphics: Graphics,
    dimensions: Rectangle,
    color: number,
    alpha?: number,
    borderWidth?: number,
    borderColor?: number
) => {
    graphics.beginFill(color, alpha)
    if (borderWidth !== undefined && borderWidth > 0) {
        graphics.lineStyle(borderWidth, borderColor ?? 0xffa500)
    }
    graphics.drawRect(dimensions.x, dimensions.y, dimensions.width, dimensions.height)
}

export const createColorTexture = (app: Application, dimensions: Rectangle, color: number, alpha?: number) => {
    const graphics = new Graphics()
    drawRectangle(graphics, dimensions, color, alpha)
    return app.renderer.generateTexture(graphics)
}
