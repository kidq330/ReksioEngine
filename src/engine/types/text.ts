import { Type } from './index'
import { TextDefinition } from '../../fileFormats/cnv/types'
import * as PIXI from 'pixi.js'
import { method, int } from '../../common/types'
import { BitmapText } from 'pixi.js'
import { Font } from './font'

export class Text extends Type<TextDefinition> {
    private text: PIXI.BitmapText | null = null

    async applyDefaults() {
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
        this.text.visible = this.definition.VISIBLE
        this.engine.rendering.addToStage(this.text, this)
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
    SETTEXT(content: string) {
        if (this.text) {
            this.text.text = content
        }
    }
}
