/**
 * The observatory's music.
 *
 * A single, lazily-created `AudioContext` that synthesises a calm instrumental
 * bed in the browser: slow pad chords, a sparse piano figure drawn from the
 * same harmony, a little air, and a soft space around all of it.
 *
 * Why generated rather than a file
 * --------------------------------
 * A shipped recording would need a licence this project cannot invent, and a
 * broken or misattributed audio control is worse than none. Everything here is
 * produced by the Web Audio API from oscillators and filters, so there is no
 * third-party asset, no download, no runtime request and nothing to attribute.
 * It also means the loop is genuinely seamless: the scheduler places every
 * event on the audio clock, so there is no seam to hear and nothing to buffer.
 *
 * Every sound begins after an explicit gesture
 * -------------------------------------------
 * Browsers refuse to start an `AudioContext` without one and they are right
 * to. The context is therefore created on the visitor's press — "Enter with
 * sound" on the welcome card, or the sound control in the chrome — and never
 * before. A remembered preference is only ever a request: if the browser
 * refuses on a later visit, playback simply does not start and the control
 * says so, because a control that claims to be playing silence is a lie.
 *
 * One instance, and it survives navigation
 * ----------------------------------------
 * The engine is a module-level singleton, so the client router swapping the
 * page around it cannot create a second one — the same rule the renderer
 * follows.
 */

export type AudioPreference = 'on' | 'off' | 'unset';

const SOUND_KEY = 'world:sound';
const VOLUME_KEY = 'world:volume';
const NOTE_KEY = 'world:sound-noted';

/** Conservative: a bed, not a performance. */
const DEFAULT_VOLUME = 0.3;
/** Anything quieter than this is silent, and muting it is the honest move. */
const MIN_AUDIBLE = 0.005;

export interface AudioState {
  /** True only while sound is actually coming out of the speakers. */
  playing: boolean;
  /** True when the visitor has asked for sound, whether or not it started. */
  wanted: boolean;
  volume: number;
  /** Set when the browser refused to start, so the interface can say so. */
  blocked: boolean;
}

/* ── Preferences ─────────────────────────────────────────────────────── */

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSoundPreference(): AudioPreference {
  const store = storage();
  if (!store) return 'unset';
  try {
    const value = store.getItem(SOUND_KEY);
    return value === 'on' || value === 'off' ? value : 'unset';
  } catch {
    return 'unset';
  }
}

