// Analysis of code blocks with the engine's own parser (src/interpreter/parser.ts). The code is prepared the way the
// interpreter prepares it (spaces removed) and every parser offset is mapped back to the document.
import { FunctionCall, Parameter, Statement } from '../../../src/interpreter/ast'
import { ParseError, parseCode, parseParameter } from '../../../src/interpreter/parser'
import { parseLogicExpression } from '../../../src/interpreter/expression'
import { ConditionExpr } from '../../../src/interpreter/expression/ast'
import { MappedText, Span, filterChars, slice, spanOf, wholeSpan } from '../cnv/text'

export type Severity = 'error' | 'warning' | 'information' | 'hint'

export interface Problem {
    span: Span
    message: string
    severity: Severity
    code: string
}

export type CallTarget =
    | { kind: 'name'; name: string; span: Span }
    | { kind: 'this' }
    | { kind: 'field'; object: string; field: string; span: Span }
    | { kind: 'indirect' }
    | { kind: 'direct' }
    // Text that can't name an object statically: `$1^PLAY()`, `!OBJ^PLAY()`, `}ELSE{OBJ^SET()`
    | { kind: 'other'; text: string; span: Span }

export interface ObjectOccurrence {
    kind: 'object'
    name: string
    span: Span
    // How the name is used: a call target, a value, a behaviour named as a branch or callback, a property value
    role: 'target' | 'value' | 'behaviour' | 'reference'
}

// A string literal that may name an object, e.g. GROUP^ADD("ANNKOT") or SCENE^RUN("OBJ","SHOW")
export interface StringOccurrence {
    kind: 'string'
    name: string
    span: Span
}

export interface MethodOccurrence {
    kind: 'method'
    name: string
    span: Span
    target: CallTarget
    argCount: number
    // Whole call, for hover
    callSpan: Span
    // The first argument when it is a string literal, e.g. the instance name of CLASS^NEW("NAME")
    firstString?: { value: string; span: Span }
}

export interface GlobalOccurrence {
    kind: 'global'
    name: string
    span: Span
    argCount: number
}

export interface LocalDeclaration {
    kind: 'local'
    name: string
    type: string
    span: Span
}

export type Occurrence = ObjectOccurrence | StringOccurrence | MethodOccurrence | GlobalOccurrence | LocalDeclaration

export interface CodeAnalysis {
    occurrences: Occurrence[]
    problems: Problem[]
}

export interface AnalysisOptions {
    // Names of the @globals the engine knows, with the TYPE an @INT-like global declares
    globals: Map<string, string | undefined>
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
// Object names in the data are mostly [A-Z0-9_], Skarb Piratów also has BUTTONZOLW7-1
const OBJECT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_\-.]*$/
// Characters that can't be part of an object name, only of mangled code
const NOT_IN_NAMES = /[{}()\[\];",'\s]/
const BEHAVIOUR_REFERENCE = /^([a-zA-Z0-9_]+)(?:\((.*)\))?$/
const IF_OPERATORS = ['_', '!_', '<', '>', '<_', '>_']

// The interpreter removes every space before parsing (and the argument substitution of $n happens after)
export const prepareCode = (code: MappedText): MappedText => filterChars(code, (char) => char !== ' ')

/** Strips the braces of a callback code value like createCallback does: `^{` and `};*$`. */
export const stripBraces = (value: MappedText): MappedText => {
    let start = value.text.startsWith('{') ? 1 : 0
    const match = /};*$/.exec(value.text)
    let end = match && match.index >= start ? match.index : value.text.length
    if (end < start) {
        end = start
    }
    return slice(value, start, end)
}

export const parseBehaviourReference = (text: string) => {
    const match = BEHAVIOUR_REFERENCE.exec(text.trim())
    return match ? { name: match[1], args: match[2] } : null
}

class Analyzer {
    readonly occurrences: Occurrence[] = []
    readonly problems: Problem[] = []
    // Inside code with unbalanced parentheses statements are split in the wrong places; the follow-up noise isn't
    // reported
    private unbalanced = 0

    constructor(private readonly options: AnalysisOptions) {}

    problem(span: Span, severity: Severity, code: string, message: string) {
        this.problems.push({ span, severity, code, message })
    }

