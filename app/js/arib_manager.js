/* -*- coding: utf-8 -*-
 * arib_manager.js - ARIB STD-B24 字幕・文字スーパー描画 & BML データ放送統合コントローラ
 * - aribb24.js (CanvasProvider) による高精細縁取り字幕・文字スーパー描画
 * - tsukumijima/web-bml (BMLBrowser + decodeTS) によるデータ放送レンダリング・L字画面連動・NVRAM保持
 * - LGTV 純正 DTV アプリ準拠のリモコン操作 (字幕キー / dデータキー / 4色キー / 十字・決定・戻る・数字キー)
 * Chromium 53 (ES5) 完全互換
 */
(function (global) {
  'use strict';

  var DAEMON_BASE = 'http://127.0.0.1:7019';
  var POLL_INTERVAL_MS = 220;
  var CLOCK_TICK_MS = 60;
  var LIVE_SYNC_DELAY_MS = 850; // uMediaServer ハードウェアデコードバッファ遅延補正

  function createAribManager(opts) {
    opts = opts || {};
    var videoEl = opts.videoEl;
    var videoContainerEl = opts.videoContainerEl;
    var captionCanvas = opts.captionCanvas;
    var superimposeCanvas = opts.superimposeCanvas;
    var bmlOverlayEl = opts.bmlOverlayEl;
    var bmlStageEl = opts.bmlStageEl;
    var bmlContentEl = opts.bmlContentEl;
    var bmlInputEl = opts.bmlInputEl;
    var bmlStatusBadgeEl = opts.bmlStatusBadgeEl;
    var onToast = opts.onToast || function () {};
    var onStateChange = opts.onStateChange || function () {};
    var onTuneRequest = opts.onTuneRequest || function () { return false; };

    var vendor = global.DTVAribVendor || null;

    var state = {
      activeStream: false,
      isLiveStream: true,
      captionEnabled: opts.initialCaptionEnabled === true,
      bmlActive: false,
      bmlHasDataComponent: null, // null: PMT未受信, true: データ放送あり, false: なし
      bmlReceiving: false,
      bmlNetworking: false,
      bmlInvisible: true,
      bmlResWidth: 960,
      bmlResHeight: 540,
      bmlVideoRect: null, // { left, top, right, bottom } in BML coordinates
      bmlUsedKeys: null,  // Set or Object map of active key groups

      sessionId: 0,
      serviceId: 0,
      cursor: 0,
      bmlCursor: 0,
      pollTimer: null,
      pollingXhr: null,
      bmlPollTimer: null,
      bmlXhr: null,
      decodingBusy: false,
      decodeTimer: null,
      bmlDecodingBusy: false,
      bmlDecodeTimer: null,
      bmlBurstUntilMs: 0,
      bmlPrefetchStarted: false,
      clockTimer: null,

      // PCR クロック同期状態
      latestPcrMs: null,
      firstPcrMs: null,
      firstVideoTimeSec: null,
      anchorPcrMs: null,
      anchorWallMs: null,
      displayPcrMs: null,

      // 字幕・文字スーパー状態
      captionQueue: [],
      activeCaption: null, // { pes, ptsMs, expirePcrMs }
      superExpirePcrMs: null,

      // BML バックグラウンドカルーセルキャッシュ (dボタン押下時に0.1秒で即時起動させる)
      cachedPmt: null,
      cachedBit: null,
      cachedProgramInfo: null,
      cachedCurrentTime: null,
      cachedPcr: null,
      cachedModuleLists: {}, // componentId -> msg
      cachedModules: {},     // componentId + '_' + moduleId -> msg
      cachedEsEvents: {}     // componentId -> msg
    };

    var tsDecoder = null;
    var bmlBrowser = null;
    var bmlInputApp = null;
    var dummyMediaEl = document.createElement('div');
    dummyMediaEl.style.width = '100%';
    dummyMediaEl.style.height = '100%';
    var audioCtx = null;
    var uiGainNode = null;
    var dataBtnTimers = [];
    var userOpenedAtMs = 0;

    function clearDataBtnTimers() {
      for (var ti = 0; ti < dataBtnTimers.length; ti++) {
        clearTimeout(dataBtnTimers[ti]);
      }
      dataBtnTimers = [];
    }

    function ensureAudioContext() {
      try {
        var AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return null;
        if (!audioCtx) audioCtx = new AC();
        if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
          audioCtx.resume();
        }
        return audioCtx;
      } catch (e) {
        return null;
      }
    }

    function getAudioDestination() {
      var ctx = ensureAudioContext();
      return ctx ? ctx.destination : null;
    }

    function playUiRomSound(soundId) {
      if (!vendor || !vendor.playRomSound) return;
      var ctx = ensureAudioContext();
      if (!ctx) return;
      try {
        if (!uiGainNode && typeof ctx.createGain === 'function') {
          uiGainNode = ctx.createGain();
          uiGainNode.gain.value = 0.55;
          uiGainNode.connect(ctx.destination);
        }
        var dest = uiGainNode || ctx.destination;
        vendor.playRomSound(soundId, dest);
      } catch (e) {}
    }

    function clearCanvas(cvs) {
      if (!cvs) return;
      var ctx = cvs.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, cvs.width, cvs.height);
    }

    function clearAllCaptions() {
      state.captionQueue = [];
      state.activeCaption = null;
      state.superExpirePcrMs = null;
      clearCanvas(captionCanvas);
      clearCanvas(superimposeCanvas);
    }

    function resetCarouselCache() {
      state.bmlHasDataComponent = null;
      state.bmlPrefetchStarted = false;
      state.bmlBurstUntilMs = 0;
      state.cachedPmt = null;
      state.cachedBit = null;
      state.cachedProgramInfo = null;
      state.cachedCurrentTime = null;
      state.cachedPcr = null;
      state.cachedModuleLists = {};
      state.cachedModules = {};
      state.cachedEsEvents = {};
    }

    /**
     * DII (moduleListUpdated) に記載されたモジュールが一通りメモリキャッシュ済みか判定する
     */
    function isAllListedModulesCached() {
      var listCount = 0;
      for (var cid in state.cachedModuleLists) {
        if (!Object.prototype.hasOwnProperty.call(state.cachedModuleLists, cid)) continue;
        var ml = state.cachedModuleLists[cid];
        var mods = (ml && ml.modules) || [];
        if (mods.length === 0) continue;
        listCount++;
        for (var i = 0; i < mods.length; i++) {
          var mid = mods[i].moduleId;
          if (!state.cachedModules[cid + '_' + mid]) {
            return false;
          }
        }
      }
      return listCount > 0;
    }

    /**
     * BML 起動・ページ遷移・キー操作直後の数秒間だけカルーセル受信を最速バースト化する
     */
    function boostBmlPolling(durationMs) {
      var until = Date.now() + (durationMs || 2800);
      if (until > state.bmlBurstUntilMs) {
        state.bmlBurstUntilMs = until;
      }
      if (!state.activeStream) return;
      if (state.bmlPollTimer) {
        clearTimeout(state.bmlPollTimer);
        state.bmlPollTimer = null;
      }
      if (!state.bmlXhr && !state.bmlDecodingBusy) {
        state.bmlPollTimer = setTimeout(pollBmlCarouselOnce, 10);
      }
    }

    function restoreVideoFullscreen() {
      if (!videoContainerEl || !videoEl) return;
      videoContainerEl.style.left = '0px';
      videoContainerEl.style.top = '0px';
      videoContainerEl.style.width = '1920px';
      videoContainerEl.style.height = '1080px';
      videoEl.style.width = '1920px';
      videoEl.style.height = '1080px';
    }

    function applyBmlVideoGeometry() {
      if (!state.bmlActive || state.bmlInvisible || !state.bmlVideoRect) {
        restoreVideoFullscreen();
        return;
      }
      var r = state.bmlVideoRect;
      var rw = Math.max(1, state.bmlResWidth || 960);
      var rh = Math.max(1, state.bmlResHeight || 540);
      var sx = 1920 / rw;
      var sy = 1080 / rh;

      var leftPx = Math.round(r.left * sx);
      var topPx = Math.round(r.top * sy);
      var widthPx = Math.round((r.right - r.left) * sx);
      var heightPx = Math.round((r.bottom - r.top) * sy);

      if (widthPx <= 8 || heightPx <= 8 || widthPx > 1920 || heightPx > 1080) {
        restoreVideoFullscreen();
        return;
      }

      videoContainerEl.style.left = leftPx + 'px';
      videoContainerEl.style.top = topPx + 'px';
      videoContainerEl.style.width = widthPx + 'px';
      videoContainerEl.style.height = heightPx + 'px';
      videoEl.style.width = widthPx + 'px';
      videoEl.style.height = heightPx + 'px';
    }

    function updateBmlStatusIndicator() {
      if (!bmlStatusBadgeEl) return;
      if (!state.bmlActive) {
        bmlStatusBadgeEl.style.display = 'none';
        return;
      }
      if (state.bmlNetworking) {
        bmlStatusBadgeEl.textContent = '通信中…';
        bmlStatusBadgeEl.style.display = 'block';
      } else if (state.bmlInvisible || state.bmlReceiving) {
        bmlStatusBadgeEl.textContent = 'データ放送 読込中…';
        bmlStatusBadgeEl.style.display = 'block';
      } else {
        bmlStatusBadgeEl.style.display = 'none';
      }
    }

    function renderCaptionPes(pesBytes, ptsMs, targetCanvas, dataIdentifier) {
      if (!vendor || !vendor.CanvasProvider || !targetCanvas) return null;
      try {
        var provider = new vendor.CanvasProvider(pesBytes, ptsMs || 0);
        var res = provider.render({
          canvas: targetCanvas,
          width: 1920,
          height: 1080,
          data_identifier: dataIdentifier || 0x80,
          normalFont: '"丸ゴシック", "太丸ゴシック", "LG Smart UI", "Noto Sans CJK JP", sans-serif',
          gaijiFont: '"丸ゴシック", "LG Smart UI", "Noto Sans CJK JP", sans-serif',
          useStroke: true,
          forceStrokeColor: 'rgba(0, 0, 0, 0.94)',
          drcsReplacement: true,
          keepAspectRatio: true
        });
        if (res && res.PRA != null && state.captionEnabled && vendor.playRomSound) {
          var dest = getAudioDestination();
          if (dest) vendor.playRomSound(res.PRA, dest);
        }
        return res;
      } catch (e) {
        return null;
      }
    }

    function handleIncomingPes(msg) {
      if (!vendor || !vendor.CanvasProvider || !msg || !msg.data) return;
      var pes = new Uint8Array(msg.data);
      if (pes.length < 4) return;

      // 1. ARIB 字幕 (stream_id = 0xBD, data_identifier = 0x80)
      if (msg.streamId === 0xBD && msg.pts != null) {
        if (!vendor.CanvasProvider.detect(pes, { data_identifier: 0x80 })) return;
        var estProvider = new vendor.CanvasProvider(pes, 0);
        var est = estProvider.render({
          data_identifier: 0x80,
          drcsReplacement: true
        });
        if (!est) return;

        var ptsMs = msg.pts / 90;
        // 録画再生時の 33bit PTS ラップアラウンド補正 (26.5時間境界)
        if (!state.isLiveStream && state.firstPcrMs != null) {
          var PCR_WRAP_MS = 95443717.688889;
          if (ptsMs < state.firstPcrMs - (PCR_WRAP_MS / 2)) {
            ptsMs += PCR_WRAP_MS;
          }
        }
        var durMs = (isFinite(est.endTime) && est.endTime > 0) ? Math.min(est.endTime * 1000, 180000) : 180000;
        state.captionQueue.push({
          pes: pes,
          ptsMs: ptsMs,
          durMs: durMs
        });
        state.captionQueue.sort(function (a, b) { return a.ptsMs - b.ptsMs; });
        var maxQueue = state.isLiveStream ? 48 : 4000;
        if (state.captionQueue.length > maxQueue) {
          state.captionQueue.splice(0, state.captionQueue.length - maxQueue);
        }
        return;
      }

      // 2. ARIB 文字スーパー (stream_id = 0xBF, data_identifier = 0x81, 即時提示)
      if (msg.streamId === 0xBF) {
        if (!vendor.CanvasProvider.detect(pes, { data_identifier: 0x81 })) return;
        var sEst = new vendor.CanvasProvider(pes, 0).render({
          data_identifier: 0x81,
          drcsReplacement: true
        });
        if (!sEst) return;
        var sDurMs = (isFinite(sEst.endTime) && sEst.endTime > 0) ? Math.min(sEst.endTime * 1000, 180000) : 30000;
        if (state.captionEnabled) {
          renderCaptionPes(pes, 0, superimposeCanvas, 0x81);
        }
        if (state.displayPcrMs != null) {
          state.superExpirePcrMs = state.displayPcrMs + sDurMs;
        }
      }
    }

    function cacheBmlMessage(msg) {
      if (!msg || !msg.type) return false;
      if (msg.type === 'pmt') {
        state.cachedPmt = msg;
        var hasBml = false;
        var comps = msg.components || [];
        for (var i = 0; i < comps.length; i++) {
          if (comps[i].streamType === 0x0D || comps[i].bxmlInfo) {
            hasBml = true;
            break;
          }
        }
        state.bmlHasDataComponent = hasBml;
        // 純正TV同様に選局直後からバックグラウンドで DSM-CC カルーセルを低負荷プリフェッチする
        if (hasBml && state.activeStream && !state.bmlActive && !state.bmlPrefetchStarted) {
          state.bmlPrefetchStarted = true;
          scheduleNextBmlPoll(1100);
        }
        return true;
      } else if (msg.type === 'bit') {
        var sameBit = !!(state.cachedBit && state.cachedBit.originalNetworkId === msg.originalNetworkId);
        state.cachedBit = msg;
        return !sameBit;
      } else if (msg.type === 'programInfo') {
        var sameProg = !!(state.cachedProgramInfo && state.cachedProgramInfo.eventId === msg.eventId && state.cachedProgramInfo.serviceId === msg.serviceId);
        state.cachedProgramInfo = msg;
        return !sameProg;
      } else if (msg.type === 'currentTime') {
        state.cachedCurrentTime = msg;
        return true;
      } else if (msg.type === 'pcr') {
        state.cachedPcr = msg;
        return true;
      } else if (msg.type === 'moduleListUpdated') {
        var prevList = state.cachedModuleLists[msg.componentId];
        if (prevList && prevList.dataEventId !== msg.dataEventId) {
          // dataEventId 更新時は該当コンポーネントの古いモジュールキャッシュを破棄
          var prefix = msg.componentId + '_';
          for (var k in state.cachedModules) {
            if (Object.prototype.hasOwnProperty.call(state.cachedModules, k) && k.indexOf(prefix) === 0) {
              delete state.cachedModules[k];
            }
          }
        } else if (prevList && prevList.dataEventId === msg.dataEventId && prevList.modules && msg.modules && prevList.modules.length === msg.modules.length) {
          return false;
        }
        state.cachedModuleLists[msg.componentId] = msg;
        return true;
      } else if (msg.type === 'moduleDownloaded') {
        var modKey = msg.componentId + '_' + msg.moduleId;
        var prevMod = state.cachedModules[modKey];
        if (prevMod && prevMod.version === msg.version && prevMod.dataEventId === msg.dataEventId) {
          // 既に保持済みの同一バージョンカルーセル再送はスキップして CPU 浪費を防ぐ
          return false;
        }
        state.cachedModules[modKey] = msg;
        return true;
      } else if (msg.type === 'esEventUpdated') {
        state.cachedEsEvents[msg.componentId] = msg;
        return true;
      }
      return true;
    }

    function replayCachedMessagesToBml() {
      if (!bmlBrowser) return;
      var k;
      if (state.cachedBit) bmlBrowser.emitMessage(state.cachedBit);
      if (state.cachedProgramInfo) bmlBrowser.emitMessage(state.cachedProgramInfo);
      if (state.cachedCurrentTime) bmlBrowser.emitMessage(state.cachedCurrentTime);
      if (state.cachedPcr) bmlBrowser.emitMessage(state.cachedPcr);
      if (state.cachedPmt) bmlBrowser.emitMessage(state.cachedPmt);
      for (k in state.cachedModuleLists) {
        if (Object.prototype.hasOwnProperty.call(state.cachedModuleLists, k)) {
          bmlBrowser.emitMessage(state.cachedModuleLists[k]);
        }
      }
      for (k in state.cachedModules) {
        if (Object.prototype.hasOwnProperty.call(state.cachedModules, k)) {
          bmlBrowser.emitMessage(state.cachedModules[k]);
        }
      }
      for (k in state.cachedEsEvents) {
        if (Object.prototype.hasOwnProperty.call(state.cachedEsEvents, k)) {
          bmlBrowser.emitMessage(state.cachedEsEvents[k]);
        }
      }
    }

    function onTsDecodedMessage(msg) {
      if (!msg) return;
      if (msg.type === 'pcr') {
        var pcrMs = (msg.pcrBase + (msg.pcrExtension || 0) / 300) / 90;
        if (state.firstPcrMs == null) {
          state.firstPcrMs = pcrMs;
        }
        // ライブ放送は到着 PCR に緩やかに追従 (TV ライブ挙動を 100% 維持)
        // 録画再生・追っかけ再生はファイル先読みで未来の PCR が高速到着するため、
        // firstPcrMs + videoEl.currentTime を正準時計として tickCaptionClock で厳密同期する。
        if (state.isLiveStream) {
          var nowWall = Date.now();
          var targetPcr = pcrMs - LIVE_SYNC_DELAY_MS;
          if (state.anchorPcrMs == null || Math.abs(targetPcr - (state.displayPcrMs || targetPcr)) > 6000) {
            state.anchorPcrMs = targetPcr;
            state.anchorWallMs = nowWall;
            state.displayPcrMs = targetPcr;
          } else {
            // ストリーム実速度へ緩やかにドリフト補正
            var expected = state.anchorPcrMs + (nowWall - state.anchorWallMs);
            var diff = targetPcr - expected;
            if (Math.abs(diff) > 350) {
              state.anchorPcrMs += diff * 0.35;
            }
          }
        }
        state.latestPcrMs = pcrMs;
      } else if (msg.type === 'pes') {
        handleIncomingPes(msg);
        return;
      }

      var shouldEmit = cacheBmlMessage(msg);
      if (shouldEmit && state.bmlActive && bmlBrowser) {
        try {
          bmlBrowser.emitMessage(msg);
        } catch (e) {}
      }
    }

    function tickCaptionClock() {
      if (!state.activeStream) return;

      var curPcr;
      if (!state.isLiveStream) {
        // 録画再生・追っかけ再生: 先読み PCR に引きずられず、映像の再生時刻 (videoEl.currentTime) と厳密同期
        if (state.firstPcrMs == null || !videoEl || videoEl.readyState < 2) return;
        var vTime = Number(videoEl.currentTime || 0);
        if (!isFinite(vTime) || vTime < 0) return;
        if (state.firstVideoTimeSec == null) {
          state.firstVideoTimeSec = vTime;
        } else if (vTime < state.firstVideoTimeSec) {
          state.firstVideoTimeSec = vTime;
        }
        curPcr = state.firstPcrMs + Math.max(0, (vTime - state.firstVideoTimeSec) * 1000);
        state.displayPcrMs = curPcr;
      } else {
        if (videoEl && videoEl.paused) {
          // 一時停止中はアンカー壁時計をスライドさせて字幕タイマーも停止させる
          if (state.anchorWallMs != null && state.displayPcrMs != null && state.anchorPcrMs != null) {
            state.anchorWallMs = Date.now() - (state.displayPcrMs - state.anchorPcrMs);
          }
          return;
        }
        if (state.anchorPcrMs == null || state.anchorWallMs == null) return;
        curPcr = state.anchorPcrMs + (Date.now() - state.anchorWallMs);
        state.displayPcrMs = curPcr;
      }

      // 期限切れ字幕の消去
      if (state.activeCaption && curPcr > state.activeCaption.expirePcrMs) {
        state.activeCaption = null;
        clearCanvas(captionCanvas);
      }
      if (state.superExpirePcrMs != null && curPcr > state.superExpirePcrMs) {
        state.superExpirePcrMs = null;
        clearCanvas(superimposeCanvas);
      }

      // 表示時刻 (PTS) に到達した字幕を取り出して描画
      var dueIdx = -1;
      for (var i = 0; i < state.captionQueue.length; i++) {
        if (state.captionQueue[i].ptsMs <= curPcr) {
          dueIdx = i;
        } else {
          break;
        }
      }
      if (dueIdx >= 0) {
        var chosen = state.captionQueue[dueIdx];
        state.captionQueue.splice(0, dueIdx + 1);
        state.activeCaption = {
          pes: chosen.pes,
          ptsMs: chosen.ptsMs,
          expirePcrMs: chosen.ptsMs + chosen.durMs
        };
        if (state.captionEnabled) {
          renderCaptionPes(chosen.pes, chosen.ptsMs, captionCanvas, 0x80);
        }
      }
    }

    function resetDecoderForNewSession(newSessId, newSvcId) {
      state.sessionId = newSessId;
      state.serviceId = newSvcId || 0;
      state.cursor = 0;
      state.bmlCursor = 0;
      state.firstPcrMs = null;
      state.firstVideoTimeSec = null;
      state.anchorPcrMs = null;
      state.anchorWallMs = null;
      state.displayPcrMs = null;
      clearAllCaptions();
      resetCarouselCache();

      if (vendor && vendor.decodeTS) {
        tsDecoder = vendor.decodeTS({
          serviceId: state.serviceId > 0 ? state.serviceId : undefined,
          parsePES: true,
          sendCallback: onTsDecodedMessage
        });
      }
    }

    function cancelDecodePump() {
      if (state.decodeTimer) {
        clearTimeout(state.decodeTimer);
        state.decodeTimer = null;
      }
      state.decodingBusy = false;
      if (state.bmlDecodeTimer) {
        clearTimeout(state.bmlDecodeTimer);
        state.bmlDecodeTimer = null;
      }
      state.bmlDecodingBusy = false;
    }

    function pumpTsBytes(tsBytes, expectSess) {
      var sliceSize = 188 * 100; // 約18.8KB単位で分割投入して UI 操作レスポンスを守る
      if (!tsBytes || !tsBytes.length) return;
      if (tsBytes.length <= sliceSize) {
        if (state.activeStream && tsDecoder && state.sessionId === expectSess) {
          try { tsDecoder.push(tsBytes); } catch (e) {}
        }
        return;
      }
      state.decodingBusy = true;
      var offset = 0;
      function stepPump() {
        state.decodeTimer = null;
        if (!state.activeStream || !tsDecoder || state.sessionId !== expectSess) {
          state.decodingBusy = false;
          return;
        }
        var end = Math.min(tsBytes.length, offset + sliceSize);
        var slice = tsBytes.subarray(offset, end);
        offset = end;
        try {
          tsDecoder.push(slice);
        } catch (e) {}
        if (offset < tsBytes.length && state.activeStream && state.sessionId === expectSess) {
          state.decodeTimer = setTimeout(stepPump, 8);
        } else {
          state.decodingBusy = false;
        }
      }
      stepPump();
    }

    function pumpBmlBytes(tsBytes, expectSess) {
      // Python 側で DSM-CC 重複排除済みのため、BML スクリプト実行(es2)を妨げない安全サイズで小分け投入する
      var fastMode = state.bmlActive && (state.bmlInvisible || state.bmlReceiving || Date.now() < state.bmlBurstUntilMs);
      var sliceSize = fastMode ? (188 * 160) : (188 * 100);
      var stepDelay = fastMode ? 10 : 16;
      if (!tsBytes || !tsBytes.length) return;
      if (tsBytes.length <= sliceSize) {
        if (state.activeStream && tsDecoder && state.sessionId === expectSess) {
          try { tsDecoder.push(tsBytes); } catch (e) {}
        }
        return;
      }
      state.bmlDecodingBusy = true;
      var offset = 0;
      function stepBmlPump() {
        state.bmlDecodeTimer = null;
        if (!state.activeStream || !tsDecoder || state.sessionId !== expectSess) {
          state.bmlDecodingBusy = false;
          return;
        }
        var curFast = state.bmlActive && (state.bmlInvisible || state.bmlReceiving || Date.now() < state.bmlBurstUntilMs);
        var curSlice = curFast ? (188 * 160) : (188 * 100);
        var end = Math.min(tsBytes.length, offset + curSlice);
        var slice = tsBytes.subarray(offset, end);
        offset = end;
        try {
          tsDecoder.push(slice);
        } catch (e) {}
        if (offset < tsBytes.length && state.activeStream && state.sessionId === expectSess) {
          state.bmlDecodeTimer = setTimeout(stepBmlPump, curFast ? 10 : stepDelay);
        } else {
          state.bmlDecodingBusy = false;
        }
      }
      stepBmlPump();
    }

    function pollSidebandOnce() {
      if (!state.activeStream || state.pollingXhr || state.decodingBusy) return;
      var url = DAEMON_BASE + '/api/ts/sideband?mode=base&session=' + state.sessionId + '&cursor=' + state.cursor;
      var xhr = new XMLHttpRequest();
      state.pollingXhr = xhr;
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.timeout = 3500;

      xhr.onload = function () {
        state.pollingXhr = null;
        if (!state.activeStream) return;
        if (xhr.status === 200 && xhr.response && xhr.response.byteLength >= 20) {
          var buf = xhr.response;
          var dv = new DataView(buf);
          // Magic 'DTVS' = 0x44545653
          if (dv.getUint32(0) === 0x44545653) {
            var srvSess = dv.getUint32(4);
            var srvSid = dv.getUint32(8);
            var nextHi = dv.getUint32(12);
            var nextLo = dv.getUint32(16);
            var nextCur = nextHi * 4294967296 + nextLo;

            if (srvSess > 0 && srvSess !== state.sessionId) {
              cancelDecodePump();
              resetDecoderForNewSession(srvSess, srvSid);
            }
            state.cursor = nextCur;

            if (buf.byteLength > 20 && tsDecoder) {
              var tsBytes = new Uint8Array(buf, 20);
              pumpTsBytes(tsBytes, state.sessionId);
            }
          }
        }
      };

      xhr.onerror = function () { state.pollingXhr = null; };
      xhr.ontimeout = function () { state.pollingXhr = null; };
      try {
        xhr.send();
      } catch (e) {
        state.pollingXhr = null;
      }
    }

    function stopBmlCarouselPoll() {
      if (state.bmlPollTimer) {
        clearTimeout(state.bmlPollTimer);
        state.bmlPollTimer = null;
      }
      if (state.bmlXhr) {
        try { state.bmlXhr.abort(); } catch (e) {}
        state.bmlXhr = null;
      }
      if (state.bmlDecodeTimer) {
        clearTimeout(state.bmlDecodeTimer);
        state.bmlDecodeTimer = null;
      }
      state.bmlDecodingBusy = false;
    }

    function scheduleNextBmlPoll(delayMs) {
      if (state.bmlPollTimer) clearTimeout(state.bmlPollTimer);
      if (!state.activeStream) return;
      if (!state.bmlActive && state.bmlHasDataComponent === false) return;
      state.bmlPollTimer = setTimeout(pollBmlCarouselOnce, delayMs);
    }

    function pollBmlCarouselOnce() {
      state.bmlPollTimer = null;
      if (!state.activeStream) return;
      if (!state.bmlActive && state.bmlHasDataComponent === false) return;
      if (state.bmlXhr || state.bmlDecodingBusy || !state.cachedPmt) {
        // PMT を未受信またはデコード中のうちは少し待ってから再試行
        scheduleNextBmlPoll(state.bmlActive ? 90 : 350);
        return;
      }
      var reqSess = state.sessionId;
      var url = DAEMON_BASE + '/api/ts/sideband?mode=bml&session=' + reqSess + '&cursor=' + state.bmlCursor;
      var xhr = new XMLHttpRequest();
      state.bmlXhr = xhr;
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.timeout = 3500;

      xhr.onload = function () {
        state.bmlXhr = null;
        if (!state.activeStream) return;
        var hasMore = false;
        if (xhr.status === 200 && xhr.response && xhr.response.byteLength >= 20) {
          var buf = xhr.response;
          var dv = new DataView(buf);
          if (dv.getUint32(0) === 0x44545653) {
            var srvSess = dv.getUint32(4);
            if (srvSess === state.sessionId && srvSess > 0) {
              var nextHi = dv.getUint32(12);
              var nextLo = dv.getUint32(16);
              var nextCur = nextHi * 4294967296 + nextLo;
              state.bmlCursor = nextCur;
              if (buf.byteLength > 20 && tsDecoder) {
                var bmlBytes = new Uint8Array(buf, 20);
                hasMore = bmlBytes.length >= 188 * 1800;
                pumpBmlBytes(bmlBytes, state.sessionId);
              }
            }
          }
        }
        var allCached = isAllListedModulesCached();
        var nextDelay;
        if (state.bmlActive) {
          var inBurst = state.bmlInvisible || state.bmlReceiving || (Date.now() < state.bmlBurstUntilMs);
          if (inBurst) {
            // 未展開・受信中・ページ遷移直後は素早くカルーセルを取り込みつつ es2 スクリプト実行時間を確保
            nextDelay = hasMore ? 45 : 150;
          } else if (allCached) {
            // 表示完了＆全モジュール取得済み: 重複カルーセルの無駄デコードを止めて UI 操作を最速化 (6秒おきの軽量監視)
            nextDelay = 6000;
          } else {
            nextDelay = 450;
          }
        } else {
          // バックグラウンド先読み中: 全モジュール揃ったら完全休止 (CPU 0%)、未完なら低負荷で続きを取得
          if (allCached) {
            return;
          }
          nextDelay = hasMore ? 180 : 280;
        }
        scheduleNextBmlPoll(nextDelay);
      };

      xhr.onerror = function () {
        state.bmlXhr = null;
        scheduleNextBmlPoll(600);
      };
      xhr.ontimeout = function () {
        state.bmlXhr = null;
        scheduleNextBmlPoll(400);
      };
      try {
        xhr.send();
      } catch (e) {
        state.bmlXhr = null;
        scheduleNextBmlPoll(600);
      }
    }

    function buildBmlIpBridge() {
      return {
        getConnectionType: function () { return 403; }, // Ethernet LAN
        isIPConnected: function () { return 1; },
        get: function (uri) {
          return new Promise(function (resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', DAEMON_BASE + '/api/bml/http?target=' + encodeURIComponent(uri), true);
            xhr.responseType = 'arraybuffer';
            xhr.timeout = 10000;
            xhr.onload = function () {
              var ct = xhr.getResponseHeader('Content-Type');
              var cc = xhr.getResponseHeader('Cache-Control');
              var hdrs;
              if (typeof Headers !== 'undefined') {
                hdrs = new Headers();
                if (ct) hdrs.append('content-type', ct);
                if (cc) hdrs.append('cache-control', cc);
              } else {
                hdrs = {
                  get: function (name) {
                    var n = String(name || '').toLowerCase();
                    if (n === 'content-type') return ct || null;
                    if (n === 'cache-control') return cc || null;
                    return null;
                  }
                };
              }
              resolve({
                statusCode: xhr.status,
                headers: hdrs,
                response: xhr.response ? new Uint8Array(xhr.response) : new Uint8Array(0)
              });
            };
            xhr.onerror = function () { resolve({}); };
            xhr.ontimeout = function () { resolve({}); };
            xhr.send();
          });
        },
        transmitTextDataOverIP: function (uri, body) {
          return new Promise(function (resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', DAEMON_BASE + '/api/bml/http?target=' + encodeURIComponent(uri), true);
            xhr.responseType = 'arraybuffer';
            xhr.timeout = 10000;
            xhr.onload = function () {
              resolve({
                resultCode: 1,
                statusCode: String(xhr.status),
                response: xhr.response ? new Uint8Array(xhr.response) : new Uint8Array(0)
              });
            };
            xhr.onerror = function () {
              resolve({ resultCode: NaN, statusCode: '', response: new Uint8Array(0) });
            };
            xhr.ontimeout = function () {
              resolve({ resultCode: NaN, statusCode: '', response: new Uint8Array(0) });
            };
            xhr.send(body);
          });
        },
        confirmIPNetwork: function () {
          return Promise.resolve({ success: true, ipAddress: '127.0.0.1', responseTimeMillis: 5 });
        }
      };
    }

    function destroyBmlInstance() {
      clearDataBtnTimers();
      if (bmlBrowser) {
        try {
          bmlBrowser.destroy();
        } catch (e) {}
        bmlBrowser = null;
      }
      bmlInputApp = null;
      if (bmlContentEl) {
        // attachShadow({ mode: 'closed' }) は同じ要素に再実行できないため新しいホスト要素に差し替える
        var freshContent = document.createElement('div');
        freshContent.id = 'bml-content';
        freshContent.className = 'bml-content-host';
        if (bmlContentEl.parentNode) {
          bmlContentEl.parentNode.replaceChild(freshContent, bmlContentEl);
        }
        bmlContentEl = freshContent;
      }
      state.bmlReceiving = false;
      state.bmlNetworking = false;
      state.bmlInvisible = true;
      state.bmlVideoRect = null;
      state.bmlUsedKeys = null;
      updateBmlStatusIndicator();
      restoreVideoFullscreen();
    }

    function openBml() {
      if (!vendor || !vendor.BMLBrowser) {
        onToast('error', 'データ放送モジュール未読込', '');
        return false;
      }
      if (!state.activeStream) {
        onToast('info', 'データ放送を利用できません', 'テレビ放送またはTS録画の再生中に [d] ボタンを押してください');
        return false;
      }
      if (state.bmlHasDataComponent === false) {
        onToast('info', 'この番組はデータ放送を行っていません', '');
        return false;
      }

      destroyBmlInstance();
      state.bmlActive = true;
      state.bmlReceiving = true;
      state.bmlInvisible = true;
      userOpenedAtMs = Date.now();
      playUiRomSound(5);

      if (bmlOverlayEl) bmlOverlayEl.className = '';
      updateBmlStatusIndicator();

      if (vendor.OverlayInputApplication && bmlInputEl) {
        bmlInputApp = new vendor.OverlayInputApplication(bmlInputEl);
      }

      var indicator = {
        setUrl: function (_url, loading) {
          if (loading) {
            state.bmlReceiving = true;
            boostBmlPolling(2800);
          } else {
            state.bmlReceiving = false;
          }
          updateBmlStatusIndicator();
        },
        setReceivingStatus: function (receiving) {
          state.bmlReceiving = !!receiving;
          if (state.bmlReceiving) {
            boostBmlPolling(2800);
          }
          updateBmlStatusIndicator();
        },
        setNetworkingGetStatus: function (getFlag) {
          state.bmlNetworking = !!getFlag;
          updateBmlStatusIndicator();
        },
        setNetworkingPostStatus: function (postFlag) {
          state.bmlNetworking = !!postFlag;
          updateBmlStatusIndicator();
        },
        setEventName: function () {}
      };

      // 実機 webOS では内蔵システムフォントを優先ヒットさせて毎回 6MB の WOFF2 再解凍を回避する
      var fontsOpt = {
        roundGothic: { source: "local('LG Smart UI'), local('Noto Sans CJK JP'), url('fonts/KosugiMaru-Regular.woff2')" },
        boldRoundGothic: { source: "local('LG Smart UI Bold'), local('LG Smart UI'), local('Noto Sans CJK JP Bold'), url('fonts/KosugiMaru-Bold.woff2')" },
        squareGothic: { source: "local('LG Smart UI'), local('Noto Sans CJK JP'), url('fonts/Kosugi-Regular.woff2')" }
      };

      bmlBrowser = new vendor.BMLBrowser({
        containerElement: bmlContentEl,
        mediaElement: dummyMediaEl,
        indicator: indicator,
        fonts: fontsOpt,
        audioNodeProvider: {
          getAudioDestinationNode: function () {
            return getAudioDestination();
          }
        },
        storagePrefix: 'dtvplus_bml_',
        videoPlaneModeEnabled: true,
        epg: {
          tune: function (onid, tsid, sid) {
            return !!onTuneRequest(onid, tsid, sid);
          }
        },
        ip: buildBmlIpBridge(),
        inputApplication: bmlInputApp || undefined,
        showErrorMessage: function (title, message) {
          onToast('warn', title || 'データ放送通知', message || '');
        }
      });

      var hasBecomeVisible = false;

      function sendDataButtonOnce() {
        if (!state.bmlActive || !bmlBrowser || !state.bmlInvisible || hasBecomeVisible) return;
        try {
          bmlBrowser.content.processKeyDown(vendor.AribKeyCode.DataButton);
          setTimeout(function () {
            if (state.bmlActive && bmlBrowser) {
              try { bmlBrowser.content.processKeyUp(vendor.AribKeyCode.DataButton); } catch (e2) {}
            }
          }, 55);
        } catch (e) {}
      }

      bmlBrowser.addEventListener('load', function (evt) {
        var d = (evt && evt.detail) || {};
        var res = d.resolution || { width: 960, height: 540 };
        state.bmlResWidth = res.width || 960;
        state.bmlResHeight = res.height || 540;
        state.bmlReceiving = false;
        updateBmlStatusIndicator();

        if (bmlStageEl) {
          var sx = (1920 / state.bmlResWidth).toFixed(5);
          var sy = (1080 / state.bmlResHeight).toFixed(5);
          bmlStageEl.style.width = state.bmlResWidth + 'px';
          bmlStageEl.style.height = state.bmlResHeight + 'px';
          bmlStageEl.style.webkitTransform = 'scale(' + sx + ', ' + sy + ')';
          bmlStageEl.style.transform = 'scale(' + sx + ', ' + sy + ')';
        }

        // 初期スクリプト完了後や /40->/60 自動遷移後も確実にL字画面へ展開させるため段階的に DataButton を通知
        clearDataBtnTimers();
        if (state.bmlInvisible && !hasBecomeVisible) {
          var delays = [40, 180, 450, 900, 1600, 2600, 4000, 6000, 9000, 13000];
          for (var di = 0; di < delays.length; di++) {
            dataBtnTimers.push(setTimeout(sendDataButtonOnce, delays[di]));
          }
        }
      });

      bmlBrowser.addEventListener('invisible', function (evt) {
        var inv = !!(evt && evt.detail);
        var wasVisible = !state.bmlInvisible;
        state.bmlInvisible = inv;
        if (!inv) {
          hasBecomeVisible = true;
          clearDataBtnTimers();
        }
        updateBmlStatusIndicator();
        applyBmlVideoGeometry();

        // 一度データ放送画面が表示された後に、BML文書内の「終了/戻る」等で invisible=true へ遷移した場合は自動で全画面TVに戻る
        if (inv && wasVisible && (Date.now() - userOpenedAtMs) > 900) {
          closeBml(true);
        }
      });

      bmlBrowser.addEventListener('videochanged', function (evt) {
        var d = (evt && evt.detail) || {};
        if (d.clientRect) {
          state.bmlVideoRect = d.clientRect;
          applyBmlVideoGeometry();
        }
      });

      bmlBrowser.addEventListener('usedkeylistchanged', function (evt) {
        var d = (evt && evt.detail) || {};
        state.bmlUsedKeys = d.usedKeyList || null;
      });

      // 既にバックグラウンドでプリフェッチ済みのカルーセル一式を即時投入する
      replayCachedMessagesToBml();
      // 全モジュール取得済みなら es2 初期スクリプト実行を妨げないよう即ポーリングを控え、未取得時のみバースト受信する
      if (isAllListedModulesCached()) {
        scheduleNextBmlPoll(1800);
      } else {
        boostBmlPolling(3500);
      }
      onStateChange(getPublicStatus());
      return true;
    }

    function closeBml(silent) {
      if (!state.bmlActive) return;
      state.bmlActive = false;
      state.bmlBurstUntilMs = 0;
      stopBmlCarouselPoll();
      if (!silent) playUiRomSound(6);
      if (bmlOverlayEl) bmlOverlayEl.className = 'hidden';
      destroyBmlInstance();
      // 再生中かつデータ放送ありチャンネルなら低負荷のバックグラウンド監視へ戻し、再押下時に瞬間表示させる
      if (state.activeStream && state.bmlHasDataComponent === true) {
        scheduleNextBmlPoll(3000);
      }
      onStateChange(getPublicStatus());
      if (!silent) {
        onToast('info', 'データ放送を終了しました', '');
      }
    }

    function toggleBml() {
      if (state.bmlActive) {
        closeBml(false);
        return false;
      }
      return openBml();
    }

    function setCaptionEnabled(enabled, showToastFlag) {
      state.captionEnabled = !!enabled;
      if (!state.captionEnabled) {
        clearCanvas(captionCanvas);
        clearCanvas(superimposeCanvas);
      } else if (state.activeCaption && state.displayPcrMs != null && state.displayPcrMs <= state.activeCaption.expirePcrMs) {
        renderCaptionPes(state.activeCaption.pes, state.activeCaption.ptsMs, captionCanvas, 0x80);
      }
      onStateChange(getPublicStatus());
      if (showToastFlag) {
        onToast('info', '字幕表示: ' + (state.captionEnabled ? 'オン' : 'オフ'), state.captionEnabled ? 'ARIB 字幕・文字スーパーを表示します' : '字幕を非表示にしました');
      }
      return state.captionEnabled;
    }

    function toggleCaption() {
      if (!state.activeStream) {
        var nextOffStream = !state.captionEnabled;
        return setCaptionEnabled(nextOffStream, true);
      }
      return setCaptionEnabled(!state.captionEnabled, true);
    }

    /**
     * LGTV 純正リモコンの keyCode を ARIB BML キーコードへ変換してディスパッチする
     * 戻り値: true = BML側でキーを消費した / false = 通常アプリ側で処理すべき
     */
    function handleKeyDown(code, keyName) {
      if (!state.bmlActive || !bmlBrowser || !vendor) return false;
      if (bmlInputApp && bmlInputApp.isLaunching) return false;

      var AK = vendor.AribKeyCode;
      var aribKey = -1;
      var kn = String(keyName || '').toLowerCase();

      // dデータボタン再押下 (実測 1019=0x03FB <IR_KEY_BML_DATA> / 885 / 893 / 807 / 779 / 459 / 'D'=68) -> 純正通りデータ放送を閉じる
      if (code === 1019 || code === 885 || code === 893 || code === 807 || code === 779 || code === 459 ||
          code === 0x03FB || code === 0x0327 || code === 0x0375 || code === 0x037D || code === 68 || code === 0x01200096 ||
          kn === 'teletext' || kn === 'bmldata' || kn === 'data') {
        closeBml(false);
        return true;
      }

      if (code === 38) aribKey = AK.Up;
      else if (code === 40) aribKey = AK.Down;
      else if (code === 37) aribKey = AK.Left;
      else if (code === 39) aribKey = AK.Right;
      else if (code === 13) aribKey = AK.Enter;
      else if (code === 461 || code === 27 || code === 8) aribKey = AK.Back;
      else if (code === 406 || code === 66) aribKey = AK.BlueButton;
      else if (code === 403 || code === 82) aribKey = AK.RedButton;
      else if (code === 404 || code === 71) aribKey = AK.GreenButton;
      else if (code === 405 || code === 89) aribKey = AK.YellowButton;
      else if (code >= 48 && code <= 57) aribKey = AK.Digit0 + (code - 48);
      else if (code >= 96 && code <= 105) aribKey = AK.Digit0 + (code - 96);

      if (aribKey === -1) {
        return false;
      }

      // 数字キーは BML 文書が numeric-tuning グループを要求している場合のみ BML へ渡し、それ以外は選局を優先 (ARIB TR-B14 準拠)
      if (aribKey >= AK.Digit0 && aribKey <= AK.Digit12) {
        var wantsNumeric = false;
        if (state.bmlUsedKeys && typeof state.bmlUsedKeys.has === 'function') {
          wantsNumeric = state.bmlUsedKeys.has('numeric-tuning');
        }
        if (!wantsNumeric) {
          return false;
        }
      }

      // まだカルーセル取得中で文書未表示のときに「戻る」を押した場合は即座にデータ放送待機をキャンセルして閉じる
      if (aribKey === AK.Back && state.bmlInvisible) {
        closeBml(false);
        return true;
      }

      if (aribKey === AK.Enter) playUiRomSound(5);
      else if (aribKey === AK.Back) playUiRomSound(6);
      else if (aribKey === AK.Up || aribKey === AK.Down || aribKey === AK.Left || aribKey === AK.Right) playUiRomSound(7);
      else if (aribKey === AK.BlueButton || aribKey === AK.RedButton || aribKey === AK.GreenButton || aribKey === AK.YellowButton) playUiRomSound(8);

      try {
        bmlBrowser.content.processKeyDown(aribKey);
        setTimeout(function () {
          if (state.bmlActive && bmlBrowser) {
            try { bmlBrowser.content.processKeyUp(aribKey); } catch (e2) {}
          }
        }, 55);
      } catch (e) {}
      // 決定キー・カラーキー・戻るキーによるページ遷移時は新モジュールを即座にバースト受信する
      if (aribKey === AK.Enter || aribKey === AK.Back ||
          aribKey === AK.BlueButton || aribKey === AK.RedButton ||
          aribKey === AK.GreenButton || aribKey === AK.YellowButton) {
        boostBmlPolling(2800);
      }
      return true;
    }

    function startStreamSession(streamOpts) {
      streamOpts = streamOpts || {};
      stopStreamSession();

      state.activeStream = true;
      state.isLiveStream = streamOpts.isLive !== false;
      state.sessionId = 0;
      state.serviceId = Number(streamOpts.serviceId) || 0;
      state.cursor = 0;
      state.firstPcrMs = null;
      state.firstVideoTimeSec = null;
      clearAllCaptions();
      resetCarouselCache();

      if (vendor && vendor.decodeTS) {
        tsDecoder = vendor.decodeTS({
          serviceId: state.serviceId > 0 ? state.serviceId : undefined,
          parsePES: true,
          sendCallback: onTsDecodedMessage
        });
      }

      pollSidebandOnce();
      state.pollTimer = setInterval(pollSidebandOnce, POLL_INTERVAL_MS);
      state.clockTimer = setInterval(tickCaptionClock, CLOCK_TICK_MS);
      onStateChange(getPublicStatus());
    }

    function stopStreamSession() {
      cancelDecodePump();
      stopBmlCarouselPoll();
      clearDataBtnTimers();
      if (state.bmlActive) {
        closeBml(true);
      }
      state.bmlCursor = 0;
      state.activeStream = false;
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
      if (state.clockTimer) {
        clearInterval(state.clockTimer);
        state.clockTimer = null;
      }
      if (state.pollingXhr) {
        try { state.pollingXhr.abort(); } catch (e) {}
        state.pollingXhr = null;
      }
      tsDecoder = null;
      state.sessionId = 0;
      state.cursor = 0;
      state.anchorPcrMs = null;
      state.anchorWallMs = null;
      state.displayPcrMs = null;
      clearAllCaptions();
      resetCarouselCache();
      restoreVideoFullscreen();
      onStateChange(getPublicStatus());
    }

    function notifySeek() {
      clearAllCaptions();
      state.anchorPcrMs = null;
      state.anchorWallMs = null;
      state.displayPcrMs = null;
    }

    function getPublicStatus() {
      return {
        activeStream: state.activeStream,
        captionEnabled: state.captionEnabled,
        bmlActive: state.bmlActive,
        bmlHasDataComponent: state.bmlHasDataComponent
      };
    }

    return {
      startStreamSession: startStreamSession,
      stopStreamSession: stopStreamSession,
      notifySeek: notifySeek,
      setCaptionEnabled: setCaptionEnabled,
      toggleCaption: toggleCaption,
      openBml: openBml,
      closeBml: closeBml,
      toggleBml: toggleBml,
      handleKeyDown: handleKeyDown,
      getStatus: getPublicStatus
    };
  }

  global.AribManagerModule = {
    createAribManager: createAribManager
  };
})(window);