export function readVolume(): number {
  const store = storage();
  if (!store) return DEFAULT_VOLUME;
  try {
    const raw = Number(store.getItem(VOLUME_KEY));
    /* Anything that is not a usable level falls back to the default rather
       than starting silent — a zero nobody chose is indistinguishable from a
       broken control. */
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function writePreference(next: AudioPreference, volume: number): void {
  const store = storage();
  try {
    store?.setItem(SOUND_KEY, next);
    store?.setItem(VOLUME_KEY, String(volume));
  } catch {
    /* storage unavailable — the choice lasts for this visit */
  }
}

/** True once the visitor has answered the welcome card at least once. */
export function hasVisited(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    return store.getItem(NOTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markVisited(): void {
  const store = storage();
  try {
    store?.setItem(NOTE_KEY, '1');
  } catch {
    /* storage unavailable — the card simply appears again */
  }
}

/* ── The score ───────────────────────────────────────────────────────── */

/**
 * The harmony, in semitones from A2.
 *
 * Am7 → Fmaj7 → Cmaj7 → G6, one bar each. It is the most ordinary turn in
 * ambient music and it is ordinary on purpose: nothing here should be the
 * thing a visitor notices.
 */
const A2 = 110;
const CHORDS: number[][] = [
  [0, 12, 15, 19, 24], // A  C  E  G   A
  [-4, 8, 12, 17, 20], // F  C  F  A   C
  [3, 15, 19, 22, 27], // C  G  C  E   G
  [-2, 10, 14, 17, 22], // G  D  G  B   D
];
/** The pentatonic the piano line is drawn from, in the same semitone space. */
const MELODY = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22];
const BPM = 52;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
/** How far ahead the scheduler places events, in seconds. */
const LOOKAHEAD = 2.4;
const TICK_MS = 400;

function semitone(root: number, steps: number): number {
  return root * Math.pow(2, steps / 12);
}

/* ── The engine ──────────────────────────────────────────────────────── */

class AmbientEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private noiseSource: AudioBufferSourceNode | null = null;

  private readonly listeners = new Set<(state: AudioState) => void>();
  private timer = 0;
  private scheduled = 0;
  private bar = 0;
  private wanted = false;
  private playing = false;
  private blocked = false;
  private volume = DEFAULT_VOLUME;
  private disposed = false;
  /** True when the page hid while playing, so coming back resumes it. */
  private resumeAfterHidden = false;

  constructor() {
    this.volume = readVolume();
    this.wanted = readSoundPreference() === 'on';
  }

  get state(): AudioState {
    return {
      playing: this.playing,
      wanted: this.wanted,
      volume: this.volume,
      blocked: this.blocked,
    };
  }

  subscribe(listener: (state: AudioState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }

  /** Build the graph. Only ever called from a visitor's gesture. */
  private ensureContext(): AudioContext | null {
    if (this.disposed) return null;
    if (this.context) return this.context;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.blocked = true;
      return null;
    }
    let context: AudioContext;
    try {
      context = new Ctor();
    } catch {
      this.blocked = true;
      return null;
    }
    this.context = context;

    /*
     * Output chain: a gentle low-pass so nothing is ever brittle, a soft
     * compressor so a stacked chord cannot clip, and then the master gain the
     * visitor actually controls.
     */
    const shelf = context.createBiquadFilter();
    shelf.type = 'lowpass';
    shelf.frequency.value = 5200;
    shelf.Q.value = 0.4;

    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.05;
    compressor.release.value = 0.6;

    const master = context.createGain();
    master.gain.value = 0;

    shelf.connect(compressor);
    compressor.connect(master);
    master.connect(context.destination);

    const bus = context.createGain();
    bus.gain.value = 1;
    bus.connect(shelf);

    /*
     * Space. A short, decorrelated impulse built from noise gives the pad a
     * room without a file; the send keeps the piano dry enough to read.
     */
    const convolver = context.createConvolver();
    convolver.buffer = this.impulse(context, 3.4, 2.4);
    const send = context.createGain();
    send.gain.value = 0.42;
    send.connect(convolver);
    convolver.connect(shelf);

    this.master = master;
    this.musicBus = bus;
    this.reverbSend = send;

    /* A quiet bed of filtered noise: the air in the room. */
    const noise = context.createBufferSource();
    noise.buffer = this.noise(context, 4);
    noise.loop = true;
    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 900;
    noiseFilter.Q.value = 0.35;
    const noiseGain = context.createGain();
    noiseGain.gain.value = 0.016;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(bus);
    noiseGain.connect(send);
    noise.start();
    this.noiseSource = noise;

    return context;
  }

  /** A decaying noise burst, used as a small, cheap room. */
  private impulse(context: AudioContext, seconds: number, decay: number): AudioBuffer {
    const rate = context.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = context.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        /* Slight decorrelation between the channels widens the image. */
        const offset = channel === 0 ? 1 : 0.94;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * offset;
      }
    }
    return buffer;
  }

  private noise(context: AudioContext, seconds: number): AudioBuffer {
    const rate = context.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = context.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    /* A one-pole filter over white noise, so it is brown-ish rather than hiss. */
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    return buffer;
  }

  /**
   * Start playing because the visitor asked. Returns false if the browser
   * refused, which the interface reports rather than papering over.
   */
  async play(options: { fadeMs?: number } = {}): Promise<boolean> {
    this.wanted = true;
    writePreference('on', this.volume);
    const context = this.ensureContext();
    if (!context || !this.master) {
      this.playing = false;
      this.emit();
      return false;
    }
    try {
      if (context.state === 'suspended') await context.resume();
    } catch {
      this.blocked = true;
      this.playing = false;
      this.emit();
      return false;
    }
    if (context.state !== 'running') {
      this.blocked = true;
      this.playing = false;
      this.emit();
      return false;
    }
    this.blocked = false;
    this.playing = true;
    /* A gentle fade in, so the music arrives rather than starts. */
    const fade = Math.max(0.4, (options.fadeMs ?? 2400) / 1000);
    const now = context.currentTime;
    const target = this.effectiveGain();
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(target, now + fade);
    /* Line the clock up with the next bar boundary before scheduling. */
    this.scheduled = Math.max(this.scheduled, now + 0.25);
    this.startScheduler();
    this.emit();
    return true;
  }

  /**
   * Stop, with a fade. The context stays alive so resuming is instant.
   *
   * `wanted` is what the *visitor* asked for and `playing` is what is actually
   * happening; they are deliberately not the same thing. A pause the visitor
   * pressed clears the request, but a pause the page performed on their behalf
   * — because the tab went to the background — must not, or coming back would
   * find that nobody wants the music any more and quietly leave it off.
   */
  pause(options: { fadeMs?: number; forget?: boolean } = {}): void {
    if (options.forget !== false) this.wanted = false;
    this.stopScheduler();
    writePreference(this.wanted ? 'on' : 'off', this.volume);
    const context = this.context;
    if (context && this.master) {
      const fade = Math.max(0.15, (options.fadeMs ?? 700) / 1000);
      const now = context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(0, now + fade);
    }
    this.playing = false;
    this.emit();
  }

  /** Mute without giving up the visitor's preference to hear it. */
  async toggle(): Promise<boolean> {
    if (this.playing) {
      this.pause();
      return false;
    }
    return this.play();
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    writePreference(this.wanted ? 'on' : 'off', this.volume);
    const context = this.context;
    if (context && this.master && this.playing) {
      const now = context.currentTime;
      const target = this.effectiveGain();
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(target, now + 0.12);
    }
    this.emit();
  }

  get volumeLevel(): number {
    return this.volume;
  }

  /**
   * The gain the master should sit at right now.
   *
   * The curve is deliberately not linear: at the top of the slider the music
   * should still be a bed under a conversation, and near the bottom it should
   * fade out rather than step.
   */
  private effectiveGain(): number {
    if (this.volume < MIN_AUDIBLE) return 0;
    return Math.pow(this.volume, 1.6) * 0.42;
  }

  /**
   * Pause because the page is hidden. `resumeAfter` remembers whether it was
   * playing so that coming back is a decision the visitor already made.
   */
  handleVisibility(hidden: boolean): void {
    if (hidden) {
      if (this.playing) {
        this.resumeAfterHidden = true;
        this.pause({ fadeMs: 500, forget: false });
      }
      return;
    }
    if (this.resumeAfterHidden && this.wanted) {
      this.resumeAfterHidden = false;
      /*
       * Honoured, not assumed. The context may have been suspended while the
       * page was away, so resuming is a request like any other start: if it is
       * refused, the controls say so rather than claiming to be playing.
       */
      void this.play({ fadeMs: 1400 });
    }
  }

  /* ── Scheduling ────────────────────────────────────────────────────── */

  private startScheduler(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.disposed) return;
      this.schedule();
      this.timer = window.setTimeout(tick, TICK_MS);
    };
    tick();
  }

  private stopScheduler(): void {
    if (!this.timer) return;
    window.clearTimeout(this.timer);
    this.timer = 0;
  }

  /** Place every event that starts inside the lookahead window. */
  private schedule(): void {
    const context = this.context;
    if (!context || !this.musicBus) return;
    const horizon = context.currentTime + LOOKAHEAD;
    if (this.scheduled < context.currentTime) this.scheduled = context.currentTime + 0.1;
    let guard = 0;
    while (this.scheduled < horizon && guard++ < 32) {
      this.placeBar(this.bar, this.scheduled);
      this.scheduled += BAR;
      this.bar = (this.bar + 1) % CHORDS.length;
    }
  }

  /** One bar: a pad chord, a piano figure, and a soft bell on the change. */
  private placeBar(bar: number, at: number): void {
    const context = this.context;
    const bus = this.musicBus;
    const send = this.reverbSend;
    if (!context || !bus || !send) return;
    const chord = CHORDS[bar % CHORDS.length];

    /* The pad: each note a pair of detuned oscillators through one filter. */
    const padGain = context.createGain();
    padGain.gain.value = 0.055;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(700, at);
    filter.frequency.linearRampToValueAtTime(1500, at + BAR * 0.6);
    filter.frequency.linearRampToValueAtTime(760, at + BAR);
    filter.Q.value = 0.7;
    filter.connect(padGain);
    padGain.connect(bus);
    const padSend = context.createGain();
    padSend.gain.value = 0.5;
    padGain.connect(padSend);
    padSend.connect(send);

    const attack = 1.4;
    const release = BAR + 1.2;
    chord.forEach((step, index) => {
      const frequency = semitone(A2, step);
      for (const detune of index % 2 === 0 ? [-5, 5] : [-3, 3]) {
        const osc = context.createOscillator();
        osc.type = index < 2 ? 'sine' : 'triangle';
        osc.frequency.value = frequency;
        osc.detune.value = detune;
        const voice = context.createGain();
        voice.gain.setValueAtTime(0, at);
        voice.gain.linearRampToValueAtTime(0.5, at + attack);
        voice.gain.setValueAtTime(0.5, at + BAR * 0.7);
        voice.gain.linearRampToValueAtTime(0, at + release);
        osc.connect(voice);
        voice.connect(filter);
        osc.start(at);
        osc.stop(at + release + 0.1);
      }
    });

    /*
     * The piano: two or three notes a bar, drawn from the pentatonic, placed
     * on beats with a deliberate avoid-the-downbeat spread so the line floats
     * over the pad rather than marching with it.
     */
    const figure = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < figure; i++) {
      const beat = Math.floor(Math.random() * 4);
      const offset = beat * BEAT;
      const step = MELODY[Math.floor(Math.random() * MELODY.length)];
      this.placePiano(semitone(A2 * 2, step), at + offset, 0.11 + Math.random() * 0.05);
    }

    /* One low note on the change, to mark the bar without a drum. */
    this.placePiano(semitone(A2 * 0.5, chord[0]), at, 0.085, 3.2);
  }

  /**
   * A piano-ish voice: a fast attack and a long decay, with a quiet octave
   * above it for the hammer. Not a piano — a small, warm bell that sits in
   * the same room as the pad.
   */
  private placePiano(frequency: number, at: number, level: number, decay = 2.1): void {
    const context = this.context;
    const bus = this.musicBus;
    const send = this.reverbSend;
    if (!context || !bus || !send) return;

    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + decay);

    const body = context.createOscillator();
    body.type = 'sine';
    body.frequency.value = frequency;
    const hammer = context.createOscillator();
    hammer.type = 'triangle';
    hammer.frequency.value = frequency * 2.002;
    const hammerGain = context.createGain();
    hammerGain.gain.value = 0.22;

    const tone = context.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2600;

    body.connect(envelope);
    hammer.connect(hammerGain);
    hammerGain.connect(envelope);
    envelope.connect(tone);
    tone.connect(bus);
    const out = context.createGain();
    out.gain.value = 0.6;
    tone.connect(out);
    out.connect(send);

    body.start(at);
    hammer.start(at);
    body.stop(at + decay + 0.1);
    hammer.stop(at + decay + 0.1);
  }

  /* ── Teardown ──────────────────────────────────────────────────────── */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopScheduler();
    try {
      this.noiseSource?.stop();
    } catch {
      /* already stopped */
    }
    void this.context?.close();
    this.context = null;
    this.listeners.clear();
  }
}

let engine: AmbientEngine | null = null;

/**
 * The one engine.
 *
 * Guarded on `window` so that importing this module from anything that might
 * run during server rendering cannot create an audio context where there is
 * no audio hardware.
 */
export function ambient(): AmbientEngine {
  if (typeof window === 'undefined') {
    /* A throwaway, so callers do not have to null-check on the server. */
    return new AmbientEngine();
  }
  const host = window as unknown as { __abdAmbient?: AmbientEngine };
  if (!host.__abdAmbient) host.__abdAmbient = new AmbientEngine();
  engine = host.__abdAmbient;
  return engine;
}

/**
 * Start the music from a visitor's gesture, if they have asked for it.
 *
 * Used on a later visit: the preference is honoured *as a request*. If the
 * browser refuses, nothing is claimed and the control reports it — which is
 * the only honest way to handle a rule the page cannot override.
 */
export async function resumeIfWanted(): Promise<void> {
  const sound = ambient();
  if (readSoundPreference() !== 'on') return;
  await sound.play({ fadeMs: 3000 });
}

export { DEFAULT_VOLUME };
