// ── Entry point ──
// topology.js loads and renders topology at module level (synchronous XHR)
// app.js runs all UI initialization via module-level side effects
// Import order matters: topology must come before app
export * from './topology.js';
export * from './app.js';
import { initPanelManager } from './panel-manager.js';

// Initialize panel manager after DOM is fully ready
if (document.readyState === 'complete') {
  initPanelManager();
} else {
  window.addEventListener('load', initPanelManager);
}