    analyzeCode(code: MappedText) {
        const prepared = prepareCode(code)
        if (!prepared.text) {
            return
        }

        let statements: Statement[]
        try {
            statements = parseCode(prepared.text)
        } catch (err) {
            if (err instanceof ParseError) {
                const span = err.position >= 0 ? spanOf(prepared, err.position, err.position + 1) : wholeSpan(prepared)
                this.problem(span, 'error', 'parse-error', err.message)
                return
            }
            throw err
        }

        const balanced = this.checkParentheses(prepared)
        if (!balanced) {
            this.unbalanced++
        }
        for (const statement of statements) {
            this.statement(prepared, statement)
        }
        if (!balanced) {
            this.unbalanced--
        }
    }

    // The statement splitter counts parentheses without looking at quotes, so an unbalanced `(` swallows the
    // following statements and a stray `)` splits in the wrong place
    checkParentheses(code: MappedText): boolean {
        let depth = 0
        for (let i = 0; i < code.text.length; i++) {
            if (code.text[i] === '(') {
                depth++
            } else if (code.text[i] === ')') {
                depth--
                if (depth < 0) {
                    this.problem(spanOf(code, i, i + 1), 'warning', 'unbalanced-parentheses', 'Unmatched ")"')
                    return false
                }
            }
        }
        if (depth > 0) {
            this.problem(wholeSpan(code), 'warning', 'unbalanced-parentheses', `${depth} unclosed "(" in this code`)
            return false
        }
        return true
    }

    statement(code: MappedText, statement: Statement) {
        if (statement.type === 'FunctionCall') {
            const text = code.text.slice(statement.start, statement.end)
            if (text.startsWith('[') && statement.target?.type === 'ObjectTarget') {
                // runLine only takes a statement without `(` and `^` as a value, so `[A^GET()+1]` becomes a call on
                // the object "[A". It still matters for single-statement code like CONDITION operands.
                this.problem(
                    spanOf(code, statement.start, statement.end),
                    'information',
                    'bracket-statement',
                    `ReksioEngine runs a statement starting with "[" as a call on "${text.slice(0, text.indexOf('^'))}", not as an expression, so its value is NULL`
                )
                try {
                    this.parameter(code, parseParameter(text, statement.start))
                } catch {
                    // only for references
                }
                return
            }
            this.call(code, statement, true)
        } else {
            this.parameter(code, statement)
        }
    }

    call(code: MappedText, call: FunctionCall, isStatement: boolean) {
        const text = code.text.slice(call.start, call.end)
        const callSpan = spanOf(code, call.start, call.end)

        if (call.target?.type === 'GlobalTarget') {
            const nameSpan = spanOf(code, call.start + 1, call.start + 1 + call.method.length)
            this.occurrences.push({ kind: 'global', name: call.method, span: nameSpan, argCount: call.args.length })
            if (!this.options.globals.has(call.method)) {
                this.problem(
                    nameSpan,
                    'error',
                    'unknown-global',
                    `Unknown global @${call.method}. The engine stops the script here`
                )
                call.args.forEach((arg) => this.parameter(code, arg))
                return
            }
            this.globalCall(code, call)
            return
        }

        // The method is the text after the last `^` before the first `(`
        const parenPos = text.indexOf('(')
        const head = parenPos === -1 ? text : text.slice(0, parenPos)
        const methodStart = call.start + head.lastIndexOf('^') + 1
        const methodSpan = spanOf(code, methodStart, methodStart + call.method.length)

        let target: CallTarget
        const ref = call.target?.ref
        if (ref === undefined) {
            this.problem(
                methodSpan,
                'warning',
                'missing-target',
                `Call of ${call.method || 'a method'} without an object. The engine stops the script here`
            )
            call.args.forEach((arg) => this.parameter(code, arg))
            return
        } else if (ref.type === 'ThisRef') {
            target = { kind: 'this' }
        } else if (ref.type === 'DirectRef') {
            target = { kind: 'direct' }
        } else if (ref.type === 'IndirectRef') {
            target = { kind: 'indirect' }
            this.parameter(code, ref.inner)
        } else {
            const span = spanOf(code, ref.start, ref.end)
            const pipe = ref.name.indexOf('|')
            if (pipe !== -1) {
                const object = ref.name.slice(0, pipe)
                const objectSpan = spanOf(code, ref.start, ref.start + pipe)
                target = { kind: 'field', object, field: ref.name.slice(pipe + 1), span: objectSpan }
                this.occurrences.push({ kind: 'object', name: object, span: objectSpan, role: 'target' })
            } else if (OBJECT_NAME.test(ref.name)) {
                target = { kind: 'name', name: ref.name, span }
                this.occurrences.push({ kind: 'object', name: ref.name, span, role: 'target' })
            } else {
                target = { kind: 'other', text: ref.name, span }
                if (ref.name.startsWith('!') && isStatement) {
                    this.problem(
                        spanOf(code, call.start, call.end),
                        'hint',
                        'disabled-statement',
                        `Statement starting with "!": the engine finds no object "${ref.name}" and skips it`
                    )
                } else if (NOT_IN_NAMES.test(ref.name) && this.unbalanced === 0) {
                    this.problem(
                        span,
                        'warning',
                        'invalid-target',
                        `"${ref.name}" is not an object name, the call is skipped`
                    )
                }
            }
        }

        const first = call.args[0]
        this.occurrences.push({
            kind: 'method',
            name: call.method,
            span: methodSpan,
            target,
            argCount: call.args.length,
            callSpan,
            firstString:
                first?.type === 'StringLiteral'
                    ? { value: first.value, span: spanOf(code, first.start + 1, first.start + 1 + first.value.length) }
                    : undefined,
        })
        call.args.forEach((arg) => this.parameter(code, arg))
    }

