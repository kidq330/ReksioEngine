// Documentation of the @globals for hover and completion (spec §4.8). Which globals exist comes from the engine
// (createGlobalHandlers in src/interpreter/interpreter.ts); this only describes them.
export const GLOBAL_DOCS: Record<string, { signature: string; description: string }> = {
    IF: {
        signature: '@IF(a, op, b, then, else)  |  @IF(condition, then, else)',
        description:
            'Five arguments: compares `a` and `b` with `_` `!_` `<` `>` `<_` `>_`; string operands are run as code. ' +
            "Three arguments: a condition like `A'1&&B>2` (`'` `!'` `<` `>` `<'` `>'` `?`, `&&` or `||`). " +
            '`then`/`else` are `{code}`, a behaviour name or `""`.',
    },
    LOOP: {
        signature: '@LOOP(code, start, count, step)',
        description: 'Runs `code` for `_I_` = start, start+step, … while `_I_` < start+count.',
    },
    WHILE: {
        signature: '@WHILE(a, op, b, code)',
        description: 'Runs `code` while the comparison holds, with the operand rules of the five-argument @IF.',
    },
    BREAK: { signature: '@BREAK()', description: 'Stops the enclosing loop or behaviour.' },
    RETURN: {
        signature: '@RETURN(value)',
        description: 'Ends the running behaviour (also from @IF branches and loop bodies) and returns `value`.',
    },
    MSGBOX: { signature: '@MSGBOX(text)', description: 'Debugging message box; ReksioEngine logs it.' },
    INT: {
        signature: '@INT("NAME", value)',
        description: 'Declares a local INTEGER, visible to the behaviours the block runs.',
    },
    STRING: {
        signature: '@STRING("NAME", value)',
        description: 'Declares a local STRING, visible to the behaviours the block runs.',
    },
    BOOL: {
        signature: '@BOOL("NAME", value)',
        description: 'Declares a local BOOL, visible to the behaviours the block runs.',
    },
    DOUBLE: {
        signature: '@DOUBLE("NAME", value)',
        description: 'Declares a local DOUBLE, visible to the behaviours the block runs.',
    },
}
