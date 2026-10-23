// Language features over a Workspace. Independent of the LSP connection so tests can drive it directly.
import * as path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import {
    CompletionItem,
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity,
    DocumentSymbol,
    Hover,
    Location,
    MarkupKind,
    Position,
    Range,
    SymbolKind,
} from 'vscode-languageserver'
import { CnvObject, CnvProperty } from './cnv/document'
import { Span, contains } from './cnv/text'
import { MethodOccurrence, Problem, Severity } from './code/analyze'
import { Block, DocumentOccurrence } from './analysis'
import { Resolution, Workspace, WorkspaceFile } from './workspace'
import { MethodInfo, PropertyInfo, describePropertyKind, formatMethodSignature, isCallbackKind } from './vocabulary'
import { GLOBAL_DOCS } from './globals'
import { readAnnEventNames } from './ann'

export interface ServiceOptions {
    // Repository root, to link methods to their engine sources
    engineRoot?: string
    // Reads a file next to the scripts (ANN/SEQ files for event names); null when missing
    readFile?: (filePath: string) => Uint8Array | null
    // Report method calls on undeclared objects as hints
    undeclaredHints?: boolean
}

const SEVERITY: Record<Severity, DiagnosticSeverity> = {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    information: DiagnosticSeverity.Information,
    hint: DiagnosticSeverity.Hint,
}

const SOURCE = 'reksio'

const typeSymbolKind = (type?: string): SymbolKind => {
    switch (type) {
        case 'BEHAVIOUR':
            return SymbolKind.Function
        case 'INTEGER':
        case 'DOUBLE':
        case 'STRING':
        case 'BOOL':
        case 'EXPRESSION':
            return SymbolKind.Variable
        case 'ARRAY':
        case 'MULTIARRAY':
        case 'VECTOR':
            return SymbolKind.Array
        case 'STRUCT':
        case 'DATABASE':
            return SymbolKind.Struct
        case 'CLASS':
            return SymbolKind.Class
        case 'CONDITION':
        case 'COMPLEXCONDITION':
            return SymbolKind.Boolean
        case 'APPLICATION':
        case 'EPISODE':
        case 'SCENE':
            return SymbolKind.Namespace
        default:
            return SymbolKind.Object
    }
}

const resolutionKind = (resolution: Resolution): CompletionItemKind => {
    if (resolution.kind === 'local' || resolution.kind === 'loopCounter') {
        return CompletionItemKind.Variable
    }
    if (resolution.kind === 'classInstance') {
        return CompletionItemKind.Class
    }
    if (resolution.kind === 'field') {
        return CompletionItemKind.Field
    }
    switch ('type' in resolution ? resolution.type : undefined) {
        case 'BEHAVIOUR':
            return CompletionItemKind.Function
        case 'INTEGER':
        case 'DOUBLE':
        case 'STRING':
        case 'BOOL':
            return CompletionItemKind.Variable
        default:
            return CompletionItemKind.Module
    }
}

const typeOf = (resolution: Resolution) =>
    resolution.kind === 'classInstance' ? 'CLASS instance' : (resolution.type ?? 'unknown TYPE')

export class LanguageService {
    readonly workspace: Workspace
    readonly options: ServiceOptions

    constructor(workspace: Workspace, options: ServiceOptions = {}) {
        this.workspace = workspace
        this.options = { undeclaredHints: true, ...options }
    }

    get vocabulary() {
        return this.workspace.vocabulary
    }

    private range(file: WorkspaceFile, span: Span): Range {
        if (file.decrypted) {
            return Range.create(0, 0, 0, 0)
        }
        return file.document.lineIndex.rangeOf(span)
    }

    private location(file: WorkspaceFile, span: Span): Location {
        return Location.create(file.uri, this.range(file, span))
    }

    private relativeName(file: WorkspaceFile) {
        return path.basename(uriToPath(file.uri))
    }

    // ---------------- diagnostics ----------------

    problems(uri: string): Problem[] {
        const file = this.workspace.file(uri)
        if (!file || file.decrypted) {
            return []
        }
        if (file.document.encrypted) {
            return [
                {
                    span: { start: 0, end: 0 },
                    severity: 'information',
                    code: 'encrypted',
                    message: 'Encrypted file: decrypt it to get diagnostics',
                },
            ]
        }
        const analysis = this.workspace.analysis(file)
        const problems = [...analysis.problems]
        for (const occurrence of analysis.occurrences) {
            if (occurrence.kind === 'method') {
                problems.push(...this.checkCall(file, occurrence))
            } else if (occurrence.kind === 'object' && occurrence.role !== 'target' && occurrence.role !== 'value') {
                problems.push(...this.checkReference(file, occurrence))
            }
        }
        return problems
    }

