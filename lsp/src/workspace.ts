// The files of a game and how they see each other. Name lookup follows the engine's scope stack (spec §2.6, §4.4):
// a scene's CNV sees its own objects, then the episode's, the application's and Application.def's.
import * as path from 'path'
import { fileURLToPath } from 'url'
import { CnvDocument, CnvObject, parseCnvDocument } from './cnv/document'
import { Span } from './cnv/text'
import { DocumentAnalysis, analyzeDocument, parseStructFields } from './analysis'
import { MethodOccurrence } from './code/analyze'
import { ScriptVocabulary } from './vocabulary'

export interface WorkspaceFile {
    uri: string
    // Lower-cased path with forward slashes, the engine matches paths case-insensitively
    key: string
    text: string
    version: number
    // The text was decrypted for indexing: positions don't match the file on disk
    decrypted: boolean
    document: CnvDocument
}

export interface ClassInstanceInfo {
    name: string
    // The CLASS object NEW was called on, and the file declaring it
    classObject: CnvObject
    classObjectFile: WorkspaceFile
    // The .class file of the CLASS
    classFile?: WorkspaceFile
    // Where NEW names the instance
    file: WorkspaceFile
    span: Span
}

export type Resolution =
    | { kind: 'object'; name: string; type?: string; file: WorkspaceFile; object: CnvObject }
    | { kind: 'builtin'; name: string; type: string }
    | { kind: 'local'; name: string; type: string; file: WorkspaceFile; span: Span }
    | { kind: 'field'; name: string; type: string; file: WorkspaceFile; struct: CnvObject }
    | { kind: 'clone'; name: string; type?: string; file: WorkspaceFile; object: CnvObject }
    | { kind: 'cursor'; name: string; type: string; file: WorkspaceFile; object: CnvObject }
    | { kind: 'classInstance'; name: string; instance: ClassInstanceInfo }
    | { kind: 'loopCounter'; name: string; type: string }

interface Graph {
    chains: Map<string, WorkspaceFile[]>
    // How each file is reached, for hover
    roles: Map<string, string>
}

export const uriToKey = (uri: string) => {
    let filePath: string
    try {
        filePath = uri.startsWith('file:') ? fileURLToPath(uri) : uri
    } catch {
        filePath = uri
    }
    return filePath.replaceAll('\\', '/').toLowerCase()
}

const joinKey = (...parts: string[]) =>
    path.posix.normalize(parts.map((part) => part.replaceAll('\\', '/')).join('/')).toLowerCase()

const valueOf = (object: CnvObject, name: string) => object.properties.find((p) => p.name === name)?.value.text

