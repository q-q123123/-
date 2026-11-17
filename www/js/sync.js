/* 体重趋势 · 同步契约（本版不启用，仅提供接口与合并能力）
 *
 * 设计：数据层是「本地优先」的。Repo 始终同步读写本机缓存（localStorage），
 * 界面永远不等网络。将来的云端同步是后台任务：
 *
 *   1) 启动 / 回到前台 / 手动点击时调用 adapter.pull({ sinceRev })
 *   2) 拿到远端 records + tombstones 后调用 WTStore.mergeRecords(本地, 远端)
 *   3) 把合并结果写回本地缓存（driver.write）并 emit 刷新界面
 *   4) 本地有改动时调用 adapter.push({ records, tombstones, baseRev })
 *
 * 服务端只需要做到：
 *   - 每条记录按 (date) 存最新版本，带 updatedAt / deviceId
 *   - 删除写墓碑 { date, deletedAt, deviceId }，不物理删除
 *   - 维护单调递增 rev，pull 支持 sinceRev 增量
 *   - 冲突用「updatedAt 大者胜，相同则 deviceId 大者胜」——与本地合并函数完全一致
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.WTSync = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CONTRACT = [
    'adapter.name: string',
    'adapter.pull({ sinceRev, deviceId }): Promise<{ records: Entry[], tombstones: Tombstone[], rev: number }>',
    'adapter.push({ records: Entry[], tombstones: Tombstone[], baseRev: number }): Promise<{ rev: number, conflicts: Entry[] }>'
  ].join('\n');

  /* 默认适配器：什么都不做，保证 UI 的“同步状态”永远显示“本机模式” */
  var NoopSyncAdapter = {
    name: 'none',
    pull: function () { return Promise.resolve({ records: [], tombstones: [], rev: 0 }); },
    push: function () { return Promise.resolve({ rev: 0, conflicts: [] }); }
  };

  /* 把远端记录合并进本地状态（纯函数，便于测试） */
  function applyRemote(state, payload, mergeFn) {
    if (!payload) return { changed: false, conflicts: 0 };
    var merged = mergeFn(
      { entries: state.entries || {}, tombstones: state.tombstones || [] },
      { entries: payload.records || {}, tombstones: payload.tombstones || [] }
    );
    var changed = JSON.stringify(merged.entries) !== JSON.stringify(state.entries || {});
    return {
      entries: merged.entries,
      tombstones: merged.tombstones,
      conflicts: merged.conflicts,
      changed: changed
    };
  }

  /* 生成自 sinceRev 以来的本地增量（本地记录都带 rev 之外的时间戳，这里用 updatedAt 过滤） */
  function diffSince(state, sinceTime) {
    var records = {};
    var entries = state.entries || {};
    Object.keys(entries).forEach(function (d) {
      var e = entries[d];
      if (!sinceTime || (e.updatedAt || 0) > sinceTime) records[d] = e;
    });
    var tombstones = (state.tombstones || []).filter(function (t) {
      return !sinceTime || (t.deletedAt || 0) > sinceTime;
    });
    return { records: records, tombstones: tombstones };
  }

  function statusText(adapter) {
    if (!adapter || adapter.name === 'none') return '本机模式（数据只保存在这台设备）';
    return '已连接：' + adapter.name;
  }

  return {
    CONTRACT: CONTRACT,
    NoopSyncAdapter: NoopSyncAdapter,
    applyRemote: applyRemote,
    diffSince: diffSince,
    statusText: statusText
  };
});