    diagnostics(uri: string): Diagnostic[] {
        const file = this.workspace.file(uri)
        if (!file) {
            return []
        }
        return this.problems(uri).map((problem) => ({
            range: this.range(file, problem.span),
            severity: SEVERITY[problem.severity],
            code: problem.code,
            source: SOURCE,
            message: problem.message,
        }))
    }

    private checkReference(file: WorkspaceFile, occurrence: DocumentOccurrence & { kind: 'object' }): Problem[] {
        const resolution = this.workspace.resolve(occurrence.name, file)
        if (resolution === null) {
            if (!this.options.undeclaredHints) {
                return []
            }
            const what = occurrence.role === 'behaviour' ? 'behaviour' : 'object'
            return [
                {
                    span: occurrence.span,
                    severity: 'hint',
                    code: 'undeclared',
                    message: `No ${what} ${occurrence.name} is declared in the files this one sees`,
                },
            ]
        }
        if (
            occurrence.role === 'behaviour' &&
            resolution.kind === 'object' &&
            resolution.type !== undefined &&
            resolution.type !== 'BEHAVIOUR'
        ) {
            return [
                {
                    span: occurrence.span,
                    severity: 'warning',
                    code: 'not-a-behaviour',
                    message: `${occurrence.name} is not a BEHAVIOUR but ${resolution.type}`,
                },
            ]
        }
        return []
    }

    private checkCall(file: WorkspaceFile, call: DocumentOccurrence & { kind: 'method' }): Problem[] {
        const target = call.target
        if (target.kind === 'name') {
            const resolution = this.workspace.resolve(target.name, file)
            if (resolution === null) {
                return this.options.undeclaredHints
                    ? [
                          {
                              span: target.span,
                              severity: 'hint',
                              code: 'undeclared',
                              message: `No object ${target.name} is declared in the files this one sees; the call is skipped if it doesn't exist when it runs`,
                          },
                      ]
                    : []
            }
            if (resolution.kind === 'classInstance') {
                const behaviours = this.workspace.instanceBehaviours(resolution.instance)
                if (resolution.instance.classFile && !behaviours.some((object) => object.name === call.name)) {
                    return [
                        {
                            span: call.span,
                            severity: 'warning',
                            code: 'unknown-method',
                            message: `${this.relativeName(resolution.instance.classFile)} has no behaviour ${call.name}, the call does nothing`,
                        },
                    ]
                }
                return []
            }
        }

        const type = this.workspace.targetType(target, file, call.block?.thisType)
        if (type === undefined || !this.vocabulary.hasClass(type) || this.vocabulary.forwardsUnknownCalls(type)) {
            return []
        }
        const method = this.vocabulary.method(type, call.name)
        if (method === undefined) {
            const subject = target.kind === 'name' ? target.name : target.kind === 'this' ? 'THIS' : 'the target'
            return [
                {
                    span: call.span,
                    severity: 'warning',
                    code: 'unknown-method',
                    message: `${subject} (${type}) has no method ${call.name} in ReksioEngine`,
                },
            ]
        }
        if (!method.decorated) {
            return []
        }
        const typed = method.params.filter((param) => param.types.length > 0)
        const required = typed.filter((param) => !param.optional && !param.rest).length
        if (call.argCount < required) {
            return [
                {
                    span: call.span,
                    severity: 'warning',
                    code: 'missing-arguments',
                    message: `${formatMethodSignature(type, method)} needs ${required} argument${required === 1 ? '' : 's'}, got ${call.argCount}. The call fails`,
                },
            ]
        }
        if (!typed.some((param) => param.rest) && call.argCount > typed.length) {
            return [
                {
                    span: call.span,
                    severity: 'information',
                    code: 'extra-arguments',
                    message: `${formatMethodSignature(type, method)} takes ${typed.length} argument${typed.length === 1 ? '' : 's'}, got ${call.argCount}. The rest are ignored`,
                },
            ]
        }
        return []
    }

