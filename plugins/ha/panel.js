'use strict';
// -- Energy Plugin Panel (Solar Sanctum) --
// Uses window.RealmAPI for SSE subscription and data access.
// Does NOT use esbuild imports -- loaded as a standalone script.

(function() {
  var API = window.RealmAPI;
  if (!API) { console.error('ha plugin: RealmAPI not available'); return; }

  var panel = document.getElementById('energy-panel');
  if (panel) {
    panel.style.setProperty('--panel-accent', 'rgba(96,192,96,0.5)');
  }

  function fmtW(w) {
    if (w == null) return '--';
    if (Math.abs(w) >= 1000) return (w / 1000).toFixed(1) + 'kW';
    return Math.round(w) + 'W';
  }

  function updateEnergyPanel(data) {
    if (!data || data.error) return;
    var panelEl = document.getElementById('energy-panel');
    if (!panelEl || panelEl.style.display === 'none') return;

    // Solar
    var solarEl = document.getElementById('energy-solar');
    if (solarEl) {
      solarEl.textContent = data.solar_kw != null ? fmtW(data.solar_kw) : '--';
    }

    // Battery
    var battEl = document.getElementById('energy-battery');
    if (battEl) {
      var soc = data.battery_soc;
      var power = data.battery_power;
      if (soc != null) {
        var dir = power < -10 ? ' +' : power > 10 ? ' -' : '';
        battEl.textContent = Math.round(soc) + '%' + dir;
      } else {
        battEl.textContent = '--';
      }
    }

    // Grid
    var gridEl = document.getElementById('energy-grid');
    if (gridEl) {
      var gp = data.grid_power;
      gridEl.textContent = gp != null ? gp.toFixed(2) + 'kW' : '--';
    }

    // House
    var houseEl = document.getElementById('energy-house');
    if (houseEl) {
      houseEl.textContent = data.house_load != null ? fmtW(data.house_load) : '--';
    }

    // Today
    var todayEl = document.getElementById('energy-today');
    if (todayEl) {
      var today = data.today_load_kwh;
      todayEl.textContent = today != null ? today.toFixed(1) + 'kWh' : '--';
    }

    // Export
    var exportEl = document.getElementById('energy-export');
    if (exportEl) {
      var exp = data.grid_export_kwh;
      exportEl.textContent = exp != null ? exp.toFixed(0) + 'kWh' : '--';
    }
  }

  // Subscribe to SSE energy events
  API.onSSE('energy', function(data) {
    updateEnergyPanel(data);
  });
})();
