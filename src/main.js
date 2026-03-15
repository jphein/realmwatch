// ── Entry point ──
// Load topology async, then run app.js + panel-manager init.
// Dynamic imports ensure app.js side effects execute AFTER topology is ready.
import { loadTopology } from './topology.js';

// ── Loading screen stage controller ──
const _RL_STAGES = [
  'Igniting the arcane sigil',
  'Channeling the ley lines',
  'Weaving the realm tapestry',
  'Summoning the guardians',
  'The Realm stands ready'
];

// Progress arc circumference: 2 * PI * 175 ≈ 1099.56
const _ARC_TOTAL = 1099.56;
function _advanceLoadStage(stage) {
  const el = document.getElementById('realm-loading');
  if (!el) return;
  el.dataset.stage = stage;

  // Update progress arc
  const arc = el.querySelector('.rl-progress-arc');
  if (arc) {
    const progress = stage / 4; // 4 stages to fill
    arc.style.strokeDashoffset = _ARC_TOTAL * (1 - progress);
  }

  // Light up stage marker rune
  const mark = el.querySelector(`.rl-stage-mark[data-mark="${stage}"]`);
  if (mark) {
    mark.classList.add('lit');
    // Emit sparks from the marker position
    _emitSparks(el, stage);
  }

  // Transition stage text
  const textEl = el.querySelector('.rl-stage-text');
  if (textEl && _RL_STAGES[stage]) {
    textEl.classList.add('fading');
    setTimeout(() => {
      textEl.textContent = _RL_STAGES[stage];
      textEl.classList.remove('fading');
    }, 400);
  }
}

function _emitSparks(loadEl, stage) {
  const sparks = loadEl.querySelector('.rl-sparks');
  if (!sparks) return;
  // Emit 8 sparks in a radial burst from center
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI * 2 * i) / 8 + (stage * 0.3);
    const dist = 30 + Math.random() * 20;
    const spark = document.createElement('div');
    spark.className = 'rl-spark';
    spark.style.setProperty('--sx', `${Math.cos(angle) * dist}px`);
    spark.style.setProperty('--sy', `${Math.sin(angle) * dist}px`);
    sparks.appendChild(spark);
    setTimeout(() => spark.remove(), 1000);
  }
}

// Expose for SSE handler in app.js
window._advanceLoadStage = _advanceLoadStage;

(async () => {
  // Failsafe: dismiss loading screen after 8s even if SSE never connects
  setTimeout(() => {
    const el = document.getElementById('realm-loading');
    if (el && !el.classList.contains('dismissed')) {
      console.warn('Realm Map: loading screen failsafe — dismissing after timeout');
      el.classList.add('dismissed');
      setTimeout(() => { el.style.display = 'none'; }, 1300);
    }
  }, 8000);

  _advanceLoadStage(1);          // Stage 1: topology loading
  await loadTopology();
  _advanceLoadStage(2);          // Stage 2: topology done, app loading
  await import('./app.js');
  _advanceLoadStage(3);          // Stage 3: app loaded, panels materializing
  const { initPanelManager } = await import('./panel-manager.js');
  if (document.readyState === 'complete') {
    initPanelManager();
  } else {
    window.addEventListener('load', initPanelManager);
  }
  // Stage 4 fires when SSE connects (in app.js)
})();