    // ---------------- lookup at a position ----------------

    private occurrenceAt(file: WorkspaceFile, offset: number): DocumentOccurrence | undefined {
        let best: DocumentOccurrence | undefined
        for (const occurrence of this.workspace.analysis(file).occurrences) {
            if (occurrence.kind === 'method' && contains(occurrence.span, offset)) {
                return occurrence
            }
            if (contains(occurrence.span, offset)) {
                if (!best || occurrence.span.end - occurrence.span.start < best.span.end - best.span.start) {
                    best = occurrence
                }
            }
        }
        return best
    }

    // The object, property name, TYPE value or object name of a CNV line at the offset
    private cnvItemAt(
        file: WorkspaceFile,
        offset: number
    ):
        | { kind: 'objectName'; name: string; span: Span }
        | { kind: 'property'; object: CnvObject; property: CnvProperty }
        | { kind: 'type'; type: string; span: Span }
        | { kind: 'param'; object: CnvObject; property: CnvProperty }
        | undefined {
        for (const object of file.document.objects.values()) {
            if (!contains(object.span, offset)) {
                continue
            }
            if (contains(object.nameSpan, offset)) {
                return { kind: 'objectName', name: object.name, span: object.nameSpan }
            }
            for (const property of object.properties) {
                if (contains(property.objectSpan, offset)) {
                    return { kind: 'objectName', name: object.name, span: property.objectSpan }
                }
                if (contains(property.nameSpan, offset)) {
                    return { kind: 'property', object, property }
                }
                if (property.paramSpan && contains(property.paramSpan, offset)) {
                    return { kind: 'param', object, property }
                }
                if (property.name === 'TYPE' && contains(property.valueSpan, offset)) {
                    return { kind: 'type', type: property.value.text, span: property.valueSpan }
                }
            }
        }
        return undefined
    }

    // ---------------- hover ----------------

    hover(uri: string, position: Position): Hover | null {
        const file = this.workspace.file(uri)
        if (!file || file.document.encrypted) {
            return null
        }
        const offset = file.document.lineIndex.offsetAt(position)
        const occurrence = this.occurrenceAt(file, offset)
        const markdown = (value: string, span: Span): Hover => ({
            contents: { kind: MarkupKind.Markdown, value },
            range: this.range(file, span),
        })

        if (occurrence) {
            switch (occurrence.kind) {
                case 'method':
                    return markdown(this.methodHover(file, occurrence), occurrence.span)
                case 'global':
                    return markdown(this.globalHover(occurrence.name), occurrence.span)
                case 'local':
                    return markdown(`\`@${occurrence.type}\` local variable **${occurrence.name}**`, occurrence.span)
                case 'object':
                case 'string': {
                    const resolution = this.workspace.resolve(occurrence.name, file)
                    if (resolution) {
                        return markdown(this.objectHover(resolution), occurrence.span)
                    }
                    if (occurrence.kind === 'object') {
                        return markdown(
                            `**${occurrence.name}**: not declared in the files this one sees`,
                            occurrence.span
                        )
                    }
                    return null
                }
            }
        }

        const item = this.cnvItemAt(file, offset)
        if (!item) {
            return null
        }
        switch (item.kind) {
            case 'objectName': {
                const resolution = this.workspace.resolve(item.name, file)
                return resolution ? markdown(this.objectHover(resolution), item.span) : null
            }
            case 'property': {
                const type = item.object.type
                const info = type ? this.vocabulary.property(type, item.property.name) : undefined
                if (item.property.name === 'TYPE') {
                    return markdown(
                        '`TYPE`: the object type. It must come before the other properties',
                        item.property.nameSpan
                    )
                }
                if (!info) {
                    return markdown(
                        `\`${item.property.name}\` is not a property of ${type ?? 'this object'}`,
                        item.property.nameSpan
                    )
                }
                return markdown(this.propertyHover(type!, info), item.property.nameSpan)
            }
            case 'param':
                return markdown(
                    `Handler of \`${item.property.name}\` for the parameter \`${item.property.param}\``,
                    item.property.paramSpan!
                )
            case 'type':
                return markdown(this.typeHover(item.type), item.span)
        }
    }

    private engineLink(info: { file: string; line: number }) {
        return `${info.file}:${info.line}`
    }

