import { Type } from './index'
import { MouseDefinition } from '../../fileFormats/cnv/types'
import { FederatedPointerEvent, Point } from 'pixi.js'
import { method, int } from '../../common/types'

type MouseEvent = {
    type: string
    key: string
}

const keysMapping = new Map([
    [0, 'LEFT'],
    [1, 'MIDDLE'],
    [2, 'RIGHT'],
])

export class Mouse extends Type<MouseDefinition> {
    private mouseMoveListener: any
    private mouseClickListener: any
    private mouseReleaseListener: any
    private buttonsListener: any
    // Pressed buttons as in PointerEvent.buttons, bit 0 is the left one
    private buttons = 0

    private clicksQueue: MouseEvent[] = []
    private lastClicksTime: Record<string, number> = {}

    private mousePosition: Point = new Point(0, 0)
    private moved = false
    private signalsDisabled: boolean = false

    async ready() {
        this.registerCallbacks()
        await this.callbacks.run('ONINIT')
    }

    destroy() {
        this.unregisterCallbacks()
    }

    async tick(elapsedMS: number) {
        while (this.clicksQueue.length > 0) {
            const event = this.clicksQueue.shift()!

            if (this.signalsDisabled) {
                continue
            }

            switch (event.type) {
                case 'click':
                    await this.callbacks.run('ONCLICK', event.key)
                    break
                case 'dblclick':
                    await this.callbacks.run('ONDBLCLICK', event.key)
                    break
                case 'release':
                    await this.callbacks.run('ONRELEASE', event.key)
                    break
            }
        }

        if (this.moved && !this.signalsDisabled) {
            await this.callbacks.run('ONMOVE')
            this.moved = false
        }
    }

    @method()
    // ACTIVE or ARROW
    SET(cursorType: string) {
        this.engine.rendering.setCursor(cursorType.toUpperCase() === 'ACTIVE' ? 'pointer' : 'auto')
    }

    @method()
    ENABLE() {
        this.registerCallbacks()
        this.engine.app.stage.eventMode = 'static'
    }

    private registerCallbacks() {
        // ENABLE may be called on an already enabled mouse, don't register listeners twice
        this.unregisterCallbacks()

        this.mouseMoveListener = this.onMouseMove.bind(this)
        this.mouseClickListener = this.onMouseClick.bind(this)
        this.mouseReleaseListener = this.onMouseRelease.bind(this)
        this.buttonsListener = (event: FederatedPointerEvent) => (this.buttons = event.buttons)

        this.engine.app.stage.addListener('pointermove', this.mouseMoveListener)
        this.engine.app.stage.addListener('pointerdown', this.buttonsListener)
        this.engine.app.stage.addListener('pointerup', this.buttonsListener)
        this.engine.app.stage.addListener('pointerupoutside', this.buttonsListener)
        if (this.callbacks.has('ONCLICK') || this.callbacks.has('ONDBLCLICK')) {
            this.engine.app.stage.addListener('pointerdown', this.mouseClickListener)
        }
        if (this.callbacks.has('ONRELEASE')) {
            this.engine.app.stage.addListener('pointerup', this.mouseReleaseListener)
        }
    }

    @method()
    DISABLE() {
        this.unregisterCallbacks()
        this.engine.app.stage.eventMode = 'none'
    }

    @method()
    DISABLESIGNAL() {
        this.signalsDisabled = true
    }

    @method()
    ENABLESIGNAL() {
        this.signalsDisabled = false
    }

    private unregisterCallbacks() {
        // removeListener without a listener would remove all listeners of that event
        if (this.mouseMoveListener === undefined) {
            return
        }

        this.engine.app.stage.removeListener('pointermove', this.mouseMoveListener)
        this.engine.app.stage.removeListener('pointerdown', this.mouseClickListener)
        this.engine.app.stage.removeListener('pointerup', this.mouseReleaseListener)
        this.engine.app.stage.removeListener('pointerdown', this.buttonsListener)
        this.engine.app.stage.removeListener('pointerup', this.buttonsListener)
        this.engine.app.stage.removeListener('pointerupoutside', this.buttonsListener)
        this.mouseMoveListener = undefined
        this.mouseClickListener = undefined
        this.mouseReleaseListener = undefined
        this.buttonsListener = undefined
    }

    @method()
    SHOW() {
        this.engine.rendering.setCursor('auto')
    }

    @method()
    HIDE() {
        this.engine.rendering.setCursor('none')
    }

    @method()
    ISLBUTTONDOWN(): boolean {
        return (this.buttons & 1) !== 0
    }

    @method()
    GETPOSX(): int {
        return this.mousePosition.x
    }

    @method()
    GETPOSY(): int {
        return this.mousePosition.y
    }

    @method()
    SETPOSITION(x: int, y: int) {
        // Browsers can't move the system cursor, so only the position reported to scripts changes
        // until the next real mouse move
        this.mousePosition = new Point(x, y)
    }

    private onMouseMove(event: FederatedPointerEvent) {
        this.moved = true
        this.buttons = event.buttons
        this.mousePosition = this.getMousePosition(event)
    }

    private onMouseClick(event: FederatedPointerEvent) {
        this.handleClickEvent(event, 'click')
    }

    private onMouseRelease(event: FederatedPointerEvent) {
        this.handleClickEvent(event, 'release')
    }

    private handleClickEvent(event: FederatedPointerEvent, type: string) {
        if (!keysMapping.has(event.button)) {
            return
        }

        const key = keysMapping.get(event.button)!
        const clickEvent = { type, key }

        this.clicksQueue.push(clickEvent)
        if (type === 'click') {
            const dateNow = this.engine.clock.now()
            const previousClick = this.lastClicksTime[key]
            if (previousClick && dateNow - previousClick < 200) {
                this.clicksQueue.push({
                    type: 'dblclick',
                    key,
                })
                delete this.lastClicksTime[key]
            } else {
                this.lastClicksTime[key] = dateNow
            }
        }

        this.onMouseMove(event)
    }

    private getMousePosition(event: FederatedPointerEvent) {
        return new Point(Math.floor(event.screen.x), Math.floor(event.screen.y))
    }
}
