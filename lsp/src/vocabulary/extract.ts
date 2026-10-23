// Extracts the script vocabulary from the engine sources with the TypeScript compiler API. Only the syntax is read,
// nothing is type-checked or run, so the engine's runtime dependencies (pixi.js, …) are not needed.
//
// - methods: upper-case methods of the classes in src/engine/types (the interpreter calls any member it finds, and
//   @method() adds argument conversion), with parameters read like transformers.ts reads them
// - TYPE -> class: the `case 'TYPE': return new Class(...)` switch in src/filesystem/definitionLoader.ts
// - @globals and built-in objects: createGlobalHandlers / createGlobalInstances in src/interpreter/interpreter.ts
import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'
import { ClassInfo, GlobalInfo, MethodInfo, MethodParam, Vocabulary } from './types'

const SCRIPT_NAME = /^[A-Z][A-Z0-9_]*$/

const readSource = (repoRoot: string, relativePath: string) => {
    const fullPath = path.join(repoRoot, relativePath)
    return ts.createSourceFile(relativePath, fs.readFileSync(fullPath, 'utf-8'), ts.ScriptTarget.Latest, true)
}

const lineOf = (sourceFile: ts.SourceFile, node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

const unwrapPromise = (type: ts.TypeNode): ts.TypeNode => {
    if (ts.isTypeReferenceNode(type) && type.typeName.getText() === 'Promise' && type.typeArguments?.length === 1) {
        return unwrapPromise(type.typeArguments[0])
    }
    return type
}

// `// comment` lines right above the method (or its decorator)
const leadingComment = (sourceFile: ts.SourceFile, node: ts.Node): string | undefined => {
    const text = sourceFile.getFullText()
    const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
    const lines = ranges
        .map((range) => text.slice(range.pos, range.end))
        .map((comment) =>
            comment
                .replace(/^\/\/\s?/, '')
                .replace(/^\/\*+\s*|\s*\*+\/$/g, '')
                .split('\n')
                .map((line) => line.replace(/^\s*\*\s?/, '').trim())
                .join('\n')
        )
        .filter((line) => !line.startsWith('eslint-') && !line.startsWith('@ts-'))
    return lines.length > 0 ? lines.join('\n').trim() : undefined
}

const readParams = (method: ts.MethodDeclaration): MethodParam[] =>
    method.parameters.map((param) => {
        const type = param.type
        const types: string[] = []
        if (type !== undefined) {
            const subTypes = ts.isUnionTypeNode(type) ? [...type.types] : [type]
            types.push(...subTypes.map((subType) => subType.getText().replace(/\[]$/, '')))
        }
        return {
            name: param.name.getText(),
            types,
            optional: param.questionToken !== undefined || param.initializer !== undefined,
            rest: param.dotDotDotToken !== undefined,
        }
    })

const readClass = (sourceFile: ts.SourceFile, node: ts.ClassDeclaration): ClassInfo => {
    const name = node.name!.getText()
    const heritage = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    const base = heritage?.types[0]?.expression.getText()
    const methods: MethodInfo[] = []
    let forwardsUnknownCalls = false

    for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || member.name === undefined) {
            continue
        }
        const methodName = member.name.getText()
        if (methodName === '__call') {
            // The root Type only logs an error; subclasses that override it forward the call
            forwardsUnknownCalls = base !== undefined
            continue
        }
        if (!SCRIPT_NAME.test(methodName)) {
            continue
        }
        const decorators = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : []
        const returns = member.type !== undefined ? unwrapPromise(member.type).getText() : undefined
        methods.push({
            name: methodName,
            params: readParams(member),
            returns: returns === 'void' ? undefined : returns,
            decorated: decorators.some((decorator) => decorator.getText().startsWith('@method(')),
            doc: leadingComment(sourceFile, member),
            owner: name,
            file: sourceFile.fileName,
            line: lineOf(sourceFile, member.name),
        })
    }

    return {
        name,
        file: sourceFile.fileName,
        line: lineOf(sourceFile, node.name!),
        extends: base,
        methods,
        forwardsUnknownCalls,
    }
}

const listSourceFiles = (repoRoot: string, relativeDir: string): string[] => {
    const result: string[] = []
    for (const entry of fs.readdirSync(path.join(repoRoot, relativeDir), { withFileTypes: true })) {
        const relativePath = path.posix.join(relativeDir, entry.name)
        if (entry.isDirectory()) {
            result.push(...listSourceFiles(repoRoot, relativePath))
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            result.push(relativePath)
        }
    }
    return result.sort()
}