    private methodHover(file: WorkspaceFile, call: MethodOccurrence & { block?: Block }): string {
        const target = call.target
        if (target.kind === 'name') {
            const resolution = this.workspace.resolve(target.name, file)
            if (resolution?.kind === 'classInstance') {
                const behaviour = this.workspace
                    .instanceBehaviours(resolution.instance)
                    .find((object) => object.name === call.name)
                const classFile = resolution.instance.classFile
                return behaviour && classFile
                    ? `Behaviour **${call.name}** of class \`${this.relativeName(classFile)}\` (instance ${target.name})`
                    : `**${call.name}**: no such behaviour in the class of ${target.name}`
            }
        }
        const type = this.workspace.targetType(target, file, call.block?.thisType)
        if (type === undefined) {
            return `**${call.name}** (the target's TYPE is not known statically)`
        }
        const method = this.vocabulary.method(type, call.name)
        if (!method) {
            return this.vocabulary.forwardsUnknownCalls(type)
                ? `**${call.name}**: ${type} passes it on to its members`
                : `**${call.name}**: ${type} has no such method in ReksioEngine`
        }
        return this.methodDoc(type, method)
    }

    private methodDoc(type: string, method: MethodInfo) {
        const lines = ['```\n' + formatMethodSignature(type, method) + '\n```']
        if (method.doc) {
            lines.push(method.doc)
        }
        const notes = []
        if (method.owner !== this.vocabulary.className(type)) {
            notes.push(`inherited from ${method.owner}`)
        }
        if (!method.decorated) {
            notes.push('arguments are not converted')
        }
        notes.push(this.engineLink(method))
        lines.push(`_${notes.join(' · ')}_`)
        return lines.join('\n\n')
    }

    private globalHover(name: string) {
        const doc = GLOBAL_DOCS[name]
        const known = this.vocabulary.global(name) !== undefined
        if (!known) {
            return `**@${name}**: not a global ReksioEngine knows`
        }
        return doc ? '```\n' + doc.signature + '\n```\n\n' + doc.description : `**@${name}**`
    }

    private declarationLine(file: WorkspaceFile, object: CnvObject) {
        if (file.decrypted) {
            return `\`${this.relativeName(file)}\``
        }
        const line = file.document.lineIndex.positionAt(object.nameSpan.start).line + 1
        return `\`${this.relativeName(file)}\` line ${line}`
    }

    private objectHover(resolution: Resolution): string {
        switch (resolution.kind) {
            case 'object': {
                const lines = [`**${resolution.name}**: ${resolution.type ?? 'no TYPE'}`]
                lines.push(`Declared in ${this.declarationLine(resolution.file, resolution.object)}`)
                const role = this.workspace.role(resolution.file)
                if (role) {
                    lines.push(`_${role}_`)
                }
                return lines.join('\n\n')
            }
            case 'builtin':
                return `**${resolution.name}**: built-in ${resolution.type} object`
            case 'local':
                return `**${resolution.name}**: local ${resolution.type} declared with @${resolution.type === 'INTEGER' ? 'INT' : resolution.type}`
            case 'field':
                return `**${resolution.name}**: ${resolution.type} field of STRUCT ${resolution.struct.name} (${this.declarationLine(resolution.file, resolution.struct)})`
            case 'clone':
                return `**${resolution.name}**: clone of ${resolution.object.name} (${resolution.type ?? 'no TYPE'}), ${this.declarationLine(resolution.file, resolution.object)}`
            case 'cursor':
                return `**${resolution.name}**: current row of DATABASE ${resolution.object.name}`
            case 'classInstance': {
                const instance = resolution.instance
                const classFile = instance.classFile ? `\`${this.relativeName(instance.classFile)}\`` : 'unknown file'
                return `**${resolution.name}**: instance of CLASS ${instance.classObject.name} (${classFile}), created with NEW in \`${this.relativeName(instance.file)}\``
            }
            case 'loopCounter':
                return `**_I_**: INTEGER counter of the enclosing @LOOP`
        }
    }

    private propertyHover(type: string, info: PropertyInfo) {
        const lines = [`\`${type}:${info.name}\`: ${describePropertyKind(info)}`]
        if (info.kind === 'callbacks') {
            lines.push(
                `Event handler. \`${info.name}^PARAM=…\` handles one parameter value, \`${info.name}=…\` the rest`
            )
        } else if (info.kind === 'callback') {
            lines.push('Event handler: `{code}` or a behaviour name, optionally with constant arguments')
        } else if (info.kind === 'code') {
            lines.push('A single statement, run when the value is needed')
        }
        return lines.join('\n\n')
    }

