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
    var onUserInteract = opts.onUserInteract || function () {};

    var vendor = global.DTVAribVendor || null;

    var state = {
      activeStream: false,
      isLiveStream: true,
      captionEnabled: opts.initialCaptionEnabled === true,
      bmlPrefetchEnabled: opts.initialBmlPrefetchEnabled !== false,
      bmlActive: false,
      bmlHasDataComponent: null, // null: PMT未受信, true: データ放送あり, false: なし
      bmlProfile: '',            // 'A' (地デジ) / 'BS' / 'CS' / 'C'
      bmlWaitingBootstrap: false, // BS 等で invisible なしの透明 startup.bml 待機中
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
      bmlPrefetchStartedAt: 0,
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
    var bmlAudioGainNode = null;
    var dataBtnTimers = [];
    var bmlBootstrapTimer = null;
    var bmlAutoCloseTimer = null;
    var bmlVideoRestoreTimer = null;
    var bmlInvisibleSinceMs = 0;
    var userOpenedAtMs = 0;
    var bmlInteractiveCache = null;
    var bmlInteractiveCacheAt = 0;
    var lastBmlHoverCheckAt = 0;
    var lastBmlPointerClickAt = 0;
    var bmlPointerHitActive = false;
    var bmlAutoNavSeq = 0;
    var bmlAutoNavTimer = null;

    function setBmlAudioMuted(muted) {
      try {
        if (bmlAudioGainNode && bmlAudioGainNode.gain) {
          bmlAudioGainNode.gain.value = muted ? 0.0 : 1.0;
        }
      } catch (e) {}
    }

    function cancelBmlAutoNav() {
      bmlAutoNavSeq++;
      if (bmlAutoNavTimer) {
        clearTimeout(bmlAutoNavTimer);
        bmlAutoNavTimer = null;
      }
      setBmlAudioMuted(false);
    }

    function invalidateBmlInteractiveCache() {
      bmlInteractiveCache = null;
      bmlInteractiveCacheAt = 0;
    }

    function setBmlPointerCursor(isHit) {
      if (bmlPointerHitActive === !!isHit) return;
      bmlPointerHitActive = !!isHit;
      if (!bmlOverlayEl) return;
      if (bmlPointerHitActive) {
        if (bmlOverlayEl.className.indexOf('bml-pointer-hit') === -1) {
          bmlOverlayEl.className = (bmlOverlayEl.className ? (bmlOverlayEl.className + ' ') : '') + 'bml-pointer-hit';
        }
      } else {
        bmlOverlayEl.className = bmlOverlayEl.className.replace(/\s*\bbml-pointer-hit\b/g, '').replace(/^\s+|\s+$/g, '');
      }
    }

    function isNodeInsideInputOverlay(node) {
      if (!bmlInputEl || !node) return false;
      var cur = node;
      while (cur) {
        if (cur === bmlInputEl) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    /**
     * 要素および祖先がすべて可視状態 (display !== none かつ visibility !== hidden) か判定する
     */
    function isBmlElementVisible(el) {
      var cur = el;
      var guard = 0;
      while (cur && guard < 24) {
        guard++;
        if (cur.nodeType === 1) {
          var cs;
          try {
            cs = global.getComputedStyle(cur);
          } catch (eCs) {
            return false;
          }
          if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
        }
        if (cur === (bmlBrowser && bmlBrowser.documentElement)) break;
        cur = cur.parentNode;
      }
      return true;
    }

    /**
     * 要素の表示矩形を取得する (BML の 4辺分割カーソル枠のように親が 0x0 の場合は可視子孫の外接矩形を返す)
     * ※ 非表示の子要素 (例: NHK top2.bml #csr5 内の隠れた #csr51) は厳密に除外する
     */
    function getBmlElementRect(el) {
      var r;
      try {
        r = el.getBoundingClientRect();
      } catch (e) {
        return null;
      }
      if (r && r.width > 4 && r.height > 4) {
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }
      var descs = null;
      try {
        descs = (typeof el.querySelectorAll === 'function') ? el.querySelectorAll('*') : el.children;
      } catch (eQ) {
        descs = el.children;
      }
      if (!descs || descs.length === 0) {
        return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
      }
      var minL = 1e9, minT = 1e9, maxR = -1e9, maxB = -1e9;
      var found = false;
      for (var i = 0; i < descs.length; i++) {
        var child = descs[i];
        if (!isBmlElementVisible(child)) continue;
        var cr;
        try {
          cr = child.getBoundingClientRect();
        } catch (eC) {
          continue;
        }
        if (!cr || (cr.width <= 0 && cr.height <= 0)) continue;
        if (cr.left < minL) minL = cr.left;
        if (cr.top < minT) minT = cr.top;
        if (cr.right > maxR) maxR = cr.right;
        if (cr.bottom > maxB) maxB = cr.bottom;
        found = true;
      }
      if (!found) return null;
      return { left: minL, top: minT, right: maxR, bottom: maxB, width: maxR - minL, height: maxB - minT };
    }

    function showBmlTapRipple(clientX, clientY) {
      if (!bmlOverlayEl || !document || !document.createElement) return;
      try {
        var dot = document.createElement('div');
        dot.className = 'bml-tap-ripple';
        dot.style.left = Math.round(clientX) + 'px';
        dot.style.top = Math.round(clientY) + 'px';
        bmlOverlayEl.appendChild(dot);
        setTimeout(function () {
          dot.className = 'bml-tap-ripple expand';
        }, 16);
        setTimeout(function () {
          if (dot.parentNode) dot.parentNode.removeChild(dot);
        }, 280);
      } catch (e) {}
    }

    function collectBmlInteractiveCandidates(forceRefresh) {
      var now = Date.now();
      if (!forceRefresh && bmlInteractiveCache && (now - bmlInteractiveCacheAt) < 400) {
        return bmlInteractiveCache;
      }
      var list = [];
      if (!bmlBrowser || !bmlBrowser.documentElement || !bmlBrowser.content) {
        bmlInteractiveCache = list;
        bmlInteractiveCacheAt = now;
        return list;
      }
      var root = bmlBrowser.documentElement.querySelector('body') || bmlBrowser.documentElement;
      var all = root.querySelectorAll('*');
      var skipTags = { script: 1, style: 1, head: 1, meta: 1, link: 1, 'arib-bg': 1, 'arib-style': 1 };
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var tag = (el.tagName || '').toLowerCase();
        if (skipTags[tag]) continue;
        if (!isBmlElementVisible(el)) continue;
        var cs;
        try {
          cs = global.getComputedStyle(el);
        } catch (eCs) {
          continue;
        }
        var rawNav = String(cs.getPropertyValue('--nav-index') || '').trim();
        var hasNav = (rawNav !== '' && rawNav !== 'auto' && rawNav !== 'none' && !isNaN(parseInt(rawNav, 10)));
        var hasAccess = el.hasAttribute('accesskey');
        var isInteractive = hasNav || hasAccess || tag === 'a' || tag === 'input' || tag === 'textarea' ||
          el.hasAttribute('onclick') || el.hasAttribute('onfocus') || el.hasAttribute('onkeydown');
        if (!isInteractive) continue;
        if (typeof bmlBrowser.content.isFocusable === 'function') {
          try {
            if (!bmlBrowser.content.isFocusable(el)) continue;
          } catch (eFoc) {
            continue;
          }
        }
        list.push({ el: el, hasNav: hasNav, hasAccess: hasAccess });
      }
      bmlInteractiveCache = list;
      bmlInteractiveCacheAt = now;
      return list;
    }

    function hitTestBmlElement(clientX, clientY, forceRefresh) {
      if (!state.bmlActive || state.bmlInvisible || !bmlBrowser || !bmlBrowser.content) return null;
      if (bmlInputApp && bmlInputApp.isLaunching) return null;

      var candidates = collectBmlInteractiveCandidates(!!forceRefresh);
      if (!candidates || candidates.length === 0) return null;

      var stageArea = 0;
      if (bmlStageEl) {
        try {
          var sr = bmlStageEl.getBoundingClientRect();
          stageArea = sr.width * sr.height;
        } catch (eSr) {}
      }

      var best = null;
      var bestArea = 1e18;
      for (var i = 0; i < candidates.length; i++) {
        var item = candidates[i];
        var el = item.el;
        var r = getBmlElementRect(el);
        if (!r || r.width <= 1 || r.height <= 1) continue;
        if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;
        var area = r.width * r.height;
        // nav-index のない画面全面ラッパー要素 (NHK top2.bml の #container 等) はボタン対象から除外
        if (!item.hasNav && !item.hasAccess && stageArea > 0 && area >= stageArea * 0.75) {
          continue;
        }
        if (area <= bestArea) {
          bestArea = area;
          best = item;
        }
      }
      return best;
    }

    /**
     * NHK top2.bml 等、nav-index / onclick を持たず単一 onkeydown スクリプトで描画される BML 画面向けに、
     * 画面内の可視カラーボタン (青/赤/緑/黄)・現在表示中の選択枠 (決定)・スクロール矢印 (上/下) を検出する。
     */
    function hitTestBmlVisualControl(clientX, clientY) {
      if (!state.bmlActive || state.bmlInvisible || !bmlBrowser || !bmlBrowser.documentElement || !vendor || !vendor.AribKeyCode) {
        return null;
      }
      var AK = vendor.AribKeyCode;
      var root = bmlBrowser.documentElement.querySelector('body') || bmlBrowser.documentElement;
      var all = root.querySelectorAll('*');
      var stageArea = 0;
      if (bmlStageEl) {
        try {
          var sr = bmlStageEl.getBoundingClientRect();
          stageArea = sr.width * sr.height;
        } catch (eSr) {}
      }

      var bestColor = null;
      var bestColorArea = 1e18;
      var bestCursor = null;
      var bestCursorArea = 1e18;
      var bestScroll = null;
      var bestScrollArea = 1e18;

      function detectColorKeyFromToken(str) {
        if (!str) return -1;
        var s = String(str).toLowerCase();
        if (s.indexOf('colbtn21') !== -1 || s.indexOf('btn_blue') !== -1 || s.indexOf('bluebtn') !== -1) return AK.BlueButton;
        if (s.indexOf('colbtn22') !== -1 || s.indexOf('btn_red') !== -1 || s.indexOf('redbtn') !== -1) return AK.RedButton;
        if (s.indexOf('colbtn23') !== -1 || s.indexOf('btn_green') !== -1 || s.indexOf('greenbtn') !== -1) return AK.GreenButton;
        if (s.indexOf('colbtn24') !== -1 || s.indexOf('btn_yellow') !== -1 || s.indexOf('yellowbtn') !== -1) return AK.YellowButton;
        return -1;
      }

      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var tag = (el.tagName || '').toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'meta' || tag === 'link') continue;
        if (!isBmlElementVisible(el)) continue;

        var idStr = String(el.id || '').toLowerCase();
        var dataStr = String((el.getAttribute && (el.getAttribute('data') || el.getAttribute('src'))) || '').toLowerCase();

        // 1. 画面内のカラーボタン (例: #colbtn21..24 や #pop_yes / #pop_no 内の colbtn21.png 等)
        var colKey = detectColorKeyFromToken(idStr);
        if (colKey === -1 && dataStr) colKey = detectColorKeyFromToken(dataStr);
        if (colKey !== -1) {
          // アイコン画像単体 (<object data="colbtn21.png">) なら親ボタン枠 (#pop_yes 等) の矩形も判定対象にする
          var targetEl = el;
          if (tag === 'object' || tag === 'img') {
            var p = el.parentNode;
            if (p && p.nodeType === 1 && isBmlElementVisible(p)) {
              var pr = getBmlElementRect(p);
              if (pr && pr.width > 10 && pr.height > 10 && (stageArea <= 0 || pr.width * pr.height < stageArea * 0.25)) {
                targetEl = p;
              }
            }
          }
          var rc = getBmlElementRect(targetEl);
          if (rc && rc.width > 6 && rc.height > 6 &&
              clientX >= rc.left && clientX <= rc.right && clientY >= rc.top && clientY <= rc.bottom) {
            var ac = rc.width * rc.height;
            if ((stageArea <= 0 || ac < stageArea * 0.35) && ac <= bestColorArea) {
              bestColorArea = ac;
              bestColor = { aribKey: colKey, kind: 'color' };
            }
          }
          continue;
        }

        // 2. 現在表示中の選択カーソル枠 (例: #pop_csr1, #csr0 等) -> クリックで決定 (Enter)
        if (/(^|_)csr\d*$|cursor|focus_frame|select_frame/.test(idStr)) {
          var rcsr = getBmlElementRect(el);
          if (rcsr && rcsr.width > 12 && rcsr.height > 12 &&
              clientX >= rcsr.left && clientX <= rcsr.right && clientY >= rcsr.top && clientY <= rcsr.bottom) {
            var acsr = rcsr.width * rcsr.height;
            if ((stageArea <= 0 || acsr < stageArea * 0.6) && acsr <= bestCursorArea) {
              bestCursorArea = acsr;
              bestCursor = { aribKey: AK.Enter, kind: 'cursor' };
            }
          }
          continue;
        }

        // 3. スクロール上下矢印 (例: #soroll_ya0 / ya1.png = 上, #soroll_ya1 / ya2.png = 下)
        if (idStr.indexOf('ya0') !== -1 || dataStr.indexOf('ya1.png') !== -1 || idStr.indexOf('scroll_up') !== -1) {
          var ru = getBmlElementRect(el);
          if (ru && ru.width > 4 && ru.height > 4 &&
              clientX >= ru.left - 10 && clientX <= ru.right + 10 && clientY >= ru.top - 10 && clientY <= ru.bottom + 10) {
            var au = ru.width * ru.height;
            if (au <= bestScrollArea) {
              bestScrollArea = au;
              bestScroll = { aribKey: AK.Up, kind: 'scroll' };
            }
          }
        } else if (idStr.indexOf('ya1') !== -1 || dataStr.indexOf('ya2.png') !== -1 || idStr.indexOf('scroll_down') !== -1) {
          var rd = getBmlElementRect(el);
          if (rd && rd.width > 4 && rd.height > 4 &&
              clientX >= rd.left - 10 && clientX <= rd.right + 10 && clientY >= rd.top - 10 && clientY <= rd.bottom + 10) {
            var ad = rd.width * rd.height;
            if (ad <= bestScrollArea) {
              bestScrollArea = ad;
              bestScroll = { aribKey: AK.Down, kind: 'scroll' };
            }
          }
        }
      }

      if (bestColor) return bestColor;
      if (bestCursor) return bestCursor;
      if (bestScroll) return bestScroll;
      return null;
    }

    function focusBmlElementByPointer(targetEl) {
      if (!state.bmlActive || !bmlBrowser || !bmlBrowser.content || !targetEl) return false;
      if (bmlBrowser.content.keyProcessStatus != null) return false;
      var curNode = (bmlBrowser.bmlDocument && bmlBrowser.bmlDocument.currentFocus)
        ? bmlBrowser.bmlDocument.currentFocus.node
        : null;
      if (curNode === targetEl) return false;
      try {
        if (typeof bmlBrowser.content.focusHelper === 'function') {
          bmlBrowser.content.focusHelper(targetEl);
          if (bmlBrowser.eventQueue && typeof bmlBrowser.eventQueue.processEventQueue === 'function') {
            bmlBrowser.eventQueue.processEventQueue();
          }
          return true;
        }
      } catch (e) {}
      return false;
    }

    function resolveAccessKeyCode(el) {
      if (!el || !vendor || !vendor.AribKeyCode) return -1;
      var ak = String(el.getAttribute('accesskey') || '').trim().toLowerCase();
      if (!ak) return -1;
      var AK = vendor.AribKeyCode;
      if (ak === 'b' || ak === 'blue') return AK.BlueButton;
      if (ak === 'r' || ak === 'red') return AK.RedButton;
      if (ak === 'g' || ak === 'green') return AK.GreenButton;
      if (ak === 'y' || ak === 'yellow') return AK.YellowButton;
      if (ak.length === 1 && ak >= '0' && ak <= '9') return AK.Digit0 + (ak.charCodeAt(0) - 48);
      return -1;
    }

    function sendAribKeyPulse(aribKey, boostMs) {
      if (!state.bmlActive || !bmlBrowser || !bmlBrowser.content) return;
      // KonomiTV 準拠: web-bml は eventQueue 上で順序実行するため Down/Up を即時ペア送信し連打遅延を排除
      try {
        bmlBrowser.content.processKeyDown(aribKey);
        bmlBrowser.content.processKeyUp(aribKey);
      } catch (eDown) {}
      invalidateBmlInteractiveCache();
      if (boostMs) boostBmlPolling(boostMs);
    }

    function handleBmlPointActivate(clientX, clientY) {
      var now = Date.now();
      if (now - lastBmlPointerClickAt < 120) return;
      lastBmlPointerClickAt = now;

      if (state.bmlInvisible) {
        onUserInteract();
        return;
      }

      // 1. 標準 nav-index / onclick / a / input / accesskey 要素への直接クリック・タップ
      var hit = hitTestBmlElement(clientX, clientY, true);
      if (hit && hit.el) {
        showBmlTapRipple(clientX, clientY);
        var akCode = (!hit.hasNav && hit.hasAccess && !hit.el.hasAttribute('onclick') && !hit.el.hasAttribute('href'))
          ? resolveAccessKeyCode(hit.el)
          : -1;
        if (akCode !== -1) {
          sendAribKeyPulse(akCode, 2800);
          return;
        }
        var changedFocus = focusBmlElementByPointer(hit.el);
        if (changedFocus) {
          setTimeout(function () {
            if (state.bmlActive && bmlBrowser && vendor) {
              sendAribKeyPulse(vendor.AribKeyCode.Enter, 2800);
            }
          }, 24);
        } else if (vendor) {
          sendAribKeyPulse(vendor.AribKeyCode.Enter, 2800);
        }
        return;
      }

      // 2. NHK top2.bml 等の単一 onkeydown 画面向け: 可視カラーボタン / 表示中選択枠 / スクロール矢印への直接クリック・タップ
      var visual = hitTestBmlVisualControl(clientX, clientY);
      if (visual && visual.aribKey != null) {
        showBmlTapRipple(clientX, clientY);
        cancelBmlAutoNav();
        sendAribKeyPulse(visual.aribKey, 2800);
        return;
      }

      // 3. L字縮小テレビ映像領域のクリックは誤作動防止のためナビゲーションせず下部ガイドバー表示のみ
      if (isPointInBmlVideoPlane(clientX, clientY)) {
        cancelBmlAutoNav();
        onUserInteract();
        return;
      }

      // 4. NHK top2.bml 等の単一 onkeydown 画面上の任意項目を直接クリック/タップした場合:
      //    現在表示されている選択枠 (青枠等) からクリック座標へ仮想十字キーで高速自動移動し、到達時に決定 (Enter) を発火
      showBmlTapRipple(clientX, clientY);
      if (startAutoNavigateToPoint(clientX, clientY)) {
        return;
      }

      // 5. 上記以外の余白クリック時は下部操作バーを表示
      onUserInteract();
    }

    function isPointInBmlVideoPlane(clientX, clientY) {
      if (!state.bmlVideoRect || !bmlStageEl) return false;
      var sr;
      try {
        sr = bmlStageEl.getBoundingClientRect();
      } catch (e) {
        return false;
      }
      if (!sr || sr.width <= 0 || sr.height <= 0) return false;
      var rw = Math.max(1, state.bmlResWidth || 960);
      var rh = Math.max(1, state.bmlResHeight || 540);
      var r = state.bmlVideoRect;
      var vLeft = sr.left + (r.left / rw) * sr.width;
      var vTop = sr.top + (r.top / rh) * sr.height;
      var vRight = sr.left + (r.right / rw) * sr.width;
      var vBottom = sr.top + (r.bottom / rh) * sr.height;
      return clientX >= vLeft && clientX <= vRight && clientY >= vTop && clientY <= vBottom;
    }

    /**
     * 現在画面上で表示されている BML 選択カーソル枠 (例: #pop_csr1, #csr0, #dTabFocus, #headsel, #cursor 等) の
     * 画面座標矩形を取得する。複数重なる場合は DOM 後方 (ポップアップ等最前面) を優先する。
     */
    function findActiveVisualFocusRect() {
      if (!state.bmlActive || state.bmlInvisible || !bmlBrowser || !bmlBrowser.documentElement) return null;
      var stageArea = 0;
      if (bmlStageEl) {
        try {
          var sr = bmlStageEl.getBoundingClientRect();
          stageArea = sr.width * sr.height;
        } catch (eSr) {}
      }

      // 1. まず可視の自前フォーカス枠要素を探索 (DOM後方を優先してポップアップ等の最前面枠を取得)
      var root = bmlBrowser.documentElement.querySelector('body') || bmlBrowser.documentElement;
      var all = root.querySelectorAll('*');
      var bestRect = null;
      var focusIdRe = /(?:^|_)csr\d*$|cursor|focus|headsel|logosel|selectbtn|arrowsel|waku/i;
      var ignoreIdRe = /focusable|csr_sqr|base\d*$/i;

      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var idStr = String(el.id || '');
        if (!idStr || !focusIdRe.test(idStr) || ignoreIdRe.test(idStr)) continue;
        if (!isBmlElementVisible(el)) continue;
        var r = getBmlElementRect(el);
        if (!r || r.width < 22 || r.height < 14) continue;
        var area = r.width * r.height;
        if (stageArea > 0 && area >= stageArea * 0.55) continue;
        bestRect = r;
      }
      if (bestRect) return bestRect;

      // 2. フォールバック: 標準 BML フォーカス要素が個別ボタンサイズならその矩形を使用
      var curNode = (bmlBrowser.bmlDocument && bmlBrowser.bmlDocument.currentFocus)
        ? bmlBrowser.bmlDocument.currentFocus.node
        : null;
      if (curNode && isBmlElementVisible(curNode)) {
        var nr = getBmlElementRect(curNode);
        if (nr && nr.width >= 20 && nr.height >= 14 && (stageArea <= 0 || nr.width * nr.height < stageArea * 0.55)) {
          return nr;
        }
      }
      return null;
    }

    function rectContainsPoint(r, x, y, pad) {
      var p = pad || 0;
      return x >= (r.left - p) && x <= (r.right + p) && y >= (r.top - p) && y <= (r.bottom + p);
    }

    function rectDistanceToPoint(r, x, y) {
      var dx = 0;
      if (x < r.left) dx = r.left - x;
      else if (x > r.right) dx = x - r.right;
      var dy = 0;
      if (y < r.top) dy = r.top - y;
      else if (y > r.bottom) dy = y - r.bottom;
      return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * BML イベントキュー (es2 スクリプト実行) が完全に完了するのを待機する
     */
    function waitBmlQueueIdle(mySeq, callback, retries) {
      var left = (retries === undefined) ? 16 : retries;
      function check() {
        if (mySeq !== bmlAutoNavSeq || !state.bmlActive || !bmlBrowser) {
          return;
        }
        var eq = bmlBrowser.eventQueue;
        var busy = !!(bmlBrowser.content && bmlBrowser.content.keyProcessStatus != null);
        if (!busy && eq) {
          if ((eq.asyncEventQueue && eq.asyncEventQueue.length > 0) ||
              (eq.syncEventQueue && eq.syncEventQueue.length > 0) ||
              (eq.syncEventQueueLockCount && eq.syncEventQueueLockCount > 0)) {
            busy = true;
          }
        }
        if (!busy || left <= 0) {
          callback();
          return;
        }
        left--;
        bmlAutoNavTimer = setTimeout(check, 12);
      }
      bmlAutoNavTimer = setTimeout(check, 14);
    }

    /**
     * 画面上の任意座標 (tx, ty) へ、現在表示中の選択枠から仮想十字キーで高速自動到達し、
     * 目標座標を包含した時点で決定 (Enter) を 1回だけ発火する。
     * - eventQueue 完了同期で取りこぼしゼロ & 最速応答
     * - 各位置ごとの 4方向優先順位付き探索でエリア境界 (ニュース枠 <-> 右メニュー等) も自然に跨げる
     * - 移動ステップ中の BML 操作音はミュートし、到着後の決定音のみ鳴らす
     */
    function startAutoNavigateToPoint(tx, ty) {
      if (!vendor || !vendor.AribKeyCode || !bmlBrowser || !bmlBrowser.content) return false;
      var initRect = findActiveVisualFocusRect();
      if (!initRect) return false;

      cancelBmlAutoNav();
      var mySeq = bmlAutoNavSeq;
      var AK = vendor.AribKeyCode;

      if (rectContainsPoint(initRect, tx, ty, 6)) {
        sendAribKeyPulse(AK.Enter, 2800);
        return true;
      }

      var maxSteps = 20;
      var stepCount = 0;
      var visited = {};
      var triedAt = {}; // rectKey -> { dirKey: true }
      var minDistSeen = rectDistanceToPoint(initRect, tx, ty);
      var nonImprovingMoves = 0;
      var startDoc = (bmlBrowser.resources && bmlBrowser.resources.activeDocument) || '';

      function rectKey(r) {
        return Math.round(r.left / 4) + '_' + Math.round(r.top / 4) + '_' + Math.round(r.width / 4) + '_' + Math.round(r.height / 4);
      }

      function buildOrderedDirs(r) {
        var cx = (r.left + r.right) / 2;
        var cy = (r.top + r.bottom) / 2;
        var dx = tx - cx;
        var dy = ty - cy;
        var hPrimary = dx >= 0 ? AK.Right : AK.Left;
        var hOpp = dx >= 0 ? AK.Left : AK.Right;
        var vPrimary = dy >= 0 ? AK.Down : AK.Up;
        var vOpp = dy >= 0 ? AK.Up : AK.Down;
        var inX = (tx >= r.left - 6 && tx <= r.right + 6);
        var inY = (ty >= r.top - 6 && ty <= r.bottom + 6);

        if (inX && !inY) return [vPrimary, hPrimary, hOpp, vOpp];
        if (inY && !inX) return [hPrimary, vPrimary, vOpp, hOpp];
        if (Math.abs(dx) > Math.abs(dy)) return [hPrimary, vPrimary, hOpp, vOpp];
        return [vPrimary, hPrimary, vOpp, hOpp];
      }

      function finish(triggerEnter) {
        if (mySeq !== bmlAutoNavSeq) return;
        bmlAutoNavTimer = null;
        setBmlAudioMuted(false);
        if (triggerEnter && state.bmlActive && bmlBrowser && bmlBrowser.content) {
          bmlAutoNavTimer = setTimeout(function () {
            if (mySeq !== bmlAutoNavSeq || !state.bmlActive) return;
            bmlAutoNavTimer = null;
            sendAribKeyPulse(AK.Enter, 2800);
          }, 18);
        }
      }

      setBmlAudioMuted(true);

      function runStep() {
        if (mySeq !== bmlAutoNavSeq || !state.bmlActive || state.bmlInvisible || !bmlBrowser || !bmlBrowser.content) {
          finish(false);
          return;
        }
        // 自動誘導中に BML 文書自体が遷移した場合は誤爆防止のため即停止
        var curDoc = (bmlBrowser.resources && bmlBrowser.resources.activeDocument) || '';
        if (startDoc && curDoc && curDoc !== startDoc) {
          finish(false);
          return;
        }

        var curRect = findActiveVisualFocusRect();
        if (!curRect) {
          finish(false);
          return;
        }
        if (rectContainsPoint(curRect, tx, ty, 6)) {
          finish(true);
          return;
        }
        if (stepCount >= maxSteps) {
          finish(false);
          return;
        }

        var prevKey = rectKey(curRect);
        visited[prevKey] = true;
        if (!triedAt[prevKey]) triedAt[prevKey] = {};

        var dirs = buildOrderedDirs(curRect);
        var dirKey = -1;
        for (var di = 0; di < dirs.length; di++) {
          if (!triedAt[prevKey][dirs[di]]) {
            dirKey = dirs[di];
            break;
          }
        }
        if (dirKey === -1) {
          finish(false);
          return;
        }
        triedAt[prevKey][dirKey] = true;
        stepCount++;

        try {
          bmlBrowser.content.processKeyDown(dirKey);
          bmlBrowser.content.processKeyUp(dirKey);
        } catch (eD) {
          finish(false);
          return;
        }

        waitBmlQueueIdle(mySeq, function () {
          if (mySeq !== bmlAutoNavSeq || !state.bmlActive || state.bmlInvisible) {
            finish(false);
            return;
          }
          var nextRect = findActiveVisualFocusRect();
          if (!nextRect) {
            finish(false);
            return;
          }
          if (rectContainsPoint(nextRect, tx, ty, 6)) {
            finish(true);
            return;
          }
          var nextKey = rectKey(nextRect);
          if (nextKey === prevKey) {
            // その方向には移動できなかった -> 同じ位置から次の優先方向を即試行
            runStep();
            return;
          }
          var nextDist = rectDistanceToPoint(nextRect, tx, ty);
          if (nextDist < minDistSeen - 4) {
            minDistSeen = nextDist;
            nonImprovingMoves = 0;
          } else {
            // エリア跨ぎ (左下ニュース -> 右メニュー等) の迂回を 3手まで許容
            nonImprovingMoves++;
            if (nonImprovingMoves > 3) {
              finish(false);
              return;
            }
          }
          runStep();
        }, 16);
      }

      runStep();
      return true;
    }

    function bindBmlPointerEvents() {
      if (!bmlOverlayEl) return;

      // ホバー時はポインタ形状のみ切り替え (勝手に BML のフォーカスや操作音を鳴らさない)
      bmlOverlayEl.addEventListener('mousemove', function (ev) {
        if (!state.bmlActive || state.bmlInvisible) return;
        if (isNodeInsideInputOverlay(ev.target)) {
          setBmlPointerCursor(false);
          return;
        }
        var now = Date.now();
        if (now - lastBmlHoverCheckAt < 75) return;
        lastBmlHoverCheckAt = now;

        var hit = hitTestBmlElement(ev.clientX, ev.clientY, false);
        if (!hit) {
          hit = hitTestBmlVisualControl(ev.clientX, ev.clientY);
        }
        if (!hit && !isPointInBmlVideoPlane(ev.clientX, ev.clientY) && findActiveVisualFocusRect()) {
          hit = true;
        }
        setBmlPointerCursor(!!hit);
      }, false);

      bmlOverlayEl.addEventListener('click', function (ev) {
        if (!state.bmlActive) return;
        if (isNodeInsideInputOverlay(ev.target)) return;
        ev.stopPropagation();
        handleBmlPointActivate(ev.clientX, ev.clientY);
      }, false);

      var touchStartPos = null;
      bmlOverlayEl.addEventListener('touchstart', function (ev) {
        if (!state.bmlActive || isNodeInsideInputOverlay(ev.target)) {
          touchStartPos = null;
          return;
        }
        if (ev.touches && ev.touches.length === 1) {
          touchStartPos = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
        } else {
          touchStartPos = null;
        }
      }, false);

      bmlOverlayEl.addEventListener('touchend', function (ev) {
        if (!state.bmlActive) return;
        if (isNodeInsideInputOverlay(ev.target)) return;
        if (!ev.changedTouches || ev.changedTouches.length === 0) return;
        var t = ev.changedTouches[0];
        if (touchStartPos) {
          var moveDx = Math.abs(t.clientX - touchStartPos.x);
          var moveDy = Math.abs(t.clientY - touchStartPos.y);
          touchStartPos = null;
          if (moveDx > 18 || moveDy > 18) return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        handleBmlPointActivate(t.clientX, t.clientY);
      }, false);

      bmlOverlayEl.addEventListener('contextmenu', function (ev) {
        if (!state.bmlActive) return;
        if (isNodeInsideInputOverlay(ev.target)) return;
        ev.preventDefault();
        ev.stopPropagation();
        handleKeyDown(461, 'Escape');
      }, false);
    }

    bindBmlPointerEvents();

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

    function getBmlAudioDestination() {
      var ctx = ensureAudioContext();
      if (!ctx) return null;
      try {
        if (!bmlAudioGainNode && typeof ctx.createGain === 'function') {
          bmlAudioGainNode = ctx.createGain();
          bmlAudioGainNode.gain.value = 1.0;
          bmlAudioGainNode.connect(ctx.destination);
        }
        return bmlAudioGainNode || ctx.destination;
      } catch (e) {
        return ctx.destination;
      }
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
      state.bmlPrefetchStartedAt = 0;
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
     * BMLBrowser 側 (lockModuleOnMemory / fetchResourceAsync 等) に未解決のモジュール受信待ちがあるか判定する
     */
    function hasPendingBmlModuleRequests() {
      if (!state.bmlActive || !bmlBrowser || !bmlBrowser.resources || !bmlBrowser.resources.componentRequests) {
        return false;
      }
      var hasPending = false;
      try {
        bmlBrowser.resources.componentRequests.forEach(function (creq) {
          if (hasPending || !creq || !creq.moduleRequests) return;
          creq.moduleRequests.forEach(function (mreqs) {
            if (mreqs && mreqs.length > 0) hasPending = true;
          });
        });
      } catch (e) {}
      return hasPending;
    }

    /**
     * DII (moduleListUpdated) に記載されたモジュールが一通りメモリキャッシュ済みか判定する。
     * PMT に複数コンポーネント (0x40/0x50/0x60 等) がある局で 0x40 だけ先に揃った瞬間に
     * 早々に休止しないよう、受信待ちリクエスト有無・他コンポーネントの到着猶予も確認する。
     */
    function isAllListedModulesCached() {
      if (hasPendingBmlModuleRequests()) return false;
      var listCount = 0;
      for (var cid in state.cachedModuleLists) {
        if (!Object.prototype.hasOwnProperty.call(state.cachedModuleLists, cid)) continue;
        var ml = state.cachedModuleLists[cid];
        var mods = (ml && ml.modules) || [];
        if (mods.length === 0) continue;
        listCount++;
        for (var i = 0; i < mods.length; i++) {
          var mid = (mods[i].id !== undefined && mods[i].id !== null) ? mods[i].id : mods[i].moduleId;
          var cached = state.cachedModules[cid + '_' + mid];
          if (!cached) {
            return false;
          }
          if (mods[i].version !== undefined && cached.version !== undefined && cached.version !== mods[i].version) {
            return false;
          }
        }
      }
      if (listCount === 0) return false;
      // PMT 上に複数の 0x0D コンポーネントがあり、先読み開始から間もない場合は 0x50/0x60 等の DII 到着を待つ
      if (state.cachedPmt && state.cachedPmt.components) {
        var dsmCompCount = 0;
        var comps = state.cachedPmt.components;
        for (var ci = 0; ci < comps.length; ci++) {
          if (comps[ci].streamType === 0x0D) dsmCompCount++;
        }
        if (dsmCompCount > listCount && state.bmlPrefetchStartedAt > 0 && (Date.now() - state.bmlPrefetchStartedAt) < 7000) {
          return false;
        }
      }
      return true;
    }

    /**
     * BML 起動・ページ遷移・キー操作直後の数秒間だけカルーセル受信を最速バースト化する
     * ※ XHR 通信中や pumpBmlBytes デコード中に既存タイマーを破棄するとポーリングループが
     *    永久停止するため、稼働中はタイマーを消さず未予約時のみ再スケジュールする。
     */
    function boostBmlPolling(durationMs) {
      var until = Date.now() + (durationMs || 2800);
      if (until > state.bmlBurstUntilMs) {
        state.bmlBurstUntilMs = until;
      }
      if (!state.activeStream) return;
      if (!state.bmlActive && (!state.bmlPrefetchEnabled || state.bmlHasDataComponent === false)) return;
      if (!state.bmlXhr && !state.bmlDecodingBusy) {
        if (state.bmlPollTimer) {
          clearTimeout(state.bmlPollTimer);
          state.bmlPollTimer = null;
        }
        state.bmlPollTimer = setTimeout(pollBmlCarouselOnce, 10);
      } else if (!state.bmlPollTimer && !state.bmlXhr) {
        state.bmlPollTimer = setTimeout(pollBmlCarouselOnce, 45);
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
      } else if (state.bmlInvisible || state.bmlReceiving || state.bmlWaitingBootstrap) {
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
        var prevHasBml = state.bmlHasDataComponent;
        var hasBml = false;
        var comps = msg.components || [];
        for (var i = 0; i < comps.length; i++) {
          if (comps[i].streamType === 0x0D || comps[i].bxmlInfo) {
            hasBml = true;
            break;
          }
        }
        state.bmlHasDataComponent = hasBml;
        // 事前読み込みバッファが ON の場合のみ、選局直後からバックグラウンドで DSM-CC カルーセルを先読みする
        if (hasBml && state.bmlPrefetchEnabled && state.activeStream && !state.bmlActive && !state.bmlPrefetchStarted) {
          state.bmlPrefetchStarted = true;
          state.bmlPrefetchStartedAt = Date.now();
          scheduleNextBmlPoll(1100);
        }
        if (prevHasBml !== hasBml) {
          onStateChange(getPublicStatus());
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
        var prefix = msg.componentId + '_';
        if (prevList && prevList.dataEventId !== msg.dataEventId) {
          // dataEventId 更新時は該当コンポーネントの古いモジュールキャッシュを破棄
          for (var k in state.cachedModules) {
            if (Object.prototype.hasOwnProperty.call(state.cachedModules, k) && k.indexOf(prefix) === 0) {
              delete state.cachedModules[k];
            }
          }
        } else if (prevList && prevList.dataEventId === msg.dataEventId && prevList.modules && msg.modules) {
          // モジュール数だけでなく各モジュールの id と version まで完全一致する場合のみ重複スキップする
          var sameAll = (prevList.modules.length === msg.modules.length);
          if (sameAll) {
            for (var mi = 0; mi < msg.modules.length; mi++) {
              var pm = prevList.modules[mi];
              var nm = msg.modules[mi];
              var pid = (pm && pm.id !== undefined) ? pm.id : (pm && pm.moduleId);
              var nid = (nm && nm.id !== undefined) ? nm.id : (nm && nm.moduleId);
              if (pid !== nid || pm.version !== nm.version) {
                sameAll = false;
                break;
              }
            }
          }
          if (sameAll) {
            return false;
          }
          // バージョンが変わった／消滅したモジュールの古いキャッシュを掃除して不整合を防ぐ
          var newVerMap = {};
          for (var ni = 0; ni < msg.modules.length; ni++) {
            var nMod = msg.modules[ni];
            var nId = (nMod && nMod.id !== undefined) ? nMod.id : (nMod && nMod.moduleId);
            if (nId !== undefined) newVerMap[String(nId)] = nMod.version;
          }
          for (var ck in state.cachedModules) {
            if (!Object.prototype.hasOwnProperty.call(state.cachedModules, ck) || ck.indexOf(prefix) !== 0) continue;
            var cmId = ck.substring(prefix.length);
            var cmObj = state.cachedModules[ck];
            if (!Object.prototype.hasOwnProperty.call(newVerMap, cmId) || (newVerMap[cmId] !== undefined && cmObj.version !== newVerMap[cmId])) {
              delete state.cachedModules[ck];
            }
          }
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
          // 初回 PCR 確定前に先行到着した録画字幕キューの 33bit ラップアラウンドを補正
          if (!state.isLiveStream && state.captionQueue.length > 0) {
            var PCR_WRAP_MS = 95443717.688889;
            for (var qi = 0; qi < state.captionQueue.length; qi++) {
              if (state.captionQueue[qi].ptsMs < state.firstPcrMs - (PCR_WRAP_MS / 2)) {
                state.captionQueue[qi].ptsMs += PCR_WRAP_MS;
              }
            }
            state.captionQueue.sort(function (a, b) { return a.ptsMs - b.ptsMs; });
          }
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
          var bufStart = null;
          try {
            if (videoEl.buffered && videoEl.buffered.length > 0) {
              bufStart = Number(videoEl.buffered.start(0));
            }
          } catch (eBuf) {}
          if (bufStart != null && isFinite(bufStart) && bufStart >= 0 && bufStart <= vTime) {
            state.firstVideoTimeSec = bufStart;
          } else {
            state.firstVideoTimeSec = (vTime < 5) ? 0 : vTime;
          }
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

    function pumpTsBytes(tsBytes, expectSess, onDone) {
      var sliceSize = 188 * 100; // 約18.8KB単位で分割投入して UI 操作レスポンスを守る
      if (!tsBytes || !tsBytes.length) {
        if (onDone) onDone();
        return;
      }
      if (tsBytes.length <= sliceSize) {
        if (state.activeStream && tsDecoder && state.sessionId === expectSess) {
          try { tsDecoder.push(tsBytes); } catch (e) {}
        }
        if (onDone) onDone();
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
          if (onDone) onDone();
        }
      }
      stepPump();
    }

    function pumpBmlBytes(tsBytes, expectSess) {
      // Python 側で DSM-CC 重複排除済みのため、BML スクリプト実行(es2)を妨げない安全サイズで小分け投入する
      var fastMode = state.bmlActive && (state.bmlInvisible || state.bmlWaitingBootstrap || state.bmlReceiving || hasPendingBmlModuleRequests() || Date.now() < state.bmlBurstUntilMs);
      var sliceSize = fastMode ? (188 * 200) : (188 * 120);
      var stepDelay = fastMode ? 8 : 14;
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
        var curFast = state.bmlActive && (state.bmlInvisible || state.bmlWaitingBootstrap || state.bmlReceiving || hasPendingBmlModuleRequests() || Date.now() < state.bmlBurstUntilMs);
        var curSlice = curFast ? (188 * 200) : (188 * 120);
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
          // デコード完了時点でアクティブまたは先読み未完なのに次ポーリングが未予約なら確実に復帰させる
          if (state.activeStream && state.sessionId === expectSess && !state.bmlXhr && !state.bmlPollTimer) {
            if (state.bmlActive || (state.bmlPrefetchEnabled && !isAllListedModulesCached())) {
              scheduleNextBmlPoll(state.bmlActive ? 25 : 140);
            }
          }
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
              var hasMoreBase = tsBytes.length >= 188 * 700;
              pumpTsBytes(tsBytes, state.sessionId, hasMoreBase ? function () {
                if (state.activeStream && !state.pollingXhr && !state.decodingBusy) {
                  setTimeout(pollSidebandOnce, 25);
                }
              } : null);
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
      if (!state.bmlActive && (!state.bmlPrefetchEnabled || state.bmlHasDataComponent === false)) return;
      state.bmlPollTimer = setTimeout(pollBmlCarouselOnce, delayMs);
    }

    function pollBmlCarouselOnce() {
      state.bmlPollTimer = null;
      if (!state.activeStream) return;
      if (!state.bmlActive && (!state.bmlPrefetchEnabled || state.bmlHasDataComponent === false)) return;
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
                hasMore = bmlBytes.length >= 188 * 2200;
                pumpBmlBytes(bmlBytes, state.sessionId);
              }
            }
          }
        }
        var allCached = isAllListedModulesCached();
        var pendingReqs = hasPendingBmlModuleRequests();
        var nextDelay;
        if (state.bmlActive) {
          var inBurst = state.bmlInvisible || state.bmlWaitingBootstrap || state.bmlReceiving || pendingReqs || (Date.now() < state.bmlBurstUntilMs);
          if (inBurst) {
            // 未展開・BS起動待機・モジュールロック待機中・ページ遷移直後は最速でカルーセルを取り込む
            nextDelay = hasMore ? 30 : 120;
          } else if (allCached) {
            // 表示完了＆全モジュール取得済み: 大容量局でもリングバッファ溢れを起こさないよう残データがあれば追い読み
            nextDelay = hasMore ? 120 : 1200;
          } else {
            nextDelay = hasMore ? 70 : 220;
          }
        } else {
          // バックグラウンド先読み中: 全モジュール揃ったら完全休止 (CPU 0%)、未完なら低負荷で続きを取得
          if (allCached) {
            return;
          }
          nextDelay = hasMore ? 110 : 220;
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

    function clearBmlBootstrapTimer() {
      if (bmlBootstrapTimer) {
        clearTimeout(bmlBootstrapTimer);
        bmlBootstrapTimer = null;
      }
      state.bmlWaitingBootstrap = false;
    }

    function clearBmlAutoCloseTimers() {
      if (bmlAutoCloseTimer) {
        clearTimeout(bmlAutoCloseTimer);
        bmlAutoCloseTimer = null;
      }
      if (bmlVideoRestoreTimer) {
        clearTimeout(bmlVideoRestoreTimer);
        bmlVideoRestoreTimer = null;
      }
      bmlInvisibleSinceMs = 0;
    }

    function destroyBmlInstance() {
      clearDataBtnTimers();
      clearBmlBootstrapTimer();
      clearBmlAutoCloseTimers();
      cancelBmlAutoNav();
      invalidateBmlInteractiveCache();
      setBmlPointerCursor(false);
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
      state.bmlProfile = '';
      state.bmlWaitingBootstrap = false;
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
      ensureAudioContext();

      if (bmlOverlayEl) bmlOverlayEl.className = '';
      updateBmlStatusIndicator();

      if (vendor.OverlayInputApplication && bmlInputEl) {
        bmlInputApp = new vendor.OverlayInputApplication(bmlInputEl);
      }

      var hasBecomeVisible = false;
      var bootstrapSentDoc = '';
      var bootstrapSentCount = 0;
      var bootstrapSentAtMs = 0;
      var bootstrapStartedAtMs = 0;

      function getActiveBmlDocPath() {
        try {
          if (bmlBrowser && bmlBrowser.resources && bmlBrowser.resources.activeDocument) {
            return String(bmlBrowser.resources.activeDocument);
          }
        } catch (e) {}
        return '';
      }

      function isStartupDocPath(docPath) {
        if (!docPath) return false;
        var low = String(docPath).toLowerCase();
        if (low.indexOf('startup.bml') !== -1) return true;
        if (/\/[0-9a-f]{2}\/0000\/?$/.test(low)) return true;
        return false;
      }

      function isElHiddenInBmlTree(el, stopNode) {
        var cur = el;
        while (cur && cur !== stopNode) {
          try {
            var st = cur.style;
            if (st) {
              if (st.visibility === 'hidden' || st.display === 'none') return true;
            }
            if (typeof global.getComputedStyle === 'function') {
              var cs = global.getComputedStyle(cur);
              if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) return true;
            }
          } catch (e) {}
          cur = cur.parentNode;
        }
        return false;
      }

      /**
       * BS (BML 1.0) の startup.bml / debug.bml 等の「invisible 属性なしで全画面映像のみ表示する透明文書」かどうかを DOM から判定する。
       * ファイル名や beitem の有無に依存せず、実 UI（可視テキスト・静止画・入力要素）が 1 つも無ければ true。
       */
      function isTransparentNoUiDoc() {
        if (!bmlBrowser) return false;
        var docEl = (bmlBrowser.content && bmlBrowser.content.documentElement) ? bmlBrowser.content.documentElement : null;
        if (!docEl || typeof docEl.querySelectorAll !== 'function') {
          var docPath = getActiveBmlDocPath();
          return (state.bmlProfile === 'BS' || state.bmlProfile === 'CS') && isStartupDocPath(docPath);
        }
        try {
          var bodyEl = docEl.querySelector('body') || docEl;
          var nodes = bodyEl.querySelectorAll('p, span, img, object, a, input');
          for (var i = 0; i < nodes.length; i++) {
            var nd = nodes[i];
            if (isElHiddenInBmlTree(nd, bodyEl)) continue;
            var tag = String(nd.nodeName || '').toLowerCase();
            if (tag === 'object') {
              var typ = String(nd.getAttribute('type') || '').toLowerCase();
              if (typ.indexOf('video/') === 0 || typ.indexOf('audio/') === 0) continue;
              var dat = String(nd.getAttribute('data') || '').replace(/^\s+|\s+$/g, '');
              if (dat) return false; // 可視の画像等がある＝実UI
            } else if (tag === 'img') {
              var src = String(nd.getAttribute('src') || '').replace(/^\s+|\s+$/g, '');
              if (src) return false;
            } else if (tag === 'input' || tag === 'a') {
              return false;
            } else {
              var txt = String(nd.textContent || '').replace(/[\s\u3000]+/g, '');
              if (txt.length > 0) return false; // 可視テキストがある＝実UI
            }
          }
          return true;
        } catch (e) {
          return false;
        }
      }

      /**
       * 現在文書の beitem[type="DataButtonPressed"] 購読状態を確認する
       * 戻り値: 'subscribed' / 'unsubscribed' / 'none' / 'unknown'
       */
      function getDataButtonBeitemState() {
        var docEl = (bmlBrowser && bmlBrowser.content && bmlBrowser.content.documentElement)
          ? bmlBrowser.content.documentElement
          : null;
        if (!docEl || typeof docEl.querySelectorAll !== 'function') return 'unknown';
        try {
          var items = docEl.querySelectorAll('beitem[type="DataButtonPressed"]');
          if (!items || items.length === 0) return 'none';
          for (var i = 0; i < items.length; i++) {
            if (items[i].getAttribute('subscribe') === 'subscribe') return 'subscribed';
          }
          return 'unsubscribed';
        } catch (e) {
          return 'unknown';
        }
      }

      function isCurrentlyWaitingHidden() {
        return !!(state.bmlInvisible || isTransparentNoUiDoc());
      }

      function isExitWaitScreen() {
        if (state.bmlInvisible) return true;
        if (!isTransparentNoUiDoc()) return false;
        var be = getDataButtonBeitemState();
        return (be === 'subscribed' || be === 'unsubscribed' || be === 'unknown');
      }

      /**
       * 一度表示された後に invisible=true または BS 透明待機画面へ遷移した場合の自動クローズを遅延判定する。
       * NHK総合・NHK BS の「NHKトップ」(/60/0000/top.bml, /40/0000/top.bml) 等のように、
       * 次文書へ即時ジャンプする中継文書が一瞬だけ invisible="invisible" を発火するケースで誤終了させないための猶予タイマー。
       */
      function scheduleBmlAutoClose(delayMs) {
        if (bmlAutoCloseTimer) {
          clearTimeout(bmlAutoCloseTimer);
          bmlAutoCloseTimer = null;
        }
        if (!state.bmlActive || !hasBecomeVisible || !isExitWaitScreen()) return;
        if ((Date.now() - userOpenedAtMs) <= 900) return;
        var waitMs = (typeof delayMs === 'number' && delayMs >= 0) ? delayMs : 1600;
        bmlAutoCloseTimer = setTimeout(function () {
          bmlAutoCloseTimer = null;
          if (!state.bmlActive || !hasBecomeVisible || !isExitWaitScreen()) return;
          var elapsed = bmlInvisibleSinceMs ? (Date.now() - bmlInvisibleSinceMs) : 0;
          // 次文書をカルーセル受信中・IP通信中の間は最大 6 秒まで待機を延長する
          if ((state.bmlReceiving || state.bmlNetworking) && elapsed < 6000) {
            scheduleBmlAutoClose(900);
            return;
          }
          closeBml(true);
        }, waitMs);
      }

      var indicator = {
        setUrl: function (_url, loading) {
          if (loading) {
            state.bmlReceiving = true;
            boostBmlPolling(2800);
            // 中継ジャンプ文書からの次文書ロード中は自動クローズ猶予を延長する
            if (bmlAutoCloseTimer && isCurrentlyWaitingHidden()) {
              scheduleBmlAutoClose(1800);
            }
          } else {
            // lockModuleOnMemory 等で裏のモジュール到着待ちがある間は receiving を強制解除しない
            state.bmlReceiving = hasPendingBmlModuleRequests();
            // 文書ロード・初期スクリプト・onload 完了後も非表示/透明待機画面のままなら終了画面として素早く閉じる
            if (state.bmlActive && hasBecomeVisible && isCurrentlyWaitingHidden() && (Date.now() - userOpenedAtMs) > 900) {
              if (!bmlInvisibleSinceMs) bmlInvisibleSinceMs = Date.now();
              scheduleBmlAutoClose(450);
            }
          }
          updateBmlStatusIndicator();
        },
        setReceivingStatus: function (receiving) {
          state.bmlReceiving = !!receiving;
          if (state.bmlReceiving) {
            boostBmlPolling(2800);
            if (bmlAutoCloseTimer && isCurrentlyWaitingHidden()) {
              scheduleBmlAutoClose(1800);
            }
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

      // KonomiTV 準拠: Greg (64スロット BML グローバルレジスタ) を sessionStorage に永続化し、
      // データ放送の開閉やチャンネル跨ぎでも既読ポップアップ状態・連動データを保持する
      var BML_GREG_KEY = 'dtvplus_bml_greg_v1';
      function loadBmlGreg() {
        var arr = null;
        try {
          var raw = global.sessionStorage && global.sessionStorage.getItem(BML_GREG_KEY);
          if (raw) arr = JSON.parse(raw);
        } catch (e) {}
        if (!Array.isArray(arr) || arr.length < 64) {
          arr = [];
          for (var gi = 0; gi < 64; gi++) arr.push('');
        }
        return arr;
      }
      var gregBridge = {
        getReg: function (index) {
          var arr = loadBmlGreg();
          return (arr[index] !== undefined && arr[index] !== null) ? String(arr[index]) : '';
        },
        setReg: function (index, value) {
          var arr = loadBmlGreg();
          if (index >= 0 && index < 64) {
            arr[index] = (value !== undefined && value !== null) ? String(value) : '';
            try {
              if (global.sessionStorage) global.sessionStorage.setItem(BML_GREG_KEY, JSON.stringify(arr));
            } catch (e) {}
          }
        }
      };

      bmlBrowser = new vendor.BMLBrowser({
        containerElement: bmlContentEl,
        mediaElement: dummyMediaEl,
        indicator: indicator,
        fonts: fontsOpt,
        audioNodeProvider: {
          getAudioDestinationNode: function () {
            return getBmlAudioDestination();
          }
        },
        storagePrefix: 'dtvplus_bml_',
        greg: gregBridge,
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

      function sendDataButtonOnce() {
        if (!state.bmlActive || !bmlBrowser || hasBecomeVisible) return false;
        if (!isCurrentlyWaitingHidden()) return false;
        var beState = getDataButtonBeitemState();
        // beitem が存在するのにまだ subscribe されていない場合 (NHK BS の初回初期化待ち等) は空撃ちしない
        if (beState === 'unsubscribed') return false;
        // BS の透明リダイレクト文書 (BS-TBS 40/0/startup.bml 等、beitem なし) には空撃ちせず次文書への遷移を待つ
        if (!state.bmlInvisible && beState === 'none') return false;
        try {
          bmlBrowser.content.processKeyDown(vendor.AribKeyCode.DataButton);
          bmlBrowser.content.processKeyUp(vendor.AribKeyCode.DataButton);
          return true;
        } catch (e) {}
        return false;
      }

      /**
       * BS (BML 1.0) 等の多段透明リダイレクト (BS-TBS 40/0->60/5000->60/0 等) や遅延購読 (NHK BS 等) に対応した起動監視ループ。
       * DataButtonPressed が購読可能になった瞬間に文書ごとに 1 回 (未遷移時のみ 2.2秒後に予備 1 回) 送信する。
       */
      function startBmlBootstrapWatch() {
        clearBmlBootstrapTimer();
        if (!state.bmlActive || hasBecomeVisible) return;
        state.bmlWaitingBootstrap = true;
        bootstrapStartedAtMs = Date.now();
        updateBmlStatusIndicator();

        function tickBootstrap() {
          bmlBootstrapTimer = null;
          if (!state.bmlActive || !bmlBrowser || hasBecomeVisible) {
            clearBmlBootstrapTimer();
            updateBmlStatusIndicator();
            return;
          }
          // 既に透明待機画面を抜けて実 UI が描画された場合
          if (!isCurrentlyWaitingHidden()) {
            hasBecomeVisible = true;
            clearBmlBootstrapTimer();
            clearDataBtnTimers();
            clearBmlAutoCloseTimers();
            updateBmlStatusIndicator();
            applyBmlVideoGeometry();
            return;
          }

          var curDoc = getActiveBmlDocPath() || '__init__';
          if (curDoc !== bootstrapSentDoc) {
            bootstrapSentDoc = curDoc;
            bootstrapSentCount = 0;
            bootstrapSentAtMs = 0;
          }

          var now = Date.now();
          var beState = getDataButtonBeitemState();
          var canSendNow = state.bmlInvisible
            ? (beState !== 'unsubscribed')
            : (beState === 'subscribed' || beState === 'unknown');
          if (canSendNow) {
            if (bootstrapSentCount === 0) {
              if (sendDataButtonOnce()) {
                bootstrapSentCount = 1;
                bootstrapSentAtMs = now;
                boostBmlPolling(4000);
              }
            } else if (bootstrapSentCount === 1 && (now - bootstrapSentAtMs) >= 2200) {
              if (sendDataButtonOnce()) {
                bootstrapSentCount = 2;
                bootstrapSentAtMs = now;
                boostBmlPolling(4000);
              }
            }
          }

          // BS の大型カルーセル 1 周 (約15秒) + 多段遷移 + NHK BS 初期化待ちまで十分カバーする
          if ((now - bootstrapStartedAtMs) < 28000) {
            bmlBootstrapTimer = setTimeout(tickBootstrap, 220);
          } else {
            state.bmlWaitingBootstrap = false;
            updateBmlStatusIndicator();
          }
        }

        bmlBootstrapTimer = setTimeout(tickBootstrap, 160);
      }

      bmlBrowser.addEventListener('load', function (evt) {
        invalidateBmlInteractiveCache();
        var d = (evt && evt.detail) || {};
        var res = d.resolution || { width: 960, height: 540 };
        state.bmlResWidth = res.width || 960;
        state.bmlResHeight = res.height || 540;
        if (d.profile) state.bmlProfile = String(d.profile);
        state.bmlReceiving = hasPendingBmlModuleRequests();
        updateBmlStatusIndicator();

        if (bmlStageEl) {
          var sx = (1920 / state.bmlResWidth).toFixed(5);
          var sy = (1080 / state.bmlResHeight).toFixed(5);
          bmlStageEl.style.width = state.bmlResWidth + 'px';
          bmlStageEl.style.height = state.bmlResHeight + 'px';
          bmlStageEl.style.webkitTransform = 'scale(' + sx + ', ' + sy + ')';
          bmlStageEl.style.transform = 'scale(' + sx + ', ' + sy + ')';
        }

        // 中継ジャンプ先の新規文書ロード開始時は自動クローズ猶予を延長する
        if (bmlAutoCloseTimer && isCurrentlyWaitingHidden()) {
          scheduleBmlAutoClose(1600);
        }

        // 初期エントリ文書 (地デジの invisible 待機 または BS の透明 startup.bml 待機) の展開を監視する
        clearDataBtnTimers();
        if (!hasBecomeVisible && isCurrentlyWaitingHidden()) {
          startBmlBootstrapWatch();
        }
      });

      bmlBrowser.addEventListener('invisible', function (evt) {
        invalidateBmlInteractiveCache();
        var inv = !!(evt && evt.detail);
        state.bmlInvisible = inv;
        if (!inv) {
          // BS (BML 1.0) の startup.bml / debug.bml 等の透明待機・リダイレクト文書は invisible="invisible" を持たないため、
          // 実 UI がまだ 1 つも描かれていない透明文書のままの invisible=false では表示完了とみなさず bootstrap 監視へ回す
          if (isTransparentNoUiDoc()) {
            if (!hasBecomeVisible) {
              startBmlBootstrapWatch();
              applyBmlVideoGeometry();
              return;
            }
            // 一度実 UI を開いた後に BS の透明待機画面へ戻った場合は、BML 内「戻る/終了」として自動クローズ判定へ
            if (isExitWaitScreen() && (Date.now() - userOpenedAtMs) > 900) {
              if (!bmlInvisibleSinceMs) bmlInvisibleSinceMs = Date.now();
              updateBmlStatusIndicator();
              applyBmlVideoGeometry();
              scheduleBmlAutoClose(900);
              return;
            }
          }
          hasBecomeVisible = true;
          clearDataBtnTimers();
          clearBmlBootstrapTimer();
          clearBmlAutoCloseTimers();
          updateBmlStatusIndicator();
          applyBmlVideoGeometry();
          return;
        }

        updateBmlStatusIndicator();
        // 一度データ放送画面が表示された後に invisible=true へ遷移した場合は、
        // 即閉じせず猶予タイマーで判定する (/60/0000/top.bml 等の一瞬の中継ジャンプ文書による誤終了を防ぐ)
        if (hasBecomeVisible && (Date.now() - userOpenedAtMs) > 900) {
          if (!bmlInvisibleSinceMs) bmlInvisibleSinceMs = Date.now();
          if (bmlVideoRestoreTimer) {
            clearTimeout(bmlVideoRestoreTimer);
            bmlVideoRestoreTimer = null;
          }
          // 一瞬の中継遷移中に L字映像が全画面へチラつかないよう 250ms 待ってから全画面へ戻す
          bmlVideoRestoreTimer = setTimeout(function () {
            bmlVideoRestoreTimer = null;
            if (state.bmlActive && state.bmlInvisible) {
              applyBmlVideoGeometry();
            }
          }, 250);
          scheduleBmlAutoClose(1600);
        } else {
          if (!hasBecomeVisible) {
            startBmlBootstrapWatch();
          }
          applyBmlVideoGeometry();
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
        onStateChange(getPublicStatus());
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
      if (bmlOverlayEl) bmlOverlayEl.className = 'hidden';
      destroyBmlInstance();
      // 事前読み込みバッファが ON かつデータ放送ありチャンネルなら低負荷のバックグラウンド監視へ戻し、再押下時に瞬間表示させる
      if (state.bmlPrefetchEnabled && state.activeStream && state.bmlHasDataComponent === true) {
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

      // 操作音は一般のテレビと同様に BML 文書自身の browser.playRomSound() に任せ、アプリ側の重複発音を行わない
      cancelBmlAutoNav();
      try {
        bmlBrowser.content.processKeyDown(aribKey);
        bmlBrowser.content.processKeyUp(aribKey);
      } catch (e) {}
      // 決定キー・カラーキー・戻るキーによるページ遷移時は新モジュールを即座にバースト受信する
      if (aribKey === AK.Enter || aribKey === AK.Back ||
          aribKey === AK.BlueButton || aribKey === AK.RedButton ||
          aribKey === AK.GreenButton || aribKey === AK.YellowButton) {
        invalidateBmlInteractiveCache();
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
      state.firstPcrMs = null;
      state.firstVideoTimeSec = null;
      state.anchorPcrMs = null;
      state.anchorWallMs = null;
      state.displayPcrMs = null;
    }

    function setBmlPrefetchEnabled(enabled) {
      state.bmlPrefetchEnabled = !!enabled;
      if (!state.bmlPrefetchEnabled) {
        if (!state.bmlActive) {
          stopBmlCarouselPoll();
          state.bmlPrefetchStarted = false;
        }
      } else {
        if (state.activeStream && !state.bmlActive && state.bmlHasDataComponent === true && !isAllListedModulesCached()) {
          state.bmlPrefetchStarted = true;
          state.bmlPrefetchStartedAt = Date.now();
          scheduleNextBmlPoll(250);
        }
      }
      onStateChange(getPublicStatus());
      return state.bmlPrefetchEnabled;
    }

    function getPublicStatus() {
      var wantsNum = false;
      if (state.bmlActive && state.bmlUsedKeys && typeof state.bmlUsedKeys.has === 'function') {
        wantsNum = !!state.bmlUsedKeys.has('numeric-tuning');
      }
      return {
        activeStream: state.activeStream,
        captionEnabled: state.captionEnabled,
        bmlPrefetchEnabled: state.bmlPrefetchEnabled,
        bmlActive: state.bmlActive,
        bmlHasDataComponent: state.bmlHasDataComponent,
        bmlWantsNumeric: wantsNum
      };
    }

    return {
      startStreamSession: startStreamSession,
      stopStreamSession: stopStreamSession,
      notifySeek: notifySeek,
      setCaptionEnabled: setCaptionEnabled,
      toggleCaption: toggleCaption,
      setBmlPrefetchEnabled: setBmlPrefetchEnabled,
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
