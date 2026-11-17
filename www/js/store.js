/* 体重趋势 · 数据层：schema / 校验 / 合并 / 导入导出 / 存储驱动抽象
 * 设计目标：本版只读写手机本地（localStorage），但结构、修订号、墓碑与合并函数
 * 都已为将来的「手机 ⇄ 电脑」同步准备好（见 js/sync.js 的契约）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.WTStore = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 3;
  var KEY = 'wt.v2';
  var BACKUP_PREFIX = 'wt.backup.';
  var MAX_BACKUPS = 3;

  var LIMITS = {
    weightAM: [20, 400],
    weightPost: [20, 400],
    waist: [25, 250]
  };

  var DEFAULT_EVENTS = [
    { id: 'eatout', name: '外出聚餐', emoji: '🍜', kind: 'transient', priorKg: 0.7, decayDays: 3 },
    { id: 'highSalt', name: '高盐', emoji: '🧂', kind: 'transient', priorKg: 0.5, decayDays: 2 },
    { id: 'carbLoad', name: '高碳水', emoji: '🍚', kind: 'transient', priorKg: 0.6, decayDays: 3 },
    { id: 'longCardio', name: '长时间有氧', emoji: '🏃', kind: 'transient', priorKg: -0.5, decayDays: 2 },
    { id: 'dietChange', name: '饮食计划调整', emoji: '📋', kind: 'structural', priorKg: -0.8, decayDays: 7 },
    { id: 'alcohol', name: '饮酒', emoji: '🍺', kind: 'transient', priorKg: 0.4, decayDays: 2 },
    { id: 'poorSleep', name: '睡眠不足', emoji: '😴', kind: 'transient', priorKg: 0.3, decayDays: 1 },
    { id: 'illness', name: '生病', emoji: '🤒', kind: 'structural', priorKg: 0, decayDays: 0 },
    { id: 'period', name: '经期前后', emoji: '🌙', kind: 'transient', priorKg: 0.8, decayDays: 4 }
  ];

  function nowMs() { return Date.now(); }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 8) + (Date.now() % 100000).toString(36);
  }

  function roundTo(v, digits) {
    var f = Math.pow(10, digits);
    var r = Math.round(v * f) / f;
    return Object.is(r, -0) ? 0 : r;
  }

  function numOrNull(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v.trim().replace(',', '.'));
      return isFinite(n) ? n : null;
    }
    return null;
  }

  function newDB() {
    return {
      version: SCHEMA,
      deviceId: uid('dev'),
      rev: 0,
      profile: {
        heightCm: null,
        sex: null,
        mode: 'cut',
        targetWeightKg: null,
        goalRateMinPctPerWeek: 0.25,
        goalRateMaxPctPerWeek: 0.5,
        weekStartsOn: 1
      },
      entries: {},
      customEvents: [],
      eventOverrides: {},
      settings: {
        smoothingDays: 7,
        trendWindow: 28,
        forecastWeeks: 4,
        showRaw: true,
        showPost: true,
        convertPost: false,
        excludeEventDays: false
      },
      tombstones: [],
      meta: { createdAt: nowMs(), lastExportAt: null, lastImportAt: null }
    };
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function sanitizeEntry(raw, date) {
    if (!isPlainObject(raw)) return null;
    var d = typeof raw.date === 'string' && raw.date.length === 10 ? raw.date : date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return null;
    var out = { date: d };
    var hasValue = false;

    ['weightAM', 'weightPost'].forEach(function (f) {
      var v = numOrNull(raw[f]);
      if (v === null) return;
      if (v < LIMITS[f][0] || v > LIMITS[f][1]) return;
      out[f] = roundTo(v, 2);
      hasValue = true;
    });

    var w = numOrNull(raw.waist);
    if (w !== null && w >= LIMITS.waist[0] && w <= LIMITS.waist[1]) {
      out.waist = roundTo(w, 1);
      hasValue = true;
    }

    out.events = Array.isArray(raw.events) ? raw.events.filter(function (x) { return typeof x === 'string'; }) : [];
    if (typeof raw.note === 'string' && raw.note.trim()) out.note = raw.note.trim().slice(0, 200);
    out.flags = Array.isArray(raw.flags) ? raw.flags.slice(0, 8) : [];
    out.updatedAt = typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt) ? raw.updatedAt : nowMs();
    out.deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : '';

    if (!hasValue && !out.events.length && !out.note) return null;
    return out;
  }

  function normalizeDB(raw) {
    var db = newDB();
    if (!isPlainObject(raw)) return db;

    if (typeof raw.deviceId === 'string' && raw.deviceId) db.deviceId = raw.deviceId;
    if (typeof raw.rev === 'number' && isFinite(raw.rev)) db.rev = raw.rev;

    if (isPlainObject(raw.profile)) {
      var p = raw.profile;
      if (numOrNull(p.heightCm) !== null) db.profile.heightCm = numOrNull(p.heightCm);
      if (p.sex === 'male' || p.sex === 'female') db.profile.sex = p.sex;
      if (p.mode === 'cut' || p.mode === 'bulk' || p.mode === 'maintain') db.profile.mode = p.mode;
      if (numOrNull(p.targetWeightKg) !== null) db.profile.targetWeightKg = roundTo(numOrNull(p.targetWeightKg), 2);
      // 目标速度：旧版是单值 goalRatePctPerWeek，迁移成 [min, max] 区间
      var gMin = numOrNull(p.goalRateMinPctPerWeek);
      var gMax = numOrNull(p.goalRateMaxPctPerWeek);
      var legacy = numOrNull(p.goalRatePctPerWeek);
      if (legacy !== null) {
        legacy = Math.abs(legacy);
        if (gMax === null) gMax = legacy;
        if (gMin === null) gMin = legacy * 0.5;
      }
      if (gMax !== null) db.profile.goalRateMaxPctPerWeek = Math.min(5, Math.max(0.02, gMax));
      if (gMin !== null) db.profile.goalRateMinPctPerWeek = Math.min(5, Math.max(0.02, gMin));
      if (db.profile.goalRateMinPctPerWeek > db.profile.goalRateMaxPctPerWeek) {
        var tmpRate = db.profile.goalRateMinPctPerWeek;
        db.profile.goalRateMinPctPerWeek = db.profile.goalRateMaxPctPerWeek;
        db.profile.goalRateMaxPctPerWeek = tmpRate;
      }
      if (p.weekStartsOn === 0 || p.weekStartsOn === 1) db.profile.weekStartsOn = p.weekStartsOn;
    }

    var srcVersion = typeof raw.version === 'number' ? raw.version : 0;

    if (isPlainObject(raw.settings)) {
      var s = raw.settings;
      if (numOrNull(s.smoothingDays) !== null) db.settings.smoothingDays = Math.min(14, Math.max(3, numOrNull(s.smoothingDays)));
      if (numOrNull(s.trendWindow) !== null) db.settings.trendWindow = Math.min(90, Math.max(14, numOrNull(s.trendWindow)));
      if (numOrNull(s.forecastWeeks) !== null) db.settings.forecastWeeks = Math.min(12, Math.max(1, numOrNull(s.forecastWeeks)));
      ['showRaw', 'showPost', 'convertPost', 'excludeEventDays'].forEach(function (k) {
        if (typeof s[k] === 'boolean') db.settings[k] = s[k];
      });
    }

    // v3 起：训练后体重只作参考，不再折算进晨起序列（老数据一次性迁移）
    if (srcVersion < 3) db.settings.convertPost = false;

    if (isPlainObject(raw.entries)) {
      Object.keys(raw.entries).forEach(function (date) {
        var e = sanitizeEntry(raw.entries[date], date);
        if (e) db.entries[e.date] = e;
      });
    }

    if (Array.isArray(raw.customEvents)) {
      raw.customEvents.forEach(function (ev) {
        if (!isPlainObject(ev) || typeof ev.id !== 'string' || typeof ev.name !== 'string') return;
        db.customEvents.push({
          id: ev.id,
          name: ev.name.slice(0, 12),
          emoji: typeof ev.emoji === 'string' ? ev.emoji.slice(0, 4) : '⭐',
          kind: ev.kind === 'structural' ? 'structural' : 'transient',
          priorKg: numOrNull(ev.priorKg) === null ? 0 : roundTo(numOrNull(ev.priorKg), 2),
          decayDays: numOrNull(ev.decayDays) === null ? 2 : Math.min(30, Math.max(0, Math.round(numOrNull(ev.decayDays))))
        });
      });
    }

    if (isPlainObject(raw.eventOverrides)) {
      Object.keys(raw.eventOverrides).forEach(function (id) {
        var o = raw.eventOverrides[id];
        if (!isPlainObject(o)) return;
        db.eventOverrides[id] = {
          priorKg: numOrNull(o.priorKg) === null ? null : roundTo(numOrNull(o.priorKg), 2),
          decayDays: numOrNull(o.decayDays) === null ? null : Math.min(30, Math.max(0, Math.round(numOrNull(o.decayDays))))
        };
      });
    }

    if (Array.isArray(raw.tombstones)) {
      raw.tombstones.forEach(function (t) {
        if (!isPlainObject(t) || typeof t.date !== 'string') return;
        db.tombstones.push({
          date: t.date,
          deletedAt: numOrNull(t.deletedAt) || nowMs(),
          deviceId: typeof t.deviceId === 'string' ? t.deviceId : ''
        });
      });
    }

    if (isPlainObject(raw.meta)) {
      db.meta.createdAt = numOrNull(raw.meta.createdAt) || nowMs();
      db.meta.lastExportAt = numOrNull(raw.meta.lastExportAt);
      db.meta.lastImportAt = numOrNull(raw.meta.lastImportAt);
    }

    return db;
  }

  function allEvents(db) {
    var overrides = (db && db.eventOverrides) || {};
    var out = DEFAULT_EVENTS.map(function (def) {
      var o = overrides[def.id];
      if (!o) return Object.assign({}, def);
      return Object.assign({}, def, {
        priorKg: o.priorKg === null || o.priorKg === undefined ? def.priorKg : o.priorKg,
        decayDays: o.decayDays === null || o.decayDays === undefined ? def.decayDays : o.decayDays
      });
    });
    var custom = (db && db.customEvents) || [];
    for (var i = 0; i < custom.length; i++) {
      if (!out.some(function (d) { return d.id === custom[i].id; })) out.push(Object.assign({}, custom[i]));
    }
    return out;
  }

  function eventById(db, id) {
    var list = allEvents(db);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ---------------- CSV 解析与导入 ---------------- */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function parseCsvRows(text) {
    var firstLine = (text.split(/\r?\n/)[0] || '');
    var counts = { ',': 0, '\t': 0, ';': 0 };
    for (var i = 0; i < firstLine.length; i++) {
      var ch = firstLine.charAt(i);
      if (counts[ch] !== undefined) counts[ch]++;
    }
    var delim = ',';
    if (counts['\t'] > counts[','] && counts['\t'] >= counts[';']) delim = '\t';
    else if (counts[';'] > counts[','] && counts[';'] > counts['\t']) delim = ';';

    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    for (var p = 0; p < text.length; p++) {
      var c = text.charAt(p);
      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(p + 1) === '"') { field += '"'; p++; }
          else inQuotes = false;
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === delim) {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else if (c !== '\r') {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }

    return rows.filter(function (r) {
      return r.some(function (cell) { return String(cell).trim() !== ''; });
    });
  }

  function classifyHeader(raw) {
    var h = String(raw === undefined || raw === null ? '' : raw)
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[()（）[\]【】:：]/g, '');
    if (!h) return null;
    if (/腰|waist|腹围/.test(h)) return 'waist';
    if (/训练后|练后|运动后|post|after/.test(h)) return 'weightPost';
    if (/日期|时间|date|day/.test(h)) return 'date';
    if (/晨|空腹|早起|am|体重|weight/.test(h)) return 'weightAM';
    if (/事件|标签|event|tag|情况/.test(h)) return 'events';
    if (/备注|note|说明|memo/.test(h)) return 'note';
    return null;
  }

  function numCell(v) {
    var s = String(v === undefined || v === null ? '' : v).replace(/[，,\s]/g, '');
    if (!s) return null;
    var m = s.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    var n = Number(m[0]);
    return isFinite(n) ? n : null;
  }

  function parseDateCell(v) {
    var s = String(v === undefined || v === null ? '' : v).trim();
    if (!s) return null;
    var m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (m) {
      var ds1 = m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
      return isRealDate(ds1) ? ds1 : null;
    }
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (m) {
      var ds2 = m[3] + '-' + pad2(+m[1]) + '-' + pad2(+m[2]);
      return isRealDate(ds2) ? ds2 : null;
    }
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) {
      var ds3 = m[1] + '-' + m[2] + '-' + m[3];
      return isRealDate(ds3) ? ds3 : null;
    }
    if (/^\d{5}$/.test(s)) {
      var serial = +s;
      if (serial > 20000 && serial < 80000) {
        var dt = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
        var ds4 = dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
        return isRealDate(ds4) ? ds4 : null;
      }
    }
    return null;
  }

  function isRealDate(ds) {
    var m = ds.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    var dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3];
  }

  function fillEntry(base, extra) {
    var out = Object.assign({}, base);
    ['weightAM', 'weightPost', 'waist'].forEach(function (f) {
      if (out[f] === undefined && extra[f] !== undefined) out[f] = extra[f];
    });
    var ev = (out.events || []).slice();
    (extra.events || []).forEach(function (id) { if (ev.indexOf(id) < 0) ev.push(id); });
    out.events = ev;
    if (!out.note && extra.note) out.note = extra.note;
    return out;
  }

  /*
   * 解析 CSV / TSV 文本 -> { entries, total, skipped, error }
   * 支持：带表头（日期/晨起/体重/训练后/腰围/事件/备注，列顺序任意）
   *       不带表头（默认列顺序：日期, 晨起, 训练后, 腰围, 事件, 备注）
   * 日期支持 2026-11-16 / 2026/11/16 / 2026年11月16日 / 11/16/2026 / 20261116 / Excel 序列号
   */
  function parseCsvEntries(text, eventDefs) {
    var rows = parseCsvRows(String(text === undefined || text === null ? '' : text).replace(/^\ufeff/, ''));
    if (!rows.length) return { entries: {}, total: 0, skipped: 0, error: '文件是空的' };

    var header = rows[0].map(classifyHeader);
    var recognized = header.filter(function (x) { return !!x; }).length;
    var hasHeader = recognized >= 2;

    var col = {};
    if (hasHeader) {
      header.forEach(function (f, idx) { if (f && col[f] === undefined) col[f] = idx; });
    } else {
      col = { date: 0, weightAM: 1, weightPost: 2, waist: 3, events: 4, note: 5 };
    }

    var names = {};
    (eventDefs || []).forEach(function (d) { names[d.name] = d.id; names[d.id] = d.id; });

    var entries = {};
    var skipped = 0;
    var total = 0;
    var startRow = hasHeader ? 1 : 0;

    for (var r = startRow; r < rows.length; r++) {
      var cells = rows[r];
      total++;
      var ds = parseDateCell(cells[col.date]);
      if (!ds) { skipped++; continue; }

      var raw = { date: ds };
      if (col.weightAM !== undefined) {
        var a = numCell(cells[col.weightAM]);
        if (a !== null) raw.weightAM = a;
      }
      if (col.weightPost !== undefined) {
        var b = numCell(cells[col.weightPost]);
        if (b !== null) raw.weightPost = b;
      }
      if (col.waist !== undefined) {
        var w = numCell(cells[col.waist]);
        if (w !== null) raw.waist = w;
      }
      if (col.events !== undefined) {
        var evText = String(cells[col.events] === undefined ? '' : cells[col.events]);
        var ids = [];
        evText.split(/[;,|/、\s]+/).forEach(function (tok) {
          var key = tok.trim();
          if (key && names[key] && ids.indexOf(names[key]) < 0) ids.push(names[key]);
        });
        if (ids.length) raw.events = ids;
      }
      if (col.note !== undefined && cells[col.note]) raw.note = String(cells[col.note]).slice(0, 200);

      var clean = sanitizeEntry(raw, ds);
      if (!clean) { skipped++; continue; }
      entries[ds] = entries[ds] ? fillEntry(entries[ds], clean) : clean;
    }

    return { entries: entries, total: total, skipped: skipped };
  }

  /* 备忘录文本解析（手机记事本里常见的一行一天）：
   *   2026年10月30日：空78.75kg 77.8cm 81.45kg
   * 规则：带 kg 的按出现顺序 -> 晨起空腹、训练后；带 cm 的 -> 腰围；
   *       行内出现事件名/别名（比如「聚餐」）会自动打上标签。
   */
  var MEMO_EVENT_ALIASES = {
    '聚餐': 'eatout', '外食': 'eatout', '下馆子': 'eatout', '饭局': 'eatout',
    '有氧': 'longCardio', '跑步': 'longCardio', '长跑': 'longCardio', '骑车': 'longCardio',
    '换计划': 'dietChange', '改计划': 'dietChange', '调整饮食': 'dietChange',
    '喝酒': 'alcohol', '酒': 'alcohol',
    '熬夜': 'poorSleep', '失眠': 'poorSleep', '没睡好': 'poorSleep',
    '高盐': 'highSalt', '咸': 'highSalt',
    '碳水': 'carbLoad', '主食': 'carbLoad',
    '经期': 'period', '月经': 'period',
    '生病': 'illness', '感冒': 'illness'
  };

  function parseMemoEntries(text, eventDefs) {
    var lines = String(text === undefined || text === null ? '' : text)
      .replace(/^\ufeff/, '')
      .split(/\r?\n/);
    var entries = {};
    var total = 0;
    var skipped = 0;
    var defs = eventDefs || [];
    var unitRe = /(\d+(?:\.\d+)?)\s*(kg|KG|Kg|公斤|千克|cm|CM|Cm|厘米|公分)/g;
    var stripRe = /(\d+(?:\.\d+)?)\s*(kg|KG|Kg|公斤|千克|cm|CM|Cm|厘米|公分)/gi;

    for (var i = 0; i < lines.length; i++) {
      var s = String(lines[i]).trim();
      if (!s) continue;
      var ds = parseDateCell(s);
      if (!ds) { skipped++; continue; }
      total++;

      var rest = s.replace(/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/, '');
      rest = rest.replace(/^[：:\s、,，.\-]+/, '');

      var kgs = [];
      var cms = [];
      var m;
      unitRe.lastIndex = 0;
      while ((m = unitRe.exec(rest)) !== null) {
        var value = Number(m[1]);
        var unit = m[2].toLowerCase();
        if (unit === 'cm' || unit === '厘米' || unit === '公分') cms.push(value);
        else kgs.push(value);
      }

      if (!kgs.length && !cms.length) { skipped++; continue; }

      var leftover = rest.replace(stripRe, ' ');
      var ids = [];
      for (var d = 0; d < defs.length; d++) {
        var def = defs[d];
        if (def.name && leftover.indexOf(def.name) >= 0 && ids.indexOf(def.id) < 0) ids.push(def.id);
      }
      Object.keys(MEMO_EVENT_ALIASES).forEach(function (key) {
        if (leftover.indexOf(key) >= 0) {
          var id = MEMO_EVENT_ALIASES[key];
          if (ids.indexOf(id) < 0) ids.push(id);
        }
      });

      var raw = { date: ds };
      if (kgs.length >= 1) raw.weightAM = kgs[0];
      if (kgs.length >= 2) raw.weightPost = kgs[1];
      if (cms.length >= 1) raw.waist = cms[0];
      if (ids.length) raw.events = ids;

      var clean = sanitizeEntry(raw, ds);
      if (!clean) { skipped++; continue; }
      entries[ds] = entries[ds] ? fillEntry(entries[ds], clean) : clean;
    }

    return { entries: entries, total: total, skipped: skipped };
  }

  function csvSample() {
    var lines = ['日期,晨起空腹(kg),训练后(kg),腰围(cm),事件,备注'];
    var now = new Date();
    for (var i = 3; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      var ds = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      lines.push(ds + ',72.' + (40 + i) + ',71.' + (70 + i) + ',84.' + (5 + (i % 2)) + ',,');
    }
    return '\ufeff' + lines.join('\r\n');
  }

  /* 合并两条记录的集合：LWW（updatedAt 大者胜，相同时 deviceId 大者胜），墓碑优先 */
  function mergeRecords(a, b) {
    a = a || {};
    b = b || {};
    var localEntries = a.entries || {};
    var remoteEntries = b.entries || {};
    var localTomb = a.tombstones || [];
    var remoteTomb = b.tombstones || [];
    var conflicts = 0;

    var entries = {};
    var dates = {};
    Object.keys(localEntries).forEach(function (d) { dates[d] = 1; });
    Object.keys(remoteEntries).forEach(function (d) { dates[d] = 1; });

    Object.keys(dates).forEach(function (d) {
      var ra = localEntries[d], rb = remoteEntries[d];
      if (!ra) { entries[d] = rb; return; }
      if (!rb) { entries[d] = ra; return; }
      if (ra.updatedAt === rb.updatedAt) {
        if (JSON.stringify(ra) === JSON.stringify(rb)) { entries[d] = ra; return; }
        conflicts++;
        entries[d] = (ra.deviceId || '') >= (rb.deviceId || '') ? ra : rb;
        return;
      }
      conflicts++;
      entries[d] = ra.updatedAt > rb.updatedAt ? ra : rb;
    });

    var tombMap = {};
    localTomb.concat(remoteTomb).forEach(function (t) {
      if (!t || !t.date) return;
      var cur = tombMap[t.date];
      if (!cur || (t.deletedAt || 0) > (cur.deletedAt || 0)) tombMap[t.date] = t;
    });

    var tombstones = [];
    Object.keys(tombMap).forEach(function (d) {
      var t = tombMap[d];
      var e = entries[d];
      if (!e || (e.updatedAt || 0) <= (t.deletedAt || 0)) {
        delete entries[d];
        tombstones.push(t);
      }
    });

    return { entries: entries, tombstones: tombstones, conflicts: conflicts };
  }

  /* ---------------- 存储驱动 ---------------- */
  /* 同步接口：read() -> 原始对象；write(obj)；clear()。
     将来接云端时实现一个 RemoteDriver：仍然同步读写本地缓存，
     后台用 SyncAdapter 拉取/推送并调用 mergeRecords 合并。 */
  function LocalDriver(storage) {
    this.storage = storage || null;
    this.memory = null;
  }
  LocalDriver.prototype.read = function () {
    try {
      if (!this.storage) return this.memory;
      var raw = this.storage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  };
  LocalDriver.prototype.write = function (data) {
    var text = JSON.stringify(data);
    if (!this.storage) { this.memory = JSON.parse(text); return; }
    try { this.storage.setItem(KEY, text); } catch (e) { /* 配额满等：忽略但保留内存态 */ }
  };
  LocalDriver.prototype.clear = function () {
    if (!this.storage) { this.memory = null; return; }
    try { this.storage.removeItem(KEY); } catch (e) {}
  };
  LocalDriver.prototype.backup = function (suffix) {
    if (!this.storage) return null;
    try {
      var raw = this.storage.getItem(KEY);
      if (!raw) return null;
      var key = BACKUP_PREFIX + (suffix || nowMs());
      this.storage.setItem(key, raw);
      var keys = [];
      for (var i = 0; i < this.storage.length; i++) {
        var k = this.storage.key(i);
        if (k && k.indexOf(BACKUP_PREFIX) === 0) keys.push(k);
      }
      keys.sort();
      while (keys.length > MAX_BACKUPS) {
        this.storage.removeItem(keys.shift());
      }
      return key;
    } catch (e) { return null; }
  };

  /* ---------------- Repo ---------------- */
  function Repo(driver) {
    this.driver = driver || new LocalDriver(null);
    this.state = newDB();
    this.listeners = [];
    this.loaded = false;
  }

  Repo.prototype.init = function () {
    var raw = this.driver.read();
    this.state = raw ? normalizeDB(raw) : newDB();
    this.loaded = true;
    // 新建或版本升级后立刻回写，保证迁移只发生一次
    if (!raw || raw.version !== SCHEMA) this.persist();
    return this.state;
  };

  Repo.prototype.persist = function () {
    this.driver.write(this.state);
  };

  Repo.prototype.bump = function () {
    this.state.rev = (this.state.rev || 0) + 1;
  };

  Repo.prototype.subscribe = function (fn) {
    this.listeners.push(fn);
    var self = this;
    return function () {
      self.listeners = self.listeners.filter(function (f) { return f !== fn; });
    };
  };

  Repo.prototype.emit = function (reason) {
    var self = this;
    this.listeners.slice().forEach(function (fn) {
      try { fn(self.state, reason); } catch (e) { /* 单个订阅者异常不影响其它 */ }
    });
  };

  Repo.prototype.commit = function (reason) {
    this.bump();
    this.persist();
    this.emit(reason);
  };

  Repo.prototype.getEntry = function (date) {
    return this.state.entries[date] || null;
  };

  Repo.prototype.upsertEntry = function (date, patch) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
    var cur = this.state.entries[date] || { date: date };
    var next = Object.assign({}, cur, patch || {}, {
      date: date,
      updatedAt: nowMs(),
      deviceId: this.state.deviceId
    });
    var clean = sanitizeEntry(next, date);
    if (!clean) {
      delete this.state.entries[date];
    } else {
      this.state.entries[date] = clean;
    }
    this.commit('entry');
    return clean;
  };

  Repo.prototype.deleteEntry = function (date) {
    if (!this.state.entries[date]) return false;
    delete this.state.entries[date];
    this.state.tombstones.push({ date: date, deletedAt: nowMs(), deviceId: this.state.deviceId });
    this.commit('entry');
    return true;
  };

  Repo.prototype.updateProfile = function (patch) {
    Object.assign(this.state.profile, patch || {});
    var normalized = normalizeDB(this.state).profile;
    this.state.profile = normalized;
    this.commit('profile');
    return this.state.profile;
  };

  Repo.prototype.updateSettings = function (patch) {
    Object.assign(this.state.settings, patch || {});
    this.state.settings = normalizeDB(this.state).settings;
    this.commit('settings');
    return this.state.settings;
  };

  Repo.prototype.setEventOverride = function (id, patch) {
    if (!this.state.eventOverrides[id]) this.state.eventOverrides[id] = { priorKg: null, decayDays: null };
    Object.assign(this.state.eventOverrides[id], patch || {});
    this.commit('events');
  };

  Repo.prototype.addCustomEvent = function (ev) {
    if (!ev || !ev.name) return null;
    var item = {
      id: uid('ev'),
      name: String(ev.name).slice(0, 12),
      emoji: ev.emoji || '⭐',
      kind: ev.kind === 'structural' ? 'structural' : 'transient',
      priorKg: numOrNull(ev.priorKg) === null ? 0 : roundTo(numOrNull(ev.priorKg), 2),
      decayDays: numOrNull(ev.decayDays) === null ? 2 : Math.min(30, Math.max(0, Math.round(numOrNull(ev.decayDays))))
    };
    this.state.customEvents.push(item);
    this.commit('events');
    return item;
  };

  Repo.prototype.removeCustomEvent = function (id) {
    this.state.customEvents = this.state.customEvents.filter(function (e) { return e.id !== id; });
    Object.keys(this.state.entries).forEach(function (d) {
      var e = this.state.entries[d];
      if (e.events && e.events.indexOf(id) >= 0) {
        e.events = e.events.filter(function (x) { return x !== id; });
      }
    }, this);
    this.commit('events');
  };

  Repo.prototype.allEvents = function () {
    return allEvents(this.state);
  };

  Repo.prototype.exportPayload = function () {
    var s = this.state;
    return {
      app: 'weight-trend',
      schema: SCHEMA,
      exportedAt: new Date().toISOString(),
      deviceId: s.deviceId,
      rev: s.rev,
      profile: s.profile,
      settings: s.settings,
      entries: s.entries,
      customEvents: s.customEvents,
      eventOverrides: s.eventOverrides,
      tombstones: s.tombstones
    };
  };

  Repo.prototype.exportJSON = function () {
    this.state.meta.lastExportAt = nowMs();
    this.persist();
    return JSON.stringify(this.exportPayload(), null, 2);
  };

  Repo.prototype.exportCSV = function () {
    var events = allEvents(this.state);
    var nameOf = {};
    events.forEach(function (e) { nameOf[e.id] = e.name; });
    var dates = Object.keys(this.state.entries).sort();
    var lines = ['日期,晨起空腹(kg),训练后(kg),腰围(cm),事件,备注'];
    dates.forEach(function (d) {
      var e = this.state.entries[d];
      var ev = (e.events || []).map(function (id) { return nameOf[id] || id; }).join('|');
      var note = (e.note || '').replace(/"/g, '""');
      lines.push([
        d,
        e.weightAM !== undefined ? e.weightAM.toFixed(2) : '',
        e.weightPost !== undefined ? e.weightPost.toFixed(2) : '',
        e.waist !== undefined ? e.waist.toFixed(1) : '',
        '"' + ev + '"',
        '"' + note + '"'
      ].join(','));
    }, this);
    return '\ufeff' + lines.join('\r\n');
  };

  Repo.prototype.importData = function (input, mode) {
    var obj = input;
    if (typeof input === 'string') {
      try { obj = JSON.parse(input); } catch (e) { return { ok: false, error: 'JSON 解析失败' }; }
    }
    if (!isPlainObject(obj) || !isPlainObject(obj.entries)) {
      return { ok: false, error: '文件格式不正确（缺少 entries）' };
    }

    var incoming = normalizeDB(obj);
    var incomingCount = Object.keys(incoming.entries).length;
    if (!incomingCount && !incoming.tombstones.length) {
      return { ok: false, error: '文件里没有可导入的记录' };
    }

    this.driver.backup('before-import');
    var backupKey = null;

    if (mode === 'replace') {
      var deviceId = this.state.deviceId;
      this.state = incoming;
      this.state.deviceId = deviceId;
    } else {
      var merged = mergeRecords(
        { entries: this.state.entries, tombstones: this.state.tombstones },
        { entries: incoming.entries, tombstones: incoming.tombstones }
      );
      this.state.entries = merged.entries;
      this.state.tombstones = merged.tombstones;
      if (incoming.customEvents.length) {
        var known = {};
        this.state.customEvents.forEach(function (e) { known[e.id] = 1; });
        incoming.customEvents.forEach(function (e) { if (!known[e.id]) this.state.customEvents.push(e); }, this);
      }
      if (incoming.profile && incoming.profile.targetWeightKg !== null) {
        Object.assign(this.state.profile, incoming.profile);
      }
    }

    this.state.meta.lastImportAt = nowMs();
    this.state.meta.lastExportAt = this.state.meta.lastExportAt || null;
    this.bump();
    this.persist();
    this.emit('import');

    return { ok: true, count: incomingCount, backup: backupKey };
  };

  /* 把一批已解析的条目写进库里。mode: 'merge' 只补空字段（默认，安全）；'replace' 覆盖同一天 */
  Repo.prototype.applyEntries = function (entries, mode) {
    var dates = Object.keys(entries || {});
    if (!dates.length) return 0;

    this.driver.backup('before-import');
    var now = nowMs();
    var self = this;
    var changed = 0;

    dates.forEach(function (date) {
      var inc = entries[date];
      var cur = self.state.entries[date];
      var next = (!cur || mode === 'replace') ? Object.assign({}, inc) : fillEntry(cur, inc);
      next.updatedAt = now;
      next.deviceId = self.state.deviceId;
      var clean = sanitizeEntry(next, date);
      if (clean) {
        self.state.entries[date] = clean;
        changed++;
      }
    });

    this.state.meta.lastImportAt = now;
    this.bump();
    this.persist();
    this.emit('import');
    return changed;
  };

  Repo.prototype.importCsv = function (text, mode) {
    var parsed = parseCsvEntries(text, allEvents(this.state));
    if (parsed.error) return { ok: false, error: parsed.error };
    if (!Object.keys(parsed.entries).length) {
      return { ok: false, error: '没有解析到有效记录：需要一列日期，以及体重或腰围中的至少一列' };
    }
    var changed = this.applyEntries(parsed.entries, mode);
    return { ok: true, count: changed, total: parsed.total, skipped: parsed.skipped, source: 'csv' };
  };

  /* 自动识别：JSON / 备忘录文本 / CSV(TSV)，挑解析出记录更多的那一种 */
  Repo.prototype.importText = function (text, mode) {
    var t = String(text === undefined || text === null ? '' : text).trim();
    if (!t) return { ok: false, error: '内容是空的' };
    if (/^[\[{]/.test(t)) return this.importData(t, mode);

    var defs = allEvents(this.state);
    var memo = parseMemoEntries(t, defs);
    var csv = parseCsvEntries(t, defs);
    var memoN = Object.keys(memo.entries).length;
    var csvN = Object.keys(csv.entries).length;
    var chosen = memoN >= csvN ? memo : csv;
    var source = memoN >= csvN ? 'memo' : 'csv';

    if (!Object.keys(chosen.entries).length) {
      return { ok: false, error: '没解析出记录：每行需要以日期开头，后面跟着体重或腰围' };
    }
    var changed = this.applyEntries(chosen.entries, mode);
    return { ok: true, count: changed, total: chosen.total, skipped: chosen.skipped, source: source };
  };

  Repo.prototype.csvTemplate = function () { return csvSample(); };

  Repo.prototype.clearAll = function () {
    this.driver.backup('before-clear');
    this.driver.clear();
    this.state = newDB();
    this.persist();
    this.emit('clear');
  };

  Repo.prototype.stats = function () {
    var dates = Object.keys(this.state.entries);
    return {
      days: dates.length,
      first: dates.length ? dates.sort()[0] : null,
      last: dates.length ? dates.sort()[dates.length - 1] : null
    };
  };

  return {
    SCHEMA: SCHEMA,
    KEY: KEY,
    LIMITS: LIMITS,
    DEFAULT_EVENTS: DEFAULT_EVENTS,
    newDB: newDB,
    normalizeDB: normalizeDB,
    sanitizeEntry: sanitizeEntry,
    allEvents: allEvents,
    eventById: eventById,
    mergeRecords: mergeRecords,
    parseCsvEntries: parseCsvEntries,
    parseMemoEntries: parseMemoEntries,
    parseDateCell: parseDateCell,
    LocalDriver: LocalDriver,
    Repo: Repo,
    roundTo: roundTo
  };
});