    private typeHover(type: string) {
        if (!this.vocabulary.isKnownType(type)) {
            return `**${type}**: not a TYPE ReksioEngine knows`
        }
        const methods = [...(this.vocabulary.methods(type)?.keys() ?? [])].sort()
        const properties = this.vocabulary.properties(type).map((property) => property.name)
        const lines = [`**${type}**`]
        if (properties.length > 0) {
            lines.push(`Properties: ${properties.join(', ')}`)
        }
        if (methods.length > 0) {
            lines.push(`Methods: ${methods.join(', ')}`)
        }
        if (this.vocabulary.forwardsUnknownCalls(type)) {
            lines.push('Other calls are passed on to its members')
        }
        return lines.join('\n\n')
    }

    // ---------------- definition / references ----------------

    private declarationOf(resolution: Resolution): { file: WorkspaceFile; span: Span; key: string } | null {
        switch (resolution.kind) {
            case 'object':
                return {
                    file: resolution.file,
                    span: resolution.object.nameSpan,
                    key: `${resolution.file.uri}#${resolution.name}`,
                }
            case 'clone':
            case 'cursor':
                return {
                    file: resolution.file,
                    span: resolution.object.nameSpan,
                    key: `${resolution.file.uri}#${resolution.object.name}`,
                }
            case 'field':
                return {
                    file: resolution.file,
                    span: resolution.struct.nameSpan,
                    key: `${resolution.file.uri}#${resolution.struct.name}`,
                }
            case 'local':
                return {
                    file: resolution.file,
                    span: resolution.span,
                    key: `${resolution.file.uri}@${resolution.name}`,
                }
            case 'classInstance':
                return {
                    file: resolution.instance.file,
                    span: resolution.instance.span,
                    key: `${resolution.instance.classObjectFile.uri}!${resolution.name}`,
                }
            default:
                return null
        }
    }

    // What the symbol at a position refers to
    private targetAt(
        file: WorkspaceFile,
        offset: number
    ): { name: string; declaration: { file: WorkspaceFile; span: Span; key: string } } | null {
        const occurrence = this.occurrenceAt(file, offset)
        if (occurrence?.kind === 'method') {
            const target = occurrence.target
            if (target.kind === 'name') {
                const resolution = this.workspace.resolve(target.name, file)
                if (resolution?.kind === 'classInstance' && resolution.instance.classFile) {
                    const classFile = resolution.instance.classFile
                    const behaviour = classFile.document.objects.get(occurrence.name)
                    if (behaviour) {
                        return {
                            name: occurrence.name,
                            declaration: {
                                file: classFile,
                                span: behaviour.nameSpan,
                                key: `${classFile.uri}#${occurrence.name}`,
                            },
                        }
                    }
                }
            }
            return null
        }
        if (occurrence?.kind === 'local') {
            return {
                name: occurrence.name,
                declaration: { file, span: occurrence.span, key: `${file.uri}@${occurrence.name}` },
            }
        }
        let name: string | undefined
        if (occurrence?.kind === 'object' || occurrence?.kind === 'string') {
            name = occurrence.name
        } else {
            const item = this.cnvItemAt(file, offset)
            if (item?.kind === 'objectName') {
                name = item.name
            }
        }
        if (name === undefined) {
            return null
        }
        const resolution = this.workspace.resolve(name, file)
        const declaration = resolution ? this.declarationOf(resolution) : null
        return declaration ? { name, declaration } : null
    }

    definition(uri: string, position: Position): Location[] {
        const file = this.workspace.file(uri)
        if (!file || file.document.encrypted) {
            return []
        }
        const offset = file.document.lineIndex.offsetAt(position)
        const occurrence = this.occurrenceAt(file, offset)
        if (occurrence?.kind === 'method' && this.options.engineRoot) {
            const type = this.workspace.targetType(occurrence.target, file, occurrence.block?.thisType)
            const method = type ? this.vocabulary.method(type, occurrence.name) : undefined
            if (method) {
                const target = path.join(this.options.engineRoot, method.file)
                return [Location.create(pathToUri(target), Range.create(method.line - 1, 0, method.line - 1, 0))]
            }
        }
        const target = this.targetAt(file, offset)
        return target ? [this.location(target.declaration.file, target.declaration.span)] : []
    }

