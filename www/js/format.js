/* 体重趋势 · 数字格式化（体重 2 位小数 / 腰围 1 位小数 / 速率双口径） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.WTFormat = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DASH = '—';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function fixed(n, d) {
    if (!isNum(n)) return DASH;
    var f = Math.pow(10, d);
    var r = Math.round(n * f) / f;
    if (Object.is(r, -0)) r = 0;
    return r.toFixed(d);
  }

  function signedFixed(n, d) {
    if (!isNum(n)) return DASH;
    var f = Math.pow(10, d);
    var r = Math.round(n * f) / f;
    if (Object.is(r, -0) || Math.abs(r) < 0.5 / f) r = 0;
    var s = Math.abs(r).toFixed(d);
    return (r > 0 ? '+' : r < 0 ? '-' : '') + s;
  }

  // 体重：2 位小数
  function kg(n) { return fixed(n, 2); }
  function kgSigned(n) { return signedFixed(n, 2); }
  function kgUnit(n) { return isNum(n) ? fixed(n, 2) + ' kg' : DASH; }

  // 腰围：1 位小数
  function cm(n) { return fixed(n, 1); }
  function cmSigned(n) { return signedFixed(n, 1); }

  // 百分比：2 位小数
  function pct(n) { return isNum(n) ? signedFixed(n, 2) + '%' : DASH; }
  function pctAbs(n) { return isNum(n) ? fixed(Math.abs(n), 2) + '%' : DASH; }

  // 核心：速率永远成对呈现
  function rate(kgPerWeek, pctPerWeek) {
    if (!isNum(kgPerWeek)) return DASH;
    var s = signedFixed(kgPerWeek, 2) + ' kg/周';
    if (isNum(pctPerWeek)) s += '（' + signedFixed(pctPerWeek, 2) + '%/周）';
    return s;
  }

  function rateShort(kgPerWeek, pctPerWeek) {
    if (!isNum(kgPerWeek)) return DASH;
    var s = signedFixed(kgPerWeek, 2) + ' kg';
    if (isNum(pctPerWeek)) s += ' (' + signedFixed(pctPerWeek, 2) + '%)';
    return s;
  }

  function range(lo, hi, digits, unit) {
    if (!isNum(lo) || !isNum(hi)) return DASH;
    return '[' + fixed(lo, digits) + ', ' + fixed(hi, digits) + ']' + (unit ? ' ' + unit : '');
  }

  function interval(lo, hi, digits, unit) {
    if (!isNum(lo) || !isNum(hi)) return DASH;
    return '[' + fixed(lo, digits) + ', ' + fixed(hi, digits) + ']' + (unit ? ' ' + unit : '');
  }

  function int(n) { return isNum(n) ? String(Math.round(n)) : DASH; }

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function dateCN(dateStr) {
    if (typeof dateStr !== 'string' || dateStr.length !== 10) return DASH;
    var m = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
    return m + '月' + d + '日';
  }

  function dateFullCN(dateStr) {
    if (typeof dateStr !== 'string' || dateStr.length !== 10) return DASH;
    var y = dateStr.slice(0, 4);
    return y + '年' + dateCN(dateStr);
  }

  function weekdayCN(dateStr) {
    if (typeof dateStr !== 'string' || dateStr.length !== 10) return '';
    var t = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
    return WEEK[new Date(t).getUTCDay()];
  }

  function md(dateStr) { return typeof dateStr === 'string' ? dateStr.slice(5) : DASH; }

  function days(n) {
    if (!isNum(n)) return DASH;
    var r = Math.round(n);
    if (r < 1) return '不到 1 天';
    return r + ' 天';
  }

  function weeks(n) {
    if (!isNum(n)) return DASH;
    var r = Math.round(n * 10) / 10;
    if (r < 0.1) return '已达成';
    return r + ' 周';
  }

  function parseNum(text) {
    if (text === null || text === undefined) return null;
    var s = String(text).trim().replace(/，/g, '').replace(/,/g, '').replace(/[^0-9.\-]/g, '');
    if (!s || s === '-' || s === '.') return null;
    var v = Number(s);
    return isFinite(v) ? v : null;
  }

  return {
    kg: kg, kgSigned: kgSigned, kgUnit: kgUnit,
    cm: cm, cmSigned: cmSigned,
    pct: pct, pctAbs: pctAbs,
    rate: rate, rateShort: rateShort,
    range: range, interval: interval, int: int,
    dateCN: dateCN, dateFullCN: dateFullCN, weekdayCN: weekdayCN, md: md,
    days: days, weeks: weeks, parseNum: parseNum, fixed: fixed
  };
});
