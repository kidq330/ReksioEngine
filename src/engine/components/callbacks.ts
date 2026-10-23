import { callback, callbacks, FieldTypeEntry } from '../../fileFormats/common'
import { Engine } from '../index'
import { Type } from '../types'
import { assert, InterruptScriptExecution } from '../../common/errors'
import { structureDefinitions } from '../../fileFormats/cnv/types'
import { captureStackTrace, popStackFrame, pushStackFrame, StackFrame } from '../../interpreter/stacktrace'

export class CallbacksComponent {
    private readonly engine: Engine
    private readonly object: Type<any>

    private registry: Map<string, callbacks<any>> = new Map<string, callbacks<any>>()

    constructor(engine: Engine, object: Type<any>) {
        this.engine = engine
        this.object = object
    }

    private registerGroup(type: string, callbacks: callbacks<any>) {
        this.registry.set(type, callbacks)
    }

    private register(type: string, callback: callback) {
        this.registry.set(type, {
            nonParametrized: callback,
            parametrized: new Map<any, callback>(),
        })
    }

    autoRegister() {
        const structure = structureDefinitions[this.object.definition.TYPE]
        if (structure === undefined) {
            return
        }

        for (const [key, value] of Object.entries(structure)) {
            const fieldDefinition = value as FieldTypeEntry

            const callback = this.object.definition[key]
            if (callback === undefined) {
                continue
            }

            if (fieldDefinition.name === 'callback') {
                this.register(key, callback)
            } else if (fieldDefinition.name === 'callbacks') {
                this.registerGroup(key, callback)
            }
        }
    }

    has(type: string): boolean {
        if (!this.registry.has(type)) {
            return false
        }
        const callbacks = this.registry.get(type)
        assert(callbacks !== undefined)

        return callbacks.nonParametrized !== null || callbacks.parametrized.size > 0
    }

    hasParametrized(type: string, param: any): boolean {
        return this.registry.get(type)?.parametrized.has(param) ?? false
    }

    async run(type: string, param?: any, thisOverride?: Type<any> | null, args?: any[]) {
        if (!this.has(type)) {
            return
        }

        try {
            const stackFrame = StackFrame.builder()
                .type('callback')
                .object(this.object)
                .callback(type)
                .args(...(param !== undefined && param !== null ? [param] : []))
                .build()
            pushStackFrame(stackFrame)

            const thisReference = thisOverride !== undefined ? thisOverride : this.object

            const callbackGroup = this.registry.get(type)
            assert(callbackGroup !== undefined)

            if (param !== null && param !== undefined && callbackGroup.parametrized.has(param)) {
                const callback = callbackGroup.parametrized.get(param)
                assert(callback !== undefined, 'Callbacks should not happen to be undefined values')
                await this.engine.scripting.executeCallback(thisReference, thisReference, callback, args)
            } else if (callbackGroup.nonParametrized) {
                await this.engine.scripting.executeCallback(
                    thisReference,
                    thisReference,
                    callbackGroup.nonParametrized,
                    args
                )
            }
        } catch (err) {
            if (!(err instanceof InterruptScriptExecution)) {
                captureStackTrace(err)
                throw err
            }
        } finally {
            popStackFrame()
        }
    }

    // "ONFINISHED$WALK" or, in Kapitan Nemo, "ONBRUTALCHANGED^5" (the CNV field syntax)
    private parseCallbackString(callbackString: string): [string, any] {
        const separator = callbackString.search(/[$^]/)
        if (separator === -1) {
            return [callbackString, undefined]
        }

        const callbackName = callbackString.substring(0, separator)
        const param = callbackString.substring(separator + 1)
        // Convert the parameter like the CNV loader does, so ONBRUTALCHANGED^5 of an INTEGER matches the value 5
        const field = structureDefinitions[this.object.definition.TYPE]?.[callbackName] as FieldTypeEntry | undefined
        const subType = (field as any)?.subType as FieldTypeEntry | undefined
        return [callbackName, subType ? subType.processor(this.object.definition, callbackName, param, param) : param]
    }

    addBehaviour(callbackString: string, behaviourName: string) {
        const [callbackName, callbackParam] = this.parseCallbackString(callbackString)

        const newEntry = this.registry.get(callbackName) ?? {
            nonParametrized: null,
            parametrized: new Map(),
        }

        const newCallback = {
            isSingleStatement: false,
            behaviourReference: behaviourName,
            constantArguments: [],
        }

        if (callbackParam === undefined) {
            newEntry.nonParametrized = newCallback
        } else {
            newEntry.parametrized.set(callbackParam, newCallback)
        }

        this.registry.set(callbackName, newEntry)
    }

    removeBehaviour(callbackString: string) {
        const [callbackName, callbackParam] = this.parseCallbackString(callbackString)
        const entry = this.registry.get(callbackName)
        if (entry === undefined) {
            return
        }

        if (callbackParam === undefined) {
            entry.nonParametrized = null
        } else {
            entry.parametrized.delete(callbackParam)
        }
    }
}