    globalCall(code: MappedText, call: FunctionCall) {
        const args = call.args
        const nameSpan = spanOf(code, call.start + 1, call.start + 1 + call.method.length)
        const declares = this.options.globals.get(call.method)
        if (declares !== undefined) {
            const [name, ...rest] = args
            if (name?.type === 'StringLiteral' && NAME.test(name.value)) {
                const span = spanOf(code, name.start + 1, name.start + 1 + name.value.length)
                this.occurrences.push({ kind: 'local', name: name.value, type: declares, span })
            } else if (name !== undefined) {
                this.parameter(code, name)
            }
            rest.forEach((arg) => this.parameter(code, arg))
            return
        }

        switch (call.method) {
            case 'IF':
                if (args.length === 5) {
                    this.operand(code, args[0])
                    this.ifOperator(code, args[1])
                    this.operand(code, args[2])
                    this.branch(code, args[3])
                    this.branch(code, args[4])
                } else if (args.length === 3) {
                    this.logic(code, args[0])
                    this.branch(code, args[1])
                    this.branch(code, args[2])
                } else {
                    this.problem(
                        nameSpan,
                        'error',
                        'if-arguments',
                        `@IF takes 3 or 5 arguments, got ${args.length}. The engine stops the script here`
                    )
                    args.forEach((arg) => this.parameter(code, arg))
                }
                return
            case 'LOOP':
                if (args[0] !== undefined) {
                    this.branch(code, args[0])
                }
                args.slice(1).forEach((arg) => this.parameter(code, arg))
                return
            case 'WHILE':
                if (args.length === 4) {
                    this.operand(code, args[0])
                    this.ifOperator(code, args[1])
                    this.operand(code, args[2])
                    this.branch(code, args[3])
                    return
                }
                args.forEach((arg) => this.parameter(code, arg))
                return
            default:
                args.forEach((arg) => this.parameter(code, arg))
        }
    }

    // A string operand of the 5-argument @IF and of @WHILE is run as code
    operand(code: MappedText, param: Parameter) {
        if (param.type === 'StringLiteral') {
            const inner = this.literalText(code, param)
            if (inner.text) {
                this.analyzeCode(inner)
            }
            return
        }
        this.parameter(code, param)
    }

    ifOperator(code: MappedText, param: Parameter) {
        if (param.type === 'StringLiteral' && !IF_OPERATORS.includes(param.value)) {
            this.problem(
                spanOf(code, param.start, param.end),
                'error',
                'if-operator',
                `Unknown comparison "${param.value}", expected one of ${IF_OPERATORS.join(' ')}`
            )
        } else {
            this.parameter(code, param)
        }
    }

