// The script vocabulary of the engine: which methods each TYPE has, which @globals exist and which objects are
// built in. It is extracted from the engine sources at build time (see extract.ts), so it follows the engine.

export interface MethodParam {
    name: string
    types: string[]
    optional: boolean
    rest: boolean
}

export interface MethodInfo {
    name: string
    params: MethodParam[]
    // Return type as declared (Promise<> unwrapped), e.g. `int` or `string | null`
    returns?: string
    // Methods without @method() are still callable, but get no argument conversion
    decorated: boolean
    doc?: string
    // Class that declares it
    owner: string
    // Path relative to the repository root and 1-based line
    file: string
    line: number
}

export interface ClassInfo {
    name: string
    file: string
    line: number
    extends?: string
    methods: MethodInfo[]
    // The class overrides __call, so calls of methods it lacks are forwarded instead of failing (GROUP, CLASS
    // instances)
    forwardsUnknownCalls: boolean
    // Key or button names the type passes as the ^PARAM of its events (the `keysMapping` of KEYBOARD and MOUSE)
    eventKeys?: string[]
}

export interface GlobalInfo {
    name: string
    // For @INT/@STRING/@BOOL/@DOUBLE: the TYPE of the declared local variable
    declares?: string
}

export interface Vocabulary {
    classes: Record<string, ClassInfo>
    // TYPE -> class name, as in createTypeInstance
    types: Record<string, string>
    globals: GlobalInfo[]
    // Built-in object name -> TYPE (RANDOM, SYSTEM, CNVLOADER)
    builtins: Record<string, string>
}
