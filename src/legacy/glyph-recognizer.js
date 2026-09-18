/**
 * RUNE PRESSURE - stroke recogniser.
 *
 * Pure math, zero DOM, zero imports: this file runs identically in the browser
 * and under `node --test`.
 *
 * Pipeline:
 *   raw pointer samples
 *     -> filterPoints()    drop sub-pixel jitter, keep real travel
 *     -> isCircle()        closed + looped + monotonically turning => NOVA
 *     -> buildRuns()       walk the path, accumulate same-direction travel
 *     -> pruneRuns()       discard runs too short to be an intentional segment
 *     -> chain             array of 8-way direction indices
 *     -> matchChain()      Levenshtein with *directional* substitution costs
 *
 * The directional cost function is what makes this feel fair: substituting a
 * direction for an adjacent one (45 degrees off) costs 1, two classes off costs
 * 2.5, a reversal costs 6. Accepting at <= 1.0 means "exact, or one segment
 * drawn 45 degrees sloppily" - and rejects reversed/mirrored shapes outright.
 *
 * Angle encoding (screen space, +y is down):
 *   0=E 1=SE 2=S 3=SW 4=W 5=NW 6=N 7=NE
 */

export const DIR_COUNT = 8;

/** Unit vectors for each direction index. */
export const DIR_VEC = [
  [1, 0], // 0 E
  [1, 1], // 1 SE
  [0, 1], // 2 S
  [-1, 1], // 3 SW
  [-1, 0], // 4 W
  [-1, -1], // 5 NW
  [0, -1], // 6 N
  [1, -1], // 7 NE
];

/** Shortest number of 45-degree steps between two direction indices (0..4). */
export function dirDistance(a, b) {
  const d = Math.abs(a - b) % DIR_COUNT;
  return Math.min(d, DIR_COUNT - d);
}

/** Quantise a vector to one of 8 directions. Returns -1 for a zero vector. */
export function quantizeDir(dx, dy) {
  if (dx === 0 && dy === 0) return -1;
  const angle = Math.atan2(dy, dx);
  const idx = Math.round(angle / (Math.PI / 4));
  return ((idx % DIR_COUNT) + DIR_COUNT) % DIR_COUNT;
}

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

/** Axis-aligned bounding box of a point list. */
export function bounds(points) {
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, diag: 0, cx: 0, cy: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return { minX, minY, maxX, maxY, w, h, diag: Math.hypot(w, h), cx: minX + w / 2, cy: minY + h / 2 };
}

/** Total travelled length of a polyline. */
export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
  return total;
}

/**
 * Collapse clusters of near-identical samples. Touch digitisers emit a lot of
 * duplicate coordinates when a finger is momentarily still, and those create
 * spurious direction flips.
 */
export function filterPoints(points, minDist = 0) {
  if (!points.length) return [];
  const out = [{ x: points[0].x, y: points[0].y }];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const last = out[out.length - 1];
    if (dist(last.x, last.y, p.x, p.y) >= minDist) out.push({ x: p.x, y: p.y });
  }
  // Always keep the true final sample: pointer-up position is meaningful.
  const lastRaw = points[points.length - 1];
  const lastKept = out[out.length - 1];
  if (lastKept && (lastKept.x !== lastRaw.x || lastKept.y !== lastRaw.y)) {
    if (out.length === 1 || dist(lastKept.x, lastKept.y, lastRaw.x, lastRaw.y) >= minDist * 0.5) {
      out.push({ x: lastRaw.x, y: lastRaw.y });
    }
  }
  return out;
}

/**
 * Walk the polyline and emit one run per uninterrupted stretch of travel in a
 * single 8-way direction.
 */
