import { TestEngine } from '../../common/testUtils'
import { CanvasObserver } from './canvasObserver'

describe('CANVAS_OBSERVER', () => {
    let engine: TestEngine
    const globals = globalThis as any

    beforeEach(() => {
        engine = new TestEngine()
        // Tests run without a DOM; the observer only needs the window's focus events
        globals.window = new EventTarget()
    })

    afterEach(() => {
        delete globals.window
    })

    test('window focus changes run ONWINDOWFOCUSON/OFF in the next tick once ENABLENOTIFY(TRUE) is called', async () => {
        const focusOn = engine.integer('FOCUSON')
        const focusOff = engine.integer('FOCUSOFF')
        await engine.load(`
OBJECT=CANVASOBSERVER
CANVASOBSERVER:TYPE=CANVAS_OBSERVER
CANVASOBSERVER:ONWINDOWFOCUSON={FOCUSON^INC();}
CANVASOBSERVER:ONWINDOWFOCUSOFF={FOCUSOFF^INC();}
`)
        const observer = engine.getObject<CanvasObserver>('CANVASOBSERVER')!

        globals.window.dispatchEvent(new Event('blur'))
        await observer.tick()
        expect(focusOff.getValue()).toBe(0)

        await engine.run('CANVASOBSERVER^ENABLENOTIFY(TRUE);')
        globals.window.dispatchEvent(new Event('blur'))
        expect(focusOff.getValue()).toBe(0)
        await observer.tick()
        expect(focusOff.getValue()).toBe(1)

        globals.window.dispatchEvent(new Event('focus'))
        await observer.tick()
        expect(focusOn.getValue()).toBe(1)

        observer.destroy()
        globals.window.dispatchEvent(new Event('blur'))
        await observer.tick()
        expect(focusOff.getValue()).toBe(1)
        expect(engine.errors).toEqual([])
    })
})
