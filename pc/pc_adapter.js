/* -*- coding: utf-8 -*-
 * pc_adapter.js - DTV Plus PC版 (Chrome) プレイヤー & デスクトップ操作アダプタ
 * - mpegts.js: GR/BS/CS (GPU HW変換TS), BS4K (無劣化HEVC TS / 自動H.264フォールバック), ABEMA/TVerライブ (無変換TS)
 * - hls.js: TVer / ABEMA VOD (HLS + ローカルCORSプロキシ)
 * - PC向け自動UIスケーリング、キーボードショートカット、右上クイックバーを提供
 */
(function (global) {
  'use strict';

  // =========================================================================
  // 0. Tailscale / LAN リモートアクセス透過リライト層
  //    app/js/*.js (TVアプリ共通コード) を1文字も変更せず、
  //    外出先 (http://<Tailscale-IP>:7019) からの接続時に
  //      - http://127.0.0.1:7019/* -> 現在のアクセス元 Origin (location.origin)
  //      - http://192.168.x.x/* 等 -> /pc/lan_proxy?target=...
  //    へ自動ルーティングする。
  // =========================================================================
  var PC_ORIGIN = (global.location && global.location.origin && global.location.origin !== 'null')
    ? global.location.origin
    : 'http://127.0.0.1:7019';
  var PC_HOST = (global.location && global.location.hostname) ? String(global.location.hostname).toLowerCase() : '127.0.0.1';
  var IS_REMOTE_CLIENT = !(PC_HOST === '127.0.0.1' || PC_HOST === 'localhost' || PC_HOST === '::1' || PC_HOST === '[::1]');

  var RE_LOCAL_DAEMON = /^https?:\/\/(?:127\.0\.0\.1|localhost):7019(\/|$)/i;
  var RE_PRIVATE_LAN = /^https?:\/\/(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?(\/|$)/i;

  function rewriteUrlForClient(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl;
    var u = rawUrl;
    if (RE_LOCAL_DAEMON.test(u)) {
      return u.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost):7019/i, PC_ORIGIN);
    }
    if (IS_REMOTE_CLIENT && RE_PRIVATE_LAN.test(u)) {
      if (u.indexOf(PC_ORIGIN + '/') === 0 || u === PC_ORIGIN) return u;
      if (u.indexOf('/pc/lan_proxy?') !== -1) return u;
      return PC_ORIGIN + '/pc/lan_proxy?target=' + encodeURIComponent(u);
    }
    return u;
  }

  // XMLHttpRequest.prototype.open を透過フック (mirakurun / epgstation / tver / arib / jikkyo 全て対応)
  if (global.XMLHttpRequest && global.XMLHttpRequest.prototype && global.XMLHttpRequest.prototype.open) {
    var origXhrOpen = global.XMLHttpRequest.prototype.open;
    global.XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof url === 'string') {
        args[1] = rewriteUrlForClient(url);
      }
      return origXhrOpen.apply(this, args);
    };
  }

  // fetch を透過フック
  if (typeof global.fetch === 'function') {
    var origFetch = global.fetch;
    global.fetch = function (input, init) {
      if (typeof input === 'string') {
        return origFetch.call(this, rewriteUrlForClient(input), init);
      }
      return origFetch.apply(this, arguments);
    };
  }

  // 画像 (局ロゴ / TVer・ABEMAサムネ / 録画サムネ) の src 代入を透過フック
  try {
    var imgSrcDesc = Object.getOwnPropertyDescriptor(global.HTMLImageElement.prototype, 'src');
    if (imgSrcDesc && imgSrcDesc.set && imgSrcDesc.get) {
      Object.defineProperty(global.HTMLImageElement.prototype, 'src', {
        configurable: true,
        enumerable: imgSrcDesc.enumerable,
        get: function () { return imgSrcDesc.get.call(this); },
        set: function (val) {
          imgSrcDesc.set.call(this, typeof val === 'string' ? rewriteUrlForClient(val) : val);
        }
      });
    }
  } catch (eImgHook) {}

  try {
    var origSetAttr = global.Element.prototype.setAttribute;
    global.Element.prototype.setAttribute = function (name, val) {
      if (typeof name === 'string' && name.toLowerCase() === 'src' && typeof val === 'string') {
        val = rewriteUrlForClient(val);
      }
      return origSetAttr.call(this, name, val);
    };
  } catch (eAttrHook) {}

  // 画質プリセット (ローカルはデフォルト高画質、Tailscale等のリモート時はデフォルト標準3M)
  var QUALITY_KEY = IS_REMOTE_CLIENT ? 'dtvplus_pc_quality_remote' : 'dtvplus_pc_quality_local';
  var pcQuality = IS_REMOTE_CLIENT ? 'medium' : 'high';
  try {
    var savedQ = localStorage.getItem(QUALITY_KEY);
    if (savedQ === 'high' || savedQ === 'medium' || savedQ === 'mobile') {
      pcQuality = savedQ;
    }
  } catch (eQInit) {}

  var lastStreamReplay = null;
  var qualityBtnEl = null;

  function getQualityLabel(q) {
    if (q === 'mobile') return '画質: 省データ';
    if (q === 'medium') return '画質: 標準3M';
    return '画質: 高画質';
  }

  var activeMpegts = null;
  var activeHls = null;
  var activeSessionSeq = 0;

  // PC 版の音量・ミュート状態を一元管理 (チャンネル切替や BS4K 跨ぎで意図せずミュートにならないよう保護)
  var pcVolume = 1.0;
  var pcUserMuted = false;
  var autoMutedByPolicy = false;
  var volSliderEl = null;
  var volLabelEl = null;

  try {
    var initVolRaw = localStorage.getItem('dtvplus_pc_volume');
    if (initVolRaw !== null) {
      var initVolNum = parseFloat(initVolRaw);
      if (!isNaN(initVolNum) && initVolNum >= 0 && initVolNum <= 1) pcVolume = initVolNum;
    }
    pcUserMuted = (localStorage.getItem('dtvplus_pc_muted') === '1');
  } catch (eInitVol) {}

  function syncVolumeUi(videoEl) {
    var v = videoEl || document.getElementById('tv-video');
    var isMuted = v ? (!!v.muted || v.volume === 0) : pcUserMuted;
    var pct = Math.round((v ? v.volume : pcVolume) * 100);
    if (volSliderEl) {
      volSliderEl.value = String(isMuted ? 0 : pct);
    }
    if (volLabelEl) {
      volLabelEl.textContent = isMuted ? 'MUTE' : (pct + '%');
    }
  }

  function applySavedAudioState(videoEl) {
    if (!videoEl) return;
    autoMutedByPolicy = false;
    videoEl.volume = pcVolume;
    videoEl.muted = pcUserMuted || (pcVolume === 0);
    syncVolumeUi(videoEl);
  }

  function safePlayVideo(videoEl, playFn, mySeq) {
    applySavedAudioState(videoEl);
    var pr;
    try {
      pr = playFn ? playFn() : videoEl.play();
    } catch (e) {
      return;
    }
    if (pr && typeof pr.catch === 'function') {
      pr.catch(function (err) {
        // チャンネル切替等で中断された古い再生の AbortError は完全無視 (絶対にミュートにしない)
        if (mySeq !== activeSessionSeq) return;
        var errName = (err && err.name) ? String(err.name) : '';
        if (errName === 'NotAllowedError') {
          try {
            autoMutedByPolicy = true;
            videoEl.muted = true;
            syncVolumeUi(videoEl);
            var p2 = videoEl.play();
            if (p2 && typeof p2.catch === 'function') p2.catch(function () {});
          } catch (e2) {}
        }
      });
    }
  }

  function supportsHevcMse() {
    if (!global.MediaSource || !global.MediaSource.isTypeSupported) return false;
    var codecs = [
      'video/mp4; codecs="hvc1.1.6.L153.B0, mp4a.40.2"',
      'video/mp4; codecs="hev1.1.6.L153.B0, mp4a.40.2"',
      'video/mp4; codecs="hvc1.1.6.L120.90, mp4a.40.2"'
    ];
    for (var i = 0; i < codecs.length; i++) {
      try {
        if (global.MediaSource.isTypeSupported(codecs[i])) return true;
      } catch (e) {}
    }
    return false;
  }

  function destroyActivePlayer() {
    activeSessionSeq++;
    if (activeMpegts) {
      try { activeMpegts.pause(); } catch (e1) {}
      try { activeMpegts.unload(); } catch (e2) {}
      try { activeMpegts.detachMediaElement(); } catch (e3) {}
      try { activeMpegts.destroy(); } catch (e4) {}
      activeMpegts = null;
    }
    if (activeHls) {
      try { activeHls.destroy(); } catch (e5) {}
      activeHls = null;
    }
  }

  /**
   * PC Chrome (mpegts.js) 用の系統別バッファプロファイル
   * - dtv     : 連続到着する地デジ/BS/CS向け (1.5秒余裕を確保しつつ追従)
   * - bs4k    : 上流 2秒バースト揺らぎを吸収するため 4.5〜14秒の厚めバッファを確保
   * - weblive : 4〜5秒セグメント単位で届く TVer/ABEMA ライブ向け (強制追従 chasing を完全OFFにして定期フリーズを根絶)
   * - recorded: 録画再生向け (非ライブ)
   */
  function buildMpegtsConfig(profile) {
    if (profile === 'weblive') {
      return {
        enableWorker: true,
        enableStashBuffer: true,
        stashInitialSize: 512 * 1024,
        liveBufferLatencyChasing: false,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 25,
        autoCleanupMinBackwardDuration: 12
      };
    }
    if (profile === 'bs4k') {
      return {
        enableWorker: true,
        enableStashBuffer: true,
        stashInitialSize: 512 * 1024,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 14.0,
        liveBufferLatencyMinRemain: 4.5,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 25,
        autoCleanupMinBackwardDuration: 12
      };
    }
    if (profile === 'recorded') {
      return {
        enableWorker: true,
        enableStashBuffer: true,
        stashInitialSize: 512 * 1024,
        liveBufferLatencyChasing: false,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 15
      };
    }
    // dtv (GR / BS / CS)
    return {
      enableWorker: true,
      enableStashBuffer: true,
      stashInitialSize: 256 * 1024,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 4.5,
      liveBufferLatencyMinRemain: 1.5,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 20,
      autoCleanupMinBackwardDuration: 10
    };
  }

  function startMpegtsStream(videoEl, tsUrl, profile, onReady, onErr, onFallback) {
    destroyActivePlayer();
    var mySeq = activeSessionSeq;

    if (!global.mpegts || !global.mpegts.isSupported()) {
      if (onErr) onErr();
      return;
    }

    var isLiveFlag = (profile !== 'recorded');
    var player = global.mpegts.createPlayer(
      {
        type: 'mpegts',
        isLive: isLiveFlag,
        url: tsUrl
      },
      buildMpegtsConfig(profile)
    );

    activeMpegts = player;
    var fallbackFired = false;

    player.on(global.mpegts.Events.ERROR, function (errType, errDetail) {
      if (mySeq !== activeSessionSeq) return;
      console.warn('[DTVPlus-PC] mpegts error:', errType, errDetail);
      if (onFallback && !fallbackFired) {
        fallbackFired = true;
        onFallback();
        return;
      }
      if (onErr) onErr();
    });

    player.attachMediaElement(videoEl);
    player.load();
    safePlayVideo(videoEl, function () { return player.play(); }, mySeq);
  }

  function toPcStreamUrl(origUrl, prefix, extraParams) {
    var u = String(origUrl || '');
    var mStream = u.match(/^https?:\/\/[^\/]+\/stream\/(.*)$/i);
    var mRec = u.match(/^https?:\/\/[^\/]+\/recorded\/(.*)$/i);
    if (mStream) {
      u = PC_ORIGIN + '/pc/stream/' + mStream[1];
    } else if (mRec) {
      u = PC_ORIGIN + '/pc/recorded/' + mRec[1];
    } else {
      u = PC_ORIGIN + prefix + '?target=' + encodeURIComponent(u);
    }
    var params = [];
    if (extraParams) params.push(extraParams);
    if (u.indexOf('quality=') === -1) params.push('quality=' + encodeURIComponent(pcQuality));
    if (params.length > 0) {
      u += (u.indexOf('?') === -1 ? '?' : '&') + params.join('&');
    }
    return u;
  }

  function attachLive(videoEl, svc, streamUrl, onReady, onErr) {
    lastStreamReplay = function () {
      attachLive(videoEl, svc, streamUrl, onReady, onErr);
    };
    var isBs4k = !!(svc && svc.channelType === 'BS4K');
    if (isBs4k) {
      // リモート省帯域モード (medium/mobile) では BS4K も 720p/540p H.264 へ縮小配信する
      var canHevc = (pcQuality === 'high') && supportsHevcMse();
      var primaryUrl = toPcStreamUrl(streamUrl, '/pc/stream/live.ts', 'mode=bs4k&codec=' + (canHevc ? 'hevc' : 'h264'));
      var fallbackUrl = toPcStreamUrl(streamUrl, '/pc/stream/live.ts', 'mode=bs4k&codec=h264');
      startMpegtsStream(
        videoEl,
        primaryUrl,
        'bs4k',
        onReady,
        onErr,
        canHevc ? function () {
          console.warn('[DTVPlus-PC] BS4K HEVC direct failed; falling back to GPU H.264');
          startMpegtsStream(videoEl, fallbackUrl, 'bs4k', onReady, onErr, null);
        } : null
      );
      return true;
    }
    var pcUrl = toPcStreamUrl(streamUrl, '/pc/stream/live.ts', '');
    startMpegtsStream(videoEl, pcUrl, 'dtv', onReady, onErr, null);
    return true;
  }

  function attachVod(videoEl, vod, info, asTsStream, applyResume, onErr) {
    lastStreamReplay = null;
    destroyActivePlayer();
    var mySeq = activeSessionSeq;

    // 1. PC Chrome での ABEMA ライブは、TVCM 境界での 48kHz<->44.1kHz ピッチ低下 & フォーマット変化を
    //    物理的に根絶する /pc/abema_live.ts (GPU 30fps 統一 + 48kHz AAC 固定リサンプル) で再生する
    var isAbemaLive = !!(vod && vod.provider === 'ABEMA' && vod.isLive && info);
    if (isAbemaLive) {
      var abemaSrcM3u8 = '';
      var candUrl = String(info.streamUrl || info.hlsFallbackUrl || '');
      var mQ = candUrl.match(/[?&]url=([^&]+)/);
      if (mQ && mQ[1]) {
        try { abemaSrcM3u8 = decodeURIComponent(mQ[1]); } catch (eDec) { abemaSrcM3u8 = mQ[1]; }
      }
      if (abemaSrcM3u8) {
        lastStreamReplay = function () {
          attachVod(videoEl, vod, info, asTsStream, applyResume, onErr);
        };
        var pcAbemaUrl = PC_ORIGIN + '/pc/abema_live.ts?url=' + encodeURIComponent(abemaSrcM3u8) + '&quality=' + encodeURIComponent(pcQuality);
        startMpegtsStream(videoEl, pcAbemaUrl, 'weblive', applyResume, onErr, null);
        return true;
      }
    }

    // 2. TVer ライブ (/api/tver/live.m2ts) 等、TS 指定の場合は mpegts.js (chasing OFF)
    if (asTsStream) {
      startMpegtsStream(videoEl, rewriteUrlForClient(info.streamUrl), 'weblive', applyResume, onErr, null);
      return true;
    }

    // 3. HLS (.m3u8): TVer / ABEMA VOD
    var rawUrl = (asTsStream === false)
      ? ((info && (info.hlsFallbackUrl || info.streamUrl)) || '')
      : ((info && info.streamUrl) || '');
    var hlsUrl = rewriteUrlForClient(rawUrl);
    if (hlsUrl && hlsUrl.indexOf(PC_ORIGIN + '/') !== 0) {
      hlsUrl = PC_ORIGIN + '/pc/hls_proxy?url=' + encodeURIComponent(hlsUrl);
    }

    if (global.Hls && global.Hls.isSupported()) {
      var hls = new global.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10
      });
      activeHls = hls;
      var mediaRecoverTries = 0;
      hls.loadSource(hlsUrl);
      hls.attachMedia(videoEl);
      hls.on(global.Hls.Events.MANIFEST_PARSED, function () {
        if (mySeq !== activeSessionSeq) return;
        if (applyResume) applyResume();
        safePlayVideo(videoEl, null, mySeq);
      });
      hls.on(global.Hls.Events.FRAG_PLAYING, function () {
        mediaRecoverTries = 0;
      });
      hls.on(global.Hls.Events.ERROR, function (ev, data) {
        if (mySeq !== activeSessionSeq) return;
        if (data && data.fatal) {
          if (data.type === global.Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (data.type === global.Hls.ErrorTypes.MEDIA_ERROR && mediaRecoverTries < 3) {
            mediaRecoverTries++;
            hls.recoverMediaError();
          } else {
            if (onErr) onErr();
          }
        }
      });
      return true;
    }

    videoEl.src = hlsUrl;
    var p = videoEl.play();
    if (p && typeof p.catch === 'function') p.catch(function () {});
    return true;
  }

  function attachRecorded(videoEl, recItem, srcInfo, startSec, applyMp4Seek, onErr) {
    lastStreamReplay = null;
    destroyActivePlayer();
    if (!srcInfo) return false;

    // MP4 エンコード済み録画は Chrome ネイティブ再生 (リモート時は /pc/lan_proxy 経由で Range シーク対応)
    if (!srcInfo.isRawTs) {
      var recSeq = activeSessionSeq;
      videoEl.src = rewriteUrlForClient(srcInfo.url);
      videoEl.load();
      safePlayVideo(videoEl, null, recSeq);
      return true;
    }

    // 生 TS / BS4K 録画は /pc/recorded 経由で mpegts.js 再生
    lastStreamReplay = function () {
      attachRecorded(videoEl, recItem, srcInfo, startSec, applyMp4Seek, onErr);
    };
    if (srcInfo.isBs4k) {
      var canHevc = (pcQuality === 'high') && supportsHevcMse();
      var primaryUrl = toPcStreamUrl(srcInfo.url, '/pc/recorded/rec.ts', 'codec=' + (canHevc ? 'hevc' : 'h264'));
      var fallbackUrl = toPcStreamUrl(srcInfo.url, '/pc/recorded/rec.ts', 'codec=h264');
      startMpegtsStream(
        videoEl,
        primaryUrl,
        'recorded',
        applyMp4Seek,
        onErr,
        canHevc ? function () {
          startMpegtsStream(videoEl, fallbackUrl, 'recorded', applyMp4Seek, onErr, null);
        } : null
      );
      return true;
    }

    var pcRecUrl = toPcStreamUrl(srcInfo.url, '/pc/recorded/rec.ts', '');
    startMpegtsStream(videoEl, pcRecUrl, 'recorded', applyMp4Seek, onErr, null);
    return true;
  }

  global.DtvPlusPcPlayer = {
    isPc: true,
    supportsHevcMse: supportsHevcMse,
    destroy: destroyActivePlayer,
    attachLive: attachLive,
    attachVod: attachVod,
    attachRecorded: attachRecorded
  };

  // =========================================================================
  // PC デスクトップ BML 16:9 レスポンシブフィット & キーボード・マウス操作拡張
  // (他UIは pc_style.css の純CSSレスポンシブで制御し、zoomハックによる崩れを廃止)
  // =========================================================================
  var isApplyingStageTransform = false;

  /**
   * #video-container (1920x1080 座標系で通常全画面 & BML小窓縮小を行う) を
   * 仮想TVステージ #pc-tv-stage で包み、PC ウィンドウの 16:9 領域へ厳密スケーリングできるようにする。
   */
  function ensurePcTvStage() {
    var tvStage = document.getElementById('pc-tv-stage');
    if (tvStage) return tvStage;
    var vCont = document.getElementById('video-container');
    if (!vCont || !vCont.parentNode) return null;
    tvStage = document.createElement('div');
    tvStage.id = 'pc-tv-stage';
    vCont.parentNode.insertBefore(tvStage, vCont);
    tvStage.appendChild(vCont);
    return tvStage;
  }

  /**
   * 固定解像度ベースの3レイヤーを現在の PC ウィンドウ内の全く同じ 16:9 表示領域へ厳密フィットさせる。
   *  - #pc-tv-stage   (1920x1080: 映像 + ARIB字幕/文字スーパー + BML小窓縮小)
   *  - #bml-stage     (960x540等: ARIB BML データ放送)
   *  - #danmaku-layer (1920x1080: ニコニコ実況弾幕)
   */
  function applyResponsiveVideoOverlays() {
    if (isApplyingStageTransform) return;
    isApplyingStageTransform = true;
    try {
      var vw = window.innerWidth || 1280;
      var vh = window.innerHeight || 720;

      // 16:9 基準の共通表示領域を算出 (映像・BML・弾幕を 1px ズレなく同期)
      var scale1080 = Math.min(vw / 1920, vh / 1080);
      var offX1080 = Math.max(0, Math.floor((vw - 1920 * scale1080) / 2));
      var offY1080 = Math.max(0, Math.floor((vh - 1080 * scale1080) / 2));

      // 1) 映像 + ARIB 字幕 + BML 小窓ステージ (1920x1080)
      var tvStage = ensurePcTvStage();
      if (tvStage) {
        tvStage.style.left = offX1080 + 'px';
        tvStage.style.top = offY1080 + 'px';
        tvStage.style.transformOrigin = '0 0';
        tvStage.style.transform = 'scale(' + scale1080.toFixed(5) + ', ' + scale1080.toFixed(5) + ')';
      }

      // 2) BML データ放送ステージ (960x540 または BML 指定解像度)
      var stage = document.getElementById('bml-stage');
      if (stage) {
        var bw = parseFloat(stage.style.width) || 960;
        var bh = parseFloat(stage.style.height) || 540;
        var bScaleX = (1920 * scale1080) / bw;
        var bScaleY = (1080 * scale1080) / bh;
        stage.style.left = offX1080 + 'px';
        stage.style.top = offY1080 + 'px';
        stage.style.transformOrigin = '0 0';
        stage.style.transform = 'scale(' + bScaleX.toFixed(5) + ', ' + bScaleY.toFixed(5) + ')';
      }

      // 3) ニコニコ実況 弾幕レイヤー (1920x1080)
      var danmaku = document.getElementById('danmaku-layer');
      if (danmaku) {
        danmaku.style.left = offX1080 + 'px';
        danmaku.style.top = offY1080 + 'px';
        danmaku.style.transformOrigin = '0 0';
        danmaku.style.transform = 'scale(' + scale1080.toFixed(5) + ', ' + scale1080.toFixed(5) + ')';
      }
    } finally {
      isApplyingStageTransform = false;
    }
  }

  function dispatchSyntheticKey(keyCode) {
    var ev;
    try {
      ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: function () { return keyCode; } });
      Object.defineProperty(ev, 'which', { get: function () { return keyCode; } });
    } catch (e) {
      ev = document.createEvent('Event');
      ev.initEvent('keydown', true, true);
      ev.keyCode = keyCode;
      ev.which = keyCode;
    }
    document.dispatchEvent(ev);
  }

  function clickGuideButton(id) {
    var el = document.getElementById(id);
    if (el) el.click();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(function () {});
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(function () {});
      }
    }
  }

  function initPcDesktopUi() {
    // 待機画面バッジを PC クライアント表示へ変更
    var badge = document.querySelector('.standby-badge');
    if (badge) {
      badge.textContent = 'DTV PLUS PC DESKTOP CLIENT';
    }

    // 音量設定を復元し、video 要素の volumechange と常時同期する
    var video = document.getElementById('tv-video');
    if (video) {
      applySavedAudioState(video);
      video.addEventListener('volumechange', function () {
        syncVolumeUi(video);
      });
    }

    // 万一自動再生ポリシーで一時ミュートされた場合は、次のクリック/キー操作で元の音量へ自動復帰
    function restoreIfAutoMuted() {
      if (autoMutedByPolicy && video) {
        autoMutedByPolicy = false;
        video.muted = pcUserMuted || (pcVolume === 0);
        video.volume = pcVolume;
        syncVolumeUi(video);
      }
    }
    document.addEventListener('pointerdown', restoreIfAutoMuted, true);
    document.addEventListener('keydown', restoreIfAutoMuted, true);

    // 右上クイックバー生成 (マウス移動時のみ表示)
    var bar = document.createElement('div');
    bar.id = 'pc-quick-bar';

    function makeBtn(label, title, onClick) {
      var b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.onclick = function (e) {
        e.stopPropagation();
        onClick();
      };
      return b;
    }

    bar.appendChild(makeBtn('メニュー', 'チャンネル・TVer・ABEMAメニュー開閉 (M)', function () { dispatchSyntheticKey(406); }));
    bar.appendChild(makeBtn('番組表', '2次元番組表を開く (G)', function () { clickGuideButton('btn-guide-epg'); }));
    bar.appendChild(makeBtn('録画', '録画ライブラリを開く (R)', function () { clickGuideButton('btn-guide-reclist'); }));
    bar.appendChild(makeBtn('データ放送', 'BML データ放送切替 (D)', function () { dispatchSyntheticKey(1019); }));
    bar.appendChild(makeBtn('実況', '実況コメント ON/OFF (J)', function () { dispatchSyntheticKey(403); }));
    bar.appendChild(makeBtn('コメ欄', 'コメント一覧開閉 (C)', function () { dispatchSyntheticKey(405); }));

    qualityBtnEl = makeBtn(
      getQualityLabel(pcQuality),
      '配信画質切替 (高画質: 8M/4K無劣化 / 標準: 720p 3M / 省データ: 540p 1.5M)',
      function () {
        pcQuality = (pcQuality === 'high') ? 'medium' : (pcQuality === 'medium' ? 'mobile' : 'high');
        try { localStorage.setItem(QUALITY_KEY, pcQuality); } catch (exQ) {}
        if (qualityBtnEl) qualityBtnEl.textContent = getQualityLabel(pcQuality);
        if (typeof lastStreamReplay === 'function') {
          lastStreamReplay();
        }
      }
    );
    bar.appendChild(qualityBtnEl);

    var volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.id = 'pc-vol-slider';
    volSlider.min = '0';
    volSlider.max = '100';
    volSliderEl = volSlider;

    var volLabel = document.createElement('span');
    volLabel.id = 'pc-vol-label';
    volLabel.title = 'クリックでミュート切替 (V)';
    volLabel.style.cursor = 'pointer';
    volLabelEl = volLabel;

    function toggleMuteUser() {
      if (!video) return;
      autoMutedByPolicy = false;
      pcUserMuted = !pcUserMuted;
      if (!pcUserMuted && pcVolume === 0) pcVolume = 0.5;
      video.volume = pcVolume;
      video.muted = pcUserMuted;
      try {
        localStorage.setItem('dtvplus_pc_volume', String(pcVolume));
        localStorage.setItem('dtvplus_pc_muted', pcUserMuted ? '1' : '0');
      } catch (ex) {}
      syncVolumeUi(video);
    }

    volLabel.onclick = function (e) {
      e.stopPropagation();
      toggleMuteUser();
    };

    volSlider.oninput = function (e) {
      e.stopPropagation();
      var v = Math.max(0, Math.min(100, parseInt(volSlider.value, 10) || 0)) / 100;
      autoMutedByPolicy = false;
      pcVolume = v;
      pcUserMuted = (v === 0);
      if (video) {
        video.volume = pcVolume;
        video.muted = pcUserMuted;
      }
      try {
        localStorage.setItem('dtvplus_pc_volume', String(pcVolume));
        localStorage.setItem('dtvplus_pc_muted', pcUserMuted ? '1' : '0');
      } catch (ex) {}
      syncVolumeUi(video);
    };
    syncVolumeUi(video);
    bar.appendChild(volSlider);
    bar.appendChild(volLabel);
    bar.appendChild(makeBtn('全画面', 'フルスクリーン切替 (F)', toggleFullscreen));

    document.body.appendChild(bar);

    var hideBarTimer = null;
    function wakeBar() {
      bar.className = 'visible';
      if (hideBarTimer) clearTimeout(hideBarTimer);
      hideBarTimer = setTimeout(function () {
        bar.className = '';
      }, 2600);
    }
    document.addEventListener('mousemove', wakeBar);
    document.addEventListener('touchstart', wakeBar, { passive: true });
    bar.addEventListener('mouseenter', function () {
      if (hideBarTimer) clearTimeout(hideBarTimer);
      bar.className = 'visible';
    });

    // 映像エリア (#pc-tv-stage) を初期化し、ダブルクリックでフルスクリーン・右クリックでメニュー開閉
    var tvStage = ensurePcTvStage() || document.getElementById('video-container');
    if (tvStage) {
      tvStage.addEventListener('dblclick', function (e) {
        e.preventDefault();
        toggleFullscreen();
      });
      tvStage.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        dispatchSyntheticKey(406);
      });
    }

    // PC キーボードショートカット (入力欄フォーカス中は無視)
    document.addEventListener('keydown', function (ev) {
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

      var k = (ev.key || '').toLowerCase();
      if (k === 'm' || ev.keyCode === 9) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        dispatchSyntheticKey(406);
      } else if (k === 'g') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        clickGuideButton('btn-guide-epg');
      } else if (k === 'r') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        clickGuideButton('btn-guide-reclist');
      } else if (k === 'd') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        dispatchSyntheticKey(1019);
      } else if (k === 'j') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        dispatchSyntheticKey(403);
      } else if (k === 'c') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        dispatchSyntheticKey(405);
      } else if (k === 'a') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        dispatchSyntheticKey(404);
      } else if (k === 'f') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        toggleFullscreen();
      } else if (k === ' ') {
        if (video && video.readyState >= 2) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          if (video.paused) video.play().catch(function () {});
          else video.pause();
        }
      } else if (k === 'v') {
        if (video) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          toggleMuteUser();
          wakeBar();
        }
      } else if (k === '[' || k === ']') {
        if (video) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          var delta = (k === ']') ? 0.05 : -0.05;
          autoMutedByPolicy = false;
          pcVolume = Math.max(0, Math.min(1, pcVolume + delta));
          pcUserMuted = (pcVolume === 0);
          video.volume = pcVolume;
          video.muted = pcUserMuted;
          try {
            localStorage.setItem('dtvplus_pc_volume', String(pcVolume));
            localStorage.setItem('dtvplus_pc_muted', pcUserMuted ? '1' : '0');
          } catch (ex) {}
          syncVolumeUi(video);
          wakeBar();
        }
      }
    }, true);

    applyResponsiveVideoOverlays();
    window.addEventListener('resize', applyResponsiveVideoOverlays);

    // BML 側 (arib_manager.js) が起動時に 1920x1080 向け transform を設定した直後にも PC 比率へ再フィット
    var bmlStageEl = document.getElementById('bml-stage');
    if (bmlStageEl && typeof MutationObserver === 'function') {
      var bmlObs = new MutationObserver(function () {
        applyResponsiveVideoOverlays();
      });
      bmlObs.observe(bmlStageEl, { attributes: true, attributeFilter: ['style'] });
    }

    wakeBar();
  }

  // =========================================================================
  // PC 版専用: 設定を LAN 内の LG TV (DTV Plus .ipk) へ同期する UI & API
  // =========================================================================
  var LAST_TV_IP_KEY = 'dtvplus_pc_last_tv_ip';
  var pcDiscoveredTvs = [];
  var pcTvScanBusy = false;

  global.DtvPlusPcSync = {
    renderSettingsPanel: function (container, getSettingsFn, showToastFn, registerFocusableFn, rerenderFn) {
      var box = document.createElement('div');
      box.className = 'setting-group';

      var hdr = document.createElement('div');
      hdr.className = 'setting-label';
      hdr.textContent = 'TV へ設定を同期（PC 版専用）';
      box.appendChild(hdr);

      var desc = document.createElement('div');
      desc.className = 'setting-desc';
      desc.textContent = 'PC で設定した接続先や表示オプションを、同一 LAN 内の TV 版 DTV Plus へ送信します（視聴履歴は送信しません）。';
      box.appendChild(desc);

      var scanRow = document.createElement('div');
      scanRow.className = 'preset-row';
      var scanBtn = document.createElement('button');
      scanBtn.className = 'btn-action';
      scanBtn.textContent = pcTvScanBusy ? 'LAN 内の TV を検索中…' : 'LAN 内の TV を検索';
      var doScan = function () {
        if (pcTvScanBusy) return;
        pcTvScanBusy = true;
        if (typeof rerenderFn === 'function') rerenderFn();
        var xhr = new XMLHttpRequest();
        xhr.open('GET', PC_ORIGIN + '/pc/discover_tv', true);
        xhr.timeout = 18000;
        xhr.onload = function () {
          pcTvScanBusy = false;
          try {
            var res = JSON.parse(xhr.responseText);
            pcDiscoveredTvs = (res && Array.isArray(res.items)) ? res.items : [];
            if (pcDiscoveredTvs.length > 0) {
              try {
                if (!localStorage.getItem(LAST_TV_IP_KEY)) {
                  localStorage.setItem(LAST_TV_IP_KEY, pcDiscoveredTvs[0].ip);
                }
              } catch (eSet) {}
              if (typeof showToastFn === 'function') {
                showToastFn('success', 'TV を検出しました', pcDiscoveredTvs.length + ' 件の DTV Plus 対応 TV が見つかりました');
              }
            } else if (typeof showToastFn === 'function') {
              showToastFn('info', 'TV が見つかりませんでした', 'TV で DTV Plus が起動中か確認するか、IP を直接入力してください');
            }
          } catch (e) {
            pcDiscoveredTvs = [];
          }
          if (typeof rerenderFn === 'function') rerenderFn();
        };
        xhr.onerror = xhr.ontimeout = function () {
          pcTvScanBusy = false;
          if (typeof showToastFn === 'function') {
            showToastFn('error', 'TV 検索エラー', 'LAN スキャンに失敗しました');
          }
          if (typeof rerenderFn === 'function') rerenderFn();
        };
        xhr.send();
      };
      if (typeof registerFocusableFn === 'function') registerFocusableFn(scanBtn, doScan);
      else scanBtn.onclick = doScan;
      scanRow.appendChild(scanBtn);

      for (var i = 0; i < pcDiscoveredTvs.length; i++) {
        (function (tv) {
          var tb = document.createElement('button');
          tb.className = 'btn-action';
          tb.textContent = 'TV: ' + tv.ip;
          var onPick = function () {
            ipIn.value = tv.ip;
            try { localStorage.setItem(LAST_TV_IP_KEY, tv.ip); } catch (e) {}
            if (typeof showToastFn === 'function') {
              showToastFn('info', '送信先 TV を選択しました', tv.ip);
            }
          };
          if (typeof registerFocusableFn === 'function') registerFocusableFn(tb, onPick);
          else tb.onclick = onPick;
          scanRow.appendChild(tb);
        })(pcDiscoveredTvs[i]);
      }
      box.appendChild(scanRow);

      var sendRow = document.createElement('div');
      sendRow.className = 'tver-toolbar';
      var ipIn = document.createElement('input');
      ipIn.type = 'text';
      ipIn.className = 'tver-input';
      ipIn.placeholder = 'TV の IP アドレスを入力';
      var savedIp = '';
      try { savedIp = localStorage.getItem(LAST_TV_IP_KEY) || ''; } catch (e) {}
      ipIn.value = savedIp;
      if (typeof registerFocusableFn === 'function') {
        registerFocusableFn(ipIn, function () { ipIn.focus(); });
      }

      var sendBtn = document.createElement('button');
      sendBtn.className = 'btn-action';
      sendBtn.style.backgroundColor = '#cf0652';
      sendBtn.textContent = '現在の設定を TV へ送信';
      var doSend = function () {
        var targetIp = (ipIn.value || '').trim();
        if (!targetIp) {
          if (typeof showToastFn === 'function') {
            showToastFn('warn', 'TV の IP アドレスを入力してください', '「LAN 内の TV を検索」で自動検出もできます');
          }
          return;
        }
        try { localStorage.setItem(LAST_TV_IP_KEY, targetIp); } catch (e) {}
        var curSettings = (typeof getSettingsFn === 'function') ? getSettingsFn() : {};
        var xhr = new XMLHttpRequest();
        xhr.open('POST', PC_ORIGIN + '/pc/sync_to_tv', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.timeout = 12000;
        xhr.onload = function () {
          try {
            var res = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300 && res && res.ok) {
              if (typeof showToastFn === 'function') {
                showToastFn('success', 'TV へ設定を送信しました', 'TV 側の [設定] タブを開くか「受信確認」を押して適用してください', 6500);
              }
            } else {
              if (typeof showToastFn === 'function') {
                showToastFn('error', 'TV 同期エラー', (res && res.error) || ('HTTP ' + xhr.status), 6000);
              }
            }
          } catch (e) {
            if (typeof showToastFn === 'function') {
              showToastFn('error', 'TV 同期エラー', '応答を解析できませんでした', 5000);
            }
          }
        };
        xhr.onerror = xhr.ontimeout = function () {
          if (typeof showToastFn === 'function') {
            showToastFn('error', 'TV 同期失敗', 'TV との通信がタイムアウトしました', 5000);
          }
        };
        xhr.send(JSON.stringify({ tvIp: targetIp, settings: curSettings }));
      };
      if (typeof registerFocusableFn === 'function') registerFocusableFn(sendBtn, doSend);
      else sendBtn.onclick = doSend;

      sendRow.appendChild(ipIn);
      sendRow.appendChild(sendBtn);
      box.appendChild(sendRow);

      container.appendChild(box);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPcDesktopUi);
  } else {
    initPcDesktopUi();
  }
})(window);
