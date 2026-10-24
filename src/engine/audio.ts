export type PlayOptions = {
    volume?: number // 0..1
    loop?: boolean
    rate?: number
    start?: number
    muted?: boolean

    onStart?: () => void
    onEnd?: () => void
    onStop?: () => void
}

export class EmptySoundError extends Error {
    constructor() {
        super('Failed to decode audio data: empty buffer')
        this.name = 'EmptySoundError'
    }
}

export class SoundInstance extends EventTarget {
    private parentSound: Sound

    private readonly manager: AudioManager
    // Created on the first real playback; with a virtual clock nothing reaches WebAudio
    private gain: GainNode | null = null

    private _isPlaying = false
    private _volume = 1
    private _muted = false

    private source: AudioBufferSourceNode | null = null
    private startedAt = 0
    private offset = 0
    private currentRate: number
    private initialOpts: Required<Pick<PlayOptions, 'loop' | 'rate'>> & PlayOptions

    private finished = false
    private stopRequested = false

    constructor(manager: AudioManager, parentSound: Sound, opts: PlayOptions = {}) {
        super()
        this.manager = manager
        this.parentSound = parentSound

        this.initialOpts = {
            loop: opts.loop ?? false,
            rate: opts.rate ?? 1,
            ...opts,
        }

        this.currentRate = this.initialOpts.rate
        this.volume = opts.volume ?? 1
        this.muted = opts.muted ?? false
    }

    private cleanupSource() {
        if (!this.source) {
            return
        }
        try {
            this.source.disconnect()
        } catch {
            /* ignore */
        }
        this.source = null
    }

    private finalize(reason: 'end' | 'stop' | 'pause') {
        if (this.finished) {
            return
        }
        this.finished = true

        this._isPlaying = false
        this.manager._setPlaying(this, false)
        this.cleanupSource()

        // Remove finished playbacks from the parent's list so instances don't accumulate. A paused one stays,
        // so that the sound's RESUME finds it.
        if (reason !== 'pause') {
            this.parentSound._removeInstance(this)
        }

        if (reason === 'end') {
            this.initialOpts.onEnd?.()
        }
        if (reason === 'stop') {
            this.initialOpts.onStop?.()
        }
    }

    private buildSource() {
        if (this.gain === null) {
            this.gain = new GainNode(this.manager.ctx)
            this.gain.connect(this.manager.master)
            this.applyGain()
        }
        const src = new AudioBufferSourceNode(this.manager.ctx, { buffer: this.parentSound.buffer })
        src.loop = this.initialOpts.loop
        src.playbackRate.value = this.initialOpts.rate
        src.connect(this.gain)

        src.addEventListener('ended', () => {
            if (this.stopRequested) {
                this.finalize('stop')
            } else {
                this.finalize('end')
            }
        })

        this.source = src
        return src
    }

    play() {
        this.finished = false
        this.stopRequested = false

        const startOffset = Math.max(0, this.initialOpts.start ?? this.offset)
        this.offset = startOffset
        this.startedAt = this.manager.currentTime
        if (!this.manager.isVirtual) {
            this.buildSource().start(0, startOffset)
        }
        this._isPlaying = true
        this.manager._setPlaying(this, true)
        this.initialOpts.onStart?.()

        return this
    }

    stop() {
        if (!this._isPlaying) {
            // A paused playback is discarded, so that RESUME doesn't bring it back
            this.parentSound._removeInstance(this)
            this.offset = 0
            return
        }
        this.stopRequested = true

        try {
            this.source?.stop()
        } catch {
            /* ignore */
        }
        this.finalize('stop')
        this.offset = 0
    }

    pause() {
        if (!this._isPlaying) {
            return
        }

        const elapsed = (this.manager.currentTime - this.startedAt) * this.currentRate
        this.offset = (this.offset + elapsed) % this.parentSound.buffer.duration

        try {
            this.source?.stop()
        } catch {
            /* ignore */
        }
        this.finalize('pause')
    }

    resume() {
        if (this._isPlaying || !this.finished) {
            return
        }
        this.play()
    }

    // With a virtual clock, ends the playback once the clock has passed the end of the sound
    advanceVirtual() {
        if (!this._isPlaying || this.initialOpts.loop) {
            return
        }
        const played = this.offset + (this.manager.currentTime - this.startedAt) * this.currentRate
        if (played >= this.parentSound.buffer.duration) {
            this.finalize('end')
        }
    }

    get isPlaying() {
        return this._isPlaying
    }

    private applyGain(): void {
        if (this.gain === null) {
            return
        }
        // If muted or volume is out of range, clamp accordingly
        this.gain.gain.value = this._muted ? 0 : Math.max(0, Math.min(1, this._volume))
    }

    get volume() {
        return this._volume
    }

    set volume(v: number) {
        this._volume = v
        this.applyGain()
    }

    get muted() {
        return this._muted
    }

    set muted(v: boolean) {
        this._muted = v
        this.applyGain()
    }

