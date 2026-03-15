// ── Constants, performance detection, world dimensions ──

export const WORLD_W = 4800, WORLD_H = 3300;
export const WORLD_SCALE = WORLD_W / 3200;  // 1.5

export const _isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
export const _cpuCores = navigator.hardwareConcurrency || 2;
// Default desktop to medium (180 motes, glow on, no star-cross).
// 'high' (400 motes + star-cross + glow halos) costs 116% renderer on Vulkan/NVIDIA.
export let _perfTier = _isMobile ? (_cpuCores >= 6 ? 'medium' : 'low') : 'medium';
export function setPerfTier(t) { _perfTier = t; }

export let _mapTilt = 0;
export function setMapTilt(v) { _mapTilt = v; }

// SSE connection
export const SSE_URL = '/sse';

export const _PERF = {
  get moteCap()       { return _perfTier === 'low' ? 80  : _perfTier === 'medium' ? 180 : 400; },
  get topoFilters()   { return _perfTier !== 'low'; },
  get topoHaloRes()   { return _perfTier === 'low' ? 2 : 1; },
  get sparkleDiv()    { return _perfTier === 'low' ? 4  : _perfTier === 'medium' ? 2 : 1; },
  get moteGlow()      { return _perfTier !== 'low'; },
  get moteStarCross() { return _perfTier === 'high'; },
  get dragLineThrottle() { return _perfTier === 'low' ? 3 : 1; },
  get dashAnims()     { return !_isMobile || _perfTier === 'high'; },
  get svgFilters()    { return !_isMobile || _perfTier === 'high'; },
  get vineAnims()     { return !_isMobile || _perfTier === 'high'; },
  get runeBreath()    { return _perfTier !== 'low'; },
};
