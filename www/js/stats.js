/* 体重趋势 · 统计与预测（纯函数；浏览器挂 window.WTStats，Node 可 require） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.WTStats = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAY = 86400000;
  var EMA_HALF_LIFE = 3.5;
  var EVENT_SHRINK_K = 5;
  var MIN_7D_POINTS = 3;

  /* ---------------- 日期（统一用「天序号」，规避时区/夏令时） ---------------- */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function parseDate(str) {
    if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return NaN;
    var y = +str.slice(0, 4), m = +str.slice(5, 7), d = +str.slice(8, 10);
    var t = Date.UTC(y, m - 1, d);
    var dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return NaN;
    return Math.round(t / DAY);
  }

  function formatDate(day) {
    var dt = new Date(day * DAY);
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }

  function localToday(now) {
    var d = now === undefined || now === null ? new Date() : new Date(now);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function dayOfWeek(day) { return ((day + 4) % 7 + 7) % 7; }

  function weekStart(day, startsOn) {
    var s = (startsOn === undefined || startsOn === null) ? 1 : startsOn;
    var off = ((dayOfWeek(day) - s) + 7) % 7;
    return day - off;
  }

  var WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function weekdayLabel(day) { return WEEK_NAMES[dayOfWeek(day)]; }

  /* ---------------- 基础统计 ---------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  function mean(arr) {
    if (!arr || !arr.length) return NaN;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function median(arr) {
    if (!arr || !arr.length) return NaN;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function mad(arr) {
    if (!arr || !arr.length) return NaN;
    var m = median(arr);
    return median(arr.map(function (x) { return Math.abs(x - m); }));
  }

  function quantile(arr, q) {
    if (!arr || !arr.length) return NaN;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var pos = (a.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededSeed(points) {
    var s = 17;
    for (var i = 0; i < points.length; i++) {
      s = (s * 131 + points[i].day * 7 + Math.round(points[i].v * 100)) % 2147483647;
    }
    return s < 0 ? -s : s;
  }

  /* ---------------- 序列构建 ---------------- */
  function buildSeries(entries, field) {
    var out = [];
    var keys = Object.keys(entries || {});
    for (var i = 0; i < keys.length; i++) {
      var e = entries[keys[i]];
      if (!e || e.deleted) continue;
      var raw = e[field];
      var v = toNumber(raw);
      if (v === null || v <= 0) continue;
      var day = parseDate(e.date || keys[i]);
      if (!isFinite(day)) continue;
      out.push({ day: day, v: v });
    }
    out.sort(function (a, b) { return a.day - b.day; });
    var res = [];
    for (var j = 0; j < out.length; j++) {
      if (res.length && res[res.length - 1].day === out[j].day) res[res.length - 1] = out[j];
      else res.push(out[j]);
    }
    return res;
  }

  /*
   * 晨起序列：以 weightAM 为主。
   * 若某天只有训练后体重，且历史上有 >=6 对同日 AM/Post，
   * 用「AM - Post 的中位差」把训练后体重折算成晨起等效值（标记 estimated）。
   */
  function buildMorningSeries(entries, allowEstimate) {
    var direct = buildSeries(entries, 'weightAM');
    var post = buildSeries(entries, 'weightPost');
    var dayMap = {};
    for (var i = 0; i < direct.length; i++) dayMap[direct[i].day] = direct[i].v;

    var diffs = [];
    for (var k = 0; k < post.length; k++) {
      if (dayMap[post[k].day] !== undefined) diffs.push(dayMap[post[k].day] - post[k].v);
    }

    if (!allowEstimate || diffs.length < 6) {
      return { series: direct, post: post, estimatedDays: [], offset: null };
    }

    var offset = median(diffs);
    var extra = [];
    for (var m = 0; m < post.length; m++) {
      if (dayMap[post[m].day] !== undefined) continue;
      var est = post[m].v + offset;
      if (est > 20 && est < 400) extra.push({ day: post[m].day, v: est });
    }
    var merged = direct.concat(extra).sort(function (a, b) { return a.day - b.day; });
    return {
      series: merged,
      post: post,
      estimatedDays: extra.map(function (p) { return p.day; }),
      offset: offset
    };
  }

  /* 7 天滚动均值（逐日输出；只对有记录的天求均值，缺失不补零） */
  function rollingMeanDaily(series, windowDays) {
    var res = [];
    if (!series.length) return res;
    var w = Math.max(2, windowDays || 7);
    var lo = 0, hi = -1, sum = 0;
    var first = series[0].day, last = series[series.length - 1].day;
    for (var d = first; d <= last; d++) {
      while (hi + 1 < series.length && series[hi + 1].day <= d) { hi++; sum += series[hi].v; }
      while (lo <= hi && series[lo].day < d - w + 1) { sum -= series[lo].v; lo++; }
      var n = hi - lo + 1;
      if (n > 0) res.push({ day: d, v: sum / n, n: n });
    }
    return res;
  }

  /* 指数平滑：半衰期 3.5 天，按真实日间隔衰减，缺失日不插值 */
  function buildEma(series, halfLifeDays) {
    var out = [];
    if (!series.length) return out;
    var hl = halfLifeDays || EMA_HALF_LIFE;
    var ema = series[0].v;
    out.push({ day: series[0].day, v: ema });
    for (var i = 1; i < series.length; i++) {
      var dt = series[i].day - series[i - 1].day;
      var a = dt <= 0 ? 1 : (1 - Math.exp(-dt * Math.LN2 / hl));
      ema = ema + a * (series[i].v - ema);
      out.push({ day: series[i].day, v: ema });
    }
    return out;
  }

  /* ---------------- 稳健斜率 ---------------- */
  function theilSen(points) {
    var n = points ? points.length : 0;
    if (n < 2) return NaN;
    var slopes = [];
    for (var i = 0; i < n - 1; i++) {
      for (var j = i + 1; j < n; j++) {
        var dt = points[j].day - points[i].day;
        if (dt > 0) slopes.push((points[j].v - points[i].v) / dt);
      }
    }
    return slopes.length ? median(slopes) : NaN;
  }

  function bootstrapSlope(points, reps, seed) {
    var n = points ? points.length : 0;
    if (n < 4) return null;
    var rand = mulberry32(seed >>> 0);
    var out = [];
    var tries = 0;
    var limit = (reps || 400) * 12;
    while (out.length < (reps || 400) && tries < limit) {
      tries++;
      var sample = new Array(n);
      for (var i = 0; i < n; i++) sample[i] = points[Math.floor(rand() * n)];
      sample.sort(function (a, b) { return a.day - b.day; });
      var distinct = 1;
      for (var k = 1; k < n; k++) if (sample[k].day !== sample[k - 1].day) distinct++;
      if (distinct < 3) continue;
      var s = theilSen(sample);
      if (isFinite(s)) out.push(s);
    }
    if (out.length < 20) return null;
    return { lo: quantile(out, 0.1), hi: quantile(out, 0.9) };
  }

  function windowPoints(series, anchorDay, windowDays) {
    var out = [];
    for (var i = 0; i < series.length; i++) {
      var d = series[i].day;
      if (d > anchorDay - windowDays && d <= anchorDay) out.push(series[i]);
    }
    return out;
  }

  /*
   * 速率统计：kg/周 + 占体重百分比 + 80% 区间
   * level 为当前平滑体重（算百分比用），未知可传 null
   */
  function computeRate(points, level, minN, minSpan) {
    var n = points ? points.length : 0;
    if (n < (minN || 2)) return null;
    var span = points[n - 1].day - points[0].day + 1;
    if (span < (minSpan || 2)) return null;
    var perDay = theilSen(points);
    if (!isFinite(perDay)) return null;

    var kgPerWeek = perDay * 7;
    var ci = bootstrapSlope(points, 400, seededSeed(points));
    var out = {
      kgPerWeek: kgPerWeek,
      pctPerWeek: isNum(level) && level > 0 ? (kgPerWeek / level) * 100 : null,
      lo80Kg: ci ? ci.lo * 7 : null,
      hi80Kg: ci ? ci.hi * 7 : null,
      lo80Pct: null,
      hi80Pct: null,
      n: n,
      spanDays: span,
      confidence: 'low'
    };
    if (out.lo80Kg !== null && isNum(level) && level > 0) {
      out.lo80Pct = out.lo80Kg / level * 100;
      out.hi80Pct = out.hi80Kg / level * 100;
    }
    if (n >= (minN || 2) + 4 && span >= (minSpan || 2) + 7) out.confidence = 'ok';
    return out;
  }

  /* 本周均值 - 上周均值 */
  function weeklyDelta(series, anchorDay, level) {
    var cur = [], prev = [];
    for (var i = 0; i < series.length; i++) {
      var d = series[i].day;
      if (d <= anchorDay && d >= anchorDay - 6) cur.push(series[i].v);
      else if (d < anchorDay - 6 && d >= anchorDay - 13) prev.push(series[i].v);
    }
    if (cur.length < MIN_7D_POINTS || prev.length < MIN_7D_POINTS) return null;
    var a = mean(cur), b = mean(prev);
    return {
      kgPerWeek: a - b,
      pctPerWeek: isNum(level) && level > 0 ? ((a - b) / level) * 100 : null,
      curMean: a, prevMean: b,
      nCur: cur.length, nPrev: prev.length
    };
  }

  /* ---------------- 预测：线性 vs 自然减速（指数饱和） ---------------- */
  function fitTau(points, tau, t0) {
    var n = points.length;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) {
      var h = points[i].day - t0;
      var x = (tau === Infinity) ? h : tau * (1 - Math.exp(-h / tau));
      var y = points[i].v;
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    var denom = sxx - sx * sx / n;
    if (Math.abs(denom) < 1e-9) return { tau: tau, l0: mean(points.map(function (p) { return p.v; })), s: 0, sse: Infinity };
    var s = (sxy - sx * sy / n) / denom;
    var l0 = sy / n - s * sx / n;
    var sse = 0;
    for (var j = 0; j < n; j++) {
      var hj = points[j].day - t0;
      var xj = (tau === Infinity) ? hj : tau * (1 - Math.exp(-hj / tau));
      var r = points[j].v - (l0 + s * xj);
      sse += r * r;
    }
    return { tau: tau, l0: l0, s: s, sse: sse };
  }

  function forecastAt(fc, day) {
    if (!fc) return null;
    var h = day - fc.anchorDay;
    var x = (fc.tau === Infinity) ? h : fc.tau * (1 - Math.exp(-h / fc.tau));
    return fc.l0 + fc.s * x;
  }

  function forecastHalfWidth(fc, day, k) {
    if (!fc || !isNum(fc.sigma)) return null;
    var h = Math.max(0, day - fc.anchorDay);
    var z = 1.2816;
    var base = z * fc.sigma * Math.sqrt(1 + h / Math.max(7, fc.windowDays));
    var kk = Math.max(1, k || 1);
    return base / Math.sqrt(kk);
  }

  function fitForecast(points, anchorDay, windowDays, opts) {
    opts = opts || {};
    var n = points ? points.length : 0;
    if (n < 8) return null;
    var linear = fitTau(points, Infinity, anchorDay);
    var best = linear;
    var taus = [14, 21, 28, 42, 56, 90];
    for (var i = 0; i < taus.length; i++) {
      var f = fitTau(points, taus[i], anchorDay);
      if (isFinite(f.sse) && f.sse < best.sse) best = f;
    }
    var useDecay = best.tau !== Infinity && isFinite(best.sse) && best.sse < linear.sse * 0.95;
    var model = useDecay ? best : linear;

    var residuals = points.map(function (p) {
      var h = p.day - anchorDay;
      var x = (model.tau === Infinity) ? h : model.tau * (1 - Math.exp(-h / model.tau));
      return p.v - (model.l0 + model.s * x);
    });
    var sigma = Math.max(1.4826 * mad(residuals), 0.25);

    var span = points[n - 1].day - points[0].day + 1;
    var coverage = Math.min(1, n / Math.max(1, windowDays));
    return {
      model: useDecay ? 'decay' : 'linear',
      tau: model.tau,
      l0: model.l0,
      s: model.s,
      sse: model.sse,
      sigma: sigma,
      anchorDay: anchorDay,
      windowDays: windowDays,
      n: n,
      spanDays: span,
      coverage: coverage,
      kgPerWeek: model.s * 7
    };
  }

  function forecastSeries(fc, horizonDays) {
    var out = [];
    if (!fc) return out;
    for (var h = 0; h <= horizonDays; h++) {
      var day = fc.anchorDay + h;
      out.push({ day: day, v: forecastAt(fc, day) });
    }
    return out;
  }

  function forecastWeeks(fc, level, coverage, weeks) {
    var out = [];
    if (!fc) return out;
    var k = Math.max(3, Math.round(7 * clamp(coverage || 0.6, 0.2, 1)));
    for (var w = 1; w <= weeks; w++) {
      var hMid = (w - 1) * 7 + 3.5;
      var day = fc.anchorDay + hMid;
      var v = forecastAt(fc, day);
      var hw = forecastHalfWidth(fc, day, k);
      out.push({
        weeksAhead: w,
        day: day,
        kg: v,
        lo80: v - hw,
        hi80: v + hw,
        pctVsNow: isNum(level) && level > 0 ? (v - level) / level * 100 : null
      });
    }
    return out;
  }

  /* 解 w(t) = target，返回天数；不可达返回 null */
  function solveTarget(fc, target, maxDays) {
    if (!fc || !isNum(target)) return null;
    var l0 = fc.l0, s = fc.s, tau = fc.tau;
    if (!isFinite(s) || Math.abs(s) < 1e-6) return null;
    var diff = target - l0;
    var h;
    if (tau === Infinity) {
      h = diff / s;
    } else {
      var r = diff / (s * tau);
      if (!(r > 0 && r < 1)) return null;
      h = -tau * Math.log(1 - r);
    }
    if (!isFinite(h) || h <= 0) return null;
    if (h > (maxDays || 730)) return null;
    return h;
  }

  /* ---------------- 事件影响 ---------------- */
  function baselineFn(ema) {
    if (!ema || !ema.length) return function () { return null; };
    return function (day) {
      if (day <= ema[0].day) return ema[0].v;
      var last = ema[ema.length - 1];
      if (day >= last.day) return last.v;
      var lo = 0, hi = ema.length - 1;
      while (hi - lo > 1) {
        var mid = (lo + hi) >> 1;
        if (ema[mid].day <= day) lo = mid; else hi = mid;
      }
      var a = ema[lo], b = ema[hi];
      var t = (day - a.day) / Math.max(1, b.day - a.day);
      return a.v + (b.v - a.v) * t;
    };
  }

  function eventEffects(series, ema, entries, eventDefs, k) {
    var kk = k || EVENT_SHRINK_K;
    var byDay = {};
    for (var i = 0; i < series.length; i++) byDay[series[i].day] = series[i].v;
    var base = baselineFn(ema);

    var occ = {};
    var keys = Object.keys(entries || {});
    for (var j = 0; j < keys.length; j++) {
      var e = entries[keys[j]];
      if (!e || e.deleted || !e.events || !e.events.length) continue;
      var day = parseDate(e.date || keys[j]);
      if (!isFinite(day)) continue;
      for (var m = 0; m < e.events.length; m++) {
        var id = e.events[m];
        (occ[id] = occ[id] || []).push(day);
      }
    }

    return (eventDefs || []).map(function (def) {
      var days = occ[def.id] || [];
      var per = [];
      var span = Math.max(0, def.decayDays || 0);
      for (var d = 0; d < days.length; d++) {
        var day0 = days[d];
        // 局部基线：事件窗口前后各取 4 天，用中位数，避免被事件本身污染
        var pre = [], post = [];
        for (var t = day0 - 4; t <= day0 - 1; t++) if (byDay[t] !== undefined) pre.push(byDay[t]);
        for (var t2 = day0 + span + 1; t2 <= day0 + span + 4; t2++) if (byDay[t2] !== undefined) post.push(byDay[t2]);
        var local = null;
        if (pre.length + post.length >= 2) local = median(pre.concat(post));
        else local = base(day0);
        if (local === null) continue;
        var total = 0, cnt = 0;
        for (var t3 = day0; t3 <= day0 + span; t3++) {
          var v = byDay[t3];
          if (v === undefined) continue;
          total += v - local; cnt++;
        }
        if (cnt) per.push(total / cnt);
      }
      var n = per.length;
      var observed = n ? mean(per) : null;
      var prior = isNum(def.priorKg) ? def.priorKg : 0;
      var effect = n ? (n * observed + kk * prior) / (n + kk) : prior;
      return {
        id: def.id,
        name: def.name,
        emoji: def.emoji || '',
        kind: def.kind || 'transient',
        priorKg: prior,
        decayDays: span,
        n: n,
        observedKg: observed,
        effectKg: effect,
        source: n >= 5 ? 'learned' : (n > 0 ? 'mixed' : 'prior')
      };
    }).sort(function (a, b) { return b.n - a.n; });
  }

  /* ---------------- 排除事件窗口 ---------------- */
  function excludeEventWindows(series, entries, eventDefs) {
    var defs = {};
    (eventDefs || []).forEach(function (d) { defs[d.id] = d; });
    var excluded = {};
    var keys = Object.keys(entries || {});
    for (var i = 0; i < keys.length; i++) {
      var e = entries[keys[i]];
      if (!e || e.deleted || !e.events || !e.events.length) continue;
      var day = parseDate(e.date || keys[i]);
      if (!isFinite(day)) continue;
      for (var j = 0; j < e.events.length; j++) {
        var def = defs[e.events[j]];
        var span = def ? Math.max(0, def.decayDays || 0) : 1;
        for (var t = day; t <= day + span; t++) excluded[t] = true;
      }
    }
    return series.filter(function (p) { return !excluded[p.day]; });
  }

  /* ---------------- 每周小结 ---------------- */
  function weeklySummary(series, waistSeries, entries, weekStartsOn) {
    var map = {};
    function bucket(day) {
      var ws = weekStart(day, weekStartsOn);
      if (!map[ws]) map[ws] = { startDay: ws, vals: [], waist: [], events: 0 };
      return map[ws];
    }
    for (var i = 0; i < series.length; i++) bucket(series[i].day).vals.push(series[i].v);
    for (var j = 0; j < waistSeries.length; j++) bucket(waistSeries[j].day).waist.push(waistSeries[j].v);
    var keys = Object.keys(entries || {});
    for (var k = 0; k < keys.length; k++) {
      var e = entries[keys[k]];
      if (!e || e.deleted || !e.events || !e.events.length) continue;
      var day = parseDate(e.date || keys[k]);
      if (!isFinite(day)) continue;
      bucket(day).events++;
    }
    var list = Object.keys(map).map(function (key) { return map[key]; })
      .sort(function (a, b) { return a.startDay - b.startDay; });

    return list.map(function (w) {
      return {
        startDay: w.startDay,
        endDay: w.startDay + 6,
        start: formatDate(w.startDay),
        end: formatDate(w.startDay + 6),
        mean: w.vals.length ? mean(w.vals) : null,
        n: w.vals.length,
        coverage: w.vals.length / 7,
        waistMean: w.waist.length ? mean(w.waist) : null,
        waistN: w.waist.length,
        events: w.events,
        deltaKg: null,
        deltaPct: null
      };
    });
  }

  /* ---------------- 数据质量 ---------------- */
  function findOutliers(series) {
    var out = [];
    for (var i = 0; i < series.length; i++) {
      var d = series[i].day;
      var win = [];
      for (var j = i; j >= 0 && series[j].day >= d - 6; j--) win.push(series[j].v);
      if (win.length < 4) continue;
      var med = median(win);
      var scale = Math.max(mad(win), 0.12);
      if (Math.abs(series[i].v - med) > 2.5 * scale) out.push(series[i].day);
    }
    return out;
  }

  function findGaps(series) {
    var out = [];
    for (var i = 1; i < series.length; i++) {
      var gap = series[i].day - series[i - 1].day;
      if (gap >= 5) {
        out.push({ from: formatDate(series[i - 1].day), to: formatDate(series[i].day), days: gap - 1 });
      }
    }
    return out;
  }

  /* ---------------- 判定 ---------------- */
  /* 目标速度区间（%/周）。兼容旧版单值 goalRatePctPerWeek：max=旧值，min=旧值的一半 */
  function goalRange(profile) {
    profile = profile || {};
    var min = isNum(profile.goalRateMinPctPerWeek) ? Math.abs(profile.goalRateMinPctPerWeek) : null;
    var max = isNum(profile.goalRateMaxPctPerWeek) ? Math.abs(profile.goalRateMaxPctPerWeek) : null;
    var legacy = isNum(profile.goalRatePctPerWeek) ? Math.abs(profile.goalRatePctPerWeek) : null;
    if (max === null) max = legacy !== null ? legacy : 0.5;
    if (min === null) min = legacy !== null ? legacy * 0.5 : max * 0.5;
    if (min > max) { var t = min; min = max; max = t; }
    return { min: min, max: max };
  }

  function judgeRate(rate, profile) {
    if (!rate || !isNum(rate.pctPerWeek)) {
      return { key: 'none', label: '数据不足', tone: 'muted' };
    }
    var pct = rate.pctPerWeek;
    var mode = (profile && profile.mode) || 'cut';
    var range = goalRange(profile);

    if (mode === 'maintain') {
      var tol = Math.max(range.max, 0.2);
      if (Math.abs(pct) <= tol) return { key: 'ok', label: '维持稳定', tone: 'good' };
      return pct > 0
        ? { key: 'up', label: '在增重', tone: 'warn' }
        : { key: 'down', label: '在减重', tone: 'warn' };
    }
    var sign = mode === 'cut' ? -1 : 1;
    var progress = pct * sign;
    if (progress <= 0) {
      return { key: 'reverse', label: mode === 'cut' ? '体重在涨' : '体重在降', tone: 'bad' };
    }
    if (progress > range.max) return { key: 'fast', label: '偏快', tone: 'warn' };
    if (progress < range.min) return { key: 'slow', label: '偏慢', tone: 'warn' };
    return { key: 'ok', label: '在计划内', tone: 'good' };
  }

  /* ---------------- 汇总 ---------------- */
  function buildDashboard(db, now, eventDefs) {
    db = db || {};
    var settings = db.settings || {};
    var profile = db.profile || {};
    var entries = db.entries || {};
    var defs = eventDefs || [];

    var today = localToday(now);
    var todayDay = parseDate(today);
    var trendWindow = clamp(settings.trendWindow || 28, 14, 90);
    var smoothDays = clamp(settings.smoothingDays || 7, 3, 14);
    var forecastWeeksCount = clamp(settings.forecastWeeks || 4, 1, 12);

    var morning = buildMorningSeries(entries, settings.convertPost !== false);
    var series = morning.series;
    var postSeries = morning.post;
    var waistSeries = buildSeries(entries, 'waist');

    var anchorDay = series.length ? series[series.length - 1].day : todayDay;
    var anchorDate = formatDate(anchorDay);

    var analysisSeries = settings.excludeEventDays
      ? excludeEventWindows(series, entries, defs)
      : series;

    var roll = rollingMeanDaily(series, smoothDays);
    var ema = buildEma(series, EMA_HALF_LIFE);

    var curRoll = null;
    for (var i = roll.length - 1; i >= 0; i--) {
      if (roll[i].day === anchorDay) { curRoll = roll[i]; break; }
    }
    var level = (curRoll && curRoll.n >= MIN_7D_POINTS)
      ? curRoll.v
      : (series.length ? series[series.length - 1].v : null);
    var levelN = curRoll ? curRoll.n : (series.length ? 1 : 0);
    var levelEstimated = !(curRoll && curRoll.n >= MIN_7D_POINTS);

    var pts28 = windowPoints(analysisSeries, anchorDay, trendWindow);
    var pts14 = windowPoints(analysisSeries, anchorDay, 14);
    var s28 = computeRate(pts28, level, 8, 10);
    var s14 = computeRate(pts14, level, 6, 7);
    var d7 = weeklyDelta(analysisSeries, anchorDay, level);

    var mainRate = s28 || s14 || null;

    var weeks = weeklySummary(series, waistSeries, entries, profile.weekStartsOn);
    for (var w = 1; w < weeks.length; w++) {
      var prev = weeks[w - 1], cur = weeks[w];
      if (prev.mean !== null && cur.mean !== null) {
        cur.deltaKg = cur.mean - prev.mean;
        cur.deltaPct = level ? (cur.deltaKg / level) * 100 : null;
      }
    }

    var fc = fitForecast(pts28, anchorDay, trendWindow);
    var forecast = null;
    if (fc) {
      var horizon = Math.max(forecastWeeksCount * 7 + 7, 28);
      forecast = {
        model: fc.model,
        tau: fc.tau,
        l0: fc.l0,
        s: fc.s,
        sigma: fc.sigma,
        anchorDay: fc.anchorDay,
        windowDays: fc.windowDays,
        kgPerWeek: fc.kgPerWeek,
        coverage: fc.coverage,
        n: fc.n,
        points: forecastSeries(fc, horizon),
        weekly: forecastWeeks(fc, level, fc.coverage, forecastWeeksCount)
      };
    }

    var target = null;
    var targetKg = toNumber(profile.targetWeightKg);
    if (isNum(targetKg) && targetKg > 0 && isNum(level)) {
      var gap = targetKg - level;
      var hTrend = fc ? solveTarget(fc, targetKg) : null;
      var byTrend = null;
      if (hTrend !== null) {
        var up = solveTarget(fc, targetKg + fc.sigma);
        var down = solveTarget(fc, targetKg - fc.sigma);
        var hLow = null, hHigh = null;
        if (up !== null && down !== null) { hLow = Math.min(up, down); hHigh = Math.max(up, down); }
        byTrend = {
          weeks: hTrend / 7,
          date: formatDate(anchorDay + Math.round(hTrend)),
          loWeeks: hLow !== null ? hLow / 7 : null,
          hiWeeks: hHigh !== null ? hHigh / 7 : null
        };
      }
      var planRange = goalRange(profile);
      var gapAbs = Math.abs(gap);
      var dir = (profile.mode === 'bulk') ? 1 : -1;
      var byPlan = null;
      if (planRange.max > 0 && isNum(level) && level > 0) {
        var kgFast = dir * (planRange.max / 100) * level;
        var kgSlow = dir * (planRange.min / 100) * level;
        var weeksFast = gapAbs / Math.max(1e-6, Math.abs(kgFast));
        var weeksSlow = gapAbs / Math.max(1e-6, Math.abs(kgSlow));
        byPlan = {
          weeksFast: weeksFast,
          weeksSlow: weeksSlow,
          dateFast: formatDate(anchorDay + Math.round(weeksFast * 7)),
          dateSlow: formatDate(anchorDay + Math.round(weeksSlow * 7)),
          kgPerWeekFast: kgFast,
          kgPerWeekSlow: kgSlow,
          pctMin: planRange.min,
          pctMax: planRange.max
        };
      }
      target = {
        kg: targetKg,
        gapKg: gap,
        reached: Math.abs(gap) < 0.05,
        byTrend: byTrend,
        byPlan: byPlan
      };
    }

    var waistPoints = windowPoints(waistSeries, waistSeries.length ? waistSeries[waistSeries.length - 1].day : anchorDay, trendWindow);
    var waistRate = computeRate(waistPoints, null, 4, 14);
    var waist = {
      slope: waistRate,
      last: waistSeries.length ? waistSeries[waistSeries.length - 1] : null,
      n: waistSeries.length
    };

    var consistency = null;
    if (s28 && waistRate) {
      var wk = s28.kgPerWeek;
      var ck = waistRate.kgPerWeek;
      if (wk < -0.05 && ck < -0.05) consistency = { text: '体重和腰围同步下降，通常说明脂肪在减少。', tone: 'good' };
      else if (Math.abs(wk) <= 0.15 && ck < -0.05) consistency = { text: '体重基本持平、腰围在降，可能在改善体成分，也可能是测量误差。', tone: 'good' };
      else if (wk < -0.05 && Math.abs(ck) <= 0.05) consistency = { text: '体重在降但腰围变化不明显，短期多半是水分和糖原；再看 2 周。', tone: 'warn' };
      else if (wk > 0.05 && ck > 0.05) consistency = { text: '体重和腰围都在涨，注意热量盈余。', tone: 'bad' };
      else consistency = { text: '体重与腰围方向不一致，建议统一测量时间和部位再看一周。', tone: 'muted' };
    }

    var outliers = findOutliers(series);
    var gaps = findGaps(series);
    var daysSinceLast = series.length ? Math.max(0, todayDay - anchorDay) : null;
    var missing = [];
    var entryKeys = entries || {};
    for (var m = 0; m < 7; m++) {
      var dd = todayDay - m;
      var ds = formatDate(dd);
      var ent = entryKeys[ds];
      if (!ent || (!isNum(toNumber(ent.weightAM)) && !isNum(toNumber(ent.waist)))) missing.push(ds);
    }

    var streak = 0;
    for (var s = 0; s < 400; s++) {
      var dstr = formatDate(todayDay - s);
      var en = entryKeys[dstr];
      if (en && (isNum(toNumber(en.weightAM)) || isNum(toNumber(en.waist)))) streak++;
      else if (s === 0) continue;
      else break;
    }

    return {
      today: today,
      todayDay: todayDay,
      anchorDay: anchorDay,
      anchorDate: anchorDate,
      series: series,
      postSeries: postSeries,
      waistSeries: waistSeries,
      ema: ema,
      roll: roll,
      current: {
        value: level,
        n: levelN,
        estimated: levelEstimated,
        day: anchorDay,
        date: anchorDate
      },
      rates: { d7: d7, s14: s14, s28: s28, main: mainRate },
      judgement: judgeRate(mainRate, profile),
      weeks: weeks,
      forecast: forecast,
      target: target,
      waist: waist,
      events: eventEffects(series, ema, entries, defs),
      consistency: consistency,
      quality: {
        outliers: outliers.map(formatDate),
        gaps: gaps,
        daysSinceLast: daysSinceLast,
        coverage28: pts28.length,
        trendWindow: trendWindow
      },
      missing: missing,
      streak: streak,
      estimatedDays: morning.estimatedDays.map(formatDate),
      hasData: series.length > 0
    };
  }

  return {
    DAY: DAY,
    EMA_HALF_LIFE: EMA_HALF_LIFE,
    parseDate: parseDate,
    formatDate: formatDate,
    localToday: localToday,
    dayOfWeek: dayOfWeek,
    weekStart: weekStart,
    weekdayLabel: weekdayLabel,
    mean: mean,
    median: median,
    mad: mad,
    quantile: quantile,
    buildSeries: buildSeries,
    buildMorningSeries: buildMorningSeries,
    rollingMeanDaily: rollingMeanDaily,
    buildEma: buildEma,
    theilSen: theilSen,
    bootstrapSlope: bootstrapSlope,
    windowPoints: windowPoints,
    computeRate: computeRate,
    weeklyDelta: weeklyDelta,
    fitForecast: fitForecast,
    forecastAt: forecastAt,
    forecastHalfWidth: forecastHalfWidth,
    forecastSeries: forecastSeries,
    forecastWeeks: forecastWeeks,
    solveTarget: solveTarget,
    eventEffects: eventEffects,
    weeklySummary: weeklySummary,
    findOutliers: findOutliers,
    findGaps: findGaps,
    judgeRate: judgeRate,
    goalRange: goalRange,
    buildDashboard: buildDashboard
  };
});
