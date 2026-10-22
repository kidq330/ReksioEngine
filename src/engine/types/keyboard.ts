import { ParentType, Type } from './index'
import { KeyboardDefinition, MusicDefinition } from '../../fileFormats/cnv/types'
import { Engine } from '../index'
import { method } from '../../common/types'
import { logger } from '../logging'

const keysMapping = {
    ArrowLeft: 'LEFT',
    ArrowRight: 'RIGHT',
    ArrowUp: 'UP',
    ArrowDown: 'DOWN',
    Space: 'SPACE',
    Digit1: '1',
    Digit2: '2',
} as any

type KeyEvent = { event: 'ONKEYDOWN' | 'ONKEYUP' | 'ONCHAR'; name: string }

export class Keyboard extends Type<KeyboardDefinition> {
    private keysState = new Map<string, boolean>()
    private changeQueue: KeyEvent[] = []
    private enabled: boolean = true
    private autoRepeat: boolean = false
    private latestCharacter: string | null = null

    private readonly onKeyDownCallback: (event: KeyboardEvent) => void
    private readonly onKeyUpCallback: (event: KeyboardEvent) => void

    constructor(engine: Engine, parent: ParentType<any> | null, definition: MusicDefinition) {
        super(engine, parent, definition)
        this.onKeyDownCallback = this.onKeyDown.bind(this)
        this.onKeyUpCallback = this.onKeyUp.bind(this)
    }

    async ready() {
        window.addEventListener('keydown', this.onKeyDownCallback)
        window.addEventListener('keyup', this.onKeyUpCallback)
    }

    destroy() {
        window.removeEventListener('keydown', this.onKeyDownCallback)
        window.removeEventListener('keyup', this.onKeyUpCallback)
    }

    async tick() {
        const changes = this.changeQueue
        this.changeQueue = []
        for (const change of changes) {
            if (change.event === 'ONCHAR') {
                this.latestCharacter = change.name
            }
            await this.callbacks.run(change.event, change.name)
        }
    }

    @method()
    ENABLE() {
        this.enabled = true
    }

    @method()
    DISABLE() {
        this.enabled = false
    }

    // The last typed character (Czarodzieje builds cheat codes from it in ONCHAR)
    @method()
    GETLATESTKEY(): string | null {
        return this.latestCharacter
    }

    @method()
    ISKEYDOWN(keyName: string): boolean {
        return this.keysState.get(keyName) ?? false
    }

    @method()
    ISENABLED(): boolean {
        return this.enabled
    }

    @method()
    SETAUTOREPEAT(state: boolean) {
        this.autoRepeat = state
    }

    private onKeyDown(event: KeyboardEvent) {
        if (!this.autoRepeat && this.keysState.get(keysMapping[event.code])) {
            return
        }

        if (this.enabled) {
            this.setKeyState(event.code, true)
            // ONCHAR's parameter is the typed character, case-sensitive (ONCHAR^1, ONCHAR^s, ONCHAR^P)
            if (event.key.length === 1) {
                this.changeQueue.push({ event: 'ONCHAR', name: event.key })
            }
        }
    }

    private onKeyUp(event: KeyboardEvent) {
        if (this.enabled) {
            this.setKeyState(event.code, false)
        }
    }

    private setKeyState(keyCode: string, value: boolean) {
        const mapped = keysMapping[keyCode]
        if (mapped === undefined) {
            // Letters still reach scripts through ONCHAR
            logger.debug(`Unsupported keyboard key code ${keyCode}`, {
                supportedKeys: Object.keys(keysMapping),
            })
            return
        }
        this.keysState.set(mapped, value)
        this.changeQueue.push({ event: value ? 'ONKEYDOWN' : 'ONKEYUP', name: mapped })
    }
}
