// ── Entry point ──
// Load topology async, then run app.js + panel-manager init.
// Dynamic imports ensure app.js side effects execute AFTER topology is ready.
import { loadTopology } from './topology.js';

(async () => {
  await loadTopology();
  await import('./app.js');
  const { initPanelManager } = await import('./panel-manager.js');
  if (document.readyState === 'complete') {
    initPanelManager();
  } else {
    window.addEventListener('load', initPanelManager);
  }
})();
