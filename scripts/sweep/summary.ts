export type SceneResult = {
    errors: number
    warnings: number
    // The scene the game was in at the end, which differs when the scene moved on by itself
    endScene: string | null
}

export type Summary = Record<string, SceneResult>

export const isError = (line: string) => line.startsWith('[error]') || line.startsWith('[pageerror]')

// One line per distinct problem with the scenes it happened in. Script stack traces ("\t@ ...") are
// reduced to their innermost frame, which names the failing call.
export const groupErrors = (logs: Record<string, string[]>): Map<string, Set<string>> => {
    const groups = new Map<string, Set<string>>()
    const add = (key: string, scene: string) => {
        if (!groups.has(key)) {
            groups.set(key, new Set())
        }
        groups.get(key)!.add(scene)
    }

    for (const [scene, lines] of Object.entries(logs)) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (!isError(line)) {
                continue
            }
            if (line.startsWith('[error] \t@')) {
                let last = line
                while (i + 1 < lines.length && lines[i + 1].startsWith('\t@')) {
                    last = lines[++i]
                }
                add('  at ' + last.replace('[error]', '').trim().slice(0, 150), scene)
            } else if (!line.includes('Error occured during method') && !line.includes('leak detected')) {
                add(line.split('\n')[0].slice(0, 160), scene)
            }
        }
    }
    return groups
}

export const formatGroups = (groups: Map<string, Set<string>>): string =>
    [...groups.entries()]
        .sort((a, b) => b[1].size - a[1].size)
        .map(([message, scenes]) => `${String(scenes.size).padStart(3)} ${message}   [${[...scenes].sort().join(',')}]`)
        .join('\n')

// Scenes that got more errors than in the baseline, or that the baseline didn't have and that have errors
export const regressions = (summary: Summary, baseline: Summary): string[] =>
    Object.entries(summary)
        .filter(([scene, result]) => result.errors > (baseline[scene]?.errors ?? 0))
        .map(([scene, result]) => `${scene}: ${baseline[scene]?.errors ?? 'new'} -> ${result.errors} errors`)
