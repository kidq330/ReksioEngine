import { structureDefinitions } from '../../../src/fileFormats/cnv/types'
import { MethodInfo, Vocabulary } from './types'

export * from './types'

export type PropertyKind =
    | 'string'
    | 'number'
    | 'boolean'
    | 'callback'
    | 'callbacks'
    | 'code'
    | 'reference'
    | 'array'
    | 'map'
    | 'rect'
    | string

export interface PropertyInfo {
    // Name as in the schema, possibly a pattern like DEF_%s_%s_%d
    name: string
    kind: PropertyKind
    // Kind of the elements (array) or of the ^PARAM key (callbacks)
    subKind?: PropertyKind
    optional: boolean
    pattern?: RegExp
}

export const isCallbackKind = (kind: PropertyKind) => kind === 'callback' || kind === 'callbacks'

export const describePropertyKind = (property: PropertyInfo) => {
    const kind = property.subKind ? `${property.kind}<${property.subKind}>` : property.kind
    return property.optional ? `${kind} (optional)` : kind
}

export const formatMethodSignature = (type: string, method: MethodInfo) => {
    const params = method.params
        .map((param) => {
            const types = param.types.length > 0 ? `: ${param.types.join(' | ')}` : ''
            return `${param.rest ? '...' : ''}${param.name}${param.optional ? '?' : ''}${types}`
        })
        .join(', ')
    const returns = method.returns ? `: ${method.returns}` : ''
    return `${type}^${method.name}(${params})${returns}`
}

const readProperties = (definition: Record<string, any>): PropertyInfo[] =>
    Object.entries(definition).map(([name, entry]) => {
        const info: PropertyInfo = {
            name,
            kind: entry.name,
            subKind: entry.subType?.name,
            optional: entry.flags?.optional === true,
        }
        if (name.includes('%')) {
            // Same patterns as the CNV parser: %s = letters, %d = digits
            info.pattern = new RegExp(`^${name.replaceAll('%s', '[a-zA-Z]+').replaceAll('%d', '[0-9]+')}$`)
        }
        return info
    })

/**
 * Lookups over the extracted vocabulary and the CNV property schemas (`structureDefinitions`, which the server
 * bundles directly from the engine sources).
 */
export class ScriptVocabulary {
    readonly data: Vocabulary
    private readonly methodCache = new Map<string, Map<string, MethodInfo>>()
    private readonly propertyCache = new Map<string, PropertyInfo[]>()

    constructor(data: Vocabulary) {
        this.data = data
    }

    // Types the CNV loader accepts
    get typeNames(): string[] {
        return Object.keys(structureDefinitions).sort()
    }

    isKnownType(type: string): boolean {
        return Object.prototype.hasOwnProperty.call(structureDefinitions, type)
    }

    hasClass(type: string): boolean {
        return this.data.types[type] !== undefined
    }

    className(type: string): string | undefined {
        return this.data.types[type]
    }

    // Methods of a TYPE including the inherited ones, or null for a type without an engine class
    methods(type: string): Map<string, MethodInfo> | null {
        const className = this.data.types[type]
        if (className === undefined) {
            return null
        }
        return this.classMethods(className)
    }

    classMethods(className: string): Map<string, MethodInfo> {
        const cached = this.methodCache.get(className)
        if (cached) {
            return cached
        }
        const chain = []
        for (let info = this.data.classes[className]; info !== undefined; ) {
            chain.unshift(info)
            info = info.extends !== undefined ? this.data.classes[info.extends] : (undefined as any)
        }
        const result = new Map<string, MethodInfo>()
        for (const info of chain) {
            for (const method of info.methods) {
                result.set(method.name, method)
            }
        }
        this.methodCache.set(className, result)
        return result
    }

    method(type: string, name: string): MethodInfo | undefined {
        return this.methods(type)?.get(name)
    }

    // GROUP and CLASS instances pass calls they don't know on
    forwardsUnknownCalls(type: string): boolean {
        const className = this.data.types[type]
        for (let info = className ? this.data.classes[className] : undefined; info !== undefined; ) {
            if (info.forwardsUnknownCalls) {
                return true
            }
            info = info.extends !== undefined ? this.data.classes[info.extends] : undefined
        }
        return false
    }

    properties(type: string): PropertyInfo[] {
        const cached = this.propertyCache.get(type)
        if (cached) {
            return cached
        }
        const definition = structureDefinitions[type]
        const result = definition !== undefined ? readProperties(definition) : []
        this.propertyCache.set(type, result)
        return result
    }

    property(type: string, name: string): PropertyInfo | undefined {
        const properties = this.properties(type)
        return (
            properties.find((property) => !property.pattern && property.name === name) ??
            properties.find((property) => property.pattern?.test(name))
        )
    }

    global(name: string) {
        return this.data.globals.find((global) => global.name === name)
    }

    builtinType(name: string): string | undefined {
        return this.data.builtins[name]
    }
}
