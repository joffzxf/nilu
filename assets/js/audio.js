/**
 * 极简合成器：没有音频文件，三个音就够。
 * 第一次点击「开始」时解锁 AudioContext。
 */
export class Sound {
  constructor() {
    this.enabled = true;
    try {
      const saved = localStorage.getItem('nilu.sound');
      if (saved === 'off') this.enabled = false;
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.master = null;
    this.scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    try {
      this.ctx = new AudioCtor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.075;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    try {
      localStorage.setItem('nilu.sound', this.enabled ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (this.enabled) this.unlock();
  }

  tone(frequency, duration, { type = 'sine', gain = 0.3, when = 0, slideTo = 0 } = {}) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const start = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), start + duration);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(env);
    env.connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  key(index, combo = 0) {
    if (!this.enabled) return;
    this.unlock();
    const note = this.scale[(index + Math.min(combo, 6)) % this.scale.length];
    const frequency = 392 * 2 ** (note / 12);
    this.tone(frequency, 0.09, { type: 'sine', gain: 0.13 });
    this.tone(frequency * 2, 0.05, { type: 'triangle', gain: 0.035 });
  }

  success(level = 0) {
    if (!this.enabled) return;
    this.unlock();
    const root = 392 * 2 ** ((Math.min(level, 12) * 2) / 12);
    this.tone(root, 0.3, { type: 'sine', gain: 0.12 });
    this.tone(root * 1.5, 0.38, { type: 'sine', gain: 0.08, when: 0.04 });
    this.tone(root * 2, 0.22, { type: 'triangle', gain: 0.03, when: 0.02 });
  }

  miss() {
    if (!this.enabled) return;
    this.unlock();
    this.tone(108, 0.2, { type: 'triangle', gain: 0.18, slideTo: 72 });
  }

  end() {
    if (!this.enabled) return;
    this.unlock();
    const notes = [196, 246.94, 293.66, 392];
    notes.forEach((frequency, i) => {
      this.tone(frequency, 1.6, { type: 'sine', gain: 0.075, when: i * 0.09 });
    });
  }
}
