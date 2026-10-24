import { Type } from './index'
import { SystemDefinition } from '../../fileFormats/cnv/types'
import { method, int } from '../../common/types'

export class System extends Type<SystemDefinition> {
    @method()
    GETYEAR(): int {
        return new Date().getFullYear()
    }

    @method()
    GETMONTH(): int {
        return new Date().getMonth() + 1
    }

    @method()
    GETDAY(): int {
        return new Date().getDate()
    }

    // 0 is Sunday, like in Windows' SYSTEMTIME
    @method()
    GETDAYOFWEEK(): int {
        return new Date().getDay()
    }

    @method()
    GETHOUR(): int {
        return new Date().getHours()
    }

    @method()
    GETMINUTES(): int {
        return new Date().getMinutes()
    }

    @method()
    GETSECONDS(): int {
        return new Date().getSeconds()
    }

    // Milliseconds counter, scripts use it to measure intervals
    @method()
    GETSYSTEMTIME(): int {
        return Math.floor(this.engine.clock.now())
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
