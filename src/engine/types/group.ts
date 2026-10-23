import { Type } from './index'
import { GroupDefinition } from '../../fileFormats/cnv/types'
import { method, int } from '../../common/types'
import { logger } from '../logging'
import { ClassInstance } from './class'

export class Group extends Type<GroupDefinition> {
    private objects: any[] = []
    private marker = 0

    async ready() {
        await this.callbacks.run('ONINIT')
    }

    @method()
    ADD(...objectsNames: string[]) {
        objectsNames.forEach((objectName) => {
            const object = this.getObject(objectName)
            if (object === null) {
                logger.warn(`Script was trying to add non-existing object "${objectName}" to a group "${this.name}"`, {
                    group: this,
                })
            } else {
                this.objects.push(object)
            }
        })
    }

    @method()
    REMOVE(...objectsNames: string[]) {
        this.objects = this.objects.filter((object) => !objectsNames.includes(object.name))
    }

    // Adds the object's clones number `from` to `to`; number 0 is the object itself, like NAME_0 in Kapitan Nemo:
    // ANNNAKLADKI^CLONE([I1-1]);GENEMIES^ADDCLONES("ANNNAKLADKI",0,[I1-1]);
    @method()
    ADDCLONES(objectName: string, from: int, to: int) {
        const object = this.getObject(objectName)
        if (object === null) {
            logger.warn(
                `Script was trying to add clones of non-existing object "${objectName}" to a group "${this.name}"`
            )
            return
        }
        for (let i = from; i <= to; i++) {
            const member = i === 0 ? object : object.clones[i - 1]
            if (member !== undefined) {
                this.objects.push(member)
            }
        }
    }

    @method()
    GETSIZE(): int {
        return this.objects.length
    }

    // The marker iterates over the members in the original; only its position is kept
    @method()
    SETMARKERPOS(position: int) {
        this.marker = position
    }

    @method()
    GETMARKERPOS(): int {
        return this.marker
    }

    async __call(methodName: string, args: any[]) {
        for (const object of this.objects) {
            if (methodName in object) {
                await object[methodName](...args)
            } else if (object instanceof ClassInstance) {
                // Methods of class instances are their behaviours, e.g. Kapitan Nemo's GENEMIES^NEXTSTEP()
                await object.__call(methodName, args)
            } else {
                const argumentsString = args?.map((arg) => typeof arg).join(', ')
                logger.warn(
                    `Method '${methodName}(${argumentsString ?? ''})' does not exist in ${object.constructor.name}`,
                    {
                        object,
                        args,
                    }
                )
            }
        }
    }

    add(object: Type<any>) {
        this.objects.push(object)
    }

    removeAll(): void {
        this.objects = []
    }
}
