/* -*- coding: utf-8 -*-
 * luna.js - LG webOS Luna Service Bus / uMediaServer / yt-dlp chroot デーモン連携
 * Chromium 53 (ES5) 完全互換
 */
(function (global) {
  'use strict';

  var activeBridges = [];

  function callLuna(uri, params, onSuccess, onFailure) {
    if (typeof PalmServiceBridge === 'undefined') {
      if (onFailure) {
        onFailure({ returnValue: false, errorText: 'PalmServiceBridge unavailable' });
      }
      return null;
    }
    try {
      var bridge = new PalmServiceBridge();
      activeBridges.push(bridge);
      bridge.onservicecallback = function (msg) {
        var idx = activeBridges.indexOf(bridge);
        if (idx !== -1 && (!params || !params.subscribe)) {
          activeBridges.splice(idx, 1);
        }
        var res = {};
        try {
          res = JSON.parse(msg);
        } catch (e) {
          res = { returnValue: false, raw: msg };
        }
        if (res && res.returnValue !== false) {
          if (onSuccess) onSuccess(res);
        } else {
          if (onFailure) onFailure(res);
        }
      };
      bridge.call(uri, JSON.stringify(params || {}));
      return bridge;
    } catch (err) {
      if (onFailure) onFailure({ returnValue: false, errorText: String(err) });
      return null;
    }
  }

  /**
   * 稼働中の yt-dlp 常駐デーモン (127.0.0.1:7019) を確認し、未起動なら start_daemon.sh で起動する
   */
  function ensureLocalHelper(callback) {
    pingHelper(function (ok, info) {
      if (ok && info && info.ytdlpVersion) {
        if (callback) callback(true, info);
      } else {
        spawnHelper(callback);
      }
    });
  }

  function pingHelper(callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'http://127.0.0.1:7019/api/ping', true);
    xhr.timeout = 1500;
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          callback(true, data);
        } catch (e) {
          callback(false, null);
        }
      } else {
        callback(false, null);
      }
    };
    xhr.onerror = function () { callback(false, null); };
    xhr.ontimeout = function () { callback(false, null); };
    xhr.send();
  }

  function spawnHelper(callback) {
    var scriptPath = '/media/developer/apps/usr/palm/applications/tv.dtvplus.webos/backend/start_daemon.sh';
    var cmd = '/bin/sh ' + scriptPath;
    callLuna(
      'luna://org.webosbrew.hbchannel.service/exec',
      { command: cmd },
      function () {
        // Python 3.12 + yt_dlp モジュール初回ロード完了をポーリング確認
        var retries = 0;
        function waitReady() {
          retries++;
          pingHelper(function (ok, info) {
            if (ok) {
              if (callback) callback(true, info);
            } else if (retries < 12) {
              setTimeout(waitReady, 500);
            } else {
              if (callback) callback(false, null);
            }
          });
        }
        setTimeout(waitReady, 600);
      },
      function () {
        if (callback) callback(false, null);
      }
    );
  }

  /**
   * LG純正 uMediaServer のハードウェア二ヶ国語（デュアルモノ）切替
   */
  function setAudioDualMono(mediaId, mode, callback) {
    if (!mediaId) {
      if (callback) callback(false, 'mediaId未取得');
      return;
    }
    callLuna(
      'luna://com.webos.media/setAudioDualMono',
      { mediaId: mediaId, audioMode: mode },
      function (res) { if (callback) callback(true, res); },
      function (err) { if (callback) callback(false, err); }
    );
  }

  /**
   * LG純正 uMediaServer のマルチ音声トラック切替
   */
  function selectAudioTrack(mediaId, trackIndex, callback) {
    if (!mediaId) {
      if (callback) callback(false, 'mediaId未取得');
      return;
    }
    callLuna(
      'luna://com.webos.media/selectTrack',
      { mediaId: mediaId, type: 'audio', index: trackIndex },
      function (res) { if (callback) callback(true, res); },
      function (err) { if (callback) callback(false, err); }
    );
  }

  /**
   * 純正 Live TV アプリを起動し、その上にニコニコ実況透過オーバーレイを重ねる
   */
  function launchNativeTvWithOverlay(jkId, prefs, callback) {
    callLuna(
      'luna://com.webos.applicationManager/launch',
      { id: 'com.webos.app.livetv' },
      function () {
        setTimeout(function () {
          var launchParams = { jkId: jkId || 'jk1' };
          if (prefs) {
            launchParams.fontSizeKey = prefs.fontSizeKey;
            launchParams.opacity = prefs.opacity;
          }
          callLuna(
            'luna://com.webos.applicationManager/launch',
            { id: 'tv.dtvplus.webos.overlay', params: launchParams },
            function (res) { if (callback) callback(true, res); },
            function (err) { if (callback) callback(false, err); }
          );
        }, 800);
      },
      function (err) {
        if (callback) callback(false, err);
      }
    );
  }

  global.WebOSBridge = {
    callLuna: callLuna,
    ensureLocalHelper: ensureLocalHelper,
    pingHelper: pingHelper,
    setAudioDualMono: setAudioDualMono,
    selectAudioTrack: selectAudioTrack,
    launchNativeTvWithOverlay: launchNativeTvWithOverlay
  };
})(window);
