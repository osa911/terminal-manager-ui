// Pre-warm audio context on first user interaction (browser autoplay policy)
let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

// Resume context on first click (required by browsers)
document.addEventListener('click', () => {
  if (audioCtx?.state === 'suspended') audioCtx.resume();
}, { once: true });

/** Gentle two-note ascending chime — AI finished processing. */
export function playDoneChime(): void {
  const ctx = getCtx();
  if (ctx.state === 'suspended') return;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.35, ctx.currentTime);
  master.connect(ctx.destination);

  const notes = [
    { freq: 523.25, start: 0, dur: 0.35 },    // C5
    { freq: 783.99, start: 0.18, dur: 0.55 },  // G5
  ];

  for (const { freq, start, dur } of notes) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime + start);

    const t0 = ctx.currentTime + start;
    env.gain.setValueAtTime(0.001, t0);
    env.gain.exponentialRampToValueAtTime(1, t0 + 0.015);
    env.gain.exponentialRampToValueAtTime(0.5, t0 + 0.08);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + dur);

    osc.connect(env).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
}

/** Urgent double-beep — AI is asking a question / needs attention. */
export function playAttentionSound(): void {
  const ctx = getCtx();
  if (ctx.state === 'suspended') return;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.4, ctx.currentTime);
  master.connect(ctx.destination);

  const beeps = [
    { start: 0, freq: 880 },     // A5
    { start: 0.18, freq: 1047 }, // C6
  ];

  for (const { start, freq } of beeps) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, ctx.currentTime + start);

    const t0 = ctx.currentTime + start;
    env.gain.setValueAtTime(0.001, t0);
    env.gain.exponentialRampToValueAtTime(1, t0 + 0.01);
    env.gain.setValueAtTime(1, t0 + 0.08);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);

    osc.connect(env).connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.18);
  }
}
