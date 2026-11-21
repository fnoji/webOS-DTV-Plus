/* -*- coding: utf-8 -*-
 * epgstation.js - EPGStation v2 API 統合クライアント (録画一覧・ソート・絞り込み・高速Rangeシーク再生・予約連携)
 * Chromium 53 (ES5) 完全互換
 */
(function (global) {
  'use strict';

  var DAEMON_PROXY = 'http://127.0.0.1:7019/api/epgstation/proxy?target=';
  var DAEMON_DURATION_PROBE = 'http://127.0.0.1:7019/api/recorded/duration?target=';

  // 完了済み動画ファイルの実尺 (秒) インメモリキャッシュ: key -> durationSec
  var videoDurationCache = {};

  function pickPrimaryVideoFile(recItem) {
    var vFiles = (recItem && recItem.videoFiles) || [];
    if (vFiles.length === 0) return null;
    for (var i = 0; i < vFiles.length; i++) {
      if (vFiles[i].type === 'encoded') return vFiles[i];
    }
    for (var j = 0; j < vFiles.length; j++) {
      if (vFiles[j].type === 'ts') return vFiles[j];
    }
    return vFiles[0];
  }

  function makeDurationCacheKey(baseUrl, videoFile) {
    if (!baseUrl || !videoFile || !videoFile.id) return '';
    return normalizeBaseUrl(baseUrl) + '|' + String(videoFile.id) + '|' + String(Number(videoFile.size) || 0);
  }

  function getCachedVideoDuration(baseUrl, recItem) {
    if (!recItem || recItem.isRecording) return 0;
    var vf = pickPrimaryVideoFile(recItem);
    var key = makeDurationCacheKey(baseUrl || recItem.serverUrl, vf);
    return (key && videoDurationCache[key] > 0) ? videoDurationCache[key] : 0;
  }

  function setCachedVideoDuration(baseUrl, recItem, sec) {
    var s = Math.round(Number(sec) || 0);
    if (s <= 0 || !recItem || recItem.isRecording) return;
    var vf = pickPrimaryVideoFile(recItem);
    var key = makeDurationCacheKey(baseUrl || recItem.serverUrl, vf);
    if (key) videoDurationCache[key] = s;
  }

  // ARIB STD-B10 大分類ジャンル名テーブル
  var GENRE_NAMES = {
    0:  'ニュース・報道',
    1:  'スポーツ',
    2:  '情報・ワイドショー',
    3:  'ドラマ',
    4:  '音楽',
    5:  'バラエティ',
    6:  '映画',
    7:  'アニメ・特撮',
    8:  'ドキュメンタリー・教養',
    9:  '劇場・公演',
    10: '趣味・教育',
    11: '福祉',
    14: '拡張',
    15: 'その他'
  };

  function normalizeBaseUrl(url) {
    if (!url) return '';
    return String(url).trim().replace(/\/+$/, '');
  }

  function getGenreName(code) {
    if (code === undefined || code === null) return '未分類';
    return GENRE_NAMES[code] || ('ジャンル ' + code);
  }

  function formatBytes(bytes) {
    var b = Number(bytes) || 0;
    if (b <= 0) return '0 B';
    var tb = b / (1024 * 1024 * 1024 * 1024);
    if (tb >= 1.0) return tb.toFixed(2) + ' TB';
    var gb = b / (1024 * 1024 * 1024);
    if (gb >= 1.0) return gb.toFixed(1) + ' GB';
    var mb = b / (1024 * 1024);
    return mb.toFixed(0) + ' MB';
  }

  function requestJson(method, fullUrl, bodyObj, timeoutMs, callback) {
    function sendVia(targetUrl, allowDirectFallback) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, targetUrl, true);
      xhr.timeout = timeoutMs || 12000;
      if (bodyObj) {
        xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (!xhr.responseText) {
            callback(null, {});
            return;
          }
          try {
            callback(null, JSON.parse(xhr.responseText));
          } catch (e) {
            callback('JSON解析エラー: ' + e.message, null);
          }
        } else {
          var errMsg = 'HTTP ' + xhr.status;
          try {
            var eo = JSON.parse(xhr.responseText);
            if (eo && (eo.message || eo.error)) errMsg += ': ' + (eo.message || eo.error);
          } catch (e2) {}
          callback(errMsg, null);
        }
      };
      xhr.onerror = function () {
        if (allowDirectFallback) {
          sendVia(fullUrl, false);
        } else {
          callback('EPGStation サーバーに接続できません (' + fullUrl + ')', null);
        }
      };
      xhr.ontimeout = function () {
        callback('EPGStation 応答タイムアウト', null);
      };
      xhr.send(bodyObj ? JSON.stringify(bodyObj) : null);
    }

    sendVia(DAEMON_PROXY + encodeURIComponent(fullUrl), true);
  }

  function checkVersion(baseUrl, callback) {
    var base = normalizeBaseUrl(baseUrl);
    if (!base) {
      callback('EPGStation URL が未入力です', null);
      return;
    }
    var t0 = Date.now();
    requestJson('GET', base + '/api/version', null, 5000, function (err, data) {
      if (err || !data) {
        callback(err || '応答なし', null);
        return;
      }
      callback(null, {
        version: data.version || '2.x',
        latencyMs: Date.now() - t0
      });
    });
  }

  function fetchStorages(baseUrl, callback) {
    var base = normalizeBaseUrl(baseUrl);
    if (!base) {
      callback('URL未設定', null);
      return;
    }
    requestJson('GET', base + '/api/storages', null, 6000, function (err, data) {
      if (err || !data || !Array.isArray(data.items) || data.items.length === 0) {
        callback(err || 'ストレージ情報なし', null);
        return;
      }
      var avail = 0;
      var total = 0;
      var used = 0;
      for (var i = 0; i < data.items.length; i++) {
        avail += Number(data.items[i].available) || 0;
        total += Number(data.items[i].total) || 0;
        used  += Number(data.items[i].used) || 0;
      }
      callback(null, {
        available: avail,
        used: used,
        total: total,
        summaryText: 'HDD残量: ' + formatBytes(avail) + ' / ' + formatBytes(total)
      });
    });
  }

  /**
   * チャンネル一覧・録画オプション集計 (局別件数 / ジャンル別件数)・ルール一覧を一括取得する
   */
  function fetchFilterMetadata(baseUrl, mirakurunBaseUrl, callback) {
    var base = normalizeBaseUrl(baseUrl);
    var mkBase = normalizeBaseUrl(mirakurunBaseUrl);
    if (!base) {
      callback('URL未設定', null);
      return;
    }

    var out = {
      channelMap: {},
      channelCounts: [],
      genreCounts: [],
      rules: []
    };
    var pending = 3;
    var rawOptions = null;

    function checkDone() {
      pending--;
      if (pending > 0) return;

      if (rawOptions) {
        var chArr = rawOptions.channels || [];
        for (var i = 0; i < chArr.length; i++) {
          var cid = chArr[i].channelId;
          var chInfo = out.channelMap[cid];
          out.channelCounts.push({
            channelId: cid,
            count: chArr[i].cnt || 0,
            name: chInfo ? chInfo.name : ('CH ' + cid)
          });
        }
        out.channelCounts.sort(function (a, b) { return b.count - a.count; });

        var gArr = rawOptions.genres || [];
        for (var g = 0; g < gArr.length; g++) {
          var gCode = gArr[g].genre;
          out.genreCounts.push({
            genre: gCode,
            count: gArr[g].cnt || 0,
            name: getGenreName(gCode)
          });
        }
        out.genreCounts.sort(function (a, b) { return b.count - a.count; });
      }
      callback(null, out);
    }

    requestJson('GET', base + '/api/channels', null, 8000, function (err, list) {
      if (!err && Array.isArray(list)) {
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          if (!c || !c.id) continue;
          var cleanName = String(c.halfWidthName || c.name || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
          var logoUrl =
            'http://127.0.0.1:7019/api/logo?nid=' + encodeURIComponent(String(c.networkId || '')) +
            '&sid=' + encodeURIComponent(String(c.serviceId || '')) +
            '&id=' + encodeURIComponent(String(c.id)) +
            '&base=' + encodeURIComponent(mkBase || '');
          out.channelMap[c.id] = {
            id: c.id,
            serviceId: c.serviceId,
            networkId: c.networkId,
            channelType: c.channelType || 'GR',
            name: cleanName || ('CH ' + c.id),
            logoUrl: logoUrl,
            directLogoUrl: c.hasLogoData ? (base + '/api/channels/' + c.id + '/logo') : ''
          };
        }
      }
      checkDone();
    });

    requestJson('GET', base + '/api/recorded/options', null, 8000, function (err, optData) {
      if (!err && optData) rawOptions = optData;
      checkDone();
    });

    requestJson('GET', base + '/api/rules?offset=0&limit=80', null, 8000, function (err, rData) {
      if (!err && rData && Array.isArray(rData.rules)) {
        for (var r = 0; r < rData.rules.length; r++) {
          var rl = rData.rules[r];
          var kw = (rl.searchOption && rl.searchOption.keyword) || ('ルール #' + rl.id);
          out.rules.push({ id: rl.id, keyword: kw });
        }
      }
      checkDone();
    });
  }

  function normalizeRecordedRecord(base, r, channelMap) {
    var startMs = Number(r.startAt) || 0;
    var endMs = Number(r.endAt) || 0;
    var epgDurSec = endMs > startMs ? Math.round((endMs - startMs) / 1000) : 0;
    var chInfo = (channelMap && channelMap[r.channelId]) || null;

    var thumbs = r.thumbnails || [];
    var thumbUrl = thumbs.length > 0 ? (base + '/api/thumbnails/' + thumbs[0]) : '';

    var vFiles = r.videoFiles || [];
    var totalBytes = 0;
    var hasEncoded = false;
    var hasTs = false;
    for (var i = 0; i < vFiles.length; i++) {
      totalBytes += Number(vFiles[i].size) || 0;
      if (vFiles[i].type === 'encoded') hasEncoded = true;
      if (vFiles[i].type === 'ts') hasTs = true;
    }

    var cachedRealDur = (!r.isRecording) ? getCachedVideoDuration(base, { serverUrl: base, isRecording: false, videoFiles: vFiles }) : 0;
    var durSec = cachedRealDur > 0 ? cachedRealDur : epgDurSec;

    var chIdNum = Number(r.channelId) || 0;
    var nidNum = chInfo ? chInfo.networkId : (chIdNum >= 100000 ? Math.floor(chIdNum / 100000) : 0);
    var chTypeStr = chInfo ? (chInfo.channelType || '') : (nidNum === 11 ? 'BS4K' : '');

    return {
      id: r.id,
      serverUrl: base,
      programId: r.programId || null,
      channelId: r.channelId,
      serviceId: chInfo ? chInfo.serviceId : (chIdNum ? (chIdNum % 100000) : 0),
      networkId: nidNum,
      channelType: chTypeStr,
      channelName: chInfo ? chInfo.name : ('CH ' + (r.channelId || '')),
      logoUrl: chInfo ? chInfo.logoUrl : '',
      directLogoUrl: chInfo ? chInfo.directLogoUrl : '',
      name: String(r.name || '無題の録画番組').replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''),
      description: r.description || '',
      extended: r.extended || '',
      startAt: startMs,
      endAt: endMs,
      epgDurationSec: epgDurSec,
      realDurationSec: cachedRealDur,
      durationSec: durSec,
      genre1: r.genre1,
      genreLabel: getGenreName(r.genre1),
      isRecording: !!r.isRecording,
      isEncoding: !!r.isEncoding,
      isProtected: !!r.isProtected,
      thumbnailUrl: thumbUrl,
      videoFiles: vFiles,
      totalBytes: totalBytes,
      sizeLabel: formatBytes(totalBytes),
      hasEncoded: hasEncoded,
      hasTs: hasTs
    };
  }

  /**
   * 録画済み一覧を取得する
   * params: { offset, limit, isReverse, channelId, genre, ruleId, keyword }
   */
  function fetchRecordedList(baseUrl, params, channelMap, callback) {
    var base = normalizeBaseUrl(baseUrl);
    if (!base) {
      callback('EPGStation URL が未設定です', null);
      return;
    }
    var p = params || {};
    var qs = [
      'isHalfWidth=true',
      'offset=' + (p.offset || 0),
      'limit=' + (p.limit || 50),
      'isReverse=' + (p.isReverse ? 'true' : 'false')
    ];
    if (p.channelId) qs.push('channelId=' + encodeURIComponent(String(p.channelId)));
    if (p.genre !== undefined && p.genre !== null && p.genre !== '') qs.push('genre=' + encodeURIComponent(String(p.genre)));
    if (p.ruleId) qs.push('ruleId=' + encodeURIComponent(String(p.ruleId)));
    if (p.keyword) qs.push('keyword=' + encodeURIComponent(String(p.keyword)));

    var url = base + '/api/recorded?' + qs.join('&');
    requestJson('GET', url, null, 12000, function (err, data) {
      if (err || !data) {
        callback(err || '取得失敗', null);
        return;
      }
      var rawArr = data.records || data.recorded || [];
      var items = [];
      for (var i = 0; i < rawArr.length; i++) {
        items.push(normalizeRecordedRecord(base, rawArr[i], channelMap));
      }
      callback(null, {
        records: items,
        total: Number(data.total) || items.length
      });
    });
  }

  function fetchReserves(baseUrl, channelMap, callback) {
    var base = normalizeBaseUrl(baseUrl);
    if (!base) {
      callback('URL未設定', null);
      return;
    }
    requestJson('GET', base + '/api/reserves?type=all&isHalfWidth=true&offset=0&limit=200', null, 10000, function (err, data) {
      if (err || !data) {
        callback(err || '予約一覧取得失敗', null);
        return;
      }
      var raw = data.reserves || [];
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var r = raw[i];
        var ch = (channelMap && channelMap[r.channelId]) || null;
        out.push({
          id: r.id,
          serverUrl: base,
          programId: r.programId || null,
          channelId: r.channelId,
          channelName: ch ? ch.name : ('CH ' + (r.channelId || '')),
          logoUrl: ch ? ch.logoUrl : '',
          name: r.name || '予約番組',
          description: r.description || '',
          startAt: Number(r.startAt) || 0,
          endAt: Number(r.endAt) || 0,
          isConflict: !!r.isConflict,
          isSkip: !!r.isSkip,
          isOverlap: !!r.isOverlap
        });
      }
      callback(null, { reserves: out, total: Number(data.total) || out.length });
    });
  }

  /**
   * 現在録画中の番組一覧を取得する (GET /api/recording)
   */
  function fetchRecording(baseUrl, channelMap, callback) {
    var base = normalizeBaseUrl(baseUrl);
    if (!base) {
      callback('URL未設定', null);
      return;
    }
    requestJson('GET', base + '/api/recording?isHalfWidth=true&offset=0&limit=100', null, 10000, function (err, data) {
      if (err || !data) {
        callback(err || '録画中一覧取得失敗', null);
        return;
      }
      var rawArr = data.records || [];
      var items = [];
      for (var i = 0; i < rawArr.length; i++) {
        var rec = normalizeRecordedRecord(base, rawArr[i], channelMap);
        rec.isRecording = true;
        rec.isRecordingEntry = true;
        items.push(rec);
      }
      callback(null, {
        records: items,
        total: Number(data.total) || items.length
      });
    });
  }

  function addProgramReserve(baseUrl, programId, callback) {
    var base = normalizeBaseUrl(baseUrl);
    if (!base || !programId) {
      callback('予約パラメータが不足しています', null);
      return;
    }
    var payload = {
      programId: Number(programId),
      allowEndLack: true,
      option: {
        enableEncode: false
      }
    };
    requestJson('POST', base + '/api/reserves', payload, 10000, callback);
  }

  function deleteReserve(baseUrl, reserveId, callback) {
    var base = normalizeBaseUrl(baseUrl);
    requestJson('DELETE', base + '/api/reserves/' + encodeURIComponent(String(reserveId)), null, 10000, callback);
  }

  /**
   * 録画中の番組を停止（キャンセル）する。
   * EPGStation v2 仕様: /api/recording/{id} は存在しないため、
   * 1) 対応する予約 (reserveId) を /api/reserves から特定して DELETE /api/reserves/{reserveId} (録画停止・録画済部分は保持)
   * 2) 予約が見つからない場合は DELETE /api/recorded/{recordedId} へフォールバックする
   */
  function stopRecording(baseUrl, recItemOrId, callback) {
    var base = normalizeBaseUrl(baseUrl);
    var recId = (recItemOrId && typeof recItemOrId === 'object') ? recItemOrId.id : recItemOrId;
    var progId = (recItemOrId && typeof recItemOrId === 'object') ? recItemOrId.programId : null;
    var chId = (recItemOrId && typeof recItemOrId === 'object') ? recItemOrId.channelId : null;
    var startAt = (recItemOrId && typeof recItemOrId === 'object') ? Number(recItemOrId.startAt || 0) : 0;

    if (!base || !recId) {
      if (callback) callback('録画停止パラメータが不足しています', null);
      return;
    }

    function fallbackDeleteRecorded() {
      requestJson('DELETE', base + '/api/recorded/' + encodeURIComponent(String(recId)), null, 12000, callback);
    }

    requestJson('GET', base + '/api/reserves?type=all&isHalfWidth=true&offset=0&limit=200', null, 8000, function (err, data) {
      if (!err && data && data.reserves && data.reserves.length > 0) {
        var rsvs = data.reserves;
        var matchedReserveId = null;
        for (var i = 0; i < rsvs.length; i++) {
          var r = rsvs[i];
          if (progId && r.programId && String(r.programId) === String(progId)) {
            matchedReserveId = r.id;
            break;
          }
          if (chId && r.channelId && String(r.channelId) === String(chId) && startAt > 0 && r.startAt && Math.abs(Number(r.startAt) - startAt) < 120000) {
            matchedReserveId = r.id;
            break;
          }
        }
        if (matchedReserveId !== null) {
          requestJson('DELETE', base + '/api/reserves/' + encodeURIComponent(String(matchedReserveId)), null, 10000, function (delErr, delRes) {
            if (!delErr) {
              if (callback) callback(null, delRes);
            } else {
              fallbackDeleteRecorded();
            }
          });
          return;
        }
      }
      fallbackDeleteRecorded();
    });
  }

  function deleteRecorded(baseUrl, recordedId, callback) {
    var base = normalizeBaseUrl(baseUrl);
    requestJson('DELETE', base + '/api/recorded/' + encodeURIComponent(String(recordedId)), null, 12000, callback);
  }

  /**
   * 録画アイテムの再生ストリームURLを構築する
   * - エンコード済み (MP4等) がある場合は標準シーク可能な直接URLを優先選択可能
   * - 生TS (.m2ts) の場合は Range バイトオフセット + tsreadex 正規化パイプURLを構築
   */
  function buildPlaybackSource(baseUrl, recItem, offsetSec, forceRawTs) {
    var base = normalizeBaseUrl(baseUrl);
    var vFiles = (recItem && recItem.videoFiles) || [];
    if (vFiles.length === 0) return null;

    var chosen = null;
    if (!forceRawTs) {
      for (var i = 0; i < vFiles.length; i++) {
        if (vFiles[i].type === 'encoded') {
          chosen = vFiles[i];
          break;
        }
      }
    }
    if (!chosen) {
      for (var j = 0; j < vFiles.length; j++) {
        if (vFiles[j].type === 'ts') {
          chosen = vFiles[j];
          break;
        }
      }
    }
    if (!chosen) chosen = vFiles[0];

    var directVideoUrl = base + '/api/videos/' + chosen.id;
    var isRawTs = (chosen.type === 'ts') || /\.m2ts$|\.ts$/i.test(chosen.filename || '');
    var isBs4kRec = !!(
      recItem && (
        recItem.channelType === 'BS4K' ||
        Number(recItem.networkId) === 11 ||
        (Number(recItem.channelId) >= 1100000 && Number(recItem.channelId) < 1200000)
      )
    );

    if (isRawTs) {
      var seekSec = Math.max(0, Math.floor(offsetSec || 0));
      var dur = Math.max(1, Math.floor(recItem.durationSec || 0));
      var fSize = Number(chosen.size) || 0;
      var proxyUrl =
        'http://127.0.0.1:7019/recorded/' + chosen.id + '.m2ts' +
        '?target=' + encodeURIComponent(directVideoUrl) +
        '&offsetSec=' + seekSec +
        '&durationSec=' + dur +
        '&size=' + fSize +
        '&sid=' + encodeURIComponent(String((recItem && recItem.serviceId) || 0)) +
        (isBs4kRec ? '&mode=bs4k' : '');
      return {
        url: proxyUrl,
        directUrl: directVideoUrl,
        isRawTs: true,
        isBs4k: isBs4kRec,
        baseOffsetSec: seekSec,
        videoFile: chosen
      };
    }

    return {
      url: directVideoUrl,
      directUrl: directVideoUrl,
      isRawTs: false,
      baseOffsetSec: 0,
      videoFile: chosen
    };
  }

  /**
   * 録画ファイルの実動画長 (秒) を取得する。
   * 1) 完了済みファイルはサイズ付きキーでインメモリキャッシュから即時返却
   * 2) EPGStation v2 標準 API (/api/videos/{id}/duration) を優先照会
   * 3) BS4K (MMT/TLV) 等で EPGStation 側が 500 エラーを返す場合は、
   *    ローカルデーモンの /api/recorded/duration (Range 先頭/末尾 PCR 差分・サイズ推定) へフォールバック
   */
  function fetchRealDuration(baseUrl, recItem, callback) {
    var base = normalizeBaseUrl(baseUrl || (recItem && recItem.serverUrl));
    var vf = pickPrimaryVideoFile(recItem);
    if (!base || !vf || !vf.id) {
      if (callback) callback('動画ファイル情報なし', 0);
      return;
    }
    var cached = getCachedVideoDuration(base, recItem);
    if (cached > 0) {
      if (callback) callback(null, cached);
      return;
    }

    function probeFallback() {
      var videoUrl = base + '/api/videos/' + vf.id;
      var xhr = new XMLHttpRequest();
      xhr.open('GET', DAEMON_DURATION_PROBE + encodeURIComponent(videoUrl), true);
      xhr.timeout = 7000;
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var res = JSON.parse(xhr.responseText);
            var sec = res && res.ok ? Math.round(Number(res.durationSec) || 0) : 0;
            if (sec > 0) {
              setCachedVideoDuration(base, recItem, sec);
              if (callback) callback(null, sec);
              return;
            }
          } catch (e) {}
        }
        if (callback) callback('実尺取得失敗', 0);
      };
      xhr.onerror = xhr.ontimeout = function () {
        if (callback) callback('実尺取得失敗', 0);
      };
      try {
        xhr.send();
      } catch (eSend) {
        if (callback) callback('実尺取得失敗', 0);
      }
    }

    var durApiUrl = base + '/api/videos/' + vf.id + '/duration';
    requestJson('GET', durApiUrl, null, 6000, function (err, data) {
      var rawDur = (!err && data && data.duration !== undefined) ? Number(data.duration) : 0;
      if (isFinite(rawDur) && rawDur > 0) {
        var sec = Math.max(1, Math.round(rawDur));
        setCachedVideoDuration(base, recItem, sec);
        if (callback) callback(null, sec);
        return;
      }
      probeFallback();
    });
  }

  global.EpgStationClient = {
    normalizeBaseUrl: normalizeBaseUrl,
    getGenreName: getGenreName,
    formatBytes: formatBytes,
    checkVersion: checkVersion,
    fetchStorages: fetchStorages,
    fetchFilterMetadata: fetchFilterMetadata,
    fetchRecordedList: fetchRecordedList,
    fetchReserves: fetchReserves,
    fetchRecording: fetchRecording,
    addProgramReserve: addProgramReserve,
    deleteReserve: deleteReserve,
    stopRecording: stopRecording,
    deleteRecorded: deleteRecorded,
    buildPlaybackSource: buildPlaybackSource,
    fetchRealDuration: fetchRealDuration,
    getCachedVideoDuration: getCachedVideoDuration,
    setCachedVideoDuration: setCachedVideoDuration
  };
})(window);
