import { ParentType, Type } from './index'
import { SceneDefinition } from '../../fileFormats/cnv/types'
import { Behaviour } from './behaviour'
import { assert } from '../../common/errors'
import { callMethod, method, int } from '../../common/types'
import { loadSound } from '../../filesystem/assetsLoader'
import { pathJoin } from '../../filesystem'
import { Group } from './group'
import { Animo } from './animo'
import { Sequence } from './sequence'
import { Sound } from './sound'
import { Timer } from './timer'
import { Value } from './values'

export class Scene extends ParentType<SceneDefinition> {
    private minHSPriority = 0
    private maxHSPriority = 10000000
    private pausedObjects: Array<Animo | Sequence | Sound | Timer> | null = null

    @method()
    SETMUSICVOLUME(volume: int) {
        assert(this.engine.music !== null)
        this.engine.music.volume = volume / 1000
    }

    @method()
    async RUNCLONES(baseObjectName: string, startingIdx: int, endingIdx: int, behaviourName: string) {
        const baseObject: Type<any> | null = this.getObject(baseObjectName)
        const behaviour = this.getObject<Behaviour>(behaviourName)
        assert(baseObject !== null && behaviour !== null)

        if (startingIdx < 1) {
            startingIdx = 1
        }
        if (endingIdx <= 0) {
            endingIdx = baseObject.clones.length
        }

        for (let i = startingIdx - 1; i <= endingIdx - 1; i++) {
            const clone = baseObject.clones[i]
            await behaviour.RUN(clone)
        }
    }

    @method()
    async RUN(objectName: string, methodName: string, ...args: Value[]) {
        const object: any = this.getObject(objectName)
        if (object === null) {
            return
        }

        if (object[methodName] !== undefined) {
            return await callMethod(object, methodName, args)
        } else {
            return await object.__call(methodName, args)
        }
    }

    @method()
    async STARTMUSIC(filename: string) {
        this.engine.music?.stop()
        const sound = await loadSound(this.engine.filesystem, filename)
        this.engine.music = sound.play({
            loop: true,
        })
    }

    // Arguments are ignored, as in the original: Wehikuł Czasu calls STOPMUSIC(G_SMUSIC)
    @method()
    STOPMUSIC(...ignored: any[]) {
        this.engine.music?.stop()
        this.engine.music = null
    }

    @method()
    GETMAXHSPRIORITY(): int {
        return this.maxHSPriority
    }

    @method()
    SETMAXHSPRIORITY(priority: int) {
        this.maxHSPriority = priority
    }

    @method()
    GETMINHSPRIORITY(): int {
        return this.minHSPriority
    }

    @method()
    SETMINHSPRIORITY(priority: int) {
        this.minHSPriority = priority
    }

    @method()
    GETPLAYINGANIMO(targetGroupName: string) {
        const targetGroup = this.engine.getObject<Group>(targetGroupName)
        if (targetGroup === null || !(targetGroup instanceof Group)) {
            return
        }

        targetGroup.removeAll()

        const scope = this.engine.currentScene?.scope
        if (!scope) {
            return
        }

        for (const value of scope.content.values()) {
            if (value instanceof Animo && value.isPlaying) {
                targetGroup.add(value)
            }
        }
    }

    // Pauses everything that is running in the scene, RESUME continues exactly those objects
    @method()
    PAUSE() {
        if (this.pausedObjects !== null || this.scope === null) {
            return
        }

        this.pausedObjects = []
        for (const object of this.scope.objects) {
            const running =
                (object instanceof Animo && object.isPlaying) ||
                ((object instanceof Sequence || object instanceof Sound) && object.ISPLAYING()) ||
                (object instanceof Timer && object.isEnabled)
            if (running) {
                this.pausedObjects.push(object as Animo | Sequence | Sound | Timer)
            }
        }

        for (const object of this.pausedObjects) {
            if (object instanceof Timer) {
                object.DISABLE()
            } else {
                object.PAUSE()
            }
        }
    }

    @method()
    async RESUME() {
        const pausedObjects = this.pausedObjects ?? []
        this.pausedObjects = null
        for (const object of pausedObjects) {
            if (object instanceof Timer) {
                object.ENABLE()
            } else {
                await object.RESUME()
            }
        }
    }

    @method()
    REMOVECLONES(objectName: string, from: int, to: int) {
        this.getObject(objectName)?.removeClones(from, to)
    }

    @method()
    ISPAUSED(): boolean {
        return this.pausedObjects !== null
    }

    public getRelativePath(filename: string) {
        const scenePath = pathJoin('DANE', this.definition.PATH)
        return this.engine.resolvePath(filename, scenePath)
    }
}
