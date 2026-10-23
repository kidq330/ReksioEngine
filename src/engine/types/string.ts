import { ParentType, ValueType } from './index'
import { Engine } from '../index'
import { StringDefinition } from '../../fileFormats/cnv/types'
import { method, int } from '../../common/types'
import { logger } from '../logging'

export class String extends ValueType<StringDefinition, string> {
    constructor(engine: Engine, parent: ParentType<any> | null, definition: StringDefinition) {
        super(engine, parent, definition, '')
    }

    async ready() {
        await this.callbacks.run('ONINIT')
    }

    @method()
    async ADD(text: string) {
        await this.setValue(this.value + text)
    }

    // A debugging message box with the value in the original, logged instead
    @method()
    MSGBOX() {
        logger.warn(`${this.name}^MSGBOX: ${this.value}`)
    }

    @method()
    async SET(text: string) {
        await this.setValue(text)
    }

    @method()
    async SUB(start: int, length: int) {
        await this.setValue(this.value.substring(0, start) + this.value.substring(start + length))
    }

    // Keeps only the given part, e.g. VARSTRING0^CUT(0,VARSTRING0^FIND("_")) (Wehikuł Czasu).
    // A non-positive length keeps the rest of the string, a guess.
    @method()
    async CUT(start: int, length: int = 0) {
        const end = length > 0 ? start + length : undefined
        await this.setValue(this.value.substring(start, end))
    }

    // Overwrites the characters from index on, e.g. one digit of a puzzle state: S^REPLACEAT(ITMPEP5SN,ITMPEP5UP)
    @method()
    async REPLACEAT(index: int, text: string) {
        await this.setValue(this.value.substring(0, index) + text + this.value.substring(index + text.length))
    }

    @method()
    async UPPER() {
        await this.setValue(this.value.toUpperCase())
    }

    @method()
    GET(index?: int, length: int = 1): string {
        if (index === undefined) {
            return this.value
        }
        return this.value.substring(index, index + length)
    }

    @method()
    FIND(needle: string, start?: int): int {
        return this.value.indexOf(needle, start)
    }

    @method()
    LENGTH(): int {
        return this.value.length
    }

    getValue(): string {
        return this.value
    }

    protected async valueChanged(oldValue: any, newValue: any) {
        if (oldValue !== newValue) {
            await this.callbacks.run('ONCHANGED', newValue)
        }
        await this.callbacks.run('ONBRUTALCHANGED', newValue)
    }

    async equals(other: ValueType<any, any>) {
        const otherString = await other.toString()
        return this.getValue().toLowerCase() === otherString.toLowerCase()
    }

    async compare(other: ValueType<any, any>) {
        const a = this.getValue()
        const b = await other.toString()
        return a < b ? -1 : a > b ? 1 : 0
    }

    public async toString(): Promise<string> {
        return this.getValue()
    }
}
