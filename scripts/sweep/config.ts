import * as fs from 'fs'
import * as path from 'path'

export type GameConfig = {
    title: string
    // Scene to start in. Tested scenes are entered from the scene it hands over to, after `setup` runs,
    // so that they see the state a real game has. Without it each scene is loaded directly.
    prelude?: string
    // Script code run before entering a tested scene, e.g. starting a new game in a save slot
    setup?: string
    // Extra script code for particular scenes, run after `setup`, e.g. the minigame level a scene reads
    sceneSetup?: Record<string, string>
    // Locations that one scene (an ARCADE) loads from a variable, swept with --locations
    locations?: {
        scene: string
        prelude?: string
        // Script code selecting the location; %LOC% is replaced with its name
        code: string
        // Folder (relative to the game root, any case) whose .cnv files are the locations
        dir: string
        // Names to skip, upper case; * matches any text
        exclude?: string[]
    }
}

export const loadConfig = (file: string): Record<string, GameConfig> => JSON.parse(fs.readFileSync(file, 'utf8'))

// Finds a path inside root matching relativePath case-insensitively, as the games' files come in any case
export const findCaseInsensitive = (root: string, relativePath: string): string | null => {
    let current = root
    for (const part of relativePath.split('/').filter(Boolean)) {
        const entry = fs.readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase())
        if (entry === undefined) {
            return null
        }
        current = path.join(current, entry)
    }
    return current
}

const matches = (name: string, pattern: string) =>
    new RegExp(
        '^' +
            pattern
                .split('*')
                .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                .join('.*') +
            '$'
    ).test(name)

export const listLocations = (root: string, locations: NonNullable<GameConfig['locations']>): string[] => {
    const dir = findCaseInsensitive(root, locations.dir)
    if (dir === null) {
        throw new Error(`Locations folder ${locations.dir} not found in ${root}`)
    }
    return fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.cnv'))
        .map((name) => name.slice(0, -4).toUpperCase())
        .filter((name) => !(locations.exclude ?? []).some((pattern) => matches(name, pattern)))
        .sort()
}

// The game folder: --root, else REKSIO_GAME_<GAME>, else <REKSIO_GAMES_DIR>/<game>
export const resolveGameRoot = (game: string, root?: string): string | null =>
    root ??
    process.env[`REKSIO_GAME_${game.toUpperCase()}`] ??
    (process.env.REKSIO_GAMES_DIR ? path.join(process.env.REKSIO_GAMES_DIR, game) : null)