    set speed(v: number) {
        const newRate = Math.max(0.01, v)
        if (this._isPlaying) {
            const elapsed = (this.manager.currentTime - this.startedAt) * this.currentRate
            this.offset = (this.offset + elapsed) % this.parentSound.buffer.duration
            this.startedAt = this.manager.currentTime

            if (this.source) {
                this.source.playbackRate.value = newRate
            }
        }

        this.currentRate = newRate
    }

    get speed() {
        return this.currentRate
    }
}

export class Sound {
    public instances: SoundInstance[] = []
    // Playback rate relative to the original one, independent of the global speed
    public rate: number = 1
    public volume: number = 1

    constructor(
        private manager: AudioManager,
        public buffer: AudioBuffer,
        // Sample rate of the source file, as decodeAudioData resamples the buffer to the context's rate
        public readonly sampleRate: number = buffer.sampleRate
    ) {}

    setRate(rate: number) {
        this.rate = rate
        this.instances.forEach((instance) => (instance.speed = this.rate * this.manager.speed))
    }

    setVolume(volume: number) {
        this.volume = volume
        this.instances.forEach((instance) => (instance.volume = volume))
    }

    _removeInstance(inst: SoundInstance) {
        const i = this.instances.indexOf(inst)
        if (i >= 0) {
            this.instances.splice(i, 1)
        }
    }

    play(opts: PlayOptions = {}) {
        const instance = new SoundInstance(this.manager, this, {
            rate: this.rate * this.manager.speed,
            volume: this.volume,
            ...opts,
        })
        this.instances.push(instance)
        return instance.play()
    }

    stop() {
        for (const inst of [...this.instances]) {
            inst.stop()
        }
    }

    pause() {
        this.instances.slice().forEach((inst) => inst.pause())
    }

    resume() {
        this.instances.slice().forEach((inst) => inst.resume())
    }

    get isPlaying() {
        return this.instances.some((instance) => instance.isPlaying)
    }
}

export const readWavSampleRate = (data: ArrayBuffer): number | null => {
    if (data.byteLength < 12) {
        return null
    }

    const view = new DataView(data)
    const fourCC = (offset: number) => String.fromCharCode(...new Uint8Array(data, offset, 4))

    if (fourCC(0) !== 'RIFF' || fourCC(8) !== 'WAVE') {
        return null
    }

    let offset = 12
    while (offset + 8 <= data.byteLength) {
        const chunkSize = view.getUint32(offset + 4, true)
        if (fourCC(offset) === 'fmt ' && offset + 16 <= data.byteLength) {
            return view.getUint32(offset + 12, true)
        }
        offset += 8 + chunkSize + (chunkSize % 2)
    }
    return null
}

export class AudioManager {
    private _ctx: AudioContext | null = null
    private _master: GainNode | null = null
    private sounds: Sound[] = []
    public speed: number = 1
    // Seconds of a virtual clock that advance() moves, or null for the AudioContext's own clock. Sounds then
    // stay silent and end when the virtual clock passes their duration, so games run deterministically.
    private virtualTime: number | null = null

    useVirtualClock() {
        this.virtualTime = 0
    }

    get isVirtual() {
        return this.virtualTime !== null
    }

    get currentTime(): number {
        return this.virtualTime ?? this.ctx.currentTime
    }

    advance(seconds: number) {
        if (this.virtualTime === null) {
            return
        }
        this.virtualTime += seconds
        for (const instance of [...this.playing]) {
            instance.advanceVirtual()
        }
    }

    private playing = new Set<SoundInstance>()

    _setPlaying(instance: SoundInstance, playing: boolean) {
        if (playing) {
            this.playing.add(instance)
        } else {
            this.playing.delete(instance)
        }
    }

    get ctx(): AudioContext {
        if (this._ctx === null) {
            this._ctx = new AudioContext()
        }
        return this._ctx
    }

    get master(): GainNode {
        if (this._master === null) {
            this._master = new GainNode(this.ctx)
            this._master.connect(this.ctx.destination)
            this._master.gain.value = 1
        }
        return this._master
    }

    setMasterVolume(v: number) {
        this.master.gain.value = Math.max(0, Math.min(1, v))
    }

    async load(dataBuffer: ArrayBuffer) {
        if (dataBuffer.byteLength === 0) {
            throw new EmptySoundError()
        }

        const sampleRate = readWavSampleRate(dataBuffer)

        let buf: AudioBuffer
        try {
            buf = await this.ctx.decodeAudioData(dataBuffer)
        } catch (err) {
            throw new Error(`Failed to decode audio data: ${err instanceof Error ? err.message : String(err)}`)
        }

        const sound = new Sound(this, buf, sampleRate ?? buf.sampleRate)
        this.sounds.push(sound)
        return sound
    }

    stopAll() {
        for (const sound of [...this.sounds]) {
            sound.stop()
        }
    }

    setGlobalRate(v: number) {
        this.speed = v
        this.sounds.forEach((s) => s.instances.forEach((instance) => (instance.speed = s.rate * this.speed)))
    }

    pause() {
        this.sounds.forEach((s) => s.pause())
    }

    resume() {
        this.sounds.forEach((s) => s.resume())
    }
}

export const globalAudio = new AudioManager()
