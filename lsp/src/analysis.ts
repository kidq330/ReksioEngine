// Scope-independent analysis of one CNV/DEF/CLASS document: which properties hold code, what the code references,
// and the problems that can be found without looking at other files.
import { CnvDocument, CnvObject, CnvProperty } from './cnv/document'
import { Span } from './cnv/text'
import { AnalysisOptions, Occurrence, Problem, analyzeCallbackValue, analyzeCode } from './code/analyze'
import { PropertyInfo, ScriptVocabulary, isCallbackKind } from './vocabulary'

export interface Block {
    object: CnvObject
    property: CnvProperty
    // The TYPE whose object THIS is bound to while the code runs, when known statically: event callbacks bind THIS
    // to the object raising the event; behaviours, conditions and expressions don't (or bind it to themselves)
    thisType?: string
}

export type DocumentOccurrence = Occurrence & { block?: Block }

export interface FieldDeclaration {
    name: string
    type: string
    struct: CnvObject
}

export interface DocumentAnalysis {
    document: CnvDocument
    occurrences: DocumentOccurrence[]
    problems: Problem[]
    // @INT("NAME",…) and friends
    locals: Map<string, { type: string; span: Span }>
    // STRUCT fields are registered under their bare names next to the STRUCT
    fields: Map<string, FieldDeclaration>
}

// FIELDS=NAME<STRING>,X<INTEGER>
export const parseStructFields = (value: string): { name: string; type: string }[] =>
    value
        .split(',')
        .map((part) => /^\s*([^<\s]+)\s*<\s*([A-Z_]+)\s*>\s*$/.exec(part))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({ name: match[1], type: match[2] }))

const callbackThisType = (object: CnvObject, property: PropertyInfo): string | undefined => {
    if (!isCallbackKind(property.kind) || object.type === 'BEHAVIOUR') {
        return undefined
    }
    return object.type
}

export const analyzeDocument = (document: CnvDocument, vocabulary: ScriptVocabulary): DocumentAnalysis => {
    const options: AnalysisOptions = {
        globals: new Map(vocabulary.data.globals.map((global) => [global.name, global.declares])),
    }
    const result: DocumentAnalysis = {
        document,
        occurrences: [],
        problems: [],
        locals: new Map(),
        fields: new Map(),
    }

    const problem = (span: Span, severity: Problem['severity'], code: string, message: string) =>
        result.problems.push({ span, severity, code, message })

    for (const property of document.strayProperties) {
        switch (property.status) {
            case 'undeclared-object':
                problem(
                    property.objectSpan,
                    'warning',
                    'property-of-undeclared-object',
                    `No OBJECT=${property.objectName} before this line, the engine ignores it`
                )
                break
            case 'malformed':
                problem(property.objectSpan, 'warning', 'malformed-line', `Neither an OBJECT line nor a property`)
                break
        }
    }

    for (const object of document.objects.values()) {
        const type = object.type
        const knownType = type !== undefined && vocabulary.isKnownType(type)

        if (type === undefined) {
            problem(
                object.nameSpan,
                'error',
                'missing-type',
                `${object.name} has no TYPE. ReksioEngine fails to load the file`
            )
        } else if (!knownType) {
            problem(
                object.typeSpan!,
                'error',
                'unknown-type',
                `Unknown TYPE "${type}". ReksioEngine fails to load the file`
            )
        }

        for (const property of object.properties) {
            if (property.name === 'TYPE') {
                continue
            }
            if (property.status === 'before-type') {
                problem(
                    property.nameSpan,
                    'error',
                    'property-before-type',
                    `${property.name} is set before ${object.name}:TYPE. ReksioEngine fails to load the file`
                )
                continue
            }
            if (!knownType) {
                continue
            }

            const info = vocabulary.property(type!, property.name)
            if (!/^[A-Za-z0-9_]+$/.test(property.name)) {
                // e.g. Czarodzieje's SNDFIRE:={@IF(…)}: `:=` leaves the code as the property name
                problem(
                    property.nameSpan,
                    'warning',
                    'malformed-property',
                    `"${property.name}" is not a property name, the engine ignores this line`
                )
                continue
            }
            if (info === undefined) {
                const what = property.name.startsWith('ON') ? 'event' : 'property'
                const effect = what === 'event' ? 'it never runs' : 'its value is kept as text'
                problem(
                    property.nameSpan,
                    'warning',
                    'unknown-property',
                    `${type} has no ${what} ${property.name} in ReksioEngine, ${effect}`
                )
                continue
            }

            checkValue(result, property, info)

            if (isCallbackKind(info.kind)) {
                const analysis = analyzeCallbackValue(property.value, options)
                const block: Block = { object, property, thisType: callbackThisType(object, info) }
                result.occurrences.push(...analysis.occurrences.map((occurrence) => ({ ...occurrence, block })))
                result.problems.push(...analysis.problems)
            } else if (info.kind === 'code') {
                const analysis = analyzeCode(property.value, options)
                const block: Block = { object, property, thisType: type === 'EXPRESSION' ? type : undefined }
                result.occurrences.push(...analysis.occurrences.map((occurrence) => ({ ...occurrence, block })))
                result.problems.push(...analysis.problems)
            } else if (info.kind === 'reference' || (info.kind === 'rect' && !property.value.text.includes(','))) {
                if (property.value.text) {
                    result.occurrences.push({
                        kind: 'object',
                        name: property.value.text,
                        span: property.valueSpan,
                        role: 'reference',
                    })
                }
            }

            if (type === 'STRUCT' && property.name === 'FIELDS') {
                for (const field of parseStructFields(property.value.text)) {
                    result.fields.set(field.name, { ...field, struct: object })
                }
            }
        }
    }

    for (const occurrence of result.occurrences) {
        if (occurrence.kind === 'local' && !result.locals.has(occurrence.name)) {
            result.locals.set(occurrence.name, { type: occurrence.type, span: occurrence.span })
        }
    }
    return result
}

const checkValue = (result: DocumentAnalysis, property: CnvProperty, info: PropertyInfo) => {
    const value = property.value.text
    const problem = (message: string) =>
        result.problems.push({ span: property.valueSpan, severity: 'warning', code: 'invalid-value', message })

    switch (info.kind) {
        case 'boolean':
            if (!['TRUE', 'FALSE', '0', '1'].includes(value)) {
                problem(`${property.name} expects TRUE, FALSE, 0 or 1; the engine reads "${value}" as FALSE`)
            }
            break
        case 'number': {
            const number = Number(value.startsWith('"') ? value.slice(1, -1) : value)
            if (isNaN(number)) {
                problem(`${property.name} expects a number; the engine reads "${value}" as 0`)
            }
            break
        }
    }
}
