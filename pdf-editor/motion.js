// Tiny motion toolkit: a physical spring for values driven from JS, and spring-shaped easings for WAAPI.
export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Critically-tunable spring. `to()` retargets mid-flight and keeps velocity, so gestures never feel stuck. */
export class Spring {
  constructor(value = 0, { stiffness = 220, damping = 26, mass = 1, precision = 0.0005 } = {}) {
    Object.assign(this, { value, target: value, velocity: 0, stiffness, damping, mass, precision, subs: new Set(), raf: 0, last: 0 });
  }
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  snap(v) { this.value = this.target = v; this.velocity = 0; cancelAnimationFrame(this.raf); this.raf = 0; this.subs.forEach((f) => f(v, true)); }
  to(t) {
    this.target = t;
    if (reduced) return this.snap(t);
    if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame((n) => this.tick(n)); }
  }
  tick(now) {
    let dt = Math.min(0.064, (now - this.last) / 1000); this.last = now;
    const h = 1 / 240;                                  // fixed sub-steps keep stiff springs stable
    for (; dt > 0; dt -= h) {
      const s = Math.min(h, dt);
      const a = (-this.stiffness * (this.value - this.target) - this.damping * this.velocity) / this.mass;
      this.velocity += a * s; this.value += this.velocity * s;
    }
    const rest = Math.abs(this.velocity) < this.precision * 40 && Math.abs(this.value - this.target) < this.precision * Math.max(1, Math.abs(this.target));
    if (rest) { this.value = this.target; this.velocity = 0; this.raf = 0; this.subs.forEach((f) => f(this.value, true)); return; }
    this.subs.forEach((f) => f(this.value, false));
    this.raf = requestAnimationFrame((n) => this.tick(n));
  }
}

/** Sample a spring into a CSS `linear()` easing so WAAPI animations get real overshoot and settle. */
const cache = new Map();
export function springEase(stiffness = 260, damping = 22) {
  const key = stiffness + ':' + damping;
  if (cache.has(key)) return cache.get(key);
  let x = 0, v = 0, t = 0; const pts = [], h = 1 / 240;
  for (let i = 0; i < 240 * 3; i++) {
    v += (-stiffness * (x - 1) - damping * v) * h; x += v * h; t += h;
    if (i % 8 === 0) pts.push(+x.toFixed(4));
    if (Math.abs(v) < 0.001 && Math.abs(x - 1) < 0.0008 && i > 8) break;
  }
  pts.push(1);
  const out = { easing: `linear(${pts.join(',')})`, duration: Math.round(t * 1000) };
  cache.set(key, out); return out;
}

/** el.animate wrapper: honours reduced motion, always resolves, commits the end state. */
export function play(el, frames, { spring, duration = 260, easing = 'cubic-bezier(.2,.8,.2,1)', delay = 0, fill = 'both' } = {}) {
  if (!el || !el.animate) return Promise.resolve();
  if (reduced) { const last = frames[frames.length - 1]; Object.assign(el.style, last.opacity != null ? { opacity: last.opacity } : {}); return Promise.resolve(); }
  const s = spring ? springEase(...spring) : null;
  const a = el.animate(frames, { duration: s ? s.duration : duration, easing: s ? s.easing : easing, delay, fill });
  return a.finished.catch(() => {}).then(() => { try { a.commitStyles(); a.cancel(); } catch {} });
}

/** Smooth, interruptible scroll (ease-out quint). */
let scrollRaf = 0;
export function smoothScroll(el, top, ms = 520) {
  cancelAnimationFrame(scrollRaf);
  if (reduced) { el.scrollTop = top; return; }
  const from = el.scrollTop, t0 = performance.now();
  const step = (n) => {
    const p = Math.min(1, (n - t0) / ms), e = 1 - Math.pow(1 - p, 5);
    el.scrollTop = from + (top - from) * e;
    if (p < 1) scrollRaf = requestAnimationFrame(step);
  };
  scrollRaf = requestAnimationFrame(step);
}
export const stopScroll = () => cancelAnimationFrame(scrollRaf);