    logic(code: MappedText, param: Parameter) {
        if (param.type !== 'StringLiteral') {
            this.parameter(code, param)
            return
        }
        const inner = this.literalText(code, param)
        let expression: ConditionExpr
        try {
            expression = parseLogicExpression(inner.text)
        } catch (err) {
            if (err instanceof ParseError) {
                this.problem(wholeSpan(inner), 'error', 'parse-error', err.message)
                return
            }
            throw err
        }
        const conditions = expression.type === 'LogicExpression' ? expression.conditions : [expression]
        for (const condition of conditions) {
            this.parameter(inner, condition.left)
            this.parameter(inner, condition.right)
        }
    }

    // A branch of @IF/@LOOP/@WHILE is a callback value: {code}, a behaviour name, BEH(args), or "" for nothing
    branch(code: MappedText, param: Parameter) {
        if (param.type === 'Identifier') {
            if (NAME.test(param.name)) {
                const span = spanOf(code, param.start, param.end)
                this.occurrences.push({ kind: 'object', name: param.name, span, role: 'behaviour' })
            }
            return
        }
        if (param.type !== 'StringLiteral') {
            this.parameter(code, param)
            return
        }
        const inner = this.literalText(code, param)
        this.callbackValue(inner, 'branch')
    }

    callbackValue(value: MappedText, where: 'branch' | 'property') {
        if (value.text === '') {
            return
        }
        if (value.text.startsWith('{')) {
            this.analyzeCode(stripBraces(value))
            return
        }
        const reference = parseBehaviourReference(value.text)
        if (reference !== null) {
            const start = value.text.indexOf(reference.name)
            this.occurrences.push({
                kind: 'object',
                name: reference.name,
                span: spanOf(value, start, start + reference.name.length),
                role: 'behaviour',
            })
            return
        }
        this.problem(
            wholeSpan(value),
            'warning',
            'invalid-callback',
            where === 'branch'
                ? `Neither {code} nor a behaviour name, the branch does nothing`
                : `Neither {code} nor a behaviour reference, the engine ignores this callback`
        )
    }

    // The value of a string literal; the closing quote is optional
    literalText(code: MappedText, param: Parameter & { type: 'StringLiteral' }): MappedText {
        return slice(code, param.start + 1, param.start + 1 + param.value.length)
    }

    parameter(code: MappedText, param: Parameter) {
        switch (param.type) {
            case 'Identifier':
                if (NAME.test(param.name) && param.name !== 'THIS') {
                    this.occurrences.push({
                        kind: 'object',
                        name: param.name,
                        span: spanOf(code, param.start, param.end),
                        role: 'value',
                    })
                }
                return
            case 'FieldAccess':
                if (NAME.test(param.objectName)) {
                    this.occurrences.push({
                        kind: 'object',
                        name: param.objectName,
                        span: spanOf(code, param.start, param.start + param.objectName.length),
                        role: 'value',
                    })
                }
                return
            case 'StringLiteral':
                if (NAME.test(param.value)) {
                    this.occurrences.push({
                        kind: 'string',
                        name: param.value,
                        span: spanOf(code, param.start + 1, param.start + 1 + param.value.length),
                    })
                }
                return
            case 'BracketExpression':
                this.parameter(code, param.expression.head)
                param.expression.tail.forEach((step) => this.parameter(code, step.operand))
                return
            case 'FunctionCall':
                this.call(code, param, false)
                return
            default:
                return
        }
    }
}

/** Analyses a code value (without braces). */
export const analyzeCode = (code: MappedText, options: AnalysisOptions): CodeAnalysis => {
    const analyzer = new Analyzer(options)
    analyzer.analyzeCode(code)
    return { occurrences: analyzer.occurrences, problems: analyzer.problems }
}

/** Analyses the value of a callback property: `{code}`, `BEH` or `BEH(args)`. */
export const analyzeCallbackValue = (value: MappedText, options: AnalysisOptions): CodeAnalysis => {
    const analyzer = new Analyzer(options)
    analyzer.callbackValue(value, 'property')
    return { occurrences: analyzer.occurrences, problems: analyzer.problems }
}
