import { Type } from './index'
import { TextDefinition } from '../../fileFormats/cnv/types'
import * as PIXI from 'pixi.js'
import { method, int } from '../../common/types'
import { BitmapText } from 'pixi.js'
import { Font } from './font'

export class Text extends Type<TextDefinition> {
    private text: PIXI.BitmapText | null = null
    // Drawing order like a DisplayType's: Czarodzieje and Wehikuł Czasu put their texts at 500-50000 over the
    // graphics, and Skarb Piratów raises them with SETPRIORITY
    private priority = 0

    async applyDefaults() {
        this.priority = this.definition.PRIORITY ?? 0
        const font = this.getObject<Font>(this.definition.FONT)
        if (font === null || font.bitmapFont === null) {
            return
        }

        this.text = new BitmapText(this.definition.TEXT ?? '', {
            fontName: font.bitmapFont.font,
        })

        const [x1, y1, x2, y2] = this.definition.RECT
        this.text.x = x1
        this.text.y = y1
        this.text.anchor.set(0.5, 0)
        if (this.definition.HJUSTIFY !== undefined) {
            this.justify(x1, y1, x2, y2, this.definition.HJUSTIFY, this.definition.VJUSTIFY ?? '')
        }
        this.text.visible = this.definition.VISIBLE
        this.engine.rendering.addToStage(this.text, this)
        this.SETPRIORITY(this.priority)
    }

    async ready() {
        await this.callbacks.run('ONINIT')
    }

    destroy() {
        if (this.text) {
            this.engine.rendering.removeFromStage(this.text)
        }
    }

    @method()
    GETPRIORITY(): int {
        return this.priority
    }

    @method()
    SETPRIORITY(priority: int) {
        this.priority = priority
        if (this.text) {
            this.text.zIndex = priority
            this.engine.rendering.putAtZindex(this.text, priority)
            this.engine.rendering.sortObjects()
        }
    }

    @method()
    SETCOLOR(r: int, g: int, b: int) {
        if (this.text) {
            this.text.tint = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
        }
    }

    @method()
    SETPOSITION(x: int, y: int) {
        if (this.text) {
            this.text.x = x
            this.text.y = y
        }
    }

    @method()
    SHOW() {
        if (this.text) {
            this.text.visible = true
        }
    }

    @method()
    HIDE() {
        if (this.text) {
            this.text.visible = false
        }
    }

    // Aligns the text within the rectangle, e.g. TXTMSG^SETJUSTIFY(0,0,800,600,"LEFT","BOTTOM") (Kapitan Nemo's log)
    @method()
    SETJUSTIFY(x1: int, y1: int, x2: int, y2: int, horizontal: string, vertical: string) {
        this.justify(x1, y1, x2, y2, horizontal, vertical)
    }

    private justify(x1: number, y1: number, x2: number, y2: number, horizontal: string, vertical: string) {
        if (!this.text) {
            return
        }
        const [x, anchorX] = horizontal === 'LEFT' ? [x1, 0] : horizontal === 'RIGHT' ? [x2, 1] : [(x1 + x2) / 2, 0.5]
        const [y, anchorY] = vertical === 'BOTTOM' ? [y2, 1] : vertical === 'CENTER' ? [(y1 + y2) / 2, 0.5] : [y1, 0]
        this.text.anchor.set(anchorX, anchorY)
        this.text.position.set(x, y)
    }

    @method()
    SETTEXT(content: string) {
        if (this.text) {
            this.text.text = content
        }
    }
}
