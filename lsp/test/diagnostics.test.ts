import { createService, lines, uri } from './helpers'

const diagnose = (text: string, extraFiles: Record<string, string> = {}) => {
    const service = createService({ 'scene.cnv': text, ...extraFiles })
    return service.problems(uri('scene.cnv')).map((problem) => ({
        code: problem.code,
        severity: problem.severity,
        text: text.slice(problem.span.start, problem.span.end),
        message: problem.message,
    }))
}

const codes = (text: string, extraFiles: Record<string, string> = {}) =>
    diagnose(text, extraFiles).map((problem) => `${problem.code}:${problem.text}`)

describe('diagnostics', () => {
    test('a clean file has none', () => {
        const text = lines(
            'OBJECT=ANIMOREKSIO',
            'ANIMOREKSIO:TYPE=ANIMO',
            'ANIMOREKSIO:VISIBLE=TRUE',
            'ANIMOREKSIO:FILENAME=REKSIO.ANN',
            'ANIMOREKSIO:TOCANVAS=TRUE',
            'ANIMOREKSIO:ONFINISHED^WALK={THIS^PLAY("STAND");}',
            'OBJECT=VARI',
            'VARI:TYPE=INTEGER',
            'VARI:VALUE=0',
            'OBJECT=BEHGO',
            'BEHGO:TYPE=BEHAVIOUR',
            'BEHGO:CODE={ANIMOREKSIO^PLAY("WALK");VARI^ADD([VARI^GET()+1]);@IF("VARI",">","5","BEHSTOP","");RANDOM^GET(5);}',
            'OBJECT=BEHSTOP',
            'BEHSTOP:TYPE=BEHAVIOUR',
            'BEHSTOP:CODE={@LOOP("{ANIMOREKSIO^SETPOSITION(_I_,0);}",0,10,1);}'
        )
        expect(diagnose(text)).toEqual([])
    })

    test('reports parse errors in code blocks', () => {
        // A bracket expression can't start with an operator
        expect(codes(lines('OBJECT=B', 'B:TYPE=BEHAVIOUR', 'B:CODE={VARI^SET([-1+2]);}'))).toContainEqual(
            'parse-error:VARI^SET([-1+2]);'
        )
    })

    test('reports unknown globals', () => {
        expect(codes(lines('OBJECT=B', 'B:TYPE=BEHAVIOUR', 'B:CODE={@CONTINUE();}'))).toEqual([
            'unknown-global:CONTINUE',
        ])
    })

    test('reports methods the TYPE of the object lacks', () => {
        const text = lines(
            'OBJECT=BTN',
            'BTN:TYPE=BUTTON',
            'BTN:ENABLE=TRUE',
            'OBJECT=B',
            'B:TYPE=BEHAVIOUR',
            'B:CODE={BTN^DISABLEBUTVISIBE();BTN^DISABLEBUTVISIBLE();}'
        )
        const problems = diagnose(text)
        expect(problems).toHaveLength(1)
        expect(problems[0]).toMatchObject({ code: 'unknown-method', severity: 'warning', text: 'DISABLEBUTVISIBE' })
        expect(problems[0].message).toContain('BUTTON')
    })

    test('checks THIS in event callbacks but not in behaviours', () => {
        const text = lines(
            'OBJECT=T',
            'T:TYPE=TIMER',
            'T:ELAPSE=100',
            'T:ONTICK={THIS^DISBLE();}',
            'OBJECT=B',
            'B:TYPE=BEHAVIOUR',
            'B:CODE={THIS^ANYTHING();}'
        )
        expect(codes(text)).toEqual(['unknown-method:DISBLE'])
    })

    test('skips GROUP calls, indirect calls and CLASS instances', () => {
        const text = lines(
            'OBJECT=GRP',
            'GRP:TYPE=GROUP',
            'OBJECT=CLS',
            'CLS:TYPE=CLASS',
            'CLS:DEF=MENU.CLASS',
            'OBJECT=B',
            'B:TYPE=BEHAVIOUR',
            'B:CODE={GRP^PLAY("X");*["ANIMO"+$1]^NOSUCH();CLS^NEW("MENU1");MENU1^SHOWMENU();MENU1^NOSUCH();$1^NOSUCH();}'
        )
        const classFile = lines('OBJECT=SHOWMENU', 'SHOWMENU:TYPE=BEHAVIOUR', 'SHOWMENU:CODE={}')
        expect(codes(text, { 'menu.class': classFile })).toEqual(['unknown-method:NOSUCH'])
        // Without the class file nothing is known about the instance's behaviours
        expect(codes(text)).toEqual([])
    })

    test('checks methods on STRUCT fields and @INT locals', () => {
        const text = lines(
            'OBJECT=SLINE',
            'SLINE:TYPE=STRUCT',
            'SLINE:FIELDS=NAME<STRING>,COUNT<INTEGER>',
            'OBJECT=B',
            'B:TYPE=BEHAVIOUR',
            'B:CODE={SLINE|NAME^UPPER();SLINE|COUNT^UPPER();@INT("DX",0);DX^ADD(1);DX^UPPER();COUNT^INC();}'
        )
        expect(codes(text)).toEqual(['unknown-method:UPPER', 'unknown-method:UPPER'])
    })

    test('reports missing arguments', () => {
        const text = lines('OBJECT=I', 'I:TYPE=INTEGER', 'OBJECT=B', 'B:TYPE=BEHAVIOUR', 'B:CODE={I^CLAMP(1);}')
        expect(codes(text)).toEqual(['missing-arguments:CLAMP'])
    })

    test('reports unknown properties, bad values and the TYPE order', () => {
        const text = lines(
            'OBJECT=A',
            'A:VISIBLE=TRUE',
            'A:TYPE=ANIMO',
            'A:VISIBLE=MAYBE',
            'A:ONCLICKED={}',
            'B:TYPE=ANIMO',
            'OBJECT=C',
            'C:TYPE=SPRITE'
        )
        expect(codes(text)).toEqual([
            'property-of-undeclared-object:B',
            'property-before-type:VISIBLE',
            'invalid-value:MAYBE',
            'unknown-property:ONCLICKED',
            'unknown-type:SPRITE',
        ])
    })

    test('reports callback values that are neither code nor a behaviour', () => {
        const text = lines(
            'OBJECT=C',
            'C:TYPE=CONDITION',
            'C:OPERAND1=1',
            'C:OPERAND2=1',
            'C:OPERATOR=EQUAL',
            'C:ONRUNTIMESUCCESS=ARRSPEED^CHANGEAT(1,1.0)'
        )
        expect(codes(text)).toEqual(['invalid-callback:ARRSPEED^CHANGEAT(1,1.0)'])
    })

    test('hints at undeclared objects only', () => {
        const text = lines('OBJECT=B', 'B:TYPE=BEHAVIOUR', 'B:CODE={NOWHERE^PLAY();@IF("X","_","1","NOBEH","");}')
        const problems = diagnose(text)
        expect(problems.map((problem) => [problem.code, problem.severity, problem.text])).toEqual([
            ['undeclared', 'hint', 'NOWHERE'],
            ['undeclared', 'hint', 'NOBEH'],
        ])
        const service = createService({ 'scene.cnv': text }, { undeclaredHints: false })
        expect(service.problems(uri('scene.cnv'))).toEqual([])
    })

    test('resolves objects through the scene, episode and application files', () => {
        const files = {
            'DANE/Application.def': lines(
                'OBJECT=APP',
                'APP:TYPE=APPLICATION',
                'APP:PATH=GAME',
                'OBJECT=EP',
                'EP:TYPE=EPISODE',
                'EP:PATH=GAME\\EP',
                'EP:SCENES=S1',
                'OBJECT=S1',
                'S1:TYPE=SCENE',
                'S1:PATH=GAME\\EP\\S1'
            ),
            'DANE/GAME/APP.cnv': lines('OBJECT=VARGLOBAL', 'VARGLOBAL:TYPE=STRING'),
            'DANE/GAME/EP/EP.cnv': lines('OBJECT=TIMEP', 'TIMEP:TYPE=TIMER'),
            'DANE/game/ep/s1/s1.cnv': lines(
                'OBJECT=B',
                'B:TYPE=BEHAVIOUR',
                'B:CODE={VARGLOBAL^UPPER();VARGLOBAL^PLAY();TIMEP^GETTICKS();TIMEP^PLAY();EP^GOTO("S1");S1^PLAY();}'
            ),
        }
        const service = createService(files)
        const problems = service.problems(uri('DANE/game/ep/s1/s1.cnv'))
        expect(problems.map((problem) => problem.message)).toEqual([
            'VARGLOBAL (STRING) has no method PLAY in ReksioEngine',
            'TIMEP (TIMER) has no method PLAY in ReksioEngine',
            'S1 (SCENE) has no method PLAY in ReksioEngine',
        ])
    })

    test('turns the diagnostics into LSP ranges', () => {
        const text = lines('OBJECT=B', 'B:TYPE=BEHAVIOUR', 'B:CODE={ @NOPE ( ) ; }')
        const service = createService({ 'scene.cnv': text })
        const [diagnostic] = service.diagnostics(uri('scene.cnv'))
        expect(diagnostic.range).toEqual({ start: { line: 2, character: 10 }, end: { line: 2, character: 14 } })
        expect(diagnostic.source).toBe('reksio')
    })
})