// `const keysMapping = { ArrowLeft: 'LEFT', … }` or `new Map([[0, 'LEFT'], …])`: the names events are raised with
const readEventKeys = (sourceFile: ts.SourceFile): string[] | undefined => {
    let keys: string[] | undefined
    sourceFile.forEachChild((node) => {
        if (!ts.isVariableStatement(node)) {
            return
        }
        for (const declaration of node.declarationList.declarations) {
            if (declaration.name.getText() !== 'keysMapping' || declaration.initializer === undefined) {
                continue
            }
            const found: string[] = []
            const visit = (child: ts.Node) => {
                if (ts.isPropertyAssignment(child) && ts.isStringLiteral(child.initializer)) {
                    found.push(child.initializer.text)
                } else if (
                    ts.isArrayLiteralExpression(child) &&
                    child.elements.length === 2 &&
                    ts.isStringLiteral(child.elements[1])
                ) {
                    found.push(child.elements[1].text)
                }
                child.forEachChild(visit)
            }
            visit(declaration.initializer)
            keys = found
        }
    })
    return keys
}

const extractClasses = (repoRoot: string): Record<string, ClassInfo> => {
    const classes: Record<string, ClassInfo> = {}
    for (const file of listSourceFiles(repoRoot, 'src/engine/types')) {
        const sourceFile = readSource(repoRoot, file)
        const eventKeys = readEventKeys(sourceFile)
        sourceFile.forEachChild((node) => {
            if (ts.isClassDeclaration(node) && node.name !== undefined) {
                const info = readClass(sourceFile, node)
                if (eventKeys !== undefined) {
                    info.eventKeys = eventKeys
                }
                classes[info.name] = info
            }
        })
    }
    return classes
}

const findFunction = (sourceFile: ts.SourceFile, name: string): ts.Node | undefined => {
    let found: ts.Node | undefined
    const visit = (node: ts.Node) => {
        if (found) {
            return
        }
        if (
            (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
            node.name?.getText() === name
        ) {
            found = node
            return
        }
        node.forEachChild(visit)
    }
    visit(sourceFile)
    return found
}

const extractTypes = (repoRoot: string): Record<string, string> => {
    const sourceFile = readSource(repoRoot, 'src/filesystem/definitionLoader.ts')
    const factory = findFunction(sourceFile, 'createTypeInstance')
    if (factory === undefined) {
        throw new Error('createTypeInstance not found in definitionLoader.ts')
    }

    // `import { String as StringType }` -> StringType is String
    const importedAs: Record<string, string> = {}
    sourceFile.forEachChild((node) => {
        const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : undefined
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                importedAs[element.name.text] = element.propertyName?.getText() ?? element.name.text
            }
        }
    })

    const types: Record<string, string> = {}
    const visit = (node: ts.Node) => {
        if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
            const typeName = node.expression.text
            const statement = node.statements[0]
            if (
                statement !== undefined &&
                ts.isReturnStatement(statement) &&
                statement.expression !== undefined &&
                ts.isNewExpression(statement.expression)
            ) {
                const className = statement.expression.expression.getText()
                types[typeName] = importedAs[className] ?? className
            }
        }
        node.forEachChild(visit)
    }
    visit(factory)
    return types
}

const extractInterpreter = (repoRoot: string): { globals: GlobalInfo[]; builtins: Record<string, string> } => {
    const sourceFile = readSource(repoRoot, 'src/interpreter/interpreter.ts')
    const tuples = (functionName: string): ts.ArrayLiteralExpression[] => {
        const node = findFunction(sourceFile, functionName)
        if (node === undefined) {
            throw new Error(`${functionName} not found in interpreter.ts`)
        }
        const result: ts.ArrayLiteralExpression[] = []
        const visit = (child: ts.Node) => {
            if (
                ts.isArrayLiteralExpression(child) &&
                child.elements.length === 2 &&
                ts.isStringLiteral(child.elements[0])
            ) {
                result.push(child)
                return
            }
            child.forEachChild(visit)
        }
        visit(node)
        return result
    }

    const globals: GlobalInfo[] = tuples('createGlobalHandlers').map((tuple) => {
        const name = (tuple.elements[0] as ts.StringLiteral).text
        // ['INT', (args) => this.handleDeclaration('INTEGER', args)]
        const declared = /handleDeclaration\('([A-Z]+)'/.exec(tuple.elements[1].getText())
        return declared ? { name, declares: declared[1] } : { name }
    })

    const builtins: Record<string, string> = {}
    for (const tuple of tuples('createGlobalInstances')) {
        const name = (tuple.elements[0] as ts.StringLiteral).text
        const type = /TYPE:\s*'([A-Z_]+)'/.exec(tuple.elements[1].getText())
        if (type) {
            builtins[name] = type[1]
        }
    }
    return { globals, builtins }
}

export const extractVocabulary = (repoRoot: string): Vocabulary => {
    const { globals, builtins } = extractInterpreter(repoRoot)
    return {
        classes: extractClasses(repoRoot),
        types: extractTypes(repoRoot),
        globals,
        builtins,
    }
}