    references(uri: string, position: Position, includeDeclaration: boolean): Location[] {
        const file = this.workspace.file(uri)
        if (!file || file.document.encrypted) {
            return []
        }
        const target = this.targetAt(file, file.document.lineIndex.offsetAt(position))
        if (!target) {
            return []
        }
        const { name, declaration } = target
        const sameDeclaration = (from: WorkspaceFile, candidate: string) => {
            const resolution = this.workspace.resolve(candidate, from)
            return resolution !== null && this.declarationOf(resolution)?.key === declaration.key
        }

        const locations: Location[] = []
        const seen = new Set<string>()
        const add = (from: WorkspaceFile, span: Span) => {
            const key = `${from.uri}:${span.start}`
            if (!seen.has(key)) {
                seen.add(key)
                locations.push(this.location(from, span))
            }
        }
        if (includeDeclaration) {
            add(declaration.file, declaration.span)
        }

        for (const candidate of this.workspace.allFiles) {
            if (candidate.document.encrypted) {
                continue
            }
            // NAME:PROPERTY lines of the declaring file
            const object = candidate.document.objects.get(name)
            if (object && sameDeclaration(candidate, name)) {
                object.properties.forEach((property) => add(candidate, property.objectSpan))
            }
            for (const occurrence of this.workspace.analysis(candidate).occurrences) {
                if ((occurrence.kind === 'object' || occurrence.kind === 'string') && occurrence.name === name) {
                    if (sameDeclaration(candidate, name)) {
                        add(candidate, occurrence.span)
                    }
                } else if (
                    occurrence.kind === 'method' &&
                    occurrence.name === name &&
                    occurrence.target.kind === 'name'
                ) {
                    // INSTANCE^BEHAVIOUR() calls a behaviour of the class file
                    const resolution = this.workspace.resolve(occurrence.target.name, candidate)
                    if (
                        resolution?.kind === 'classInstance' &&
                        resolution.instance.classFile !== undefined &&
                        `${resolution.instance.classFile.uri}#${name}` === declaration.key
                    ) {
                        add(candidate, occurrence.span)
                    }
                }
            }
        }
        return locations
    }

    // ---------------- symbols ----------------

    documentSymbols(uri: string): DocumentSymbol[] {
        const file = this.workspace.file(uri)
        if (!file || file.document.encrypted) {
            return []
        }
        return [...file.document.objects.values()].map((object) => {
            const children = object.properties
                .filter((property) => property.name !== 'TYPE')
                .map((property) => {
                    const info = object.type ? this.vocabulary.property(object.type, property.name) : undefined
                    const name = property.param !== undefined ? `${property.name}^${property.param}` : property.name
                    return DocumentSymbol.create(
                        name || '(empty)',
                        info ? describePropertyKind(info) : undefined,
                        info && isCallbackKind(info.kind) ? SymbolKind.Event : SymbolKind.Property,
                        this.range(file, property.line.span),
                        this.range(file, property.nameSpan)
                    )
                })
            return DocumentSymbol.create(
                object.name,
                object.type,
                typeSymbolKind(object.type),
                this.range(file, object.span),
                this.range(file, object.nameSpan),
                children
            )
        })
    }

    // ---------------- completion ----------------

