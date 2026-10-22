import { Type } from './index'
import { CNVLoaderDefinition } from '../../fileFormats/cnv/types'
import { assert } from '../../common/errors'
import { method } from '../../common/types'
import { doReady, loadDefinition } from '../../filesystem/definitionLoader'

export class CNVLoader extends Type<CNVLoaderDefinition> {
    // Names of the objects each loaded file declared, so RELEASE can remove them again
    private loadedObjects = new Map<string, string[]>()

    @method()
    async LOAD(filename: string) {
        assert(this.engine.currentScene !== null)
        const definition = await this.engine.filesystem.getCNVFile(
            await this.engine.currentScene.getRelativePath(filename)
        )

        assert(this.parent !== null && this.parent.scope !== null)
        await loadDefinition(this.engine, this.parent.scope, definition, this.engine.currentScene)
        this.loadedObjects.set(filename.toUpperCase(), Object.keys(definition))
        await doReady(this.parent.scope)
    }

    @method()
    RELEASE(filename: string) {
        const names = this.loadedObjects.get(filename.toUpperCase())
        const scope = this.parent?.scope
        if (names === undefined || scope === null || scope === undefined) {
            return
        }

        for (const name of names) {
            const object = scope.get(name)
            if (object !== null) {
                object.destroy()
                scope.remove(name)
            }
        }
        this.loadedObjects.delete(filename.toUpperCase())
    }
}
