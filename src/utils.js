// ── Pure helper functions ──

export function scaleLabel(s) {
  if (s <= -7) return "Deep Depletion";
  if (s <= -3) return "Depleted";
  if (s <= 3) return "Balanced";
  if (s <= 7) return "Replete";
  return "Full Plenitude";
}

export function scaleColor(s) {
  if (s <= -7) return "#ff4040";
  if (s <= -3) return "#f09040";
  if (s <= 3) return "#f0d040";
  if (s <= 7) return "#a0d060";
  return "#a0ff60";
}

export function fmtBytes(b) {
  if (b == null) return "N/A";
  if (b > 1073741824) return (b / 1073741824).toFixed(2) + " GB";
  if (b > 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b > 1024) return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}

export function fmtRate(bps) {
  if (bps == null || bps === 0) return "0";
  if (bps > 1048576) return (bps / 1048576).toFixed(1) + " MB/s";
  if (bps > 1024) return (bps / 1024).toFixed(0) + " KB/s";
  return bps + " B/s";
}

export function scalePct(s) { return Math.max(0, Math.min(100, (s + 10) / 20 * 100)); }