const CNVLOADER_LOAD = /CNVLOADER\s*\^\s*LOAD\s*\(\s*"([^"]+)"/gi
const DYNAMIC_CNVLOADER_LOAD = /CNVLOADER\s*\^\s*LOAD\s*\(\s*[^"\s]/i

export class Workspace {
    readonly vocabulary: ScriptVocabulary
    private readonly files = new Map<string, WorkspaceFile>()
    private readonly byKey = new Map<string, WorkspaceFile>()
    private readonly analyses = new Map<string, { version: number; analysis: DocumentAnalysis }>()
    private graph: Graph | null = null
    private instances: Map<string, Map<string, ClassInstanceInfo>> | null = null
    private versionCounter = 0

    constructor(vocabulary: ScriptVocabulary) {
        this.vocabulary = vocabulary
    }

    setFile(uri: string, text: string, decrypted = false) {
        const existing = this.files.get(uri)
        if (existing && existing.text === text && existing.decrypted === decrypted) {
            return existing
        }
        const file: WorkspaceFile = {
            uri,
            key: uriToKey(uri),
            text,
            version: ++this.versionCounter,
            decrypted,
            document: parseCnvDocument(uri, text),
        }
        if (decrypted) {
            file.document.encrypted = false
        }
        // The same file under another spelling of its URI (an editor's file:///c%3A/… for a scanned file:///C:/…)
        const sameFile = this.byKey.get(file.key)
        if (sameFile && sameFile.uri !== uri) {
            this.files.delete(sameFile.uri)
            this.analyses.delete(sameFile.uri)
        }
        this.files.set(uri, file)
        this.byKey.set(file.key, file)
        this.invalidate()
        return file
    }

    removeFile(uri: string) {
        const file = this.files.get(uri)
        if (file) {
            this.files.delete(uri)
            if (this.byKey.get(file.key) === file) {
                this.byKey.delete(file.key)
            }
            this.analyses.delete(uri)
            this.invalidate()
        }
    }

    private invalidate() {
        this.graph = null
        this.instances = null
    }

    file(uri: string) {
        return this.files.get(uri)
    }

    get allFiles(): WorkspaceFile[] {
        return [...this.files.values()]
    }

    fileByKey(key: string) {
        return this.byKey.get(key)
    }

    analysis(file: WorkspaceFile): DocumentAnalysis {
        const cached = this.analyses.get(file.uri)
        if (cached && cached.version === file.version) {
            return cached.analysis
        }
        const analysis = analyzeDocument(file.document, this.vocabulary)
        this.analyses.set(file.uri, { version: file.version, analysis })
        return analysis
    }

    // ---- load graph ----

    private buildGraph(): Graph {
        const chains = new Map<string, WorkspaceFile[]>()
        const roles = new Map<string, string>()
        const sceneDirs = new Map<string, WorkspaceFile[]>()
        const rootFamilies: { dir: string; files: WorkspaceFile[] }[] = []
        const lookup = (key: string) => this.byKey.get(key)

        for (const root of this.files.values()) {
            if (path.posix.basename(root.key) !== 'application.def') {
                continue
            }
            const dir = path.posix.dirname(root.key)
            const objects = [...root.document.objects.values()]
            const fileFor = (object: CnvObject) => {
                const objectPath = valueOf(object, 'PATH')
                return objectPath ? lookup(joinKey(dir, objectPath, `${object.name}.cnv`)) : undefined
            }

            roles.set(root.uri, 'root (Application.def)')
            chains.set(root.uri, [root])

            const family: WorkspaceFile[] = [root]
            let applicationChain = [root]
            for (const application of objects.filter((object) => object.type === 'APPLICATION')) {
                const file = fileFor(application)
                if (file) {
                    applicationChain = [file, root]
                    chains.set(file.uri, applicationChain)
                    roles.set(file.uri, `application ${application.name}`)
                    family.unshift(file)
                }
            }

            const episodeChains = new Map<string, WorkspaceFile[]>()
            for (const episode of objects.filter((object) => object.type === 'EPISODE')) {
                const file = fileFor(episode)
                const chain = file ? [file, ...applicationChain] : applicationChain
                if (file) {
                    chains.set(file.uri, chain)
                    roles.set(file.uri, `episode ${episode.name}`)
                    family.unshift(file)
                }
                for (const scene of (valueOf(episode, 'SCENES') ?? '').split(',')) {
                    episodeChains.set(scene.trim(), chain)
                }
            }

            for (const scene of objects.filter((object) => object.type === 'SCENE')) {
                const file = fileFor(scene)
                if (!file) {
                    continue
                }
                const parentChain = episodeChains.get(scene.name) ?? applicationChain
                chains.set(file.uri, [file, ...parentChain])
                roles.set(file.uri, `scene ${scene.name}`)
                const sceneDir = path.posix.dirname(file.key)
                sceneDirs.set(sceneDir, [...(sceneDirs.get(sceneDir) ?? []), file])
            }
            rootFamilies.push({ dir, files: family })
        }

        // A scene that loads files with a computed name, like CNVLOADER^LOAD(["CNVLEVEL"+VARLEVEL+".CNV"]), may see
        // the objects of any CNV next to it; those come last
        for (const scenes of sceneDirs.values()) {
            for (const scene of scenes) {
                if (!DYNAMIC_CNVLOADER_LOAD.test(scene.text)) {
                    continue
                }
                const chain = chains.get(scene.uri)!
                const siblings = [...this.files.values()].filter(
                    (file) =>
                        path.posix.dirname(file.key) === path.posix.dirname(scene.key) &&
                        path.posix.extname(file.key) === '.cnv' &&
                        !scenes.includes(file) &&
                        !chain.includes(file)
                )
                chains.set(scene.uri, [...chain, ...siblings])
            }
        }

        // CNVLOADER^LOAD("X.CNV") loads X into the current scene
        const loadedBy = new Map<string, WorkspaceFile>()
        for (const file of this.files.values()) {
            for (const match of file.text.matchAll(CNVLOADER_LOAD)) {
                const loaded = lookup(joinKey(path.posix.dirname(file.key), match[1]))
                if (loaded && loaded !== file && !loadedBy.has(loaded.uri)) {
                    loadedBy.set(loaded.uri, file)
                }
            }
        }
        for (const [loadedUri, loader] of loadedBy) {
            const loaderChain = chains.get(loader.uri)
            const loaded = this.files.get(loadedUri)!
            if (loaderChain && loaderChain[0] === loader && !chains.has(loadedUri)) {
                // The scene sees the loaded objects too
                chains.set(loader.uri, dedupe([loader, loaded, ...loaderChain.slice(1)]))
                chains.set(loadedUri, dedupe([loaded, loader, ...loaderChain.slice(1)]))
                roles.set(loadedUri, `loaded by CNVLOADER from ${path.posix.basename(loader.key)}`)
            }
        }

        // CLASS objects name their .class file with DEF
        const classDeclarations = new Map<string, WorkspaceFile[]>()
        for (const file of this.files.values()) {
            for (const object of file.document.objects.values()) {
                const def = object.type === 'CLASS' ? valueOf(object, 'DEF') : undefined
                if (def) {
                    const name = path.posix.basename(def.replaceAll('\\', '/')).toLowerCase()
                    classDeclarations.set(name, [...(classDeclarations.get(name) ?? []), file])
                }
            }
        }

        const fallbackChain = (file: WorkspaceFile, seen: Set<string>): WorkspaceFile[] => {
            const known = chains.get(file.uri)
            if (known) {
                return known
            }
            if (seen.has(file.uri)) {
                return [file]
            }
            seen.add(file.uri)

            const extension = path.posix.extname(file.key)
            if (extension === '.class') {
                const declaring = classDeclarations.get(path.posix.basename(file.key)) ?? []
                const rest = declaring.flatMap((declaringFile) => fallbackChain(declaringFile, seen))
                roles.set(file.uri, 'class definition')
                return dedupe([file, ...rest])
            }

            const loader = loadedBy.get(file.uri)
            if (loader) {
                roles.set(file.uri, `loaded by CNVLOADER from ${path.posix.basename(loader.key)}`)
                return dedupe([file, ...fallbackChain(loader, seen)])
            }

            const scenes = sceneDirs.get(path.posix.dirname(file.key))
            if (scenes) {
                roles.set(file.uri, `next to scene file ${path.posix.basename(scenes[0].key)}`)
                return dedupe([file, ...fallbackChain(scenes[0], seen)])
            }

            const family = rootFamilies.find((candidate) => file.key.startsWith(candidate.dir + '/'))
            if (family) {
                roles.set(file.uri, 'not loaded by a scene')
                return dedupe([file, ...family.files])
            }
            return [file]
        }

        for (const file of this.files.values()) {
            if (!chains.has(file.uri)) {
                chains.set(file.uri, fallbackChain(file, new Set()))
            }
        }
        return { chains, roles }
    }

    private getGraph(): Graph {
        if (this.graph === null) {
            this.graph = this.buildGraph()
        }
        return this.graph
    }

    /** The files whose objects a file's code can see, nearest first. */
    chain(file: WorkspaceFile): WorkspaceFile[] {
        return this.getGraph().chains.get(file.uri) ?? [file]
    }

    role(file: WorkspaceFile): string | undefined {
        return this.getGraph().roles.get(file.uri)
    }

    classFile(classObject: CnvObject): WorkspaceFile | undefined {
        const def = valueOf(classObject, 'DEF')
        if (!def) {
            return undefined
        }
        const name = path.posix.basename(def.replaceAll('\\', '/')).toLowerCase()
        return this.allFiles.find((file) => path.posix.basename(file.key) === name)
    }

    // ---- CLASS instances ----

    private getInstances(): Map<string, Map<string, ClassInstanceInfo>> {
        if (this.instances !== null) {
            return this.instances
        }
        const instances = new Map<string, Map<string, ClassInstanceInfo>>()
        this.instances = instances
        for (const file of this.files.values()) {
            for (const occurrence of this.analysis(file).occurrences) {
                if (occurrence.kind !== 'method' || occurrence.name !== 'NEW' || !occurrence.firstString) {
                    continue
                }
                const target = occurrence.target
                const block = occurrence.block
                const classObject =
                    target.kind === 'name'
                        ? this.findObject(target.name, file)
                        : target.kind === 'this' && block?.thisType !== undefined
                          ? { file, object: block.object }
                          : null
                if (classObject === null || classObject.object.type !== 'CLASS') {
                    continue
                }
                const name = occurrence.firstString.value
                const byName = instances.get(classObject.file.uri) ?? new Map()
                if (!byName.has(name)) {
                    byName.set(name, {
                        name,
                        classObject: classObject.object,
                        classObjectFile: classObject.file,
                        classFile: this.classFile(classObject.object),
                        file,
                        span: occurrence.firstString.span,
                    })
                }
                instances.set(classObject.file.uri, byName)
            }
        }
        return instances
    }

    // ---- name resolution ----

    findObject(name: string, from: WorkspaceFile): { file: WorkspaceFile; object: CnvObject } | null {
        for (const file of this.chain(from)) {
            const object = file.document.objects.get(name)
            if (object) {
                return { file, object }
            }
        }
        return null
    }

    resolve(name: string, from: WorkspaceFile): Resolution | null {
        const chain = this.chain(from)
        const instances = this.getInstances()
        for (let i = 0; i < chain.length; i++) {
            const file = chain[i]
            const object = file.document.objects.get(name)
            if (object) {
                return { kind: 'object', name, type: object.type, file, object }
            }

            const analysis = this.analysis(file)
            const field = analysis.fields.get(name)
            if (field) {
                return { kind: 'field', name, type: field.type, file, struct: field.struct }
            }

            const instance = instances.get(file.uri)?.get(name)
            if (instance) {
                return { kind: 'classInstance', name, instance }
            }

            // OBJ_1, OBJ_2, … are clones, OBJ_0 the original
            const clone = /^(.+)_(\d+)$/.exec(name)
            const original = clone ? file.document.objects.get(clone[1]) : undefined
            if (original) {
                return { kind: 'clone', name, type: original.type, file, object: original }
            }

            const cursor = /^(.+)_CURSOR$/.exec(name)
            const database = cursor ? file.document.objects.get(cursor[1]) : undefined
            if (database?.type === 'DATABASE') {
                return { kind: 'cursor', name, type: 'STRUCT', file, object: database }
            }

            // Block-local variables come right after the caller's own scope
            if (i === 0) {
                const local = this.analysis(from).locals.get(name)
                if (local) {
                    return { kind: 'local', name, type: local.type, file: from, span: local.span }
                }
            }
        }

        const builtin = this.vocabulary.builtinType(name)
        if (builtin) {
            return { kind: 'builtin', name, type: builtin }
        }
        if (name === '_I_') {
            return { kind: 'loopCounter', name, type: 'INTEGER' }
        }
        return null
    }

    // Behaviours of a class instance are its methods
    instanceBehaviours(instance: ClassInstanceInfo): CnvObject[] {
        if (!instance.classFile) {
            return []
        }
        return [...instance.classFile.document.objects.values()].filter((object) => object.type === 'BEHAVIOUR')
    }

    // Every name a file can see, nearest first (for completion)
    visibleNames(from: WorkspaceFile): Map<string, Resolution> {
        const result = new Map<string, Resolution>()
        const add = (name: string) => {
            if (!result.has(name)) {
                const resolution = this.resolve(name, from)
                if (resolution) {
                    result.set(name, resolution)
                }
            }
        }
        const chain = this.chain(from)
        for (const name of this.analysis(from).locals.keys()) {
            add(name)
        }
        for (const file of chain) {
            file.document.objects.forEach((_, name) => add(name))
            this.analysis(file).fields.forEach((_, name) => add(name))
            this.getInstances()
                .get(file.uri)
                ?.forEach((_, name) => add(name))
        }
        Object.keys(this.vocabulary.data.builtins).forEach(add)
        return result
    }

    // The TYPE of a call target, when known
    targetType(target: MethodOccurrence['target'], from: WorkspaceFile, thisType?: string): string | undefined {
        switch (target.kind) {
            case 'this':
                return thisType
            case 'name': {
                const resolution = this.resolve(target.name, from)
                return resolution && 'type' in resolution ? resolution.type : undefined
            }
            case 'field': {
                const resolution = this.resolve(target.object, from)
                if (resolution?.kind === 'object' && resolution.object.type === 'STRUCT') {
                    const fields = parseStructFields(valueOf(resolution.object, 'FIELDS') ?? '')
                    return fields.find((field) => field.name === target.field)?.type
                }
                return undefined
            }
            default:
                return undefined
        }
    }
}

const dedupe = (files: WorkspaceFile[]) => [...new Set(files)]
