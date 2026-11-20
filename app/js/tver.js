/* -*- coding: utf-8 -*-
 * tver.js - yt-dlp 常駐デーモン統合クライアント (TVer / Abema TV / yt-dlp自己更新)
 * ストリームURL抽出はすべて TV内 chroot の公式 yt-dlp に依存
 * Chromium 53 (ES5) 完全互換
 */
(function (global) {
  'use strict';

  var DAEMON_BASE = 'http://127.0.0.1:7019';

  function callDaemon(path, timeoutMs, callback) {
    function sendReq() {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', DAEMON_BASE + path, true);
      xhr.timeout = timeoutMs || 25000;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            callback(null, JSON.parse(xhr.responseText));
          } catch (e) {
            callback('JSON解析エラー: ' + e.message, null);
          }
        } else {
          var msg = 'HTTP ' + xhr.status;
          try {
            var errObj = JSON.parse(xhr.responseText);
            if (errObj && errObj.error) msg = errObj.error;
          } catch (e2) {}
          callback(msg, null);
        }
      };
      xhr.onerror = function () {
        callback('ローカルストリームサービスに接続できません', null);
      };
      xhr.ontimeout = function () {
        callback('ストリーム取得がタイムアウトしました', null);
      };
      xhr.send();
    }

    if (global.WebOSBridge) {
      global.WebOSBridge.ensureLocalHelper(function () {
        sendReq();
      });
    } else {
      sendReq();
    }
  }

  function callDaemonPost(path, bodyObj, timeoutMs, callback) {
    function sendReq() {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', DAEMON_BASE + path, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = timeoutMs || 20000;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            callback(null, JSON.parse(xhr.responseText));
          } catch (e) {
            callback('JSON解析エラー: ' + e.message, null);
          }
        } else {
          var msg = 'HTTP ' + xhr.status;
          try {
            var errObj = JSON.parse(xhr.responseText);
            if (errObj && errObj.error) msg = errObj.error;
          } catch (e2) {}
          callback(msg, null);
        }
      };
      xhr.onerror = function () {
        callback('ローカルストリームサービスに接続できません', null);
      };
      xhr.ontimeout = function () {
        callback('通信がタイムアウトしました', null);
      };
      xhr.send(JSON.stringify(bodyObj || {}));
    }

    if (global.WebOSBridge) {
      global.WebOSBridge.ensureLocalHelper(function () {
        sendReq();
      });
    } else {
      sendReq();
    }
  }

  function getDaemonInfo(callback) {
    callDaemon('/api/ping', 8000, callback);
  }

  function updateYtdlp(callback) {
    callDaemon('/api/ytdlp/update', 95000, callback);
  }

  function fetchTverHome(callback) {
    callDaemon('/api/tver/home', 20000, callback);
  }

  function fetchTverLiveChannels(callback) {
    callDaemon('/api/tver/live/channels', 25000, callback);
  }

  function searchTver(keyword, callback) {
    callDaemon('/api/tver/search?q=' + encodeURIComponent(keyword || ''), 20000, callback);
  }

  function fetchJikkyoForces(callback) {
    callDaemon('/api/jikkyo/forces', 8000, callback);
  }

  function fetchTverGoodCounts(ids, callback) {
    callDaemonPost('/api/tver/good_counts', { ids: ids || [] }, 15000, callback);
  }

  function checkExpiredVodHistory(items, callback) {
    callDaemonPost('/api/vod/check_expired', { items: items || [] }, 18000, callback);
  }

  function fetchAbemaChannels(callback) {
    callDaemon('/api/abema/channels', 25000, callback);
  }

  function fetchAbemaVodHome(genreId, callback) {
    var q = genreId ? ('?genre=' + encodeURIComponent(genreId)) : '';
    callDaemon('/api/abema/vod/home' + q, 25000, callback);
  }

  function searchAbemaVod(keyword, callback) {
    callDaemon('/api/abema/vod/search?q=' + encodeURIComponent(keyword || ''), 25000, callback);
  }

  function fetchAbemaVodSeries(seriesId, seasonIdOrCb, maybeCb) {
    var seasonId = '';
    var callback = maybeCb;
    if (typeof seasonIdOrCb === 'function') {
      callback = seasonIdOrCb;
    } else if (seasonIdOrCb) {
      seasonId = String(seasonIdOrCb);
    }
    var url = '/api/abema/vod/series?id=' + encodeURIComponent(seriesId || '');
    if (seasonId) url += '&seasonId=' + encodeURIComponent(seasonId);
    callDaemon(url, 25000, callback);
  }

  /**
   * TVer / Abema TV / 任意URLのストリームをローカルデーモン経由で抽出する
   */
  function extractStreamUrl(pageUrl, callback) {
    callDaemon('/api/extract?url=' + encodeURIComponent(pageUrl), 35000, callback);
  }

  function getDeviceInfo(callback) {
    callDaemon('/api/device/info', 5000, callback);
  }

  function discoverLanServers(kind, callback) {
    callDaemon('/api/lan/discover?type=' + encodeURIComponent(kind || ''), 18000, callback);
  }

  function checkPendingSyncedSettings(callback) {
    callDaemon('/api/sync/settings/pending', 5000, callback);
  }

  function ackSyncedSettings(callback) {
    callDaemonPost('/api/sync/settings/ack', {}, 5000, callback);
  }

  global.VodStreamClient = {
    getDaemonInfo: getDaemonInfo,
    getDeviceInfo: getDeviceInfo,
    discoverLanServers: discoverLanServers,
    checkPendingSyncedSettings: checkPendingSyncedSettings,
    ackSyncedSettings: ackSyncedSettings,
    updateYtdlp: updateYtdlp,
    fetchTverHome: fetchTverHome,
    fetchTverLiveChannels: fetchTverLiveChannels,
    searchTver: searchTver,
    fetchTverGoodCounts: fetchTverGoodCounts,
    fetchJikkyoForces: fetchJikkyoForces,
    checkExpiredVodHistory: checkExpiredVodHistory,
    fetchAbemaChannels: fetchAbemaChannels,
    fetchAbemaVodHome: fetchAbemaVodHome,
    searchAbemaVod: searchAbemaVod,
    fetchAbemaVodSeries: fetchAbemaVodSeries,
    extractStreamUrl: extractStreamUrl
  };
})(window);
