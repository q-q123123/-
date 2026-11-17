/* 体重趋势 · 手写 SVG 图表（零依赖，支持触摸游标） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.WTChart = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  function svgEl(name, attrs) {
    var n = document.createElementNS(NS, name);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
          n.setAttribute(k, String(attrs[k]));
        }
      }
    }
    return n;
  }

  function niceStep(span, targetTicks) {
    var raw = span / Math.max(1, targetTicks);
    if (!isFinite(raw) || raw <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }

  function pathFrom(points, x, y) {
    var d = '';
    var started = false;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!p || !isFinite(p.v)) { started = false; continue; }
      var cmd = started ? 'L' : 'M';
      d += cmd + x(p.day).toFixed(2) + ' ' + y(p.v).toFixed(2) + ' ';
      started = true;
    }
    return d.trim();
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function mdLabel(day) {
    var dt = new Date(day * 86400000);
    return pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }

  function render(host, spec) {
    if (!host) return null;
    var width = Math.max(240, Math.floor(host.clientWidth || host.getBoundingClientRect().width || 320));
    var height = spec.height || 240;
    var margin = spec.margin || { top: 14, right: 14, bottom: 36, left: 46 };
    var plotW = Math.max(10, width - margin.left - margin.right);
    var plotH = Math.max(10, height - margin.top - margin.bottom);

    host.innerHTML = '';
    host.classList.add('chart-host');

    var days = [];
    var vals = [];
    function collect(list, isBand) {
      (list || []).forEach(function (p) {
        if (!p || !isFinite(p.day) || !isFinite(p.v)) return;
        days.push(p.day); vals.push(p.v);
      });
    }
    (spec.lines || []).forEach(function (l) { collect(l.points); });
    (spec.dots || []).forEach(function (p) { days.push(p.day); vals.push(p.v); });
    if (spec.band) { collect(spec.band.upper); collect(spec.band.lower); }
    if (spec.extraValues) vals = vals.concat(spec.extraValues);

    if (!days.length) {
      var empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = spec.emptyText || '还没有足够的数据';
      host.appendChild(empty);
      return null;
    }

    var x0 = spec.xDomain ? spec.xDomain[0] : Math.min.apply(null, days);
    var x1 = spec.xDomain ? spec.xDomain[1] : Math.max.apply(null, days);
    if (x1 - x0 < 1) x1 = x0 + 1;

    var vMin = spec.yDomain ? spec.yDomain[0] : Math.min.apply(null, vals);
    var vMax = spec.yDomain ? spec.yDomain[1] : Math.max.apply(null, vals);
    if (!isFinite(vMin) || !isFinite(vMax)) { vMin = 0; vMax = 1; }
    if (vMax - vMin < 0.5) { var mid = (vMax + vMin) / 2; vMin = mid - 0.25; vMax = mid + 0.25; }
    var padY = (vMax - vMin) * 0.08;
    vMin -= padY; vMax += padY;

    function x(day) { return margin.left + (day - x0) / (x1 - x0) * plotW; }
    function y(v) { return margin.top + (vMax - v) / (vMax - vMin) * plotH; }

    var svg = svgEl('svg', {
      width: width, height: height,
      viewBox: '0 0 ' + width + ' ' + height,
      role: 'img',
      'aria-label': spec.ariaLabel || '趋势图',
      class: 'chart-svg'
    });

    // 网格与 Y 轴刻度
    var step = niceStep(vMax - vMin, 4);
    var tickStart = Math.ceil(vMin / step) * step;
    for (var t = tickStart; t <= vMax + 1e-9; t += step) {
      var ty = y(t);
      svg.appendChild(svgEl('line', {
        x1: margin.left, x2: margin.left + plotW, y1: ty, y2: ty,
        class: 'chart-grid'
      }));
      var lbl = svgEl('text', { x: margin.left - 8, y: ty + 3.5, class: 'chart-ytick', 'text-anchor': 'end' });
      lbl.textContent = spec.yFmt ? spec.yFmt(t) : String(Math.round(t * 100) / 100);
      svg.appendChild(lbl);
    }

    // X 轴刻度
    var tickDays = 3;
    for (var i = 0; i <= tickDays; i++) {
      var day = Math.round(x0 + (x1 - x0) * i / tickDays);
      var tx = x(day);
      var xl = svgEl('text', {
        x: tx, y: height - 8, class: 'chart-xtick',
        'text-anchor': i === 0 ? 'start' : (i === tickDays ? 'end' : 'middle')
      });
      xl.textContent = mdLabel(day);
      svg.appendChild(xl);
    }

    // 预测带
    if (spec.band && spec.band.upper && spec.band.lower) {
      var up = spec.band.upper.filter(function (p) { return isFinite(p.v); });
      var down = spec.band.lower.filter(function (p) { return isFinite(p.v); });
      if (up.length && down.length) {
        var d = pathFrom(up, x, y);
        var rev = down.slice().reverse();
        for (var r = 0; r < rev.length; r++) {
          d += ' L' + x(rev[r].day).toFixed(2) + ' ' + y(rev[r].v).toFixed(2);
        }
        d += ' Z';
        svg.appendChild(svgEl('path', { d: d, class: 'chart-band', fill: spec.band.color || 'rgba(56,189,248,.18)' }));
      }
    }

    // 目标线
    if (spec.targetLine && isFinite(spec.targetLine.v)) {
      var tl = y(spec.targetLine.v);
      svg.appendChild(svgEl('line', {
        x1: margin.left, x2: margin.left + plotW, y1: tl, y2: tl, class: 'chart-target'
      }));
      if (spec.targetLine.label) {
        var tlt = svgEl('text', { x: margin.left + plotW - 2, y: tl - 5, class: 'chart-target-label', 'text-anchor': 'end' });
        tlt.textContent = spec.targetLine.label;
        svg.appendChild(tlt);
      }
    }

    // 线段
    (spec.lines || []).forEach(function (line) {
      if (!line.points || line.points.length < 2 && !(line.points || []).length) return;
      var d2 = pathFrom(line.points, x, y);
      if (!d2) return;
      svg.appendChild(svgEl('path', {
        d: d2,
        fill: 'none',
        stroke: line.color || '#38bdf8',
        'stroke-width': line.width || 2,
        'stroke-dasharray': line.dash || null,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        opacity: line.opacity === undefined ? 1 : line.opacity,
        class: 'chart-line'
      }));
    });

    // 原始点
    (spec.dots || []).forEach(function (p) {
      if (!isFinite(p.v)) return;
      var cx = x(p.day), cy = y(p.v);
      if (p.hollow) {
        svg.appendChild(svgEl('circle', {
          cx: cx, cy: cy, r: p.r || 2.2, fill: 'none',
          stroke: p.color || '#94a3b8', 'stroke-width': 1.2, opacity: 0.85
        }));
      } else {
        svg.appendChild(svgEl('circle', {
          cx: cx, cy: cy, r: p.r || 2.4, fill: p.color || '#94a3b8', opacity: p.opacity || 0.55
        }));
      }
    });

    // 事件图标（x 轴下方）
    (spec.events || []).forEach(function (ev) {
      var t2 = svgEl('text', {
        x: x(ev.day), y: height - 22, class: 'chart-event', 'text-anchor': 'middle'
      });
      t2.textContent = ev.emoji || '•';
      svg.appendChild(t2);
    });

    // 今天竖线
    if (isFinite(spec.today) && spec.today >= x0 && spec.today <= x1) {
      var txToday = x(spec.today);
      svg.appendChild(svgEl('line', {
        x1: txToday, x2: txToday, y1: margin.top, y2: margin.top + plotH, class: 'chart-today'
      }));
    }

    var cursorLine = svgEl('line', {
      x1: 0, x2: 0, y1: margin.top, y2: margin.top + plotH, class: 'chart-cursor', opacity: 0
    });
    svg.appendChild(cursorLine);

    var hit = svgEl('rect', {
      x: margin.left, y: margin.top, width: plotW, height: plotH,
      fill: 'transparent', class: 'chart-hit'
    });
    svg.appendChild(hit);

    host.appendChild(svg);

    var tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.style.display = 'none';
    host.appendChild(tip);

    function invX(px) { return x0 + (px - margin.left) / plotW * (x1 - x0); }

    function onMove(evt) {
      if (!spec.tooltip) return;
      var rect = svg.getBoundingClientRect();
      var px = (evt.clientX || (evt.touches && evt.touches[0] ? evt.touches[0].clientX : 0)) - rect.left;
      var day = Math.round(invX(px));
      if (day < Math.round(x0) || day > Math.round(x1)) { hide(); return; }
      var html = spec.tooltip(day);
      if (!html) { hide(); return; }
      var cx = x(day);
      cursorLine.setAttribute('x1', cx);
      cursorLine.setAttribute('x2', cx);
      cursorLine.setAttribute('opacity', 0.9);
      tip.innerHTML = html;
      tip.style.display = 'block';
      var tw = tip.offsetWidth;
      var left = cx + 10;
      if (left + tw > width - 4) left = cx - tw - 10;
      if (left < 4) left = 4;
      tip.style.left = left + 'px';
      tip.style.top = Math.max(4, margin.top) + 'px';
    }

    function hide() {
      tip.style.display = 'none';
      cursorLine.setAttribute('opacity', 0);
    }

    var handler = function (e) { onMove(e); };
    svg.addEventListener('pointerdown', handler);
    svg.addEventListener('pointermove', handler);
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointerup', function (e) {
      if (e.pointerType === 'touch') hide();
    });

    return {
      destroy: function () {
        svg.removeEventListener('pointerdown', handler);
        svg.removeEventListener('pointermove', handler);
        host.innerHTML = '';
      }
    };
  }

  return { render: render, niceStep: niceStep };
});