    completion(uri: string, position: Position): CompletionItem[] {
        const file = this.workspace.file(uri)
        if (!file || file.document.encrypted) {
            return []
        }
        const prefix = logicalPrefix(file.text, position)
        if (prefix.startsWith('#')) {
            return []
        }

        const separator = prefix.search(/[:=]/)
        if (separator === -1) {
            const items: CompletionItem[] = [
                { label: 'OBJECT', kind: CompletionItemKind.Keyword, insertText: 'OBJECT=' },
            ]
            for (const object of file.document.objects.values()) {
                items.push({ label: object.name, kind: CompletionItemKind.Module, detail: object.type })
            }
            return items
        }

        const objectName = prefix.slice(0, separator)
        if (objectName === 'OBJECT') {
            return []
        }
        const rest = prefix.slice(separator).replace(/^[:=]+/, '')
        const valueSeparator = rest.search(/[:=]/)
        const resolution = this.workspace.resolve(objectName, file)
        const object = resolution?.kind === 'object' ? resolution.object : file.document.objects.get(objectName)
        const type = object?.type

        if (valueSeparator === -1) {
            const caret = rest.indexOf('^')
            if (caret !== -1) {
                return object ? this.eventParameterCompletions(file, object, rest.slice(0, caret)) : []
            }
            return this.propertyCompletions(type)
        }

        const propertyName = rest.slice(0, valueSeparator).split('^')[0]
        const value = rest.slice(valueSeparator).replace(/^[:=]+/, '')
        if (propertyName === 'TYPE') {
            return this.vocabulary.typeNames.map((name) => ({ label: name, kind: CompletionItemKind.Class }))
        }
        const info = type ? this.vocabulary.property(type, propertyName) : undefined
        if (!info) {
            return []
        }
        switch (info.kind) {
            case 'boolean':
                return ['TRUE', 'FALSE'].map((label) => ({ label, kind: CompletionItemKind.Value }))
            case 'reference':
            case 'rect':
                return this.nameCompletions(file, () => true)
            case 'code':
                return this.codeCompletions(file, value, undefined)
            case 'callback':
            case 'callbacks': {
                if (value.startsWith('{')) {
                    const thisType = type === 'BEHAVIOUR' ? undefined : type
                    return this.codeCompletions(file, value.slice(1), thisType)
                }
                return [
                    { label: '{…}', kind: CompletionItemKind.Snippet, insertText: '{}', detail: 'inline code' },
                    ...this.behaviourCompletions(file),
                ]
            }
            default:
                return []
        }
    }

    private propertyCompletions(type: string | undefined): CompletionItem[] {
        const items: CompletionItem[] = [{ label: 'TYPE', kind: CompletionItemKind.Property, insertText: 'TYPE=' }]
        if (!type) {
            return items
        }
        for (const info of this.vocabulary.properties(type)) {
            if (info.pattern) {
                continue
            }
            items.push({
                label: info.name,
                kind: isCallbackKind(info.kind) ? CompletionItemKind.Event : CompletionItemKind.Property,
                detail: describePropertyKind(info),
                insertText: info.kind === 'callbacks' ? undefined : `${info.name}=`,
            })
        }
        return items
    }

    private nameCompletions(file: WorkspaceFile, filter: (resolution: Resolution) => boolean): CompletionItem[] {
        const items: CompletionItem[] = []
        for (const [name, resolution] of this.workspace.visibleNames(file)) {
            if (filter(resolution)) {
                items.push({ label: name, kind: resolutionKind(resolution), detail: typeOf(resolution) })
            }
        }
        return items
    }

    private behaviourCompletions(file: WorkspaceFile) {
        return this.nameCompletions(
            file,
            (resolution) => resolution.kind === 'object' && resolution.type === 'BEHAVIOUR'
        )
    }

