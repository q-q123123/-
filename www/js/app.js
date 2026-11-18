/* 体重趋势 · 界面与交互 */
(function () {
  'use strict';

  var Stats = window.WTStats;
  var Fmt = window.WTFormat;
  var Store = window.WTStore;
  var Chart = window.WTChart;
  var Sync = window.WTSync || { statusText: function () { return '本机模式'; } };

  var VERSION = '1.7.1';

  var app = {
    repo: null,
    dash: null,
    fc: null,
    tab: 'record',
    date: null,
    chartMode: 'weight',
    range: 90,
    scenario: {},
    lastTab: null,
    pasteOpen: false,
    folds: {}
  };

  /* ---------------- 小工具 ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2200);
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 200);
    };
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  function safeStorage() {
    try {
      var s = window.localStorage;
      s.setItem('wt.__probe', '1');
      s.removeItem('wt.__probe');
      return s;
    } catch (e) { return null; }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    app.repo = new Store.Repo(new Store.LocalDriver(safeStorage()));
    app.repo.init();
    app.date = Stats.localToday();

    if (window.navigator && navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }
    setupServiceWorker();
    setupInstallPrompt();

    app.repo.subscribe(function () { recompute(); render(); });

    var hash = String(location.hash || '').replace('#', '');
    if (['record', 'trend', 'analysis', 'settings'].indexOf(hash) >= 0) app.tab = hash;

    recompute();

    // 演示数据：?demo=1（仅在本地没有任何记录时载入）
    try {
      var params = new URLSearchParams(location.search);
      if (params.get('demo') === '1' && !Object.keys(app.repo.state.entries).length) {
        app.repo.importData({ entries: makeDemoEntries() }, 'merge');
      }
    } catch (e) { /* URLSearchParams 不可用时忽略 */ }

    bind();
    render();
  }

  /* ---------------- 安装为 App ---------------- */
  var installPrompt = null;

  function isNativeShell() {
    try {
      return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) return true;
    } catch (e) { /* ignore */ }
    return !!navigator.standalone;
  }

  function setupInstallPrompt() {
    if (!window.addEventListener) return;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      installPrompt = e;
      if (app.tab === 'settings') render();
    });
    window.addEventListener('appinstalled', function () {
      installPrompt = null;
      toast('已安装到桌面', 'good');
      if (app.tab === 'settings') render();
    });
  }



  /* ---------------- 版本更新 ---------------- */
  var lastUpdateCheck = 0;

  function showUpdateBar() {
    var bar = $('#updateBar');
    if (bar) bar.hidden = false;
  }

  function setupServiceWorker() {
    if (isNativeShell()) return;   // 打包成 App 后资源在本地，不需要 Service Worker
    if (!('serviceWorker' in navigator)) return;
    if (String(location.protocol).indexOf('http') !== 0) return;

    var reloading = false;
    var hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) {
        reloading = false;
        location.reload();
        return;
      }
      // 首次安装（之前没有旧版在跑）不刷新
      if (!hadController) return;
      var el = document.activeElement;
      var typing = el && /^(INPUT|TEXTAREA)$/i.test(el.tagName || '');
      if (typing) { showUpdateBar(); return; }
      hadController = false;
      location.reload();
    });

    app.applyUpdate = function () {
      var w = app.pendingWorker;
      if (!w) { location.reload(); return; }
      reloading = true;
      try { w.postMessage({ type: 'SKIP_WAITING' }); } catch (e) { location.reload(); }
    };

    app.checkUpdate = function () {
      if (!app.swReg) { location.reload(); return; }
      lastUpdateCheck = Date.now();
      app.swReg.update().then(function () {
        toast('已检查更新');
      }).catch(function () {
        toast('检查更新失败，稍后再试');
      });
    };

    navigator.serviceWorker.register('sw.js').then(function (reg) {
      app.swReg = reg;

      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          // 只有「本来就有旧版本在跑」时才提示，首次安装不提示
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            app.pendingWorker = sw;
            showUpdateBar();
          }
        });
      });

      // 回到前台时顺带查一次（5 分钟内不重复查）
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        if (Date.now() - lastUpdateCheck < 5 * 60 * 1000) return;
        lastUpdateCheck = Date.now();
        reg.update().catch(function () {});
      });
    }).catch(function () {});
  }

  function recompute() {
    app.dash = Stats.buildDashboard(app.repo.state, new Date(), app.repo.allEvents());
    var f = app.dash.forecast;
    app.fc = f ? {
      tau: f.tau, l0: f.l0, s: f.s, sigma: f.sigma,
      anchorDay: f.anchorDay, windowDays: f.windowDays
    } : null;
  }

  /* ---------------- 渲染入口 ---------------- */
  function render() {
    var view = $('#view');
    if (!view) return;
    var html;
    if (app.tab === 'record') html = renderRecord();
    else if (app.tab === 'trend') html = renderTrend();
    else if (app.tab === 'analysis') html = renderAnalysis();
    else html = renderSettings();

    view.innerHTML = html;
    $$('#tabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === app.tab);
    });
    var meta = $('#topMeta');
    if (meta) meta.textContent = Fmt.dateCN(app.dash.today) + ' ' + Fmt.weekdayCN(app.dash.today);
    if (app.lastTab !== app.tab) {
      app.lastTab = app.tab;
      window.scrollTo(0, 0);
    }
    afterRender();
  }

  function afterRender() {
    if (app.tab === 'trend') {
      var host = $('#weightChart');
      if (host) Chart.render(host, buildWeightSpec());
      var host2 = $('#waistChart');
      if (host2) Chart.render(host2, buildWaistSpec());
    }
  }

  /* ---------------- 记录页 ---------------- */
  function needsBackup() {
    var meta = app.repo.state.meta || {};
    var count = Object.keys(app.repo.state.entries).length;
    if (!count || count < 5) return false;
    if (!meta.lastExportAt) return true;
    return (Date.now() - meta.lastExportAt) > 7 * 86400000;
  }

  function chip(tone, label) {
    return '<span class="chip ' + tone + '">' + esc(label) + '</span>';
  }

  function renderRecord() {
    var d = app.dash;
    var entry = app.repo.getEntry(app.date) || {};
    var html = '';

    if (needsBackup()) {
      html += '<div class="banner">数据只保存在这台手机上，已经 7 天以上没导出了。<button class="link" data-act="goto-settings">去导出备份 →</button></div>';
    }

    var rate = d.rates.main;
    html += '<section class="card quick">'
      + '<div class="quick-row">'
      + '<div class="quick-item">'
      + '<div class="quick-label">当前体重 · 近 7 天均值</div>'
      + '<div class="quick-value">' + (d.current.value ? Fmt.kg(d.current.value) : '—') + '<small>kg</small></div>'
      + '<div class="quick-note">' + (d.current.estimated ? '样本不足，显示最近一次实测' : '覆盖 ' + d.current.n + ' 天') + '</div>'
      + '</div>'
      + '<div class="quick-item">'
      + '<div class="quick-label">近 ' + d.quality.trendWindow + ' 天速度</div>'
      + '<div class="quick-value small">' + (rate ? Fmt.kgSigned(rate.kgPerWeek) : '—') + '<small>kg/周</small></div>'
      + '<div class="quick-note">' + (rate && rate.pctPerWeek !== null ? Fmt.pct(rate.pctPerWeek) : '—') + '<span> %/周</span></div>'
      + '</div>'
      + '</div>'
      + '<div class="chips tight">'
      + chip(d.judgement.tone, d.judgement.label)
      + chip('muted', '连续记录 ' + d.streak + ' 天')
      + (d.forecast ? chip('info', '预测模型：' + (d.forecast.model === 'decay' ? '含平台期' : '线性')) : '')
      + '</div>'
      + '</section>';

    html += renderDateBar();
    html += renderEntryForm(entry);
    html += '<div class="save-bar"><button class="btn primary" data-act="save">保存 ' + Fmt.dateCN(app.date) + '</button></div>';
    return html;
  }

  function renderDateBar() {
    var d = app.dash;
    var date = app.date;
    var isToday = date === d.today;
    var entry = app.repo.getEntry(date);

    var strip = '';
    for (var i = 6; i >= 0; i--) {
      var ds = Stats.formatDate(d.todayDay - i);
      var ent = app.repo.getEntry(ds);
      var hasAm = !!(ent && ent.weightAM !== undefined);
      var cls = 'daydot' + (ds === date ? ' on' : '') + (hasAm ? '' : ' empty');
      strip += '<button class="' + cls + '" data-act="pick-day" data-date="' + ds + '"'
        + ' aria-label="' + ds + (hasAm ? ' ' + Fmt.kg(ent.weightAM) + 'kg' : '') + '">'
        + '<span class="dd-top"><b>' + ds.slice(8) + '</b><i>' + Fmt.weekdayCN(ds).slice(1) + '</i></span>'
        + '<span class="dd-w">' + (hasAm ? Fmt.kg(ent.weightAM) : '—') + '</span>'
        + '</button>';
    }

    var amText = (entry && entry.weightAM !== undefined)
      ? '晨起 ' + Fmt.kg(entry.weightAM) + ' kg'
      : '晨起未记录';

    return '<section class="datebar">'
      + '<button class="datebar-btn" data-act="prev-day" aria-label="前一天">‹</button>'
      + '<div class="datebar-mid">'
      + '<div class="datebar-date">' + Fmt.dateFullCN(date) + ' ' + Fmt.weekdayCN(date) + '</div>'
      + '<div class="datebar-sub">' + (isToday ? '今天' : '补记') + ' · ' + amText + '</div>'
      + '</div>'
      + '<button class="datebar-btn" data-act="next-day" aria-label="后一天"' + (isToday ? ' disabled' : '') + '>›</button>'
      + '</section>'
      + '<div class="daystrip">' + strip + '</div>';
  }

  function field(name, label, unit, value, digits, hint, cls) {
    var v = (value === undefined || value === null) ? '' : Fmt.fixed(value, digits);
    return '<label class="field' + (cls ? ' ' + cls : '') + '">'
      + '<span class="field-label">' + label + (hint ? '<i>' + hint + '</i>' : '') + '</span>'
      + '<span class="field-input">'
      + '<input type="text" inputmode="decimal" name="' + name + '" value="' + esc(v) + '" placeholder="—" autocomplete="off" enterkeyhint="done">'
      + '<b>' + unit + '</b></span>'
      + '</label>';
  }

  function renderEntryForm(entry) {
    var events = app.repo.allEvents();
    var selected = entry.events || [];
    var chips = events.map(function (ev) {
      var on = selected.indexOf(ev.id) >= 0;
      return '<button type="button" class="chip ev' + (on ? ' on' : '') + '" data-act="toggle-event" data-id="' + ev.id + '">'
        + (ev.emoji ? ev.emoji + ' ' : '') + esc(ev.name) + '</button>';
    }).join('');

    var nameById = {};
    events.forEach(function (ev) { nameById[ev.id] = ev; });
    var summaryChips = selected.map(function (id) {
      var ev = nameById[id];
      if (!ev) return '';
      return '<span class="chip muted">' + (ev.emoji ? ev.emoji + ' ' : '') + esc(ev.name) + '</span>';
    }).join('');

    return '<form id="entryForm" class="card form-card" autocomplete="off" novalidate>'
      + field('weightAM', '晨起空腹体重', 'kg', entry.weightAM, 2, '排空后、同一台秤')
      + field('waist', '腰围', 'cm', entry.waist, 1, '肚脐水平、呼气末')
      + field('weightPost', '力量训练后体重', 'kg', entry.weightPost, 2, '仅作参考，可留空', 'secondary')
      + '<div class="ev-block">'
      + '<button type="button" class="collapse-row" data-act="toggle-events">'
      + '<span>今天有什么特殊情况</span>'
      + '<span class="collapse-hint">' + (selected.length ? '已选 ' + selected.length + ' 项' : '可选') + '</span>'
      + '<i class="chev">›</i>'
      + '</button>'
      + (summaryChips ? '<div class="chips ev-summary">' + summaryChips + '</div>' : '')
      + '<div class="ev-panel"><div class="chips ev-chips">' + chips + '</div></div>'
      + '</div>'
      + '<label class="field note"><span class="field-label">备注</span>'
      + '<input type="text" name="note" maxlength="100" value="' + esc(entry.note || '') + '" placeholder="可选，例如睡眠 5 小时">'
      + '</label>'
      + '</form>';
  }

  function saveEntry() {
    var form = $('#entryForm');
    if (!form) return;
    var read = function (name) {
      var el = form.querySelector('[name="' + name + '"]');
      return el ? el.value : '';
    };
    var patch = {};
    var problems = [];

    ['weightAM', 'weightPost', 'waist'].forEach(function (name) {
      var v = Fmt.parseNum(read(name));
      if (v === null) { patch[name] = undefined; return; }
      var lim = Store.LIMITS[name];
      if (lim && (v < lim[0] || v > lim[1])) {
        problems.push(name);
        patch[name] = undefined;
        return;
      }
      patch[name] = v;
    });

    if (problems.length) {
      toast('数值超出合理范围，请检查', 'bad');
      return;
    }

    var events = $$('.ev-chips .chip.on').map(function (el) { return el.getAttribute('data-id'); });
    patch.events = events;
    patch.note = read('note').trim();

    var clean = app.repo.upsertEntry(app.date, patch);
    if (!clean) {
      toast('这条记录已清空');
    } else {
      var fields = [];
      if (clean.weightAM !== undefined) fields.push('体重 ' + Fmt.kg(clean.weightAM));
      if (clean.waist !== undefined) fields.push('腰围 ' + Fmt.cm(clean.waist));
      toast('已保存' + (fields.length ? ' · ' + fields.join('、') : '') + ' · 连续 ' + (app.dash.streak || 0) + ' 天', 'good');
    }
  }

  /* ---------------- 趋势页 ---------------- */
  function segBtn(value, label, current) {
    return '<button data-act="' + value.group + '" data-value="' + value.value + '" class="' + (String(current) === String(value.value) ? 'on' : '') + '">' + label + '</button>';
  }

  function rangeStart() {
    var d = app.dash;
    if (app.range === 0) return d.series.length ? d.series[0].day : d.todayDay - 89;
    return d.todayDay - app.range + 1;
  }

  function renderTrend() {
    var d = app.dash;
    if (!d.hasData) return emptyState('趋势图需要至少 3 天体重记录', '先去记录几天吧');
    var html = '';
    html += '<div class="seg">'
      + '<button data-act="chartmode" data-value="weight" class="' + (app.chartMode === 'weight' ? 'on' : '') + '">体重</button>'
      + '<button data-act="chartmode" data-value="waist" class="' + (app.chartMode === 'waist' ? 'on' : '') + '">腰围</button>'
      + '<button data-act="chartmode" data-value="both" class="' + (app.chartMode === 'both' ? 'on' : '') + '">体重+腰围</button>'
      + '</div>';
    html += '<div class="seg small">'
      + [30, 90, 180, 0].map(function (r) {
        return '<button data-act="range" data-value="' + r + '" class="' + (app.range === r ? 'on' : '') + '">' + (r === 0 ? '全部' : r + ' 天') + '</button>';
      }).join('')
      + '</div>';

    if (app.chartMode !== 'waist') {
      html += '<section class="card chart-card">'
        + '<div class="section-title">体重趋势</div>'
        + '<div id="weightChart" class="chart-host"></div>'
        + '<div class="legend">'
        + '<span><i class="mk dot"></i>原始记录</span>'
        + '<span><i class="mk line" style="background:#22d3ee"></i>7 天均值</span>'
        + '<span><i class="mk hollow"></i>训练后（仅参考）</span>'
        + '<span><i class="mk line thin" style="background:#a78bfa"></i>平滑</span>'
        + '<span><i class="mk dash"></i>预测</span>'
        + '</div></section>';
    }
    if (app.chartMode !== 'weight') {
      html += '<section class="card chart-card">'
        + '<div class="section-title">腰围趋势</div>'
        + '<div id="waistChart" class="chart-host"></div>'
        + '<div class="legend"><span><i class="mk dot"></i>实测</span><span><i class="mk line" style="background:#f472b6"></i>趋势线</span></div>'
        + '</section>';
    }
    html += renderWeeks();
    return html;
  }

  function eventsByDay() {
    var map = {};
    var entries = app.repo.state.entries;
    var defs = {};
    app.repo.allEvents().forEach(function (e) { defs[e.id] = e; });
    Object.keys(entries).forEach(function (d) {
      var e = entries[d];
      if (!e.events || !e.events.length) return;
      var def = defs[e.events[0]];
      map[d] = (def && def.emoji) || '•';
    });
    return map;
  }

  function buildWeightSpec() {
    var d = app.dash;
    var start = rangeStart();
    var today = d.todayDay;
    var fc = app.fc;
    var xEnd = Math.max(today, fc ? fc.anchorDay + 28 : today);

    var dots = d.series.filter(function (p) { return p.day >= start; })
      .map(function (p) {
        return {
          day: p.day, v: p.v, r: 2.2,
          color: app.repo.state.settings.showRaw ? '#94a3b8' : 'rgba(0,0,0,0)',
          opacity: 0.6
        };
      });

    var postDots = [];
    if (app.repo.state.settings.showPost) {
      postDots = d.postSeries.filter(function (p) { return p.day >= start; })
        .map(function (p) { return { day: p.day, v: p.v, hollow: true, color: '#cbd5e1', r: 2 }; });
    }

    var rollLine = d.roll.filter(function (p) { return p.day >= start && p.n >= 3; })
      .map(function (p) { return { day: p.day, v: p.v }; });

    var emaLine = d.ema.filter(function (p) { return p.day >= start; })
      .map(function (p) { return { day: p.day, v: p.v }; });

    var fcLine = [], bandUp = [], bandDown = [];
    if (fc) {
      for (var h = 0; h <= 28; h++) {
        var day = fc.anchorDay + h;
        var v = Stats.forecastAt(fc, day);
        var hw = Stats.forecastHalfWidth(fc, day, 1) || 0;
        fcLine.push({ day: day, v: v });
        bandUp.push({ day: day, v: v + hw });
        bandDown.push({ day: day, v: v - hw });
      }
    }

    var evMap = eventsByDay();
    var evList = [];
    Object.keys(evMap).forEach(function (dt) {
      var day = Stats.parseDate(dt);
      if (day >= start) evList.push({ day: day, emoji: evMap[dt] });
    });

    var targetLine = null;
    var t = app.repo.state.profile.targetWeightKg;
    if (t && Fmt.parseNum(t) !== null) targetLine = { v: Number(t), label: '目标 ' + Fmt.kg(Number(t)) };

    return {
      height: 250,
      xDomain: [start, xEnd],
      today: today,
      dots: dots.concat(postDots),
      lines: [
        { points: emaLine, color: '#a78bfa', width: 1.4, opacity: 0.55 },
        { points: rollLine, color: '#22d3ee', width: 2.2 },
        { points: fcLine, color: '#f59e0b', width: 2, dash: '5 4', opacity: 0.95 }
      ],
      band: { upper: bandUp, lower: bandDown },
      events: evList,
      targetLine: targetLine,
      yFmt: function (v) { return Fmt.kg(v); },
      ariaLabel: '体重趋势图',
      tooltip: function (day) {
        var ds = Stats.formatDate(day);
        var out = ['<b>' + Fmt.dateCN(ds) + ' ' + Fmt.weekdayCN(ds) + '</b>'];
        var e = app.repo.getEntry(ds);
        if (e && e.weightAM !== undefined) out.push('晨起 ' + Fmt.kg(e.weightAM) + ' kg');
        else if (e && e.weightPost !== undefined) out.push('训练后 ' + Fmt.kg(e.weightPost) + ' kg');
        else out.push('<span class="dim">无记录</span>');
        var r = null;
        for (var i = 0; i < d.roll.length; i++) if (d.roll[i].day === day) { r = d.roll[i]; break; }
        if (r && r.n >= 3) out.push('7 天均值 ' + Fmt.kg(r.v));
        if (day > today && fc) out.push('预测 ' + Fmt.kg(Stats.forecastAt(fc, day)));
        return out.join('<br>');
      }
    };
  }

  function buildWaistSpec() {
    var d = app.dash;
    var start = rangeStart();
    var pts = d.waistSeries.filter(function (p) { return p.day >= start; });
    if (!pts.length) return { height: 200, emptyText: '还没有腰围记录', dots: [], lines: [] };

    var slope = Stats.theilSen(pts);
    var offsets = pts.map(function (p) { return p.v - slope * p.day; });
    var intercept = Stats.median(offsets);

    var trend = [];
    var last = pts[pts.length - 1].day;
    for (var day = pts[0].day; day <= last; day++) {
      trend.push({ day: day, v: intercept + slope * day });
    }

    return {
      height: 200,
      xDomain: [start, Math.max(d.todayDay, last)],
      today: d.todayDay,
      dots: pts.map(function (p) { return { day: p.day, v: p.v, r: 2.6, color: '#94a3b8', opacity: 0.75 }; }),
      lines: [{ points: trend, color: '#f472b6', width: 2 }],
      yFmt: function (v) { return Fmt.cm(v); },
      ariaLabel: '腰围趋势图',
      tooltip: function (day) {
        var ds = Stats.formatDate(day);
        var e = app.repo.getEntry(ds);
        var out = ['<b>' + Fmt.dateCN(ds) + ' ' + Fmt.weekdayCN(ds) + '</b>'];
        if (e && e.waist !== undefined) out.push('腰围 ' + Fmt.cm(e.waist) + ' cm');
        else out.push('<span class="dim">无记录</span>');
        return out.join('<br>');
      }
    };
  }

  function renderWeeks() {
    var weeks = app.dash.weeks.filter(function (w) { return w.n > 0 || w.waistN > 0; });
    if (!weeks.length) return '';
    var rows = weeks.slice(-10).reverse().map(function (w) {
      var delta = (w.deltaKg === null || w.deltaKg === undefined) ? '—'
        : Fmt.rateShort(w.deltaKg, w.deltaPct);
      return '<tr>'
        + '<td>' + Fmt.md(w.start) + '~' + Fmt.md(w.end) + '</td>'
        + '<td class="num">' + (w.mean === null ? '—' : Fmt.kg(w.mean)) + '</td>'
        + '<td class="num">' + delta + '</td>'
        + '<td class="num dim">' + w.n + '/7</td>'
        + '<td class="num dim">' + (w.waistMean === null ? '—' : Fmt.cm(w.waistMean)) + '</td>'
        + '</tr>';
    }).join('');

    var total = weeks.slice(-10).length;
    return '<section class="card">'
      + '<div class="section-title">每周小结</div>'
      + '<div class="weeks-wrap">'
      + '<table class="table"><thead><tr>'
      + '<th>周</th><th class="num">周均 kg</th><th class="num">环比</th><th class="num">记录</th><th class="num">腰围</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>'
      + '</div>'
      + (total > 4 ? '<button class="link" data-act="toggle-weeks" data-count="' + total + '">展开全部 ' + total + ' 周</button>' : '')
      + '<div class="hint">环比 = 本周均值 − 上周均值；括号内为相对当前体重的百分比。</div>'
      + '</section>';
  }

  /* ---------------- 分析页 ---------------- */
  function emptyState(title, sub) {
    return '<section class="card empty"><div class="empty-title">' + esc(title) + '</div>'
      + (sub ? '<div class="empty-sub">' + esc(sub) + '</div>' : '')
      + '<button class="btn" data-act="goto-record">去记录</button></section>';
  }

  function foldCard(key, title, digest, body, defaultOpen) {
    var open = (app.folds && app.folds[key] !== undefined) ? app.folds[key] : !!defaultOpen;
    return '<details class="card fold" data-fold="' + key + '"' + (open ? ' open' : '') + '>'
      + '<summary class="fold-head">'
      + '<span class="section-title">' + title + '</span>'
      + '<span class="fold-digest">' + (digest || '') + '</span>'
      + '<i class="chev">›</i>'
      + '</summary>'
      + '<div class="fold-body">' + body + '</div>'
      + '</details>';
  }

  function modelLabel(d) {
    if (!d.forecast) return '数据不足';
    return d.forecast.model === 'decay' ? '含平台期' : '线性';
  }

  function forecastSettingsBody(d) {
    var st = app.repo.state.settings;
    var windows = [14, 28, 56];
    var models = [['auto', '自动'], ['linear', '线性'], ['decay', '含平台期']];
    var body = '<div class="field"><span class="field-label">计算窗口</span><div class="seg small">'
      + windows.map(function (n) {
        return '<button data-act="trend-window" data-value="' + n + '" class="' + (st.trendWindow === n ? 'on' : '') + '">' + n + ' 天</button>';
      }).join('')
      + '</div></div>'
      + '<div class="field"><span class="field-label">预测模型</span><div class="seg small">'
      + models.map(function (m) {
        return '<button data-act="forecast-model" data-value="' + m[0] + '" class="' + (st.forecastModel === m[0] ? 'on' : '') + '">' + m[1] + '</button>';
      }).join('')
      + '</div></div>'
      + '<div class="hint">窗口越短越跟得上最近的变化。窗口内<b>越近的数据权重越高</b>（半衰期 = 窗口的一半），所以换阶段时不用精确标日期，旧阶段会自然淡出。</div>';

    if (d.forecast) {
      body += '<div class="hint">当前：' + (d.forecast.model === 'decay' ? '含平台期（速度逐渐放缓）' : '线性外推（匀速变化）')
        + '，起点对齐当前体重 ' + Fmt.kg(d.current.value) + ' kg。</div>';
    }
    return body;
  }

  function renderAnalysis() {
    var d = app.dash;
    if (!d.hasData) return emptyState('还没有数据', '记录几天后这里会出现速度、预测和归因');

    return rateCard(d)
      + forecastCard(d)
      + targetCard(d)
      + foldCard('forecast', '预测设置', '窗口 ' + d.quality.trendWindow + ' 天 · ' + modelLabel(d), forecastSettingsBody(d))
      + foldCard('rates', '三种口径对照', '14 / ' + d.quality.trendWindow + ' 天', rateTableBody(d))
      + eventCard(d)
      + waistCard(d)
      + qualityCard(d);
  }

  function rateCard(d) {
    var r = d.rates.main;
    var j = d.judgement;
    var body;
    if (!r) {
      body = '<div class="muted-text">至少要 8 天、跨度 10 天以上的记录才能给出速度。当前记录 ' + d.series.length + ' 天。</div>';
    } else {
      body = '<div class="rate-big">'
        + '<div class="rate-cell"><b>' + Fmt.kgSigned(r.kgPerWeek) + '</b><i>kg/周</i></div>'
        + '<div class="rate-cell"><b>' + (r.pctPerWeek === null ? '—' : Fmt.pct(r.pctPerWeek)) + '</b><i>%/周</i></div>'
        + '</div>'
        + '<div class="muted-text">80% 区间 ' + Fmt.interval(r.lo80Kg, r.hi80Kg, 2, 'kg/周')
        + ' · 基于 ' + r.n + ' 个记录日（跨度 ' + r.spanDays + ' 天）</div>';
    }
    return '<section class="card">'
      + '<div class="section-title">近 ' + d.quality.trendWindow + ' 天变化速度 ' + chip(j.tone, j.label) + '</div>'
      + body
      + '</section>';
  }

  function rateRow(label, r, main) {
    if (!r) return '<tr><td' + (main ? ' class="strong"' : '') + '>' + label + '</td><td class="num dim">—</td><td class="num dim">—</td></tr>';
    return '<tr>'
      + '<td' + (main ? ' class="strong"' : '') + '>' + label + '</td>'
      + '<td class="num' + (main ? ' strong' : '') + '">' + Fmt.kgSigned(r.kgPerWeek) + '</td>'
      + '<td class="num' + (main ? ' strong' : '') + '">' + (r.pctPerWeek === null ? '—' : Fmt.pct(r.pctPerWeek)) + '</td>'
      + '</tr>';
  }

  function rateTableBody(d) {
    var r = d.rates;
    return '<table class="table"><thead><tr><th>口径</th><th class="num">kg/周</th><th class="num">%/周</th></tr></thead><tbody>'
      + rateRow('本周均值 vs 上周', r.d7, false)
      + rateRow('14 天趋势', r.s14, false)
      + rateRow(d.quality.trendWindow + ' 天趋势（主）', r.s28, true)
      + '</tbody></table>'
      + '<div class="hint">口径冲突时以主指标为准：它用 Theil–Sen 中位数斜率，抗离群点和漏记。</div>';
  }

  function forecastCard(d) {
    var f = d.forecast;
    if (!f) {
      return '<section class="card"><div class="section-title">趋势预测</div>'
        + '<div class="muted-text">需要至少 8 天、跨度 10 天的记录才能预测。</div></section>';
    }
    var rows = f.weekly.map(function (w) {
      return '<tr>'
        + '<td>' + w.weeksAhead + ' 周后</td>'
        + '<td class="num strong">' + Fmt.kg(w.kg) + '</td>'
        + '<td class="num dim">' + Fmt.fixed(w.lo80, 2) + '–' + Fmt.fixed(w.hi80, 2) + '</td>'
        + '<td class="num">' + (w.pctVsNow === null ? '—' : Fmt.pct(w.pctVsNow)) + '</td>'
        + '</tr>';
    }).join('');

    return '<section class="card">'
      + '<div class="section-title">趋势预测 ' + chip('info', f.model === 'decay' ? '含平台期' : '线性外推') + '</div>'
      + '<table class="table"><thead><tr><th>时间</th><th class="num">预计周均 kg</th><th class="num">80% 区间</th><th class="num">相对现在</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>'
      + '<div class="hint">'
      + (f.model === 'decay'
        ? '模型判断你的变化速度会随时间自然放缓（热适应），并不是一直线性下降。'
        : '当前数据更支持线性外推；如果以后变慢，模型会自动切换。')
      + ' 区间基于残差离散度，天数越远越宽。</div>'
      + '</section>';
  }

  function targetCard(d) {
    var t = d.target;
    if (!t) {
      return '<section class="card"><div class="section-title">目标</div>'
        + '<div class="muted-text">在设置里填一个目标体重，这里会算出按当前趋势还要多久。</div></section>';
    }
    if (t.reached) {
      return '<section class="card"><div class="section-title">目标</div>'
        + '<div class="big-text good">已经达到 ' + Fmt.kg(t.kg) + ' kg 的目标</div></section>';
    }
    var trend = t.byTrend
      ? '<div class="kv"><span>按当前趋势</span><b>约 ' + Fmt.weeks(t.byTrend.weeks) + '</b><em>' + t.byTrend.date
        + (t.byTrend.loWeeks !== null ? '（' + Fmt.weeks(t.byTrend.loWeeks) + '–' + Fmt.weeks(t.byTrend.hiWeeks) + '）' : '')
        + '</em></div>'
      : '<div class="kv"><span>按当前趋势</span><b class="dim">按当前速度到不了</b></div>';

    var plan = '';
    if (t.byPlan) {
      var pb = t.byPlan;
      plan = '<div class="kv"><span>按计划速度</span><b>约 ' + Fmt.weeks(pb.weeksFast) + '–' + Fmt.weeks(pb.weeksSlow) + '</b>'
        + '<em>' + pb.dateFast + ' ~ ' + pb.dateSlow + '</em></div>'
        + '<div class="muted-text">计划 ' + Fmt.fixed(pb.pctMin, 2) + '–' + Fmt.fixed(pb.pctMax, 2) + ' %/周 ≈ '
        + Fmt.kgSigned(pb.kgPerWeekSlow) + ' ~ ' + Fmt.kgSigned(pb.kgPerWeekFast) + ' kg/周</div>';
    }

    return '<section class="card">'
      + '<div class="section-title">目标 ' + Fmt.kg(t.kg) + ' kg</div>'
      + '<div class="muted-text">还差 ' + Fmt.kg(Math.abs(t.gapKg)) + ' kg（' + (t.gapKg < 0 ? '需要减' : '需要增') + '）</div>'
      + trend + plan
      + '</section>';
  }

  function eventCard(d) {
    var items = d.events.filter(function (e) { return e.n > 0 || Math.abs(e.effectKg) > 0.01; });
    if (!items.length) return '';

    var maxAbs = Math.max.apply(null, items.map(function (e) { return Math.abs(e.effectKg); }).concat([0.1]));
    var rows = items.map(function (e) {
      var w = Math.max(6, Math.round(Math.abs(e.effectKg) / maxAbs * 100));
      var source = e.source === 'learned' ? '基于 ' + e.n + ' 次记录'
        : (e.source === 'mixed' ? '先验 + ' + e.n + ' 次记录' : '经验值（还没攒够样本）');
      return '<div class="ev-row">'
        + '<div class="ev-name">' + (e.emoji ? e.emoji + ' ' : '') + esc(e.name) + '</div>'
        + '<div class="ev-bar"><i class="' + (e.effectKg >= 0 ? 'up' : 'down') + '" style="width:' + w + '%"></i></div>'
        + '<div class="ev-val ' + (e.effectKg >= 0 ? 'up' : 'down') + '">' + Fmt.kgSigned(e.effectKg) + ' kg</div>'
        + '<div class="ev-meta">' + source + (e.decayDays ? ' · 通常 ' + e.decayDays + ' 天内回落' : '') + '</div>'
        + '</div>';
    }).join('');

    var scenarioChips = d.events.slice(0, 6).map(function (e) {
      return '<button type="button" class="chip ev' + (app.scenario[e.id] ? ' on' : '') + '" data-act="scenario" data-id="' + e.id + '">'
        + esc(e.name) + '</button>';
    }).join('');

    var scenarioText = renderScenario();

    var body = rows
      + '<div class="hint">短期波动主要是水分、糖原和肠道内容物，不代表脂肪变化。</div>'
      + '<div class="section-title small">如果接下来几天发生这些事</div>'
      + '<div class="chips ev-chips">' + scenarioChips + '</div>'
      + '<div id="scenarioBox">' + scenarioText + '</div>';

    return foldCard('events', '事件影响与情景', items.length + ' 项', body);
  }

  function renderScenario() {
    var d = app.dash;
    var chosen = Object.keys(app.scenario).filter(function (id) { return app.scenario[id]; });
    if (!chosen.length) {
      return '<div class="muted-text">选几个事件，看看它们会把接下来 7 天的体重推到哪。</div>';
    }
    if (!app.fc) return '<div class="muted-text">数据还不够，先攒几天记录。</div>';

    var defs = {};
    d.events.forEach(function (e) { defs[e.id] = e; });
    var startDay = d.todayDay + 1;
    var rows = '';
    for (var h = 1; h <= 7; h++) {
      var day = d.todayDay + h;
      var base = Stats.forecastAt(app.fc, day);
      var add = 0;
      chosen.forEach(function (id) {
        var e = defs[id];
        if (!e) return;
        var decay = Math.max(1, e.decayDays || 1);
        add += e.effectKg * Math.exp(-(day - startDay) / decay);
      });
      rows += '<tr><td>' + Fmt.dateCN(Stats.formatDate(day)) + '</td>'
        + '<td class="num">' + Fmt.kg(base) + '</td>'
        + '<td class="num ' + (add >= 0 ? 'up' : 'down') + '">' + Fmt.kgSigned(add) + '</td>'
        + '<td class="num strong">' + Fmt.kg(base + add) + '</td></tr>';
    }
    return '<table class="table small"><thead><tr><th>日期</th><th class="num">趋势</th><th class="num">事件影响</th><th class="num">预计</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>';
  }

  function waistCard(d) {
    var w = d.waist;
    if (!w.slope && !w.n) return '';
    var slope = w.slope;
    var rows = '';
    if (slope) {
      rows += '<div class="rate-big one">'
        + '<div class="rate-cell"><b>' + Fmt.cmSigned(slope.kgPerWeek) + '</b><i>cm/周</i></div>'
        + '</div>';
      if (slope.lo80Kg !== null) {
        rows += '<div class="muted-text">80% 区间 ' + Fmt.interval(slope.lo80Kg, slope.hi80Kg, 1, 'cm/周')
          + ' · 基于 ' + slope.n + ' 次记录</div>';
      }
    } else {
      rows += '<div class="muted-text">腰围记录还不够（至少 4 次、跨度 14 天）。</div>';
    }
    if (w.last) rows += '<div class="muted-text">最近一次：' + Fmt.dateCN(Stats.formatDate(w.last.day)) + ' ' + Fmt.cm(w.last.v) + ' cm</div>';
    if (d.consistency) rows += '<div class="consistency ' + d.consistency.tone + '">' + esc(d.consistency.text) + '</div>';

    var digest = w.slope ? Fmt.cmSigned(w.slope.kgPerWeek) + ' cm/周' : '记录不足';
    return foldCard('waist', '腰围', digest, rows);
  }

  function qualityCard(d) {
    var q = d.quality;
    var items = [];
    items.push('覆盖：近 ' + q.trendWindow + ' 天有 ' + q.coverage28 + ' 天记录');
    if (q.daysSinceLast !== null) items.push('最近记录：' + (q.daysSinceLast === 0 ? '今天' : q.daysSinceLast + ' 天前'));
    if (q.outliers.length) items.push('疑似离群点：' + q.outliers.slice(-3).map(function (s) { return Fmt.md(s); }).join('、'));
    if (q.gaps.length) items.push('断档：' + q.gaps.slice(-2).map(function (g) { return Fmt.md(g.from) + '→' + Fmt.md(g.to) + '(' + g.days + ' 天)'; }).join('、'));
    if (d.estimatedDays.length) items.push('由训练后体重折算补齐：' + d.estimatedDays.length + ' 天');

    return foldCard('quality', '数据质量', q.coverage28 + '/' + q.trendWindow + ' 天', 
      '<ul class="plain">' + items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>'
      + '<div class="hint">漏记不需要补填，算法只在有记录的日子里计算，不会当成 0。</div>');
  }

  /* ---------------- 设置页 ---------------- */
  function modeLabelOf(p) {
    return p.mode === 'bulk' ? '增肌' : (p.mode === 'maintain' ? '维持' : '减脂');
  }

  function renderSettings() {
    var s = app.repo.state;
    var p = s.profile;
    var st = s.settings;

    var targetDigest = p.targetWeightKg ? '目标 ' + Fmt.kg(p.targetWeightKg) + ' kg' : '未设目标';

    var personal = settingRow('身高', 'profile.heightCm', 'number', p.heightCm, 'cm')
      + settingRow('目标体重（可留空）', 'profile.targetWeightKg', 'number', p.targetWeightKg, 'kg')
      + settingRow('目标速度下限', 'profile.goalRateMinPctPerWeek', 'number', p.goalRateMinPctPerWeek, '%/周')
      + settingRow('目标速度上限', 'profile.goalRateMaxPctPerWeek', 'number', p.goalRateMaxPctPerWeek, '%/周')
      + '<div class="hint">' + goalRateHint(p) + '</div>'
      + '<div class="field"><span class="field-label">模式</span><div class="seg small" data-group="mode">'
      + ['cut|减脂', 'maintain|维持', 'bulk|增肌'].map(function (pair) {
        var v = pair.split('|')[0];
        return '<button data-act="mode" data-value="' + v + '" class="' + (p.mode === v ? 'on' : '') + '">' + pair.split('|')[1] + '</button>';
      }).join('')
      + '</div></div>'
      + '<div class="field"><span class="field-label">每周从</span><div class="seg small">'
      + '<button data-act="weekstart" data-value="1" class="' + (p.weekStartsOn === 1 ? 'on' : '') + '">周一开始</button>'
      + '<button data-act="weekstart" data-value="0" class="' + (p.weekStartsOn === 0 ? 'on' : '') + '">周日开始</button>'
      + '</div></div>';

    var calc = settingRow('平滑天数', 'settings.smoothingDays', 'number', st.smoothingDays, '天')
      + settingRow('趋势窗口', 'settings.trendWindow', 'number', st.trendWindow, '天')
      + settingRow('预测周数', 'settings.forecastWeeks', 'number', st.forecastWeeks, '周')
      + toggleRow('缺晨起体重时，用训练后体重估算（不推荐）', 'settings.convertPost', st.convertPost)
      + toggleRow('趋势计算时跳过事件日及其回落期', 'settings.excludeEventDays', st.excludeEventDays)
      + toggleRow('在图上显示原始点', 'settings.showRaw', st.showRaw)
      + toggleRow('在图上显示训练后体重', 'settings.showPost', st.showPost);

    var dataBody = '<div class="muted-text">' + esc(Sync.statusText(null)) + '</div>'
      + '<div class="kv"><span>当前版本</span><b>v' + VERSION + '</b>'
      + '<em><button class="link" data-act="check-update">检查更新</button></em></div>'
      + '<div class="btn-row">'
      + '<button class="btn" data-act="export-json">导出 JSON 备份</button>'
      + '<button class="btn" data-act="export-csv">导出 CSV</button>'
      + '<button class="btn" data-act="paste-toggle">粘贴导入</button>'
      + '<button class="btn" data-act="import">导入文件</button>'
      + '<button class="btn" data-act="csv-template">下载 CSV 模板</button>'
      + '<button class="btn" data-act="demo">载入演示数据</button>'
      + '<button class="btn danger" data-act="clear">清空全部数据</button>'
      + '</div>'
      + '<input type="file" id="importFile" accept=".json,.csv,.txt,application/json,text/csv,text/plain" hidden>'
      + (app.pasteOpen ? pastePanel() : '')
      + '<div class="hint">可以直接把手机备忘录里「<b>2026年10月30日：空78.75kg 77.8cm 81.45kg</b>」这种整段内容粘进来；CSV 表头能识别 日期 / 晨起 / 体重 / 训练后 / 腰围 / 事件 / 备注。</div>'
      + '<div class="hint">数据只保存在这台设备的浏览器里。换手机、清缓存前请先导出 JSON。</div>';

    var about = '<details><summary>周平均速度是怎么算的</summary><div class="prose">'
      + '<p>单日体重受水分、糖原和肠道内容物影响，日间波动常有 0.5–1 kg，所以不看单日数字。</p>'
      + '<p><b>7 天滚动均值</b>：每天取最近 7 天已记录值的平均，缺失日不补 0。它消掉了周内节律，比如周末聚餐导致的周一大涨。</p>'
      + '<p><b>稳健斜率</b>：用 Theil–Sen 估计（所有点对斜率的中位数），对离群点和漏记都不敏感。再乘 7 得到 kg/周，除以当前平滑体重得到 %/周。</p>'
      + '<p><b>不确定性</b>：对日期做 400 次自助重抽样得到 80% 区间。区间越宽，说明数据越不足以支撑结论。</p>'
      + '</div></details>'
      + '<details><summary>预测是怎么来的</summary><div class="prose">'
      + '<p>在「计算窗口」内拟合趋势（默认 28 天），<b>越近的数据权重越高</b>（半衰期 = 窗口的一半），所以换阶段时旧阶段会自然淡出。</p>'
      + '<p>可以选「线性」（匀速变化）、「含平台期」（速度逐渐放缓，适合减脂后期）或「自动」。<b>增肌模式下自动一律用线性</b>，因为上调热量的过程是加速的，饱和模型方向相反。</p>'
      + '<p>预测曲线<b>从当前体重出发</b>（起点对齐近 7 天均值），所以第一周的预测不会和卡片上的数字对不上。</p>'
      + '<p>预测区间由残差的稳健离散度决定，天数越远越宽；预测的是「那一周的平均体重」，比预测某一天更稳。</p>'
      + '</div></details>'
      + '<details><summary>聚餐、有氧、换计划影响怎么算</summary><div class="prose">'
      + '<p>每个事件有一个先验偏移量和回落天数（比如外出聚餐 +0.7 kg、2–3 天回落）。</p>'
      + '<p>应用会把事件日及其回落期的实测值，和「事件前后各 4 天的中位数基线」比较，得到你自己的实测影响。</p>'
      + '<p>用经验贝叶斯收缩：effect = (n × 实测均值 + 5 × 先验) / (n + 5)。样本少时主要听先验，样本多了就越来越听你自己的数据。</p>'
      + '</div></details>'
      + '<details><summary>这些数字不能做什么</summary><div class="prose">'
      + '<p>两位小数是精度，不是准确度：0.02 kg 的变化没有意义。</p>'
      + '<p>本工具只做计算和提示，不构成医疗或营养建议。安全减脂速度参考 0.25–1.0 %体重/周。</p>'
      + '</div></details>';

    return foldCard('personal', '个人信息', modeLabelOf(p) + ' · ' + targetDigest, personal)
      + foldCard('calc', '计算设置', '窗口 ' + st.trendWindow + ' 天', calc)
      + foldCard('events-edit', '事件与预期影响', app.repo.allEvents().length + ' 项',
        '<div class="hint">先验值可以按你自己的经验改；攒够 5 次记录后，应用会用自己的数据校正。</div>' + eventEditor())
      + foldCard('data', '数据与备份', 'v' + VERSION, dataBody)
      + foldCard('about', '关于计算', '', about);
  }

  function pastePanel() {
    return '<div class="paste-box">'
      + '<textarea id="pasteText" rows="6" placeholder="把备忘录内容整段粘进来，例如：2026年10月30日：空78.75kg 77.8cm 81.45kg"></textarea>'
      + '<div class="btn-row">'
      + '<button class="btn primary" data-act="paste-import">解析并导入</button>'
      + '<button class="btn" data-act="paste-cancel">取消</button>'
      + '</div>'
      + '<div class="hint">一行一天；带 kg 的按顺序当作「晨起、训练后」，带 cm 的当作腰围。文件导入也支持同样的文本。</div>'
      + '</div>';
  }

  function goalRateHint(p) {
    var min = p.goalRateMinPctPerWeek;
    var max = p.goalRateMaxPctPerWeek;
    if (!Fmt.parseNum(min) || !Fmt.parseNum(max)) return '目标速度用于判定「在计划内 / 偏快 / 偏慢」。';
    var cur = app.dash && app.dash.current ? app.dash.current.value : null;
    var dir = p.mode === 'bulk' ? 1 : -1;
    var base = '目标速度 ' + Fmt.fixed(min, 2) + '–' + Fmt.fixed(max, 2) + ' %/周';
    if (cur) base += ' ≈ ' + Fmt.kgSigned(dir * (min / 100) * cur) + ' ~ ' + Fmt.kgSigned(dir * (max / 100) * cur) + ' kg/周';
    return base + '。落在这个区间里显示「在计划内」。';
  }

  function settingRow(label, key, kind, value, unit) {
    var v = (value === null || value === undefined) ? '' : String(value);
    return '<label class="field inline">'
      + '<span class="field-label">' + label + '</span>'
      + '<span class="field-input">'
      + '<input type="text" inputmode="decimal" data-setting="' + key + '" data-kind="' + kind + '" value="' + esc(v) + '" placeholder="未设置">'
      + '<b>' + unit + '</b></span></label>';
  }

  function toggleRow(label, key, on) {
    return '<label class="toggle"><input type="checkbox" data-setting="' + key + '" data-kind="bool"' + (on ? ' checked' : '') + '><span>' + label + '</span></label>';
  }

  function eventEditor() {
    var defs = app.repo.allEvents();
    var overrides = app.repo.state.eventOverrides || {};
    var custom = app.repo.state.customEvents || [];
    var rows = defs.map(function (e) {
      var isCustom = custom.some(function (c) { return c.id === e.id; });
      var o = overrides[e.id] || {};
      var prior = (o.priorKg === null || o.priorKg === undefined) ? e.priorKg : o.priorKg;
      var decay = (o.decayDays === null || o.decayDays === undefined) ? e.decayDays : o.decayDays;
      return '<div class="ev-edit">'
        + '<div class="ev-edit-name">' + (e.emoji || '') + ' ' + esc(e.name) + '</div>'
        + '<input type="text" inputmode="decimal" data-ev="' + e.id + '" data-field="priorKg" value="' + prior + '" aria-label="影响 kg">'
        + '<span class="unit">kg</span>'
        + '<input type="text" inputmode="numeric" data-ev="' + e.id + '" data-field="decayDays" value="' + decay + '" aria-label="回落天数">'
        + '<span class="unit">天</span>'
        + (isCustom ? '<button class="link danger" data-act="del-event" data-id="' + e.id + '">删除</button>' : '')
        + '</div>';
    }).join('');

    return rows
      + '<div class="ev-add">'
      + '<input type="text" id="newEvName" maxlength="8" placeholder="新事件名称">'
      + '<input type="text" id="newEvPrior" inputmode="decimal" placeholder="影响 kg" value="0.5">'
      + '<button class="btn small" data-act="add-event">添加</button>'
      + '</div>';
  }

  /* ---------------- 演示数据 ---------------- */
  function makeDemoEntries() {
    var todayDay = app.dash.todayDay;
    var out = {};
    var weight = 78.4;
    var rnd = (function (seed) {
      return function () {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
    })(20261116);
    var eventsPlan = { 7: 'eatout', 18: 'longCardio', 19: 'longCardio', 26: 'dietChange', 33: 'eatout', 34: 'highSalt' };
    for (var i = 85; i >= 0; i--) {
      var day = todayDay - i;
      var ds = Stats.formatDate(day);
      var progress = (85 - i) / 85;
      var trend = 78.4 - 3.6 * progress;
      var noise = (rnd() - 0.5) * 0.55;
      var ev = eventsPlan[(85 - i)];
      var bump = 0;
      if (ev === 'eatout') bump = 0.9;
      if (ev === 'highSalt') bump = 0.5;
      if (ev === 'longCardio') bump = -0.6;
      if (ev === 'dietChange') bump = -1.0;
      var v = trend + noise + bump;
      var entry = { date: ds, weightAM: Math.round(v * 100) / 100, updatedAt: 1 };
      if (rnd() > 0.12) entry.weightPost = Math.round((v - 0.7 + (rnd() - 0.5) * 0.4) * 100) / 100;
      if (i % 3 === 0) entry.waist = Math.round((92 - 3.2 * progress + (rnd() - 0.5) * 0.4) * 10) / 10;
      if (ev) entry.events = [ev];
      out[ds] = entry;
    }
    return out;
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    document.addEventListener('click', function (e) {
      var target = e.target;
      if (!target || !target.closest) return;

      var tabBtn = target.closest('#tabs button');
      if (tabBtn) {
        app.tab = tabBtn.getAttribute('data-tab');
        try { history.replaceState(null, '', '#' + app.tab); } catch (err) {}
        render();
        return;
      }

      var btn = target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      handleAction(act, btn);
    });

    document.addEventListener('change', function (e) {
      var el = e.target;
      if (!el) return;
      if (el.getAttribute && el.getAttribute('data-setting')) return handleSettingChange(el);
      if (el.getAttribute && el.getAttribute('data-ev')) return handleEventEdit(el);
      if (el.id === 'importFile') return handleImportFile(el);
    });

    var view = $('#view');
    if (view) {
      // <details> 的展开状态要记住，否则重新渲染会全部收起
      view.addEventListener('toggle', function (e) {
        var t = e.target;
        if (t && t.getAttribute && t.getAttribute('data-fold')) {
          app.folds[t.getAttribute('data-fold')] = !!t.open;
        }
      }, true);

      view.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target && e.target.name && e.target.name !== 'note') {
          e.preventDefault();
          saveEntry();
        }
      });
    }

    window.addEventListener('resize', debounce(function () {
      if (app.tab === 'trend') render();
    }, 200));
  }

  function handleAction(act, el) {
    switch (act) {
      case 'prev-day':
        app.date = Stats.formatDate(Math.max(
          Stats.parseDate(app.date) - 1,
          app.dash.todayDay - 365
        ));
        render();
        break;
      case 'next-day': {
        var next = Stats.parseDate(app.date) + 1;
        if (next <= app.dash.todayDay) { app.date = Stats.formatDate(next); render(); }
        break;
      }
      case 'pick-day':
        app.date = el.getAttribute('data-date');
        render();
        break;
      case 'save':
        saveEntry();
        break;
      case 'toggle-event': {
        el.classList.toggle('on');
        break;
      }
      case 'toggle-events': {
        var block = el.closest('.ev-block');
        if (block) block.classList.toggle('open');
        break;
      }
      case 'toggle-weeks': {
        var card = el.closest('.card');
        var wrap = card ? card.querySelector('.weeks-wrap') : null;
        if (!wrap) break;
        var opened = wrap.classList.toggle('open');
        el.textContent = opened ? '收起' : ('展开全部 ' + el.getAttribute('data-count') + ' 周');
        break;
      }
      case 'trend-window':
        app.repo.updateSettings({ trendWindow: Number(el.getAttribute('data-value')) });
        break;
      case 'forecast-model':
        app.repo.updateSettings({ forecastModel: el.getAttribute('data-value') });
        break;
      case 'chartmode':
        app.chartMode = el.getAttribute('data-value');
        render();
        break;
      case 'range':
        app.range = Number(el.getAttribute('data-value'));
        render();
        break;
      case 'mode':
        app.repo.updateProfile({ mode: el.getAttribute('data-value') });
        break;
      case 'weekstart':
        app.repo.updateProfile({ weekStartsOn: Number(el.getAttribute('data-value')) });
        break;
      case 'scenario': {
        var id = el.getAttribute('data-id');
        app.scenario[id] = !app.scenario[id];
        if (!app.scenario[id]) delete app.scenario[id];
        el.classList.toggle('on');
        var box = $('#scenarioBox');
        if (box) box.innerHTML = renderScenario();
        break;
      }
      case 'install-app':
        if (installPrompt) {
          installPrompt.prompt();
          installPrompt = null;
        } else {
          toast('请用浏览器菜单里的「安装应用 / 添加到主屏幕」');
        }
        break;
      case 'apply-update':
        if (app.applyUpdate) app.applyUpdate();
        break;
      case 'check-update':
        if (app.checkUpdate) app.checkUpdate();
        break;
      case 'goto-settings':
        app.tab = 'settings';
        render();
        break;
      case 'goto-record':
        app.tab = 'record';
        render();
        break;
      case 'export-json':
        download('体重趋势-备份-' + stamp() + '.json', app.repo.exportJSON(), 'application/json');
        toast('已导出 JSON', 'good');
        break;
      case 'export-csv':
        download('体重趋势-' + stamp() + '.csv', app.repo.exportCSV(), 'text/csv');
        toast('已导出 CSV', 'good');
        break;
      case 'import': {
        var input = $('#importFile');
        if (input) input.click();
        break;
      }
      case 'paste-toggle':
        app.pasteOpen = !app.pasteOpen;
        render();
        break;
      case 'paste-cancel':
        app.pasteOpen = false;
        render();
        break;
      case 'paste-import': {
        var ta = $('#pasteText');
        if (!ta) break;
        var pm = window.confirm('点「确定」= 合并（只补空缺，不覆盖已有数据）；点「取消」= 覆盖同一天') ? 'merge' : 'replace';
        var pr = app.repo.importText(ta.value, pm);
        if (pr.ok) {
          app.pasteOpen = false;
          toast('已导入 ' + pr.count + ' 天' + (pr.skipped ? '，跳过 ' + pr.skipped + ' 行' : ''), 'good');
          render();
        } else {
          toast('导入失败：' + pr.error, 'bad');
        }
        break;
      }
      case 'csv-template':
        download('体重趋势-导入模板.csv', app.repo.csvTemplate(), 'text/csv');
        toast('模板已下载');
        break;
      case 'demo': {
        if (!window.confirm('载入 85 天演示数据？会覆盖现有记录（会先自动备份）。')) break;
        var demo = makeDemoEntries();
        var res = app.repo.importData({ entries: demo }, 'merge');
        toast(res.ok ? '演示数据已载入（' + res.count + ' 天）' : '载入失败：' + res.error, res.ok ? 'good' : 'bad');
        break;
      }
      case 'clear':
        if (!window.confirm('确定清空所有记录？请先确认已经导出备份。')) break;
        app.repo.clearAll();
        toast('已清空');
        break;
      case 'add-event': {
        var name = $('#newEvName');
        var prior = $('#newEvPrior');
        if (!name || !name.value.trim()) { toast('先填事件名', 'bad'); break; }
        app.repo.addCustomEvent({ name: name.value.trim(), priorKg: Fmt.parseNum(prior ? prior.value : '0') || 0, decayDays: 2 });
        toast('已添加', 'good');
        break;
      }
      case 'del-event':
        app.repo.removeCustomEvent(el.getAttribute('data-id'));
        toast('已删除');
        break;
      default:
        break;
    }
  }

  function handleSettingChange(el) {
    var key = el.getAttribute('data-setting');
    var kind = el.getAttribute('data-kind');
    var value;
    if (kind === 'bool') value = el.checked;
    else if (kind === 'number') {
      value = Fmt.parseNum(el.value);
      if (value === null && el.value.trim() !== '') { toast('请输入数字', 'bad'); return; }
      if (el.value.trim() === '') value = null;
    } else value = el.value;

    var parts = key.split('.');
    if (parts[0] === 'profile') {
      var patch = {};
      patch[parts[1]] = value;
      app.repo.updateProfile(patch);
    } else if (parts[0] === 'settings') {
      var sp = {};
      sp[parts[1]] = value === null ? undefined : value;
      app.repo.updateSettings(sp);
    }
    toast('已保存', 'good');
  }

  function handleEventEdit(el) {
    var id = el.getAttribute('data-ev');
    var field = el.getAttribute('data-field');
    var raw = el.value.trim();
    if (raw === '') return;
    var v = field === 'decayDays' ? Math.round(Fmt.parseNum(raw)) : Fmt.parseNum(raw);
    if (v === null || !isFinite(v)) { toast('请输入数字', 'bad'); return; }
    var patch = {};
    patch[field] = v;
    app.repo.setEventOverride(id, patch);
    toast('已保存', 'good');
  }

  function handleImportFile(el) {
    var file = el.files && el.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      var mode = window.confirm('点「确定」= 合并（只补空缺，不覆盖已有数据）；点「取消」= 覆盖同一天') ? 'merge' : 'replace';
      var res = app.repo.importText(text, mode);
      if (res.ok) {
        var extra = res.skipped ? '，跳过 ' + res.skipped + ' 行' : '';
        toast('已导入 ' + res.count + ' 天' + extra, 'good');
      } else {
        toast('导入失败：' + res.error, 'bad');
      }
      el.value = '';
    };
    reader.readAsText(file, 'utf-8');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
