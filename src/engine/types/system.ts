import { Type } from './index'
import { SystemDefinition } from '../../fileFormats/cnv/types'
import { method, int } from '../../common/types'

export class System extends Type<SystemDefinition> {
    // Milliseconds counter, scripts use it to measure intervals
    @method()
    GETSYSTEMTIME(): int {
        return Math.floor(performance.now())
    }

    // Czarodzieje only enables scrolling backgrounds in minigames above 799 MHz, report a fast machine
    @method()
    GETMHZ(): int {
        return 1000
    }

    @method()
    GETDATE(): int {
        const date = new Date()
        return date.getDate() - 0xf41db + (date.getMonth() + (date.getFullYear() - 1900) * 100) * 100
    }
}