export function buildRuns(points) {
  const runs = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const dir = quantizeDir(dx, dy);
    const prev = runs[runs.length - 1];
    if (prev && prev.dir === dir) {
      prev.len += len;
      prev.x2 = b.x;
      prev.y2 = b.y;
    } else {
      runs.push({ dir, len, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }
  return runs;
}

/** Merge neighbouring runs that already share a direction. */
function mergeAdjacent(runs) {
  const out = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.dir === r.dir) {
      prev.len += r.len;
      prev.x2 = r.x2;
      prev.y2 = r.y2;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * Drop runs shorter than `minLen`. Removing a run can expose two neighbours
 * that now agree, so merge and repeat until the result is stable.
 */
export function pruneRuns(runs, minLen) {
  let current = mergeAdjacent(runs);
  for (let pass = 0; pass < 4; pass++) {
    const kept = current.filter((r) => r.len >= minLen);
    if (!kept.length) return current;
    const merged = mergeAdjacent(kept);
    if (merged.length === current.length) {
      current = merged;
      break;
    }
    current = merged;
  }
  return current;
}

/**
 * Closed-loop detection for the NOVA rune.
 *
 * A circle is closed (end lands near start), long relative to its own size, has
 * a roughly square bounding box, and - critically - turns the same rotational
 * direction almost the whole way round. That last test is what separates a real
 * circle from a scribble, which is closed but constantly reverses.
 */
export function circleMetrics(points) {
  const b = bounds(points);
  const len = pathLength(points);
  const runs = buildRuns(points);
  const first = points[0];
  const last = points[points.length - 1];
  const closure = b.diag > 0 ? dist(first.x, first.y, last.x, last.y) / b.diag : Infinity;

  let cw = 0;
  let ccw = 0;
  for (let i = 1; i < runs.length; i++) {
    const delta = (runs[i].dir - runs[i - 1].dir + DIR_COUNT) % DIR_COUNT;
    if (delta === 1 || delta === 2) cw += 1;
    else if (delta === DIR_COUNT - 1 || delta === DIR_COUNT - 2) ccw += 1;
  }
  const turns = Math.max(0, runs.length - 1);
  const consistency = turns > 0 ? Math.max(cw, ccw) / turns : 0;
  const aspect = b.h > 0 ? b.w / b.h : Infinity;

  return { b, len, runs: runs.length, closure, consistency, aspect };
}

export function isCircle(points, opts = {}) {
  const maxClosure = opts.maxClosure ?? 0.36;
  const minTurns = opts.minTurns ?? 5;
  const minLenFactor = opts.minLenFactor ?? 1.75;
  const maxLenFactor = opts.maxLenFactor ?? 7.5;
  const minConsistency = opts.minConsistency ?? 0.62;
  const minAspect = opts.minAspect ?? 0.42;
  const maxAspect = opts.maxAspect ?? 2.4;

  if (points.length < 6) return false;
  const m = circleMetrics(points);
  if (m.b.diag <= 0) return false;
  if (m.runs < minTurns) return false;
  if (m.closure > maxClosure) return false;
  if (m.len < m.b.diag * minLenFactor) return false;
  if (m.len > m.b.diag * maxLenFactor) return false;
  if (m.consistency < minConsistency) return false;
  if (m.aspect < minAspect || m.aspect > maxAspect) return false;
  return true;
}

/** Remove consecutive duplicate direction indices. */
function collapse(chain) {
  const out = [];
  for (const d of chain) {
    if (out[out.length - 1] !== d) out.push(d);
  }
  return out;
}

/** Direction chain for a stroke, or [] when there is not enough signal. */
export function strokeToChain(points, opts = {}) {
  const minDistFactor = opts.minDistFactor ?? 0.05;
  const minSegFactor = opts.minSegFactor ?? 0.13;
  const b = bounds(points);
  if (b.diag <= 0) return [];
  const filtered = filterPoints(points, Math.max(1.5, b.diag * minDistFactor));
  const raw = buildRuns(filtered);
  if (raw.length < 1) return [];
  const pruned = pruneRuns(raw, b.diag * minSegFactor);
  const chosen = pruned.length >= Math.min(2, raw.length) ? pruned : raw;
  return collapse(chosen.map((r) => r.dir));
}

/** Cost of substituting direction `a` with direction `b`. */
export function substitutionCost(a, b) {
  const d = dirDistance(a, b);
  if (d === 0) return 0;
  if (d === 1) return 1;
  if (d === 2) return 2.5;
  return 6;
}

/**
 * Levenshtein distance over direction chains, with directional substitution
 * costs and a fixed gap cost. Insertions/deletions are deliberately expensive,
 * so a chain only matches a template of the same segment count (unless a
 * segment was drawn with a 45-degree error).
 */
export function chainDistance(a, b, gapCost = 1.6) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return 0;
  if (n === 0) return m * gapCost;
  if (m === 0) return n * gapCost;
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j * gapCost;
  for (let i = 1; i <= n; i++) {
    curr[0] = i * gapCost;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + substitutionCost(a[i - 1], b[j - 1]);
      const del = prev[j] + gapCost;
      const ins = curr[j - 1] + gapCost;
      curr[j] = Math.min(sub, del, ins);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[m];
}

/**
 * Best matching template for a direction chain.
 * @returns {{id:string, cost:number, confidence:number}|null}
 */
export function matchChain(chain, templates, opts = {}) {
  const maxCost = opts.maxCost ?? 1.0;
  const minSegments = opts.minSegments ?? 2;
  if (!chain || chain.length < minSegments) return null;

  let best = null;
  for (const t of templates) {
    if (!t.chain || t.chain.length < 1) continue;
    const cost = chainDistance(chain, t.chain);
    if (cost > maxCost) continue;
    // Prefer lower cost, then the template with the closer segment count.
    const lengthPenalty = Math.abs(t.chain.length - chain.length) * 0.01;
    const rank = cost + lengthPenalty;
    if (!best || rank < best.rank) best = { id: t.id, cost, rank, confidence: Math.max(0, 1 - cost / 3) };
  }
  return best ? { id: best.id, cost: best.cost, confidence: best.confidence } : null;
}

/**
 * Full classification of one stroke.
 *
 * @returns {{
 *   id: string|null,      matched rune id, or null
 *   kind: 'rune'|'circle'|'tap'|'unknown',
 *   chain: number[],      recognised direction chain
 *   confidence: number,
 *   cost: number,
 *   metrics: object
 * }}
 */
export function classifyStroke(points, templates, opts = {}) {
  const minSize = opts.minSize ?? 30; // px of bbox diagonal to count as a stroke
  const b = bounds(points);
  const len = pathLength(points);
  const base = {
    id: null,
    kind: 'unknown',
    chain: [],
    confidence: 0,
    cost: Infinity,
    metrics: { ...b, len, points: points.length },
  };

  if (points.length < 2 || b.diag < minSize || len < minSize * 0.9) {
    return { ...base, kind: 'tap' };
  }

  if (isCircle(points, opts.circle)) {
    const t = templates.find((x) => x.chain === 'circle');
    if (t) return { ...base, id: t.id, kind: 'circle', confidence: 1, cost: 0 };
  }

  const chain = strokeToChain(points, opts);
  const match = matchChain(chain, templates, opts);
  if (match) {
    return { ...base, id: match.id, kind: 'rune', chain, confidence: match.confidence, cost: match.cost };
  }
  return { ...base, chain, kind: 'unknown' };
}

/**
 * Re-sample a polyline at a fixed spacing. Used by the test suite to turn a
 * hand-authored shape into something that looks like digitiser output, and by
 * the renderer to smooth trails.
 */
export function densifyPolyline(points, step = 4) {
  if (points.length < 2) return points.map((p) => ({ x: p.x, y: p.y }));
  const out = [{ x: points[0].x, y: points[0].y }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = dist(a.x, a.y, b.x, b.y);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }
  return out;
}

/** Deterministic pseudo-random jitter, so recogniser tests never flake. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Add reproducible human-ish wobble to a polyline. */
export function jitter(points, amount, seed = 1) {
  const rand = mulberry32(seed);
  return points.map((p) => ({
    x: p.x + (rand() * 2 - 1) * amount,
    y: p.y + (rand() * 2 - 1) * amount,
  }));
}