    private codeCompletions(file: WorkspaceFile, code: string, thisType: string | undefined): CompletionItem[] {
        code = code.replaceAll(' ', '')
        const quotes = (code.match(/"/g) ?? []).length
        if (quotes % 2 === 1) {
            const inner = code.slice(code.lastIndexOf('"') + 1)
            if (inner.startsWith('{')) {
                return this.codeCompletions(file, inner.slice(1), thisType)
            }
            // A string argument: behaviours for @IF branches, objects for the rest
            const items = this.nameCompletions(file, () => true)
            items.forEach((item) => {
                item.sortText = item.kind === CompletionItemKind.Function ? `0${item.label}` : `1${item.label}`
            })
            return items
        }

        if (/@[A-Za-z_]*$/.test(code)) {
            return this.vocabulary.data.globals.map((global) => ({
                label: global.name,
                kind: CompletionItemKind.Keyword,
                detail: GLOBAL_DOCS[global.name]?.signature,
                documentation: GLOBAL_DOCS[global.name]?.description,
            }))
        }

        const call = /(\*?)([A-Za-z0-9_|$]+)\^[A-Za-z0-9_]*$/.exec(code)
        if (call) {
            if (call[1] === '*') {
                return []
            }
            return this.methodCompletions(file, call[2], thisType)
        }

        const items = this.nameCompletions(file, () => true)
        items.push({ label: 'THIS', kind: CompletionItemKind.Keyword, detail: thisType })
        return items
    }

    private methodCompletions(file: WorkspaceFile, targetText: string, thisType: string | undefined): CompletionItem[] {
        let type: string | undefined
        if (targetText === 'THIS') {
            type = thisType
        } else if (targetText.includes('|')) {
            const [objectName, field] = targetText.split('|')
            type = this.workspace.targetType(
                { kind: 'field', object: objectName, field, span: { start: 0, end: 0 } },
                file
            )
        } else {
            const resolution = this.workspace.resolve(targetText, file)
            if (resolution?.kind === 'classInstance') {
                return this.workspace.instanceBehaviours(resolution.instance).map((behaviour) => ({
                    label: behaviour.name,
                    kind: CompletionItemKind.Method,
                    detail: `behaviour of ${resolution.instance.classObject.name}`,
                }))
            }
            type = resolution && 'type' in resolution ? resolution.type : undefined
        }
        const methods = type ? this.vocabulary.methods(type) : null
        if (!methods) {
            return []
        }
        return [...methods.values()].map((method) => ({
            label: method.name,
            kind: CompletionItemKind.Method,
            detail: formatMethodSignature(type!, method),
            documentation: method.doc ? { kind: MarkupKind.Markdown, value: method.doc } : undefined,
        }))
    }

    private eventParameterCompletions(file: WorkspaceFile, object: CnvObject, propertyName: string): CompletionItem[] {
        const names = new Set<string>()
        const type = object.type
        const className = type ? this.vocabulary.className(type) : undefined
        const keys = className ? this.vocabulary.data.classes[className]?.eventKeys : undefined
        keys?.forEach((key) => names.add(key))
        if (type === 'BOOL') {
            names.add('TRUE')
            names.add('FALSE')
        }
        // Parameters already handled for this object
        object.properties.forEach((property) => property.param && names.add(property.param))
        // Events named in calls on the object, e.g. ANIMO^PLAY("WALK")
        for (const candidate of this.workspace.allFiles) {
            for (const occurrence of this.workspace.analysis(candidate).occurrences) {
                if (
                    occurrence.kind === 'method' &&
                    occurrence.firstString &&
                    occurrence.target.kind === 'name' &&
                    occurrence.target.name === object.name &&
                    ['PLAY', 'ISPLAYING', 'SETFRAME', 'NPLAY'].includes(occurrence.name)
                ) {
                    names.add(occurrence.firstString.value.toUpperCase())
                }
            }
        }
        for (const event of this.fileEvents(file, object)) {
            names.add(event.toUpperCase())
        }
        return [...names].map((name) => ({ label: name, kind: CompletionItemKind.EnumMember, detail: propertyName }))
    }

    // Event names of the ANIMO's ANN file or the SEQUENCE's SEQ file, when they can be read
    private fileEvents(file: WorkspaceFile, object: CnvObject): string[] {
        const readFile = this.options.readFile
        const fileName = object.properties.find((property) => property.name === 'FILENAME')?.value.text
        if (!readFile || !fileName || file.decrypted) {
            return []
        }
        const dir = path.dirname(uriToPath(file.uri))
        const data = readFile(path.join(dir, fileName.replaceAll('\\', '/')))
        if (!data) {
            return []
        }
        try {
            if (object.type === 'ANIMO') {
                return readAnnEventNames(data)
            }
            if (object.type === 'SEQUENCE') {
                const text = new TextDecoder('latin1').decode(data)
                return [...text.matchAll(/^\s*NAME\s*[=\s]\s*(\S+)/gm)].map((match) => match[1])
            }
        } catch {
            return []
        }
        return []
    }
}

const uriToPath = (uri: string) => (uri.startsWith('file:') ? fileURLToPath(uri) : uri)
const pathToUri = (filePath: string) => pathToFileURL(filePath).toString()

/**
 * The logical line up to the cursor, prepared like the CNV loader prepares lines: continued physical lines joined,
 * tabs and `/` removed, leading spaces trimmed.
 */
export const logicalPrefix = (text: string, position: Position) => {
    const lines = text.split('\n')
    const current = (lines[position.line] ?? '').slice(0, position.character)
    let prefix = current
    for (let line = position.line - 1; line >= 0 && lines[line].includes('/'); line--) {
        prefix = lines[line].replace(/\r$/, '').replace(/ +$/, '') + prefix.replace(/^[ \t]+/, '')
    }
    return prefix.replaceAll('\t', '').replace(/^ +/, '').replaceAll('/', '')
}
