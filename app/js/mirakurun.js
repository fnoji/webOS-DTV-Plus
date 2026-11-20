/* -*- coding: utf-8 -*-
 * mirakurun.js - Mirakurun / mirakc クライアント (LG純正ISDB選局番号・内蔵jlogo補完・2次元EPG対応)
 * Chromium 53 (ES5) 完全互換
 */
(function (global) {
  'use strict';

  // ARIB / LGTV 純正 BS・BS4K ワンタッチ選局 (shortCut 1〜12) 標準プリセット
  var DEFAULT_BS_SHORTCUTS = {
    101: 1,
    102: 2,
    103: 3,
    141: 4,
    151: 5,
    161: 6,
    171: 7,
    181: 8,
    191: 9,
    200: 10,
    211: 11,
    222: 12
  };

  var DEFAULT_BS4K_SHORTCUTS = {
    101: 1,
    141: 4,
    151: 5,
    161: 6,
    171: 7,
    181: 8,
    191: 9,
    201: 10,
    211: 11,
    221: 12
  };

  function pad3(num) {
    var n = parseInt(num, 10);
    if (isNaN(n) || n < 0) return String(num || '');
    if (n < 10) return '00' + n;
    if (n < 100) return '0' + n;
    return String(n);
  }

  function normalizeBaseUrl(url) {
    if (!url) return '';
    return url.trim().replace(/\/+$/, '');
  }

  function xhrJson(url, timeoutMs, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = timeoutMs || 12000;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var data = JSON.parse(xhr.responseText);
          onSuccess(data);
        } catch (e) {
          if (onError) onError('JSON解析失敗: ' + e.message);
        }
      } else {
        if (onError) onError('HTTPエラー ' + xhr.status + ' (' + url + ')');
      }
    };
    xhr.onerror = function () {
      if (onError) onError('ネットワーク到達不能 (' + url + ')');
    };
    xhr.ontimeout = function () {
      if (onError) onError('応答タイムアウト (' + url + ')');
    };
    xhr.send();
  }

  function fetchNativeTvChannelMap(callback) {
    xhrJson(
      'http://127.0.0.1:7019/api/tv/channelmap',
      1800,
      function (res) {
        callback((res && res.channels) || {});
      },
      function () {
        callback({});
      }
    );
  }

  function checkServerVersion(baseUrl, callback) {
    var base = normalizeBaseUrl(baseUrl);
    var t0 = Date.now();
    xhrJson(
      base + '/api/version',
      12000,
      function (ver) {
        callback(null, {
          current: (ver && ver.current) || '不明',
          latencyMs: Date.now() - t0
        });
      },
      function (err) {
        callback(err, null);
      }
    );
  }

  function detectChannelType(svc, forceType) {
    if (forceType) return forceType;
    if (svc.channel && svc.channel.type) {
      var t = String(svc.channel.type).toUpperCase();
      if (t === 'BS4K') return 'BS4K';
      if (t === 'GR' || t === 'BS' || t === 'CS' || t === 'SKY') return t === 'SKY' ? 'CS' : t;
    }
    var nid = svc.networkId || 0;
    // ARIB 新4K8K衛星放送 BS4K networkId = 11 (0x000B) または serviceType 173 (超高精細映像)
    if (nid === 11 || svc.type === 173) return 'BS4K';
    if (nid === 4) return 'BS';
    if (nid === 6 || nid === 7 || nid === 10) return 'CS';
    if (nid >= 30000) return 'GR';
    if (svc.serviceId >= 101 && svc.serviceId <= 299) return 'BS';
    return 'CS';
  }

  function computeThreeDigitNumber(chType, svc, remoconKeyId, nativeEntry) {
    if (nativeEntry && nativeEntry.channelNumber && nativeEntry.channelNumber.length <= 4) {
      return pad3(nativeEntry.channelNumber);
    }
    if (chType === 'GR') {
      var rck = remoconKeyId || (((svc.serviceId & 0x01E0) >> 5) + 1);
      var branch = (svc.serviceId & 0x0007) + 1;
      if (rck >= 1 && rck <= 12 && branch >= 1 && branch <= 9) {
        return pad3(rck * 10 + branch);
      }
      return pad3(svc.serviceId);
    }
    return pad3(svc.serviceId);
  }

  function fetchServices(baseUrl, callback, options) {
    var opts = options || {};
    var base = normalizeBaseUrl(baseUrl);

    fetchNativeTvChannelMap(function (nativeMap) {
      xhrJson(
        base + '/api/services',
        18000,
        function (rawList) {
          if (!Array.isArray(rawList)) {
            callback('サービス一覧の形式が不正です', null);
            return;
          }
          var filtered = [];
          for (var i = 0; i < rawList.length; i++) {
            var s = rawList[i];
            if (!s || !s.id) continue;
            if (s.type && s.type !== 1 && s.type !== 173) continue;
            if ((s.networkId >= 30000) && ((s.serviceId & 0x01FF) >= 0x0180)) continue;

            var chType = detectChannelType(s, opts.forceChannelType || null);
            if (opts.onlyChannelType && chType !== opts.onlyChannelType) continue;
            var nativeKey = s.networkId + '_' + s.serviceId;
            var nativeEntry = nativeMap[nativeKey] || null;

            var rawRck = s.remoteControlKeyId || (s.channel && s.channel.RemoteControlKeyId) || 0;
            var chNum3 = computeThreeDigitNumber(chType, s, rawRck, nativeEntry);

            // LGTV 純正 DB の shortCut (1〜12) または ARIB 標準ワンタッチ割当を解決
            var shortCut = 0;
            if (nativeEntry && nativeEntry.shortCut >= 1 && nativeEntry.shortCut <= 12) {
              shortCut = nativeEntry.shortCut;
            } else if (chType === 'GR' && rawRck >= 1 && rawRck <= 12) {
              shortCut = rawRck;
            } else if (chType === 'BS' && DEFAULT_BS_SHORTCUTS[s.serviceId]) {
              shortCut = DEFAULT_BS_SHORTCUTS[s.serviceId];
            } else if (chType === 'BS4K' && DEFAULT_BS4K_SHORTCUTS[s.serviceId]) {
              shortCut = DEFAULT_BS4K_SHORTCUTS[s.serviceId];
            }

            // CS1 (networkId=6) / CS2 (networkId=7) のバンド識別 (日本仕様リモコン CS1/CS2 キー対応)
            var csBand = '';
            if (chType === 'CS') {
              csBand = (s.networkId === 6) ? 'CS1' : 'CS2';
            }

            // Mirakurun ロゴ + LGTV 内蔵公式 jlogo フォールバック統合URL
            var proxyLogoUrl =
              'http://127.0.0.1:7019/api/logo?nid=' + encodeURIComponent(String(s.networkId)) +
              '&sid=' + encodeURIComponent(String(s.serviceId)) +
              '&id=' + encodeURIComponent(String(s.id)) +
              '&base=' + encodeURIComponent(base);
            var directLogoUrl = (s.hasLogoData === true) ? (base + '/api/services/' + s.id + '/logo') : '';

            filtered.push({
              id: s.id,
              serviceId: s.serviceId,
              networkId: s.networkId,
              name: s.name || ('CH ' + chNum3),
              channelType: chType,
              channelCode: (s.channel && s.channel.channel) ? String(s.channel.channel) : '',
              csBand: csBand,
              sourceBaseUrl: base,
              remoconId: rawRck,
              channelNumber: chNum3,
              shortCut: shortCut,
              displayNum: chNum3,
              hasLogoData: true,
              logoUrl: proxyLogoUrl,
              directLogoUrl: directLogoUrl,
              jkId: global.JikkyoModule ? global.JikkyoModule.resolveJikkyoId(s) : null,
              isSubChannel: false
            });
          }

          filtered.sort(function (a, b) {
            var order = { GR: 1, BS: 2, BS4K: 3, CS: 4 };
            if ((order[a.channelType] || 9) !== (order[b.channelType] || 9)) {
              return (order[a.channelType] || 9) - (order[b.channelType] || 9);
            }
            if (a.channelType === 'GR') {
              var ra = a.remoconId || 99;
              var rb = b.remoconId || 99;
              if (ra !== rb) return ra - rb;
            }
            var na = parseInt(a.channelNumber, 10) || a.serviceId;
            var nb = parseInt(b.channelNumber, 10) || b.serviceId;
            if (na !== nb) return na - nb;
            return a.serviceId - b.serviceId;
          });

          var seenPrimary = {};
          for (var j = 0; j < filtered.length; j++) {
            var item = filtered[j];
            var groupKey;
            if (item.channelType === 'GR') {
              groupKey = 'GR_' + item.networkId;
            } else if (item.channelType === 'BS') {
              if (item.serviceId >= 101 && item.serviceId <= 189) {
                groupKey = 'BS_' + Math.floor(item.serviceId / 10);
              } else {
                groupKey = 'BS_EXACT_' + item.serviceId;
              }
            } else {
              groupKey = item.channelType + '_' + item.id;
            }
            if (seenPrimary[groupKey]) {
              item.isSubChannel = true;
              // 地デジのサブチャンネルにはワンタッチ1桁 shortCut を割り当てず 3桁番号 ("012"等) とする (LG純正準拠)
              if (item.channelType === 'GR') {
                item.shortCut = 0;
              }
            } else {
              seenPrimary[groupKey] = true;
            }

            // 表示用チャンネル番号: 地デジ主CHは 1〜12、地デジサブCHおよび BS/BS4K/CS は純正通り3桁番号 ("101", "055", "218"等)
            if (item.channelType === 'GR' && !item.isSubChannel && (item.shortCut || item.remoconId)) {
              item.displayNum = String(item.shortCut || item.remoconId);
            } else {
              item.displayNum = item.channelNumber;
            }
          }

          callback(null, filtered);
        },
        function (err) {
          callback(err, null);
        }
      );
    });
  }

  /**
   * 2次元EPGラテ欄および現在番組表示用に、過去2時間〜未来24時間の番組インデックスを作成する
   * options.networkId を指定すると対象ネットワーク (BS4K=11 等) のみを高速取得する
   */
  function fetchProgramsIndex(baseUrl, callback, options) {
    var base = normalizeBaseUrl(baseUrl);
    var opts = options || {};
    var qs = opts.networkId ? ('?networkId=' + encodeURIComponent(String(opts.networkId))) : '';
    xhrJson(
      base + '/api/programs' + qs,
      25000,
      function (rawPrograms) {
        if (!Array.isArray(rawPrograms)) {
          callback('番組情報の形式が不正です', {});
          return;
        }
        var now = Date.now();
        var minTime = now - 2 * 3600 * 1000;
        var maxTime = now + 24 * 3600 * 1000;
        var map = {};

        for (var i = 0; i < rawPrograms.length; i++) {
          var p = rawPrograms[i];
          if (!p || !p.startAt || !p.name) continue;
          var dur = p.duration || 0;
          var endAt = p.startAt + dur;
          if (endAt < minTime || p.startAt > maxTime) continue;

          var extendText = '';
          if (p.extended && typeof p.extended === 'object') {
            var ek = Object.keys(p.extended);
            var parts = [];
            for (var ei = 0; ei < ek.length; ei++) {
              parts.push('【' + ek[ei] + '】' + p.extended[ek[ei]]);
            }
            extendText = parts.join('\n');
          }

          var key = p.networkId + '_' + p.serviceId;
          if (!map[key]) map[key] = [];
          map[key].push({
            id: p.id,
            eventId: p.eventId,
            serviceId: p.serviceId,
            networkId: p.networkId,
            isFree: p.isFree !== false,
            name: p.name,
            description: p.description || '',
            extendedText: extendText,
            startAt: p.startAt,
            endAt: endAt,
            duration: dur
          });
        }

        var keys = Object.keys(map);
        for (var k = 0; k < keys.length; k++) {
          map[keys[k]].sort(function (a, b) {
            return a.startAt - b.startAt;
          });
        }
        callback(null, map);
      },
      function (err) {
        callback(err, {});
      }
    );
  }

  function getCurrentAndNext(programsMap, svc) {
    if (!programsMap || !svc) return { current: null, next: null, list: [] };
    var key = svc.networkId + '_' + svc.serviceId;
    var list = programsMap[key] || [];
    var now = Date.now();
    var current = null;
    var next = null;

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.startAt <= now && now < p.endAt) {
        current = p;
        if (i + 1 < list.length) next = list[i + 1];
        break;
      }
      if (p.startAt > now) {
        next = p;
        break;
      }
    }
    return { current: current, next: next, list: list };
  }

  function buildStreamUrl(baseUrl, svc, useHelperProxy) {
    var base = normalizeBaseUrl((svc && svc.sourceBaseUrl) || baseUrl);
    var isBs4k = !!(svc && svc.channelType === 'BS4K');
    var direct;
    if (isBs4k) {
      // BS4K (MMT/TLV) は Mirakurun 4.x のチャンネルストリーム (?decode=0) から生 MMT/TLV を取得し
      // ローカルデーモンの mmt2ts で MPEG-2 TS (H.265 + AAC-ADTS) へリアルタイム無劣化変換する
      if (svc.channelCode) {
        direct = base + '/api/channels/BS4K/' + encodeURIComponent(svc.channelCode) + '/stream?decode=0';
      } else {
        direct = base + '/api/services/' + svc.id + '/stream?decode=0';
      }
    } else {
      direct = base + '/api/services/' + svc.id + '/stream?decode=1';
    }
    if (useHelperProxy || isBs4k) {
      return (
        'http://127.0.0.1:7019/stream/' + svc.id + '.m2ts' +
        '?target=' + encodeURIComponent(direct) +
        '&sid=' + encodeURIComponent(String((svc && svc.serviceId) || 0)) +
        (isBs4k ? '&mode=bs4k' : '')
      );
    }
    return direct;
  }

  global.MirakurunClient = {
    pad3: pad3,
    normalizeBaseUrl: normalizeBaseUrl,
    checkServerVersion: checkServerVersion,
    fetchServices: fetchServices,
    fetchProgramsIndex: fetchProgramsIndex,
    getCurrentAndNext: getCurrentAndNext,
    buildStreamUrl: buildStreamUrl
  };
})(window);
