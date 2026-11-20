/* -*- coding: utf-8 -*-
 * app.js - DTV Plus メインアプリケーションコントローラ
 * - LG webOS 純正 DTV アプリ基調 UI & 55インチ大型文字対応
 * - 全動画配信抽出を TV内 chroot の公式 yt-dlp に一本化 (リモコン1クリック自己更新対応)
 * - TVer / Abema TV (試験的) 表示 ON/OFF 切替
 * - カテゴリ別視聴履歴 & VOD 再生時間レジューム復帰
 * - 全画面時1クリック目ワンクッション表示
 * - 2次元ラテ欄 EPG グリッド番組表 & 番組詳細・録画予約UI
 * - ニコニコ実況 文字サイズ・透過度調整
 * Chromium 53 (ES5) 完全互換
 */
(function () {
  'use strict';

  var SETTINGS_KEY = 'dtvplus_webos_settings_v2';
  var HISTORY_KEY  = 'dtvplus_webos_history_v2';
  var RECQUEUE_KEY = 'dtvplus_webos_recqueue_v1';
  var JK_PREFS_KEY = 'dtvplus_jikkyo_prefs_v1';

  var defaultSettings = {
    mirakurunUrl: '',
    bs4kMirakurunUrl: '',
    bs4kMirakurunCleared: false,
    useStreamProxy: true,
    showSubChannels: false,
    autoPlayLastChannel: false,
    lastServiceId: null,
    enableGR: true,
    enableBS: true,
    enableBS4K: false,
    enableCS: true,
    enableTver: false,
    enableAbema: false,
    enableAbemaComments: true,
    jikkyoEnabled: true,
    jikkyoFontSize: 'xlarge',
    jikkyoOpacity: 0.70,
    captionEnabled: false,    // ARIB 字幕・文字スーパー表示 ON/OFF
    enableRecordingMode: false, // 初期設定は視聴専用モード
    epgstationUrl: '',
    epgstationReadOnly: true,
    epgstationServers: [],
    activeEpgstationId: '',
    mediaSaveServerUrl: '',
    mediaSaveServerCleared: false,
    recordingStorageMode: 'unset',
    recordingStoragePath: ''
  };

  function cloneDefaultSettings() {
    var s = {};
    var k;
    for (k in defaultSettings) {
      if (defaultSettings.hasOwnProperty(k)) {
        s[k] = Array.isArray(defaultSettings[k]) ? defaultSettings[k].slice() : defaultSettings[k];
      }
    }
    return s;
  }

  function loadJsonStorage(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return fallback;
  }

  function loadSettings() {
    var s = cloneDefaultSettings();
    var k;
    var saved = loadJsonStorage(SETTINGS_KEY, null);
    if (saved) {
      for (k in saved) {
        if (saved.hasOwnProperty(k)) s[k] = saved[k];
      }
      s.useStreamProxy = true;
    }
    if (!Array.isArray(s.epgstationServers)) {
      s.epgstationServers = [];
    }
    if (s.epgstationServers.length === 0 && s.epgstationUrl) {
      s.epgstationServers = [{
        id: 'epg_srv_1',
        name: '録画サーバー',
        url: s.epgstationUrl,
        readOnly: s.epgstationReadOnly !== false
      }];
      s.activeEpgstationId = 'epg_srv_1';
    }
    var foundActive = null;
    for (var i = 0; i < s.epgstationServers.length; i++) {
      if (s.epgstationServers[i].id === s.activeEpgstationId) {
        foundActive = s.epgstationServers[i];
        break;
      }
    }
    if (!foundActive && s.epgstationServers.length > 0) {
      foundActive = s.epgstationServers[0];
      s.activeEpgstationId = foundActive.id;
    }
    if (foundActive) {
      s.epgstationUrl = foundActive.url;
      s.epgstationReadOnly = foundActive.readOnly !== false;
    } else {
      s.activeEpgstationId = '';
      s.epgstationUrl = '';
      s.epgstationReadOnly = true;
    }
    return s;
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
      var jkPrefs = {
        enabled: state.settings.jikkyoEnabled,
        fontSizeKey: state.settings.jikkyoFontSize,
        opacity: state.settings.jikkyoOpacity,
        jkId: (state.currentService && state.currentService.jkId) || undefined
      };
      localStorage.setItem(JK_PREFS_KEY, JSON.stringify(jkPrefs));
      if (window.JikkyoModule && window.JikkyoModule.syncSharedPrefs) {
        window.JikkyoModule.syncSharedPrefs(jkPrefs);
      }
    } catch (e) {}
  }

  function normalizeVodThumbUrl(url, provider) {
    if (!url || typeof url !== 'string') return '';
    if (url.indexOf('http://127.0.0.1:7019/api/img') === 0) return url;
    var isProxyDomain =
      url.indexOf('abema-tv.com') !== -1 ||
      url.indexOf('abema.tv') !== -1 ||
      url.indexOf('hayabusa.io') !== -1 ||
      url.indexOf('streaks.jp') !== -1;
    if ((String(provider || '').toUpperCase() === 'ABEMA' || isProxyDomain) && url.indexOf('https://') === 0) {
      return 'http://127.0.0.1:7019/api/img?url=' + encodeURIComponent(url);
    }
    return url;
  }

  function isHistoryItemLive(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.isLive) return true;
    var u = String(entry.pageUrl || '');
    if (u.indexOf('/now-on-air/') !== -1 || u.indexOf('tver.jp/live/') !== -1) return true;
    return false;
  }

  function appendUniqueHistoryEntry(list, entry, maxLen) {
    if (!entry || !entry.id) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === entry.id) return;
    }
    if (list.length < maxLen) {
      list.push(entry);
    }
  }

  function loadHistory() {
    var h = loadJsonStorage(HISTORY_KEY, null);
    var changed = false;
    if (!h || typeof h !== 'object') {
      h = { GR: [], BS: [], BS4K: [], CS: [], TVER: [], TVER_LIVE: [], ABEMA_LIVE: [], ABEMA_VOD: [], RECORDED: [] };
    }
    if (!h.GR) h.GR = [];
    if (!h.BS) h.BS = [];
    if (!h.BS4K) h.BS4K = [];
    if (!h.CS) h.CS = [];
    if (!h.TVER) h.TVER = [];
    if (!h.TVER_LIVE) h.TVER_LIVE = [];
    if (!h.ABEMA_LIVE) h.ABEMA_LIVE = [];
    if (!h.ABEMA_VOD) h.ABEMA_VOD = [];
    if (!h.RECORDED) h.RECORDED = [];

    // 旧 ABEMA 統合履歴を ABEMA_LIVE / ABEMA_VOD へ自動マイグレーション
    if (Array.isArray(h.ABEMA) && h.ABEMA.length > 0) {
      for (var ai = 0; ai < h.ABEMA.length; ai++) {
        var ae = h.ABEMA[ai];
        if (!ae || !ae.id) continue;
        if (ae.thumbnail) {
          ae.thumbnail = normalizeVodThumbUrl(ae.thumbnail, 'ABEMA');
        }
        if (isHistoryItemLive(ae)) {
          ae.isLive = true;
          ae.resumeSec = 0;
          appendUniqueHistoryEntry(h.ABEMA_LIVE, ae, 10);
        } else {
          ae.isLive = false;
          appendUniqueHistoryEntry(h.ABEMA_VOD, ae, 10);
        }
      }
      h.ABEMA = [];
      changed = true;
    }

    // TVer 履歴に万一ライブ項目が混在していれば TVER_LIVE へ分離
    if (h.TVER.length > 0) {
      var cleanTverVod = [];
      for (var ti = 0; ti < h.TVER.length; ti++) {
        var te = h.TVER[ti];
        if (!te || !te.id) continue;
        if (isHistoryItemLive(te)) {
          te.isLive = true;
          te.resumeSec = 0;
          appendUniqueHistoryEntry(h.TVER_LIVE, te, 10);
          changed = true;
        } else {
          cleanTverVod.push(te);
        }
      }
      h.TVER = cleanTverVod;
    }

    // サムネイル URL 正規化と期限切れ VOD 履歴の起動時自動消去
    var nowMs = Date.now();
    var vodBuckets = ['TVER', 'ABEMA_VOD'];
    for (var bi = 0; bi < vodBuckets.length; bi++) {
      var bkey = vodBuckets[bi];
      var src = h[bkey] || [];
      var kept = [];
      for (var vi = 0; vi < src.length; vi++) {
        var ve = src[vi];
        if (!ve || !ve.id) continue;
        if (ve.thumbnail) {
          ve.thumbnail = normalizeVodThumbUrl(ve.thumbnail, ve.provider || bkey);
        }
        var expMs = Number(ve.expireAt || 0);
        if (expMs > 0 && nowMs >= expMs) {
          changed = true;
          continue;
        }
        kept.push(ve);
      }
      h[bkey] = kept;
    }
    var liveBuckets = ['ABEMA_LIVE', 'TVER_LIVE'];
    for (var lbi = 0; lbi < liveBuckets.length; lbi++) {
      var lkey = liveBuckets[lbi];
      var lsrc = h[lkey] || [];
      for (var li = 0; li < lsrc.length; li++) {
        if (lsrc[li] && lsrc[li].thumbnail) {
          lsrc[li].thumbnail = normalizeVodThumbUrl(lsrc[li].thumbnail, lsrc[li].provider || lkey);
        }
      }
    }

    if (changed) {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
      } catch (e) {}
    }
    return h;
  }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
    } catch (e) {}
  }

  function loadRecQueue() {
    var q = loadJsonStorage(RECQUEUE_KEY, []);
    return Array.isArray(q) ? q : [];
  }

  function saveRecQueue() {
    try {
      localStorage.setItem(RECQUEUE_KEY, JSON.stringify(state.recQueue));
    } catch (e) {}
  }

  var state = {
    settings: loadSettings(),
    history: loadHistory(),
    recQueue: loadRecQueue(),

    services: [],
    bs4kServices: [],
    programsMap: {},
    mainProgramsMap: {},
    bs4kProgramsMap: {},
    mirakurunVersion: null,
    bs4kMirakurunVersion: null,
    ytdlpVersion: '確認中…',
    deviceLanIp: '',
    lanDiscover: { mirakurun: [], epgstation: [], mediasave: [] },
    lanDiscoverBusy: { mirakurun: false, epgstation: false, mediasave: false },
    syncPromptOpen: false,
    jikkyoForces: {},
    jikkyoForcesUpdatedAt: 0,
    jikkyoForcesFetching: false,
    tverGoodCounts: {},
    tverGoodCountsPending: {},

    currentTab: 'GR',
    drawerOpen: true,
    commentPanelOpen: false,
    osdVisible: false,
    epgOpen: false,
    modalOpen: false,

    // LG純正 SimilarListISDB 準拠 番号入力・候補リスト状態
    similarOpen: false,
    similarDigits: '',
    similarThreeDigitOnly: false,
    similarBand: 'GR',
    similarCandidates: [],
    similarFocusIdx: 0,
    similarMoved: false,
    similarTimer: null,
    lastLiveBand: 'GR',

    focusIndex: 0,
    focusables: [],

    // EPG 2次元グリッド状態
    epgType: 'GR',
    epgBaseHourMs: 0,
    epgChannels: [],
    epgColsCells: [], // [colIdx][rowIdx] -> { el, prog, svc }
    epgColIdx: 0,
    epgRowIdx: 0,
    epgInToolbar: false,
    epgToolbarIdx: 0,

    // ABEMA 番組表キャッシュ & 予約状態 (保存サーバー同期)
    abemaTimetable: null,
    abemaTimetableLoading: false,
    abemaTimetableError: '',
    abemaReserves: [],
    abemaLiveJobs: [],
    abemaLiveSort: 'channel', // 'channel' | 'popular'
    mediaSavedIdMap: {},
    mediaActiveIdMap: {},

    // モーダル状態
    modalButtons: [],
    modalFocusIdx: 0,

    // 録画・保存ライブラリ (EPGStation + TVer/ABEMA保存) 状態
    recOverlayOpen: false,
    epgstationVersion: null,
    epgstationStorageText: '',
    epgstationMeta: null, // { channelMap, channelCounts, genreCounts, rules }
    recServerMode: 'EPGSTATION', // 'EPGSTATION' | 'MEDIASAVE'
    mediaSaveMeta: null,  // { itemCount, activeJobs, freeGb, seriesCounts, broadcasterCounts }
    recCategory: 'ALL',   // 'ALL' | 'RECORDING_NOW' | 'RESERVES' | 'RESUME' | 'SAVED_VOD' | 'MS_SERIES:x' | 'MS_CH:x' | 'GENRE:x' | 'CH:x' | 'RULE:x'
    recSort: 'date_desc', // 'date_desc' | 'date_asc' | 'title_asc' | 'duration_desc' | 'resume_first'
    recKeyword: '',
    recPage: 0,
    recItems: [],
    recTotalCount: 0,
    recReserves: [],
    activeRecordingMap: {},
    activeReserveMap: {},
    activeRecordingList: [],
    activeReserveList: [],
    recLoading: false,
    recZone: 'LIST',      // 'TOOLBAR' | 'SIDEBAR' | 'LIST' | 'PAGER'
    recToolbarIdx: 0,
    recSideIdx: 0,
    recSideDefs: [],
    recListIdx: 0,
    recPagerIdx: 0,

    // 再生状態
    mode: 'IDLE', // 'IDLE' | 'LIVE' | 'VOD' | 'RECORDED'
    currentService: null,
    currentVod: null,
    currentRecorded: null,
    recBaseOffsetSec: 0,
    recIsRawTs: false,
    recSeekDebounceTimer: null,
    recPendingSeekSec: null,
    recDurationPollTimer: null,
    osdScrubbing: false,
    osdScrubTargetSec: 0,
    audioModeIndex: 0,
    jikkyoStatusText: '--',

    tverViewMode: 'VOD',         // 'VOD' | 'LIVE'
    tverHomeSections: null,
    tverSearchItems: null,
    tverKeyword: '',
    tverLoading: false,
    tverLiveChannels: null,
    tverSpecialLiveChannels: null,
    tverLiveLoading: false,
    tverLiveUpdatedAt: 0,
    vodExpirySyncedAt: { TVER: 0, ABEMA_VOD: 0 },

    abemaChannels: null,
    abemaLoading: false,
    abemaUpdatedAt: 0,
    abemaCustomUrl: '',
    abemaViewMode: 'LIVE',       // 'LIVE' | 'VOD'
    abemaVodGenre: '',           // '' = おすすめ総合 / 'animation' 等
    abemaVodHomeSections: null,
    abemaVodSearchItems: null,
    abemaVodKeyword: '',
    abemaVodSeries: null,        // { seriesId, title, content, freeCount, totalCount, items }
    abemaVodLoading: false,

    osdTimer: null,
    toastTimer: null,
    guideTimer: null,
    tuneTimeoutTimer: null,
    vodWatchdogTimer: null,
    lastWheelTime: 0,
    lastWheelRawTime: 0,
    wheelZapArmedAt: 0,
    wheelZapArmedDir: 0,
    cursorVisible: false,
    cursorShownAt: 0
  };

  var dom = {
    videoContainer: document.getElementById('video-container'),
    video: document.getElementById('tv-video'),
    captionCanvas: document.getElementById('caption-canvas'),
    superimposeCanvas: document.getElementById('superimpose-canvas'),
    bmlOverlay: document.getElementById('bml-overlay'),
    bmlStage: document.getElementById('bml-stage'),
    bmlContent: document.getElementById('bml-content'),
    bmlInputOverlay: document.getElementById('bml-input-overlay'),
    bmlStatusBadge: document.getElementById('bml-status-badge'),
    standby: document.getElementById('standby-placeholder'),
    standbyMsg: document.getElementById('standby-msg'),
    danmaku: document.getElementById('danmaku-layer'),
    toast: document.getElementById('rich-toast'),
    toastTitle: document.getElementById('toast-title'),
    toastDetail: document.getElementById('toast-detail'),
    similarBox: document.getElementById('similar-list-box'),
    simBandBadge: document.getElementById('sim-band-badge'),
    simDigits: document.getElementById('sim-digits'),
    simModeHint: document.getElementById('sim-mode-hint'),
    simListBody: document.getElementById('sim-list-body'),
    osd: document.getElementById('osd-banner'),
    osdRemocon: document.getElementById('osd-remocon'),
    osdLogo: document.getElementById('osd-logo'),
    osdChName: document.getElementById('osd-ch-name'),
    osdRecBtn: document.getElementById('osd-rec-btn'),
    osdModeBadge: document.getElementById('osd-mode-badge'),
    osdSubBadge: document.getElementById('osd-sub-badge'),
    osdAudioBadge: document.getElementById('osd-audio-badge'),
    osdJkBadge: document.getElementById('osd-jk-badge'),
    osdProgTitle: document.getElementById('osd-prog-title'),
    osdTimeText: document.getElementById('osd-time-text'),
    osdProgressTrack: document.querySelector('.osd-progress-track'),
    osdProgress: document.getElementById('osd-progress-fill'),
    osdDesc: document.getElementById('osd-desc'),
    osdNext: document.getElementById('osd-next'),
    leftDrawer: document.getElementById('left-drawer'),
    brandModeSub: document.getElementById('brand-mode-sub'),
    clock: document.getElementById('header-clock'),
    navTabs: document.getElementById('nav-tabs'),
    drawerBody: document.getElementById('drawer-body'),
    epgOverlay: document.getElementById('epg-overlay'),
    epgRangeLabel: document.getElementById('epg-range-label'),
    epgControls: document.getElementById('epg-controls'),
    epgChHeaders: document.getElementById('epg-ch-headers'),
    epgTimeAxis: document.getElementById('epg-time-axis'),
    epgGridScroll: document.getElementById('epg-grid-scroll'),
    epgColsWrap: document.getElementById('epg-columns-wrap'),
    recOverlay: document.getElementById('recorded-overlay'),
    recCountLabel: document.getElementById('rec-count-label'),
    recStorageBadge: document.getElementById('rec-storage-badge'),
    recToolbar: document.getElementById('rec-toolbar'),
    recSearchInput: document.getElementById('rec-search-input'),
    recSidebar: document.getElementById('rec-sidebar'),
    recMainList: document.getElementById('rec-main-list'),
    recPagerBar: document.getElementById('rec-pager-bar'),
    modalBackdrop: document.getElementById('modal-backdrop'),
    modalSub: document.getElementById('modal-sub'),
    modalTitle: document.getElementById('modal-title'),
    modalBody: document.getElementById('modal-body'),
    modalActions: document.getElementById('modal-actions'),
    rightPanel: document.getElementById('right-comment-panel'),
    commentTitle: document.getElementById('comment-panel-title'),
    commentForce: document.getElementById('comment-force'),
    commentList: document.getElementById('comment-log-list'),
    bottomGuide: document.getElementById('bottom-guide-bar'),
    guideNormalWrap: document.getElementById('guide-normal-wrap'),
    guideBmlWrap: document.getElementById('guide-bml-wrap'),
    btnGuideSub: document.getElementById('btn-guide-sub'),
    btnGuideBml: document.getElementById('btn-guide-bml'),
    btnGuideRecList: document.getElementById('btn-guide-reclist'),
    btnGuideRec: document.getElementById('btn-guide-rec'),
    keycapRec: document.getElementById('keycap-rec'),
    labelRec: document.getElementById('label-rec'),
    labelSub: document.getElementById('label-sub'),
    labelBmlSub: document.getElementById('label-bml-sub'),
    labelRed: document.getElementById('label-red'),
    labelGreen: document.getElementById('label-green')
  };

  // ニコニコ実況エンジンの初期化
  var jikkyo = new window.JikkyoModule.JikkyoEngine(dom.danmaku, {
    onComment: function (cObj, force) {
      dom.commentForce.textContent = force + ' コメ/分';
      appendCommentRow(cObj);
    },
    onStatus: function (statusText, jkId) {
      state.jikkyoStatusText = statusText;
      dom.osdJkBadge.textContent = statusText;
      dom.commentTitle.textContent = jkId ? ('実況 ' + jkId.toUpperCase()) : 'ニコニコ実況';
    }
  });
  jikkyo.setEnabled(state.settings.jikkyoEnabled);
  jikkyo.setFontSizeKey(state.settings.jikkyoFontSize);
  jikkyo.setOpacity(state.settings.jikkyoOpacity);

  // ARIB 字幕 (STD-B24) & データ放送 (BML) 統合マネージャの初期化
  var aribManager = (window.AribManagerModule && window.AribManagerModule.createAribManager)
    ? window.AribManagerModule.createAribManager({
        videoEl: dom.video,
        videoContainerEl: dom.videoContainer,
        captionCanvas: dom.captionCanvas,
        superimposeCanvas: dom.superimposeCanvas,
        bmlOverlayEl: dom.bmlOverlay,
        bmlStageEl: dom.bmlStage,
        bmlContentEl: dom.bmlContent,
        bmlInputEl: dom.bmlInputOverlay,
        bmlStatusBadgeEl: dom.bmlStatusBadge,
        initialCaptionEnabled: !!state.settings.captionEnabled,
        onToast: function (type, title, detail) {
          showRichToast(type, title, detail);
        },
        onStateChange: function (st) {
          syncAribUiState(st);
        },
        onTuneRequest: function (onid, _tsid, sid) {
          var list = state.services || [];
          for (var i = 0; i < list.length; i++) {
            if ((onid && list[i].networkId === onid && list[i].serviceId === sid) || (!onid && list[i].serviceId === sid)) {
              playLiveChannel(list[i]);
              return true;
            }
          }
          return false;
        }
      })
    : null;

  function syncAribUiState(st) {
    if (!st && aribManager) st = aribManager.getStatus();
    var capOn = st ? !!st.captionEnabled : !!state.settings.captionEnabled;
    var bmlOn = st ? !!st.bmlActive : false;
    var subText = '字幕: ' + (capOn ? 'ON' : 'OFF');
    if (dom.labelSub) dom.labelSub.textContent = subText;
    if (dom.labelBmlSub) dom.labelBmlSub.textContent = subText;
    if (dom.osdSubBadge) {
      dom.osdSubBadge.textContent = subText;
      dom.osdSubBadge.style.backgroundColor = capOn ? '#0f766e' : '#2f333d';
      dom.osdSubBadge.style.color = '#ffffff';
    }
    if (dom.btnGuideSub) {
      dom.btnGuideSub.className = 'guide-btn' + (capOn ? ' active-guide' : '');
    }
    if (dom.guideNormalWrap && dom.guideBmlWrap) {
      dom.guideNormalWrap.className = bmlOn ? 'guide-bar-inner hidden' : 'guide-bar-inner';
      dom.guideBmlWrap.className = bmlOn ? 'guide-bar-inner' : 'guide-bar-inner hidden';
    }
    if (bmlOn) {
      if (state.drawerOpen) setDrawerOpen(false);
      if (state.epgOpen) closeEpgGrid();
      if (state.recOverlayOpen) closeRecordedOverlay();
      if (state.similarOpen) closeSimilarList();
      hideOsdBanner();
      wakeBottomGuide();
    }
  }

  function toggleSubtitleMode() {
    if (!aribManager) return;
    var nextVal = aribManager.toggleCaption();
    state.settings.captionEnabled = nextVal;
    saveSettings();
    if (state.currentTab === 'SETTINGS') renderCurrentTab();
  }

  function toggleDataBroadcast() {
    if (!aribManager) return;
    if (state.drawerOpen) {
      setDrawerOpen(false);
    }
    aribManager.toggleBml();
  }

  syncAribUiState(aribManager ? aribManager.getStatus() : null);
  saveSettings();
  updateRedLabel();

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatHm(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function formatSec(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
    return pad2(m) + ':' + pad2(s);
  }

  /**
   * LG純正風 リッチ通知カード表示
   * @param {'info'|'success'|'warn'|'error'} type
   */
  function showRichToast(type, title, detail, durationMs) {
    dom.toast.className = 'type-' + (type || 'info') + ' visible';
    dom.toastTitle.textContent = title || '';
    dom.toastDetail.textContent = detail || '';
    dom.toastDetail.style.display = detail ? 'block' : 'none';
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      dom.toast.className = 'type-' + (type || 'info');
    }, durationMs || 3800);
  }

  /**
   * リッチモーダルダイアログを開く
   */
  function openModal(subText, titleText, bodyText, buttons, opts) {
    state.modalOpen = true;
    dom.modalSub.textContent = subText || '';
    dom.modalTitle.textContent = titleText || '';
    var qrUrl = (opts && opts.qrUrl && typeof opts.qrUrl === 'string') ? opts.qrUrl.trim() : '';
    var svgStr = (qrUrl && window.QrCodeSvg && typeof window.QrCodeSvg.createSvgString === 'function')
      ? window.QrCodeSvg.createSvgString(qrUrl, 156)
      : '';
    if (svgStr) {
      dom.modalBody.className = 'modal-body modal-body-with-qr';
      dom.modalBody.innerHTML = '';

      var textCol = document.createElement('div');
      textCol.className = 'modal-body-text';
      textCol.textContent = bodyText || '';
      dom.modalBody.appendChild(textCol);

      var isPc = !!window.DtvPlusPcSync;
      var qrBox = document.createElement('div');
      qrBox.className = 'modal-qr-box' + (isPc ? ' clickable' : '');
      if (isPc) {
        qrBox.title = 'クリックで公式ページを開く (' + qrUrl + ')';
        qrBox.onclick = function (ev) {
          ev.stopPropagation();
          try {
            window.open(qrUrl, '_blank', 'noopener,noreferrer');
          } catch (e) {}
        };
      }
      var svgWrap = document.createElement('div');
      svgWrap.className = 'modal-qr-svg';
      svgWrap.innerHTML = svgStr;
      qrBox.appendChild(svgWrap);

      var cap = document.createElement('div');
      cap.className = 'modal-qr-caption';
      cap.textContent = isPc ? 'クリックで公式ページ' : 'スマホで公式ページ';
      qrBox.appendChild(cap);

      dom.modalBody.appendChild(qrBox);
    } else {
      dom.modalBody.className = 'modal-body';
      dom.modalBody.textContent = bodyText || '';
    }
    dom.modalActions.innerHTML = '';
    state.modalButtons = [];
    state.modalFocusIdx = 0;

    for (var i = 0; i < buttons.length; i++) {
      (function (btnDef, idx) {
        var b = document.createElement('button');
        b.className = 'btn-action focusable';
        if (btnDef.danger) b.style.backgroundColor = '#7f1d1d';
        if (btnDef.primary) b.style.backgroundColor = '#cf0652';
        b.textContent = btnDef.label;
        b._onActivate = function () {
          closeModal();
          if (btnDef.onClick) btnDef.onClick();
        };
        b.onclick = function (ev) {
          ev.stopPropagation();
          b._onActivate();
        };
        b.onmouseenter = function () {
          state.modalFocusIdx = idx;
          applyModalFocus();
        };
        dom.modalActions.appendChild(b);
        state.modalButtons.push(b);
      })(buttons[i], i);
    }
    dom.modalBackdrop.className = '';
    applyModalFocus();
  }

  function applyModalFocus() {
    for (var i = 0; i < state.modalButtons.length; i++) {
      state.modalButtons[i].className = state.modalButtons[i].className.replace(/\s*focused/g, '');
    }
    if (state.modalButtons[state.modalFocusIdx]) {
      state.modalButtons[state.modalFocusIdx].className += ' focused';
    }
  }

  function closeModal() {
    state.modalOpen = false;
    dom.modalBackdrop.className = 'hidden';
  }

  function wakeBottomGuide() {
    dom.bottomGuide.className = '';
    if (state.guideTimer) clearTimeout(state.guideTimer);
    if (!state.drawerOpen && !state.epgOpen && !state.recOverlayOpen) {
      state.guideTimer = setTimeout(function () {
        if (!state.drawerOpen && !state.epgOpen && !state.recOverlayOpen && !state.osdVisible) {
          dom.bottomGuide.className = 'auto-hidden';
        }
      }, 5500);
    }
  }

  function isAllUiHidden() {
    return !state.drawerOpen && !state.epgOpen && !state.recOverlayOpen && !state.modalOpen && !state.similarOpen && !state.osdVisible && !state.commentPanelOpen;
  }

  function formatYmdHm(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + w + ') ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function isRecordingFeatureEnabled() {
    return state.settings.enableRecordingMode !== false;
  }

  /**
   * フロント画面向けのクリーンなサーバー表示名を返す (ローカル IP / URL 表記は設定タブのみに表示)
   */
  function formatServerDisplayName(srv) {
    if (!srv) return '録画サーバー';
    var raw = String(srv.name || '').trim();
    raw = raw.replace(/\s*[\(（]\s*(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?[^\)）]*[\)）]\s*$/i, '').trim();
    if (!raw || /^https?:\/\//i.test(raw) || /^(?:\d{1,3}\.){3}\d{1,3}/.test(raw)) {
      var u = String(srv.url || '');
      if (u.indexOf(':8888') !== -1 || u.indexOf('bs4k') !== -1) return 'BS4K サーバー';
      return 'メインサーバー';
    }
    return raw;
  }

  function getActiveEpgServer() {
    var list = state.settings.epgstationServers || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.settings.activeEpgstationId) {
        return list[i];
      }
    }
    if (list.length > 0) return list[0];
    if (state.settings.epgstationUrl) {
      return {
        id: 'fallback',
        name: state.settings.epgstationUrl,
        url: state.settings.epgstationUrl,
        readOnly: state.settings.epgstationReadOnly !== false
      };
    }
    return null;
  }

  function setActiveEpgServerById(srvId, reloadNow) {
    var list = state.settings.epgstationServers || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === srvId) {
        state.settings.activeEpgstationId = list[i].id;
        state.settings.epgstationUrl = list[i].url;
        state.settings.epgstationReadOnly = list[i].readOnly !== false;
        state.epgstationVersion = null;
        state.epgstationStorageText = '';
        state.epgstationMeta = null;
        state.recPage = 0;
        saveSettings();
        if (reloadNow) {
          loadEpgStationConnection(true, function () {});
        }
        return;
      }
    }
  }

  /**
   * 現在の視聴モード (LIVE / VOD / RECORDED) および録画モード設定に応じて
   * 録画ボタン・コメント系UIの表示/非表示を一括制御する
   */
  function syncRecordingModeUi() {
    var recOn = isRecordingFeatureEnabled();
    var isRecordedPlaying = (state.mode === 'RECORDED');

    if (dom.osdRecBtn) {
      dom.osdRecBtn.style.display = (recOn && !isRecordedPlaying) ? '' : 'none';
    }
    if (dom.btnGuideRecList) {
      dom.btnGuideRecList.style.display = recOn ? '' : 'none';
    }
    if (dom.btnGuideRec) {
      dom.btnGuideRec.style.display = (recOn && !isRecordedPlaying) ? '' : 'none';
    }
    if (dom.brandModeSub) {
      dom.brandModeSub.textContent = recOn
        ? '放送・配信・録画統合ビューワー'
        : '放送・配信 視聴専用モード';
    }

    // 録画視聴中はコメント関連UI (実況バッジ / 赤ボタン:実況 / 黄ボタン:コメント欄 / 右側コメントパネル) を完全に無効化・非表示にする
    var btnRed = document.getElementById('btn-guide-red');
    var btnYellow = document.getElementById('btn-guide-yellow');
    if (dom.osdJkBadge) {
      dom.osdJkBadge.style.display = isRecordedPlaying ? 'none' : '';
    }
    if (btnRed) {
      btnRed.style.display = isRecordedPlaying ? 'none' : '';
    }
    if (btnYellow) {
      btnYellow.style.display = isRecordedPlaying ? 'none' : '';
    }
    if (isRecordedPlaying && state.commentPanelOpen) {
      state.commentPanelOpen = false;
      dom.rightPanel.className = 'closed';
    }

    // VOD (TVer/ABEMA) または MP4エンコード済録画では ARIB字幕・データ放送ボタンを隠す
    var supportsAribTs = (state.mode === 'LIVE' || state.mode === 'IDLE' || (state.mode === 'RECORDED' && state.recIsRawTs));
    updateRecButtonsUi();
    if (dom.osdSubBadge) {
      dom.osdSubBadge.style.display = supportsAribTs ? '' : 'none';
    }
    if (dom.btnGuideSub) {
      dom.btnGuideSub.style.display = supportsAribTs ? '' : 'none';
    }
    if (dom.btnGuideBml) {
      dom.btnGuideBml.style.display = supportsAribTs ? '' : 'none';
    }
  }

  /**
   * 視聴メイン画面に内部実装名 (yt-dlp 等) が露出しないよう整形する
   */
  function sanitizeMainScreenMessage(msg) {
    if (!msg) return '';
    return String(msg).replace(/\s*\(?yt-dlp\)?\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * 放送局ロゴ画像をセットする (デーモン統合 /api/logo -> Mirakurun直接URL -> 非表示 の2段フォールバック)
   */
  function attachChannelLogo(imgEl, svc) {
    if (!imgEl || !svc || !svc.logoUrl) {
      if (imgEl) imgEl.style.display = 'none';
      return;
    }
    var triedDirect = false;
    imgEl.style.display = 'inline-block';
    imgEl.onerror = function () {
      if (!triedDirect && svc.directLogoUrl && imgEl.src !== svc.directLogoUrl) {
        triedDirect = true;
        imgEl.src = svc.directLogoUrl;
      } else {
        imgEl.style.display = 'none';
      }
    };
    imgEl.src = svc.logoUrl;
  }

  function appendCommentRow(cObj) {
    var row = document.createElement('div');
    row.className = 'comment-row';
    var tm = document.createElement('span');
    tm.className = 'comment-time';
    tm.textContent = cObj.time;
    var tx = document.createElement('span');
    tx.textContent = cObj.text;
    tx.style.color = cObj.color || '#ffffff';
    row.appendChild(tm);
    row.appendChild(tx);
    dom.commentList.appendChild(row);
    while (dom.commentList.childNodes.length > 60) {
      dom.commentList.removeChild(dom.commentList.firstChild);
    }
    dom.commentList.scrollTop = dom.commentList.scrollHeight;
  }

  function updateClock() {
    var now = new Date();
    dom.clock.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  }
  updateClock();
  setInterval(updateClock, 15000);

  // =========================================================================
  // ナビゲーションタブ構築 (地デジ / BS / BS4K / CS / TVer / ABEMA / 録画 / 設定)
  // ※「番組表」はここに置かず、「録画」は ABEMA の右・設定の左に配置
  // =========================================================================
  function getActiveTabDefs() {
    var defs = [];
    if (state.settings.enableGR !== false)   { defs.push({ id: 'GR', label: '地デジ' }); }
    if (state.settings.enableBS !== false)   { defs.push({ id: 'BS', label: 'BS' }); }
    if (state.settings.enableBS4K !== false) { defs.push({ id: 'BS4K', label: 'BS4K' }); }
    if (state.settings.enableCS !== false)   { defs.push({ id: 'CS', label: 'CS' }); }
    if (state.settings.enableTver !== false) {
      defs.push({ id: 'TVER', label: 'TVer' });
    }
    if (state.settings.enableAbema !== false) {
      defs.push({ id: 'ABEMA', label: 'ABEMA' });
    }
    if (isRecordingFeatureEnabled()) {
      defs.push({ id: 'RECORDED', label: '録画' });
    }
    defs.push({ id: 'SETTINGS', label: '設定' });
    return defs;
  }

  function renderNavTabs() {
    var defs = getActiveTabDefs();
    var validIds = [];
    for (var i = 0; i < defs.length; i++) {
      validIds.push(defs[i].id);
    }
    if (validIds.indexOf(state.currentTab) === -1) {
      state.currentTab = validIds[0] || 'SETTINGS';
    }

    dom.navTabs.innerHTML = '';
    for (var j = 0; j < defs.length; j++) {
      (function (def) {
        var el = document.createElement('div');
        el.className = 'nav-tab' + (state.currentTab === def.id ? ' active' : '');
        el.setAttribute('data-tab', def.id);
        el.textContent = def.label;
        el.onclick = function () {
          switchTab(def.id);
        };
        dom.navTabs.appendChild(el);
      })(defs[j]);
    }
  }

  // =========================================================================
  // 視聴履歴 & VOD 再生時間レジューム管理
  // =========================================================================
  function recordChannelHistory(svc) {
    if (!svc || !svc.channelType) return;
    var bucket = state.history[svc.channelType];
    if (!bucket) return;
    var next = [{
      id: svc.id,
      serviceId: svc.serviceId,
      networkId: svc.networkId,
      name: svc.name,
      remoconId: svc.remoconId,
      channelType: svc.channelType,
      watchedAt: Date.now()
    }];
    for (var i = 0; i < bucket.length; i++) {
      if (bucket[i].id !== svc.id && next.length < 6) {
        next.push(bucket[i]);
      }
    }
    state.history[svc.channelType] = next;
    saveHistory();
  }

  function getVodHistoryKey(provider, isLive) {
    var p = String(provider || '').toUpperCase();
    if (p === 'ABEMA' || p === 'ABEMA_LIVE' || p === 'ABEMA_VOD') {
      if (p === 'ABEMA_LIVE') return 'ABEMA_LIVE';
      if (p === 'ABEMA_VOD') return 'ABEMA_VOD';
      return isLive ? 'ABEMA_LIVE' : 'ABEMA_VOD';
    }
    if (p === 'TVER' || p === 'TVER_LIVE') {
      if (p === 'TVER_LIVE') return 'TVER_LIVE';
      return isLive ? 'TVER_LIVE' : 'TVER';
    }
    return p || 'TVER';
  }

  function pruneExpiredVodHistory() {
    var nowMs = Date.now();
    var removed = 0;
    var buckets = ['TVER', 'ABEMA_VOD'];
    for (var b = 0; b < buckets.length; b++) {
      var k = buckets[b];
      var list = state.history[k] || [];
      if (list.length === 0) continue;
      var kept = [];
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it || !it.id) continue;
        var expMs = Number(it.expireAt || 0);
        if (expMs > 0 && nowMs >= expMs) {
          removed++;
          continue;
        }
        kept.push(it);
      }
      if (kept.length !== list.length) {
        state.history[k] = kept;
      }
    }
    if (removed > 0) {
      saveHistory();
    }
    return removed;
  }

  function removeVodHistoryEntry(provider, isLive, id) {
    if (!id) return false;
    var key = getVodHistoryKey(provider, isLive);
    var list = state.history[key] || [];
    var next = [];
    var removed = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) {
        removed = true;
      } else {
        next.push(list[i]);
      }
    }
    if (removed) {
      state.history[key] = next;
      saveHistory();
    }
    return removed;
  }

  function syncVodHistoryExpiry(bucketKey, force) {
    if (bucketKey !== 'TVER' && bucketKey !== 'ABEMA_VOD') return;
    if (!window.VodStreamClient || !window.VodStreamClient.checkExpiredVodHistory) return;
    var list = state.history[bucketKey] || [];
    if (list.length === 0) return;

    var nowMs = Date.now();
    var lastSync = (state.vodExpirySyncedAt && state.vodExpirySyncedAt[bucketKey]) || 0;
    // 10分以内の再チェックは抑制（起動直後や強制更新時のみ即確認）
    if (!force && (nowMs - lastSync) < 10 * 60 * 1000) return;
    state.vodExpirySyncedAt[bucketKey] = nowMs;

    var reqItems = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || !it.id || it.isLive) continue;
      // すでに配信期限が判明しており残り6時間以上余裕がある項目は外部へ再照会しない
      var expMs = Number(it.expireAt || 0);
      if (!force && expMs > 0 && (expMs - nowMs) > 6 * 3600 * 1000) continue;
      reqItems.push({
        id: it.id,
        provider: bucketKey === 'ABEMA_VOD' ? 'ABEMA' : 'TVER',
        pageUrl: it.pageUrl || '',
        isLive: false
      });
    }
    if (reqItems.length === 0) return;

    window.VodStreamClient.checkExpiredVodHistory(reqItems, function (err, data) {
      if (err || !data || !data.results) return;
      var resMap = data.results;
      var curList = state.history[bucketKey] || [];
      var next = [];
      var changed = false;
      var now2 = Date.now();
      for (var j = 0; j < curList.length; j++) {
        var entry = curList[j];
        if (!entry || !entry.id) continue;
        var info = resMap[entry.id];
        if (info) {
          if (info.expired) {
            changed = true;
            continue;
          }
          if (info.expireAt && Number(info.expireAt) > 0) {
            if (now2 >= Number(info.expireAt)) {
              changed = true;
              continue;
            }
            if (Number(entry.expireAt || 0) !== Number(info.expireAt)) {
              entry.expireAt = Number(info.expireAt);
              changed = true;
            }
          }
        }
        next.push(entry);
      }
      if (changed) {
        state.history[bucketKey] = next;
        saveHistory();
        if (state.drawerOpen && ((bucketKey === 'TVER' && state.currentTab === 'TVER' && state.tverViewMode === 'VOD') ||
            (bucketKey === 'ABEMA_VOD' && state.currentTab === 'ABEMA' && state.abemaViewMode === 'VOD'))) {
          renderCurrentTab();
        }
      }
    });
  }

  function recordVodHistory(vodItem, posSec, durSec) {
    if (!vodItem || !vodItem.provider || !vodItem.id) return;
    var isLive = isHistoryItemLive(vodItem);
    var prov = String(vodItem.provider || '').toUpperCase();
    var key = getVodHistoryKey(prov, isLive);
    var bucket = state.history[key] || [];
    var existing = null;
    for (var i = 0; i < bucket.length; i++) {
      if (bucket[i].id === vodItem.id) {
        existing = bucket[i];
        break;
      }
    }
    var resumeSec = posSec !== undefined ? Math.floor(posSec) : (existing ? existing.resumeSec : 0);
    var totalSec = durSec ? Math.floor(durSec) : (vodItem.duration || (existing ? existing.duration : 0));
    var expireAtMs = isLive ? 0 : Number(vodItem.expireAt || (existing ? existing.expireAt : 0) || 0);

    var entry = {
      id: vodItem.id,
      provider: prov,
      pageUrl: vodItem.pageUrl,
      title: vodItem.title || '',
      seriesTitle: vodItem.seriesTitle || '',
      broadcasterName: vodItem.broadcaster || vodItem.broadcasterName || prov,
      broadcastDateLabel: vodItem.broadcastDateLabel || '',
      thumbnail: normalizeVodThumbUrl(vodItem.thumbnail || '', prov),
      isLive: isLive,
      liveKind: vodItem.liveKind || (existing ? (existing.liveKind || '') : ''),
      expireAt: expireAtMs,
      resumeSec: isLive ? 0 : resumeSec,
      duration: totalSec,
      watchedAt: Date.now()
    };

    var next = [entry];
    for (var j = 0; j < bucket.length; j++) {
      if (bucket[j].id !== vodItem.id && next.length < 10) {
        next.push(bucket[j]);
      }
    }
    state.history[key] = next;
    saveHistory();
  }

  function getCurrentPlaybackSec() {
    var vCur = Math.max(0, dom.video.currentTime || 0);
    if (state.mode === 'RECORDED' && state.recIsRawTs) {
      return state.recBaseOffsetSec + vCur;
    }
    return vCur;
  }

  /**
   * 配信保存サーバー動画 (id が "ms_" 始まり) の履歴レコードを自動補完する。
   * 過去に保存された履歴からも確実に再生できるようにする。
   */
  function ensureMediaServerFields(recItem) {
    if (!recItem) return recItem;
    var idStr = String(recItem.id || '');
    if (recItem.isMediaServerItem || idStr.indexOf('ms_') === 0) {
      recItem.isMediaServerItem = true;
      if (recItem.hasEncoded === undefined) recItem.hasEncoded = true;
      var rawMid = recItem.mediaItemId || (idStr.indexOf('ms_') === 0 ? idStr.slice(3) : '');
      recItem.mediaItemId = rawMid;
      var saveBase = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
      if (rawMid && saveBase) {
        if (!recItem.directVideoUrl) {
          recItem.directVideoUrl = saveBase + '/api/video/' + encodeURIComponent(rawMid);
        }
        if (!recItem.thumbnailUrl) {
          recItem.thumbnailUrl = saveBase + '/api/thumb/' + encodeURIComponent(rawMid);
        }
      }
    }
    return recItem;
  }

  function recordRecordedHistory(recItem, posSec, durSec) {
    if (!recItem || !recItem.id) return;
    ensureMediaServerFields(recItem);
    var bucket = state.history.RECORDED || [];
    var existing = null;
    for (var i = 0; i < bucket.length; i++) {
      if (bucket[i].id === recItem.id) {
        existing = bucket[i];
        break;
      }
    }
    var resumeSec = posSec !== undefined ? Math.floor(posSec) : (existing ? existing.resumeSec : 0);
    var totalSec = durSec ? Math.floor(durSec) : (recItem.durationSec || (existing ? existing.durationSec : 0));

    var entry = {
      id: recItem.id,
      name: recItem.name,
      description: recItem.description || '',
      extended: recItem.extended || '',
      channelId: recItem.channelId,
      serviceId: recItem.serviceId || 0,
      networkId: recItem.networkId || 0,
      channelType: recItem.channelType || '',
      channelName: recItem.channelName || '',
      logoUrl: recItem.logoUrl || '',
      directLogoUrl: recItem.directLogoUrl || '',
      startAt: recItem.startAt || 0,
      endAt: recItem.endAt || 0,
      durationSec: totalSec,
      thumbnailUrl: recItem.thumbnailUrl || '',
      videoFiles: recItem.videoFiles || [],
      isMediaServerItem: !!recItem.isMediaServerItem,
      mediaItemId: recItem.mediaItemId || '',
      directVideoUrl: recItem.directVideoUrl || '',
      hasEncoded: !!(recItem.hasEncoded || recItem.isMediaServerItem),
      sizeLabel: recItem.sizeLabel || '',
      genre1: recItem.genre1,
      genreLabel: recItem.genreLabel || '',
      isProtected: !!recItem.isProtected,
      serverUrl: recItem.serverUrl || state.settings.epgstationUrl || '',
      resumeSec: resumeSec,
      watchedAt: Date.now()
    };

    var next = [entry];
    for (var j = 0; j < bucket.length; j++) {
      if (bucket[j].id !== recItem.id && next.length < 30) {
        next.push(bucket[j]);
      }
    }
    state.history.RECORDED = next;
    saveHistory();
  }

  function findRecordedResumeSec(recId) {
    var bucket = state.history.RECORDED || [];
    for (var i = 0; i < bucket.length; i++) {
      if (bucket[i].id === recId && bucket[i].resumeSec > 5) {
        if (bucket[i].durationSec > 0 && bucket[i].resumeSec > bucket[i].durationSec - 15) {
          return 0;
        }
        return bucket[i].resumeSec;
      }
    }
    return 0;
  }

  function flushCurrentVodProgress() {
    if (state.mode === 'VOD' && state.currentVod && !state.currentVod.isLive) {
      var cur = dom.video.currentTime || 0;
      var dur = dom.video.duration || state.currentVod.duration || 0;
      if (cur > 2) {
        recordVodHistory(state.currentVod, cur, dur);
      }
    } else if (state.mode === 'RECORDED' && state.currentRecorded) {
      var rCur = getCurrentPlaybackSec();
      var rDur = state.currentRecorded.durationSec || dom.video.duration || 0;
      if (rCur > 2) {
        recordRecordedHistory(state.currentRecorded, rCur, rDur);
      }
    }
  }

  function findVodResumeSec(provider, id) {
    var key = getVodHistoryKey(provider, false);
    var bucket = state.history[key] || [];
    var nowMs = Date.now();
    for (var i = 0; i < bucket.length; i++) {
      if (bucket[i].id === id && bucket[i].resumeSec > 5) {
        if (bucket[i].expireAt && nowMs >= Number(bucket[i].expireAt)) {
          return 0;
        }
        // 終了直前 (残り15秒未満) なら最初から再生
        if (bucket[i].duration > 0 && bucket[i].resumeSec > bucket[i].duration - 15) {
          return 0;
        }
        return bucket[i].resumeSec;
      }
    }
    return 0;
  }

  // 5秒ごとに再生中のVOD位置を自動バックアップ (誤終了からの復帰用)
  setInterval(function () {
    flushCurrentVodProgress();
  }, 5000);
  // 5分ごとに配信期限切れの VOD 履歴を自動消去
  setInterval(function () {
    pruneExpiredVodHistory();
  }, 5 * 60 * 1000);
  window.addEventListener('beforeunload', flushCurrentVodProgress);

  // =========================================================================
  // Mirakurun データ読込 & 接続診断
  // =========================================================================
  function rebuildMergedProgramsMap() {
    var merged = {};
    var mKeys = Object.keys(state.mainProgramsMap || {});
    for (var i = 0; i < mKeys.length; i++) {
      merged[mKeys[i]] = state.mainProgramsMap[mKeys[i]];
    }
    var bKeys = Object.keys(state.bs4kProgramsMap || {});
    for (var j = 0; j < bKeys.length; j++) {
      merged[bKeys[j]] = state.bs4kProgramsMap[bKeys[j]];
    }
    state.programsMap = merged;
  }

  function loadMirakurunData(showSuccessToast, onReady) {
    var url = (state.settings.mirakurunUrl || '').trim();
    if (!url) {
      state.mirakurunVersion = null;
      state.services = [];
      state.mainProgramsMap = {};
      rebuildMergedProgramsMap();
      dom.standbyMsg.textContent = '放送サーバーが未設定です ― [設定] タブから LAN 検索または PC 同期で設定してください';
      renderCurrentTab();
      if (onReady) onReady(false);
      return;
    }
    dom.standbyMsg.textContent = '放送サーバーに接続しています…';

    window.MirakurunClient.checkServerVersion(url, function (vErr, verInfo) {
      if (vErr) {
        state.mirakurunVersion = null;
        state.services = [];
        dom.standbyMsg.textContent = '放送サーバーに接続できません ― [設定] タブで接続先を確認してください';
        showRichToast('error', 'Mirakurun 接続エラー', vErr + ' / 設定タブから接続先を変更できます', 5500);
        renderCurrentTab();
        if (onReady) onReady(false);
        return;
      }

      state.mirakurunVersion = verInfo.current + ' (' + verInfo.latencyMs + 'ms)';

      window.MirakurunClient.fetchServices(url, function (err, services) {
        if (err || !services) {
          dom.standbyMsg.textContent = 'チャンネル一覧の取得に失敗しました: ' + (err || '不明');
          showRichToast('error', 'チャンネル取得失敗', String(err || ''), 5000);
          state.services = [];
          renderCurrentTab();
          if (onReady) onReady(false);
          return;
        }

        state.services = services;
        dom.standbyMsg.textContent = 'Mirakurun 接続完了 (' + services.length + ' チャンネル) ― メニューから放送局を選択してください';
        if (showSuccessToast) {
          showRichToast('success', 'Mirakurun 接続成功', 'Ver ' + verInfo.current + ' / ' + services.length + 'サービス取得 (' + verInfo.latencyMs + 'ms)');
        }
        renderCurrentTab();

        window.MirakurunClient.fetchProgramsIndex(url, function (pErr, pMap) {
          if (!pErr && pMap) {
            state.mainProgramsMap = pMap;
            rebuildMergedProgramsMap();
            renderCurrentTab();
            if (state.epgOpen) renderEpgGridContents();
            if (state.mode === 'LIVE' && state.currentService) refreshOsdContent();
          }
        });

        if (onReady) onReady(true);
      });
    });
  }

  function loadBs4kMirakurunData(showToastFlag) {
    var url4k = (state.settings.bs4kMirakurunUrl || '').trim();
    if (!url4k) {
      state.bs4kServices = [];
      state.bs4kProgramsMap = {};
      rebuildMergedProgramsMap();
      state.bs4kMirakurunVersion = null;
      if (state.currentTab === 'BS4K' || state.currentTab === 'SETTINGS') renderCurrentTab();
      return;
    }
    var norm4k = window.MirakurunClient.normalizeBaseUrl(url4k);
    var t0 = Date.now();
    // Mirakurun 4.x の /api/version は外部ネット参照でハングする場合があるため、
    // 応答が高速な /api/services を直接取得して接続判定する
    window.MirakurunClient.fetchServices(norm4k, function (err, svcs) {
      if (err || !svcs) {
        state.bs4kMirakurunVersion = null;
        state.bs4kServices = [];
        if (showToastFlag) {
          showRichToast('error', 'BS4K Mirakurun 接続エラー', String(err || '応答なし'), 5000);
        }
        if (state.currentTab === 'BS4K' || state.currentTab === 'SETTINGS') renderCurrentTab();
        return;
      }
      var latMs = Date.now() - t0;
      state.bs4kServices = svcs;
      state.bs4kMirakurunVersion = 'Mirakurun (' + latMs + 'ms)';
      if (showToastFlag) {
        showRichToast('success', 'BS4K Mirakurun 接続成功', svcs.length + 'ch (' + latMs + 'ms)');
      }
      if (state.currentTab === 'BS4K' || state.currentTab === 'SETTINGS') renderCurrentTab();

      // BS4K (networkId=11) のみを高速取得し、メイン Mirakurun 側と独立マージする
      window.MirakurunClient.fetchProgramsIndex(norm4k, function (pErr, pMap) {
        if (!pErr && pMap) {
          state.bs4kProgramsMap = pMap;
          rebuildMergedProgramsMap();
          if (state.currentTab === 'BS4K') renderCurrentTab();
          if (state.epgOpen && state.epgType === 'BS4K') renderEpgGridContents();
          if (state.mode === 'LIVE' && state.currentService && state.currentService.channelType === 'BS4K') {
            refreshOsdContent();
          }
        }
      }, { networkId: 11 });

      // バージョン番号は任意で裏取得 (失敗しても接続状態には影響させない)
      window.MirakurunClient.checkServerVersion(norm4k, function (vErr, verInfo) {
        if (!vErr && verInfo && verInfo.current) {
          state.bs4kMirakurunVersion = verInfo.current + ' (' + latMs + 'ms)';
          if (state.currentTab === 'SETTINGS') renderCurrentTab();
        }
      });
    }, { onlyChannelType: 'BS4K' });
  }

  // =========================================================================
  // 映像再生制御 (Mirakurun 生TS & yt-dlp 抽出による TVer / Abema 再生)
  // =========================================================================
  function resetVideoElement() {
    flushCurrentVodProgress();
    if (window.DtvPlusPcPlayer && window.DtvPlusPcPlayer.destroy) {
      try { window.DtvPlusPcPlayer.destroy(); } catch (e0) {}
    }
    if (state.tuneTimeoutTimer) {
      clearTimeout(state.tuneTimeoutTimer);
      state.tuneTimeoutTimer = null;
    }
    if (state.vodWatchdogTimer) {
      clearInterval(state.vodWatchdogTimer);
      state.vodWatchdogTimer = null;
    }
    try {
      dom.video.pause();
      dom.video.onloadedmetadata = null;
      dom.video.onloadeddata = null;
      dom.video.oncanplay = null;
      dom.video.onplaying = null;
      dom.video.onerror = null;
      while (dom.video.firstChild) {
        dom.video.removeChild(dom.video.firstChild);
      }
      dom.video.removeAttribute('src');
      dom.video.load();
    } catch (e) {}
  }

  /**
   * DTV 放送波 (GR / BS / CS) 専用の uMediaServer 向け mediaOption
   */
  function buildDtvLiveMediaOption() {
    return {
      mediaTransportType: 'URI',
      option: {
        transmission: {
          playTime: { realTime: true },
          useSeekableRanges: false,
          bufferControl: {
            userBufferCtrl: true,
            bufferingMinTime: 1,
            bufferingMaxTime: 5,
            preBufferTime: 1
          }
        }
      }
    };
  }

  /**
   * BS4K (MMT/TLV -> HEVC/H.265 リマックス) 専用の mediaOption
   * SMB400/portproxy 経由の 30Mbps ストリームで発生する最大 2秒前後のバースト到着揺らぎを吸収し、
   * 定期的なリバッファリングフリーズを防ぐため、realTime強制追従を外し 3秒プリバッファを確保する
   */
  function buildBs4kLiveMediaOption() {
    return {
      mediaTransportType: 'URI',
      option: {
        transmission: {
          useSeekableRanges: false,
          bufferControl: {
            userBufferCtrl: true,
            bufferingMinTime: 3,
            bufferingMaxTime: 12,
            preBufferTime: 3
          }
        }
      }
    };
  }

  /**
   * ABEMA ライブ (HLS 5秒セグメント変換TS) 専用の mediaOption
   * DTV 放送波とは伝送特性が全く異なるため、セグメント到着ゆらぎを吸収できるよう独立設定とする
   */
  function buildAbemaLiveMediaOption() {
    return {
      mediaTransportType: 'URI',
      option: {
        transmission: {
          useSeekableRanges: false
        }
      }
    };
  }

  function playLiveChannel(svc, forceDirectFallback) {
    if (!svc) return;
    resetVideoElement();

    if (state.currentService && state.currentService.id !== svc.id) {
      recordChannelHistory(state.currentService);
    }
    recordChannelHistory(svc);

    state.mode = 'LIVE';
    state.currentService = svc;
    state.lastLiveBand = svc.channelType || 'GR';
    state.currentVod = null;
    state.currentRecorded = null;
    syncRecordingModeUi();
    state.audioModeIndex = 0;
    updateAudioBadgeLabel();

    state.settings.lastServiceId = svc.id;
    saveSettings();

    var isBs4kSvc = (svc.channelType === 'BS4K');
    dom.standby.className = '';
    dom.standbyMsg.textContent = (isBs4kSvc ? 'BS4K (HEVC/MMT) 選局中: ' : '選局中: ') + svc.name + ' …';

    function startPlayback(useProxy) {
      resetVideoElement();
      var effectiveProxy = isBs4kSvc ? true : useProxy;
      var streamUrl = window.MirakurunClient.buildStreamUrl(state.settings.mirakurunUrl, svc, effectiveProxy);

      var source = document.createElement('source');
      source.src = streamUrl;
      // ★ LG純正 photovideo 準拠: Chromium 53 の canPlayType 検査を通過させるため
      // 先頭MIMEには必ず video/mp4 を指定し、mediaOption でライブTS用バッファ制御を渡す
      var mediaOpt = isBs4kSvc ? buildBs4kLiveMediaOption() : buildDtvLiveMediaOption();
      source.type = 'video/mp4; mediaOption=' + escape(JSON.stringify(mediaOpt));

      var fallbackTriggered = false;
      function handleStreamError() {
        if (fallbackTriggered) return;
        fallbackTriggered = true;
        if (!isBs4kSvc && useProxy && !forceDirectFallback) {
          // 万一ローカルデーモン未応答時は直接ストリームへフォールバック (通常 MPEG-2 TS のみ)
          startPlayback(false);
        } else {
          dom.standby.className = '';
          dom.standbyMsg.textContent = 'ストリームを受信できませんでした (' + svc.name + ')';
          showRichToast('error', 'ストリーム受信失敗', svc.name + ' のチューナー空き状況を確認してください');
        }
      }

      source.onerror = handleStreamError;
      dom.video.onerror = handleStreamError;

      var started = false;
      function hideStandby() {
        started = true;
        if (state.tuneTimeoutTimer) {
          clearTimeout(state.tuneTimeoutTimer);
          state.tuneTimeoutTimer = null;
        }
        dom.standby.className = 'hidden';
      }
      dom.video.onloadeddata = hideStandby;
      dom.video.oncanplay = hideStandby;
      dom.video.onplaying = hideStandby;

      // Mirakurun は B-CAS 未契約チャンネルでも HTTP 200 のまま復号不能パケットを流し続けるため、
      // EIT の isFree フラグとデコード開始タイムアウトを組み合わせて未契約ブロックを通知する
      state.tuneTimeoutTimer = setTimeout(function () {
        if (started || state.mode !== 'LIVE' || !state.currentService || state.currentService.id !== svc.id) return;
        var pnCheck = window.MirakurunClient.getCurrentAndNext(state.programsMap, svc);
        var isPaid = (pnCheck.current && pnCheck.current.isFree === false) || svc.channelType === 'CS';
        if (isPaid) {
          dom.standby.className = '';
          dom.standbyMsg.textContent = svc.name + ' は有料放送（B-CAS未契約・スクランブル未解除）のため視聴できません';
          showRichToast('warn', '有料放送（未契約）', svc.name + ' の映像を復号できませんでした（EIT有料番組 / デコード応答なし）', 6500);
        } else {
          dom.standbyMsg.textContent = svc.name + ' の映像デコード待機中…（電波状況またはチューナーを確認してください）';
        }
      }, isBs4kSvc ? 15000 : 9000);

      if (window.DtvPlusPcPlayer && window.DtvPlusPcPlayer.attachLive) {
        window.DtvPlusPcPlayer.attachLive(dom.video, svc, streamUrl, hideStandby, handleStreamError);
      } else {
        dom.video.appendChild(source);
        try {
          dom.video.load();
          var p = dom.video.play();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (e) {}
      }

      if (aribManager) {
        if (useProxy && !isBs4kSvc) {
          aribManager.startStreamSession({ isLive: true, serviceId: svc.serviceId });
        } else {
          aribManager.stopStreamSession();
        }
      }
    }

    // tsreadex ストリーム正規化パイプ経由で起動 (デーモン確認後に開始)
    if (!forceDirectFallback) {
      window.WebOSBridge.ensureLocalHelper(function (ok) {
        startPlayback(!!ok);
      });
    } else {
      startPlayback(false);
    }

    dom.commentList.innerHTML = '';
    jikkyo.connect(svc.jkId);

    showOsdBanner();
    renderCurrentTab();
  }

  /**
   * TVer / Abema TV エピソード・チャンネルを公式 yt-dlp 経由で抽出・再生し、レジューム秒数があれば自動復帰する
   */
  function playVodItem(item, forceFromStart) {
    if (!item || !item.pageUrl) return;
    flushCurrentVodProgress();

    var providerLabel = item.provider === 'ABEMA' ? 'ABEMA' : 'TVer';
    var displayTitle = item.seriesTitle ? (item.seriesTitle + ' ' + (item.title || '')) : (item.title || item.channelName || providerLabel);
    var savedSec = (!forceFromStart && !item.isLive) ? findVodResumeSec(item.provider, item.id) : 0;

    showRichToast('info', providerLabel + ' ストリーム準備中', displayTitle, 6000);
    dom.standby.className = '';
    dom.standbyMsg.textContent = providerLabel + ' の映像を読み込んでいます…';

    window.VodStreamClient.extractStreamUrl(item.pageUrl, function (err, info) {
      if (err || !info || !info.streamUrl) {
        var rawErr = String(err || 'ストリームURLを取得できませんでした');
        var cleanErr = sanitizeMainScreenMessage(rawErr);
        // VOD が配信終了・無料期間終了・404 だった場合は履歴から自動消去する
        if (!item.isLive && item.id) {
          var lowErr = rawErr.toLowerCase();
          var isExpiredErr =
            lowErr.indexOf('404') !== -1 ||
            lowErr.indexOf('410') !== -1 ||
            lowErr.indexOf('not found') !== -1 ||
            lowErr.indexOf('unavailable') !== -1 ||
            lowErr.indexOf('expired') !== -1 ||
            lowErr.indexOf('premium') !== -1 ||
            rawErr.indexOf('配信終了') !== -1 ||
            rawErr.indexOf('公開終了') !== -1 ||
            rawErr.indexOf('視聴できません') !== -1 ||
            rawErr.indexOf('プレミアム') !== -1;
          if (isExpiredErr) {
            if (removeVodHistoryEntry(item.provider, false, item.id)) {
              dom.standbyMsg.textContent = providerLabel + ' 配信終了のため再生できませんでした（視聴履歴から削除済）';
              showRichToast('warn', providerLabel + ' 配信期間終了', '視聴期限が切れていたため履歴から自動削除しました', 6000);
              if (state.drawerOpen && (state.currentTab === 'TVER' || state.currentTab === 'ABEMA')) {
                renderCurrentTab();
              }
              return;
            }
          }
        }
        dom.standbyMsg.textContent = providerLabel + ' 読み込み失敗: ' + cleanErr;
        showRichToast('error', providerLabel + ' 再生準備エラー', cleanErr + ' / 通信状態または設定を確認してください', 6000);
        return;
      }

      if (info.ytdlpVersion) {
        state.ytdlpVersion = info.ytdlpVersion;
      }

      resetVideoElement();
      if (aribManager) aribManager.stopStreamSession();
      state.mode = 'VOD';
      state.currentRecorded = null;
      syncRecordingModeUi();
      var isCustomUrlItem = !!item.isCustomUrl;
      var infoThumb = info.thumbnail ? normalizeVodThumbUrl(info.thumbnail, item.provider) : '';
      state.currentVod = {
        id: isCustomUrlItem ? (info.id || item.id) : (item.id || info.id),
        slotId: item.slotId || '',
        provider: item.provider,
        pageUrl: item.pageUrl || item.targetUrl || item.url || info.webpage_url || info.pageUrl || '',
        seriesTitle: isCustomUrlItem
          ? (info.seriesTitle || item.seriesTitle || info.title || providerLabel)
          : (item.seriesTitle || info.seriesTitle || item.channelName || providerLabel),
        title: isCustomUrlItem
          ? ((info.title && info.title !== info.seriesTitle) ? info.title : (item.title !== item.seriesTitle ? item.title : ''))
          : (item.title || info.title || ''),
        broadcaster: item.broadcasterName || item.channelName || info.broadcaster || providerLabel,
        broadcastDateLabel: item.broadcastDateLabel || '',
        genreName: item.genreName || info.genreName || '',
        description: info.description || item.description || '',
        nextTitle: item.nextTitle || '',
        nextStartAt: Number(item.nextStartAt || 0),
        duration: info.duration || item.duration || 0,
        isLive: !!(item.isLive || info.isLive),
        liveKind: item.liveKind || '',
        startAt: Number(item.startAt || 0),
        endAt: Number(item.endAt || 0),
        expireAt: Number(info.expireAt || item.expireAt || 0),
        thumbnail: item.thumbnail || infoThumb || '',
        streamUrl: info.streamUrl
      };
      updateRecButtonsUi();
      if (state.currentVod.isLive && String(state.currentVod.provider || '').toUpperCase() === 'ABEMA') {
        refreshAbemaReserves();
      } else if (!state.currentVod.isLive) {
        refreshMediaSavedIds(function () { updateRecButtonsUi(); });
      }

      recordVodHistory(state.currentVod, savedSec, state.currentVod.duration);

      var useTsRelay = (info.streamType === 'ts');
      var fallbackTried = false;
      var liveRetryCount = 0;
      var liveRetryTimer = null;

      function attachVodSource(asTsStream) {
        if (liveRetryTimer) {
          clearTimeout(liveRetryTimer);
          liveRetryTimer = null;
        }
        resetVideoElement();
        var source = document.createElement('source');
        if (asTsStream) {
          source.src = info.streamUrl;
          var mediaOpt = buildAbemaLiveMediaOption();
          source.type = 'video/mp4; mediaOption=' + escape(JSON.stringify(mediaOpt));
        } else {
          source.src = (asTsStream === false && info.hlsFallbackUrl) ? info.hlsFallbackUrl : info.streamUrl;
          source.type = 'application/vnd.apple.mpegurl';
        }

        var seekApplied = false;
        function applyResumeIfNeeded() {
          if (!seekApplied && savedSec > 5 && !state.currentVod.isLive) {
            seekApplied = true;
            try {
              dom.video.currentTime = savedSec;
              showRichToast('success', '前回の続きから再生復帰', formatSec(savedSec) + ' の位置から再開しました');
            } catch (e) {}
          }
        }

        var errHandledThisAttach = false;
        function onVodStreamError() {
          if (errHandledThisAttach) return;
          if (state.mode !== 'VOD' || !state.currentVod || state.currentVod.streamUrl !== info.streamUrl) return;
          errHandledThisAttach = true;

          // ライブ配信 (ABEMA / TVer Live) は TVCM 切替時の音声/映像フォーマット変化で一時エラーが出ることがあるため
          // 即停止せず自動再接続でシームレス復帰させる
          if (state.currentVod.isLive) {
            if (liveRetryCount < 6) {
              liveRetryCount++;
              dom.standby.className = '';
              dom.standbyMsg.textContent = providerLabel + ' ストリーム再接続中… (' + liveRetryCount + '/6)';
              var nextAsTs = asTsStream;
              if (asTsStream && info.hlsFallbackUrl && !fallbackTried) {
                fallbackTried = true;
                nextAsTs = false;
              } else {
                nextAsTs = useTsRelay;
              }
              liveRetryTimer = setTimeout(function () {
                liveRetryTimer = null;
                if (state.mode === 'VOD' && state.currentVod && state.currentVod.streamUrl === info.streamUrl) {
                  attachVodSource(nextAsTs);
                }
              }, 900);
              return;
            }
          } else if (asTsStream && info.hlsFallbackUrl && !fallbackTried) {
            fallbackTried = true;
            attachVodSource(false);
            return;
          }
          dom.standby.className = '';
          dom.standbyMsg.textContent = providerLabel + ' ストリーム再生エラー';
          showRichToast('error', '再生エラー', 'ストリームのデコードを開始できませんでした');
        }

        source.onerror = onVodStreamError;
        dom.video.onerror = onVodStreamError;
        dom.video.onloadedmetadata = applyResumeIfNeeded;
        dom.video.onloadeddata = function () {
          dom.standby.className = 'hidden';
          liveRetryCount = 0;
          applyResumeIfNeeded();
        };
        dom.video.onplaying = function () {
          dom.standby.className = 'hidden';
          liveRetryCount = 0;
          applyResumeIfNeeded();
        };

        if (window.DtvPlusPcPlayer && window.DtvPlusPcPlayer.attachVod) {
          window.DtvPlusPcPlayer.attachVod(dom.video, state.currentVod, info, asTsStream, applyResumeIfNeeded, onVodStreamError);
        } else {
          dom.video.appendChild(source);
          try {
            dom.video.load();
            var pr = dom.video.play();
            if (pr && typeof pr.catch === 'function') pr.catch(function () {});
          } catch (e) {}
        }
      }

      attachVodSource(useTsRelay);

      // ABEMA / ライブ配信 フリーズ検知＆自動再接続ウォッチドッグ (CM切替時の解像度変化・映像静止フリーズ対策)
      if (state.currentVod.isLive) {
        var lastWatchTime = -1;
        var lastDecodedFrames = -1;
        var stallTicks = 0;
        var watchingItem = item;
        var watchingUrl = info.streamUrl;
        state.vodWatchdogTimer = setInterval(function () {
          if (state.mode !== 'VOD' || !state.currentVod || state.currentVod.streamUrl !== watchingUrl) {
            if (state.vodWatchdogTimer) {
              clearInterval(state.vodWatchdogTimer);
              state.vodWatchdogTimer = null;
            }
            return;
          }
          if (dom.video.paused) {
            stallTicks = 0;
            return;
          }
          var curT = Number(dom.video.currentTime) || 0;
          var curFrames = (typeof dom.video.webkitDecodedFrameCount === 'number') ? dom.video.webkitDecodedFrameCount : -1;
          var timeStalled = (lastWatchTime >= 0 && Math.abs(curT - lastWatchTime) < 0.05);
          // 音声だけ進んで映像フレームだけ静止フリーズしたケースも検知 (再生開始後 curFrames > 0)
          var videoFrozen = (curFrames > 0 && lastDecodedFrames > 0 && curFrames === lastDecodedFrames);
          if (timeStalled || videoFrozen) {
            stallTicks++;
            if (stallTicks >= 3) { // 約7.5秒停止で自動復帰
              clearInterval(state.vodWatchdogTimer);
              state.vodWatchdogTimer = null;
              showRichToast('warn', providerLabel + ' ストリーム自動再接続', '映像停止を検知したため再接続します');
              playVodItem(watchingItem, true);
            }
          } else {
            stallTicks = 0;
          }
          lastWatchTime = curT;
          lastDecodedFrames = curFrames;
        }, 2500);
      }

      dom.commentList.innerHTML = '';
      dom.commentForce.textContent = '0 コメ/分';
      if (state.currentVod.provider === 'TVER') {
        // TVer 再生時はニコニコ実況を使用せず完全に切断する
        jikkyo.disconnect();
        dom.osdJkBadge.textContent = '実況: OFF';
        dom.commentTitle.textContent = 'コメントなし';
      } else if (state.currentVod.provider === 'ABEMA' && state.currentVod.isLive && state.settings.enableAbemaComments !== false) {
        // ABEMA ライブ放送時は ABEMA 公式コメントストリームを弾幕＆右側一覧へ流す
        jikkyo.connectAbemaSlot(item.id, item.slotId || '');
      } else {
        jikkyo.disconnect();
        dom.osdJkBadge.textContent = 'コメント: OFF';
        dom.commentTitle.textContent = 'コメント停止中';
      }

      setDrawerOpen(false);
      showOsdBanner();
      if (!savedSec) {
        showRichToast('success', providerLabel + ' 再生開始', displayTitle);
      }
    });
  }

  /**
   * EPGStation 録画済み番組を再生する (生TSの HTTP Range 高速シーク + tsreadex 正規化 / MP4ネイティブ再生両対応)
   */
  function stopRecordedDurationPoll() {
    if (state.recDurationPollTimer) {
      clearInterval(state.recDurationPollTimer);
      state.recDurationPollTimer = null;
    }
  }

  /**
   * 生 TS 録画ファイルの実録画秒数 (PCR差分) と最新ファイルサイズをバックエンド経由で高速取得し、
   * EPG 番組枠長ではなく実際の録画長をタイムライン・シーク計算へ反映する。
   */
  function probeRecordedRealDuration(recItem, rawTargetUrl) {
    if (!recItem || !rawTargetUrl) return;
    var probeUrl = 'http://127.0.0.1:7019/api/recorded/duration?target=' + encodeURIComponent(rawTargetUrl);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', probeUrl, true);
    xhr.timeout = 8000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || xhr.status !== 200) return;
      try {
        var res = JSON.parse(xhr.responseText);
        if (!res || !res.ok) return;
        if (state.mode !== 'RECORDED' || !state.currentRecorded || state.currentRecorded.id !== recItem.id) return;
        if (res.durationSec > 0) {
          recItem.realDurationSec = res.durationSec;
          recItem.durationSec = res.durationSec;
        }
        if (res.sizeBytes > 0 && recItem.videoFiles && recItem.videoFiles.length > 0) {
          for (var i = 0; i < recItem.videoFiles.length; i++) {
            if (recItem.videoFiles[i].type === 'ts' || recItem.videoFiles.length === 1) {
              recItem.videoFiles[i].size = res.sizeBytes;
            }
          }
        }
        if (!state.osdScrubbing) {
          refreshOsdContent();
        }
      } catch (e) {}
    };
    try { xhr.send(); } catch (e) {}
  }

  function playRecordedItem(recItem, explicitStartSec, silentSeekToast) {
    ensureMediaServerFields(recItem);
    var isDirectMedia = !!(recItem && recItem.isMediaServerItem && recItem.directVideoUrl);
    if (!recItem || (!isDirectMedia && (!recItem.videoFiles || recItem.videoFiles.length === 0))) {
      showRichToast('error', '再生可能な映像ファイルがありません', '');
      return;
    }
    flushCurrentVodProgress();
    stopRecordedDurationPoll();

    var epgBase = window.EpgStationClient.normalizeBaseUrl(recItem.serverUrl || state.settings.epgstationUrl);
    recItem.serverUrl = epgBase;
    var startSec = explicitStartSec !== undefined ? Math.max(0, Math.floor(explicitStartSec)) : findRecordedResumeSec(recItem.id);
    if (recItem.durationSec > 0 && startSec > recItem.durationSec - 8) {
      startSec = 0;
    }

    var srcInfo = isDirectMedia
      ? { url: recItem.directVideoUrl, directUrl: recItem.directVideoUrl, isRawTs: false, isBs4k: false, baseOffsetSec: 0 }
      : window.EpgStationClient.buildPlaybackSource(epgBase, recItem, startSec, false);
    if (!srcInfo || !srcInfo.url) {
      showRichToast('error', '録画ストリームURLを構築できませんでした', '');
      return;
    }

    resetVideoElement();
    if (aribManager) aribManager.stopStreamSession();
    state.mode = 'RECORDED';
    state.currentRecorded = recItem;
    state.currentVod = null;
    state.recBaseOffsetSec = srcInfo.baseOffsetSec || 0;
    state.recIsRawTs = !!srcInfo.isRawTs;
    state.audioModeIndex = 0;
    updateAudioBadgeLabel();
    syncRecordingModeUi();

    // 生 TS 録画は実録画秒数 (PCR差分) を高速取得し、追っかけ録画中は 10 秒ごとに最新長を追従更新
    if (srcInfo.isRawTs && srcInfo.directUrl) {
      probeRecordedRealDuration(recItem, srcInfo.directUrl);
      if (recItem.isRecording) {
        state.recDurationPollTimer = setInterval(function () {
          if (state.mode !== 'RECORDED' || !state.currentRecorded || state.currentRecorded.id !== recItem.id) {
            stopRecordedDurationPoll();
            return;
          }
          probeRecordedRealDuration(recItem, srcInfo.directUrl);
        }, 10000);
      }
    }

    recordRecordedHistory(recItem, startSec, recItem.durationSec);

    dom.standby.className = '';
    dom.standbyMsg.textContent = '録画番組を読み込んでいます: ' + recItem.name + (startSec > 0 ? (' (' + formatSec(startSec) + '〜)') : '');

    function beginRecStream(useTsProxy) {
      resetVideoElement();
      var source = document.createElement('source');
      if (srcInfo.isRawTs) {
        source.src = useTsProxy ? srcInfo.url : srcInfo.directUrl;
        var mediaOpt = {
          mediaTransportType: 'URI'
        };
        source.type = 'video/mp4; mediaOption=' + escape(JSON.stringify(mediaOpt));
      } else {
        source.src = srcInfo.url;
      }

      var fallbackTried = false;
      function onRecErr() {
        if (fallbackTried) return;
        fallbackTried = true;
        if (srcInfo.isRawTs && useTsProxy && !srcInfo.isBs4k) {
          beginRecStream(false);
        } else {
          dom.standby.className = '';
          dom.standbyMsg.textContent = '録画ストリームの再生に失敗しました (' + recItem.name + ')';
          showRichToast('error', '録画再生エラー', 'メディアサーバーとの接続状態を確認してください');
        }
      }
      source.onerror = onRecErr;
      dom.video.onerror = onRecErr;

      var mp4SeekApplied = false;
      function applyMp4Seek() {
        if (!srcInfo.isRawTs && !mp4SeekApplied && startSec > 2) {
          mp4SeekApplied = true;
          try {
            dom.video.currentTime = startSec;
          } catch (e) {}
        }
      }
      dom.video.onloadedmetadata = applyMp4Seek;
      dom.video.onloadeddata = function () {
        dom.standby.className = 'hidden';
        applyMp4Seek();
      };
      dom.video.onplaying = function () {
        dom.standby.className = 'hidden';
        applyMp4Seek();
      };

      if (window.DtvPlusPcPlayer && window.DtvPlusPcPlayer.attachRecorded) {
        window.DtvPlusPcPlayer.attachRecorded(dom.video, recItem, srcInfo, startSec, applyMp4Seek, onRecErr);
      } else {
        dom.video.appendChild(source);
        try {
          dom.video.load();
          var pr = dom.video.play();
          if (pr && typeof pr.catch === 'function') pr.catch(function () {});
        } catch (e) {}
      }

      if (aribManager) {
        if (srcInfo.isRawTs && useTsProxy && !srcInfo.isBs4k) {
          aribManager.startStreamSession({ isLive: false, serviceId: recItem.serviceId || 0 });
        } else {
          aribManager.stopStreamSession();
        }
      }
    }

    if (srcInfo.isRawTs) {
      window.WebOSBridge.ensureLocalHelper(function (ok) {
        beginRecStream(!!ok);
      });
    } else {
      beginRecStream(false);
    }

    // 録画再生中はライブ実況を切断する
    jikkyo.disconnect();
    dom.commentList.innerHTML = '';
    dom.commentForce.textContent = '0 コメ/分';
    dom.osdJkBadge.textContent = '録画再生';
    dom.commentTitle.textContent = '実況: OFF';

    if (state.recOverlayOpen) closeRecordedOverlay();
    if (state.epgOpen) closeEpgGrid();
    setDrawerOpen(false);
    showOsdBanner();

    if (!silentSeekToast) {
      if (startSec > 5) {
        showRichToast('success', '録画再生 (続きから復帰)', formatSec(startSec) + '〜  ' + recItem.name);
      } else {
        showRichToast('success', '録画再生開始', recItem.name);
      }
    }
  }

  // =========================================================================
  // EPGStation 録画中・予約中 並列ステータス管理 & メイン/BS4K 自動振り分け
  // =========================================================================
  function isBs4kEpgServerEntry(srv) {
    if (!srv) return false;
    var id = String(srv.id || '').toLowerCase();
    var name = String(srv.name || '').toLowerCase();
    var url = String(srv.url || '').toLowerCase();
    if (id.indexOf('bs4k') !== -1 || name.indexOf('bs4k') !== -1 || name.indexOf('4k') !== -1) return true;
    var bs4kMk = String(state.settings.bs4kMirakurunUrl || '').toLowerCase();
    var mHost = bs4kMk.match(/^https?:\/\/([^:\/]+)/);
    if (mHost && mHost[1] && url.indexOf(mHost[1]) !== -1) return true;
    return false;
  }

  function isTargetBs4k(obj) {
    if (!obj) return false;
    if (obj.channelType === 'BS4K') return true;
    if (Number(obj.networkId) === 11) return true;
    return false;
  }

  function resolveEpgStationServer(wantBs4k) {
    var list = state.settings.epgstationServers || [];
    var i;
    if (wantBs4k) {
      for (i = 0; i < list.length; i++) {
        if (list[i] && list[i].url && isBs4kEpgServerEntry(list[i])) {
          return {
            id: list[i].id,
            name: list[i].name || list[i].url,
            url: window.EpgStationClient.normalizeBaseUrl(list[i].url),
            readOnly: list[i].readOnly !== false,
            isBs4k: true
          };
        }
      }
    } else {
      // メイン(GR/BS/CS)用: 非BS4Kのアクティブサーバーを優先、なければ非BS4K先頭
      for (i = 0; i < list.length; i++) {
        if (list[i] && list[i].url && !isBs4kEpgServerEntry(list[i]) && list[i].id === state.settings.activeEpgstationId) {
          return {
            id: list[i].id,
            name: list[i].name || list[i].url,
            url: window.EpgStationClient.normalizeBaseUrl(list[i].url),
            readOnly: list[i].readOnly !== false,
            isBs4k: false
          };
        }
      }
      for (i = 0; i < list.length; i++) {
        if (list[i] && list[i].url && !isBs4kEpgServerEntry(list[i])) {
          return {
            id: list[i].id,
            name: list[i].name || list[i].url,
            url: window.EpgStationClient.normalizeBaseUrl(list[i].url),
            readOnly: list[i].readOnly !== false,
            isBs4k: false
          };
        }
      }
    }
    var fallbackUrl = window.EpgStationClient.normalizeBaseUrl(state.settings.epgstationUrl);
    if (!fallbackUrl) return null;
    return {
      id: state.settings.activeEpgstationId || '',
      name: fallbackUrl,
      url: fallbackUrl,
      readOnly: state.settings.epgstationReadOnly !== false,
      isBs4k: !!wantBs4k
    };
  }

  function findEpgServerByUrl(url) {
    var norm = window.EpgStationClient.normalizeBaseUrl(url);
    var list = state.settings.epgstationServers || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && window.EpgStationClient.normalizeBaseUrl(list[i].url) === norm) {
        return {
          id: list[i].id,
          name: list[i].name || list[i].url,
          url: norm,
          readOnly: list[i].readOnly !== false,
          isBs4k: isBs4kEpgServerEntry(list[i])
        };
      }
    }
    return {
      id: '',
      name: norm,
      url: norm,
      readOnly: state.settings.epgstationReadOnly !== false,
      isBs4k: false
    };
  }

  function findActiveRecording(programId, serviceId, startAt) {
    if (programId && state.activeRecordingMap[String(programId)]) {
      return state.activeRecordingMap[String(programId)];
    }
    var list = state.activeRecordingList || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (programId && r.programId && String(r.programId) === String(programId)) return r;
      if (serviceId && r.serviceId && Number(r.serviceId) === Number(serviceId)) {
        if (!startAt || (r.startAt && r.endAt && startAt >= r.startAt - 120000 && startAt < r.endAt)) {
          return r;
        }
      }
    }
    return null;
  }

  function findActiveReserve(programId, serviceId, startAt) {
    if (programId && state.activeReserveMap[String(programId)]) {
      return state.activeReserveMap[String(programId)];
    }
    var list = state.activeReserveList || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (programId && r.programId && String(r.programId) === String(programId)) return r;
      if (serviceId && r.channelId && Number(r.channelId % 100000) === Number(serviceId)) {
        if (startAt && r.startAt && Math.abs(r.startAt - startAt) < 120000) {
          return r;
        }
      }
    }
    return null;
  }

  function refreshEpgStationLiveStatus(callback) {
    if (!isRecordingFeatureEnabled()) {
      if (callback) callback();
      return;
    }
    var servers = [];
    var seen = {};
    var rawList = state.settings.epgstationServers || [];
    var i;
    for (i = 0; i < rawList.length; i++) {
      if (rawList[i] && rawList[i].url) {
        var normU = window.EpgStationClient.normalizeBaseUrl(rawList[i].url);
        if (normU && !seen[normU]) {
          seen[normU] = true;
          servers.push({
            url: normU,
            name: rawList[i].name || normU,
            readOnly: rawList[i].readOnly !== false,
            isBs4k: isBs4kEpgServerEntry(rawList[i])
          });
        }
      }
    }
    if (servers.length === 0 && state.settings.epgstationUrl) {
      var defU = window.EpgStationClient.normalizeBaseUrl(state.settings.epgstationUrl);
      if (defU) servers.push({ url: defU, name: defU, readOnly: state.settings.epgstationReadOnly !== false, isBs4k: false });
    }
    if (servers.length === 0) {
      if (callback) callback();
      return;
    }

    var chMap = (state.epgstationMeta && state.epgstationMeta.channelMap) || {};
    var pending = servers.length * 2;
    var nextRecList = [];
    var nextRsvList = [];

    function doneOne() {
      pending--;
      if (pending > 0) return;

      var recMap = {};
      for (var a = 0; a < nextRecList.length; a++) {
        if (nextRecList[a].programId) recMap[String(nextRecList[a].programId)] = nextRecList[a];
      }
      var rsvMap = {};
      for (var b = 0; b < nextRsvList.length; b++) {
        if (nextRsvList[b].programId) rsvMap[String(nextRsvList[b].programId)] = nextRsvList[b];
      }

      state.activeRecordingList = nextRecList;
      state.activeReserveList = nextRsvList;
      state.activeRecordingMap = recMap;
      state.activeReserveMap = rsvMap;

      if (state.mode === 'LIVE') {
        refreshOsdContent();
      } else {
        updateRecButtonsUi();
      }
      if (state.epgOpen) {
        renderEpgGridContents();
      }
      if (state.recOverlayOpen) {
        renderRecSidebar();
      }
      if (callback) callback();
    }

    for (i = 0; i < servers.length; i++) {
      (function (srv) {
        window.EpgStationClient.fetchRecording(srv.url, chMap, function (err, data) {
          if (!err && data && data.records) {
            for (var k = 0; k < data.records.length; k++) {
              data.records[k].serverUrl = srv.url;
              data.records[k].serverName = srv.name;
              data.records[k].serverReadOnly = srv.readOnly;
              nextRecList.push(data.records[k]);
            }
          }
          doneOne();
        });
        window.EpgStationClient.fetchReserves(srv.url, chMap, function (err, data) {
          if (!err && data && data.reserves) {
            for (var k = 0; k < data.reserves.length; k++) {
              data.reserves[k].serverUrl = srv.url;
              data.reserves[k].serverName = srv.name;
              data.reserves[k].serverReadOnly = srv.readOnly;
              nextRsvList.push(data.reserves[k]);
            }
          }
          doneOne();
        });
      })(servers[i]);
    }
  }

  // =========================================================================
  // 配信保存サーバー (TVer / ABEMA 保存・再生 API 連携)
  // =========================================================================
  function normalizeMediaSaveUrl(url) {
    return window.EpgStationClient.normalizeBaseUrl(url);
  }

  function mediaSaveRequest(method, apiPath, payload, callback) {
    var base = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
    if (!base) {
      if (callback) callback('保存サーバー URL が未設定です', null);
      return;
    }
    var targetUrl = 'http://127.0.0.1:7019/api/epgstation/proxy?target=' + encodeURIComponent(base + apiPath);
    var xhr = new XMLHttpRequest();
    xhr.open(method, targetUrl, true);
    xhr.timeout = 20000;
    if (payload !== null && payload !== undefined) {
      xhr.setRequestHeader('Content-Type', 'application/json');
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var parsed = xhr.responseText ? JSON.parse(xhr.responseText) : {};
          if (callback) callback(null, parsed);
        } catch (e) {
          if (callback) callback('JSON解析エラー', null);
        }
      } else {
        var errMsg = 'HTTP ' + xhr.status;
        try {
          var ep = xhr.responseText ? JSON.parse(xhr.responseText) : null;
          if (ep && ep.error) errMsg = String(ep.error);
        } catch (e2) {}
        if (callback) callback(errMsg, null);
      }
    };
    xhr.onerror = function () { if (callback) callback('保存サーバー接続失敗', null); };
    xhr.ontimeout = function () { if (callback) callback('保存サーバータイムアウト', null); };
    try {
      xhr.send(payload !== null && payload !== undefined ? JSON.stringify(payload) : null);
    } catch (ex) {
      if (callback) callback(String(ex), null);
    }
  }

  // =========================================================================
  // ABEMA 番組表キャッシュ & 録画予約 API 連携 (配信保存サーバー)
  // =========================================================================
  function formatDateWeekHm(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + w + ') ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function proxyAbemaThumbUrl(rawUrl) {
    if (!rawUrl) return '';
    if (rawUrl.indexOf('/api/img?url=') !== -1) return rawUrl;
    return 'http://127.0.0.1:7019/api/img?url=' + encodeURIComponent(rawUrl);
  }

  function fetchAbemaTimetable(force, callback) {
    var base = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
    if (!base) {
      state.abemaTimetableError = '配信保存サーバーが未設定です。[設定] タブで保存サーバー URL を設定してください。';
      if (callback) callback(state.abemaTimetableError, null);
      return;
    }
    state.abemaTimetableLoading = true;
    state.abemaTimetableError = '';
    var apiPath = '/api/abema/timetable' + (force ? '?force=1' : '');
    mediaSaveRequest('GET', apiPath, null, function (err, data) {
      state.abemaTimetableLoading = false;
      if (err || !data || !data.channels) {
        state.abemaTimetableError = 'ABEMA 番組表の取得に失敗しました (' + String(err || '応答不正') + ')';
        if (callback) callback(state.abemaTimetableError, null);
        return;
      }
      state.abemaTimetable = data;
      if (data.reserves) state.abemaReserves = data.reserves;
      if (data.activeLiveJobs) state.abemaLiveJobs = data.activeLiveJobs;
      if (callback) callback(null, data);
    });
  }

  function refreshAbemaReserves(callback) {
    var base = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
    if (!base) {
      state.abemaReserves = [];
      state.abemaLiveJobs = [];
      if (callback) callback(null);
      return;
    }
    mediaSaveRequest('GET', '/api/abema/reserves', null, function (err, data) {
      if (!err && data) {
        state.abemaReserves = data.reserves || [];
        state.abemaLiveJobs = data.activeLiveJobs || [];
        updateRecButtonsUi();
      }
      if (callback) callback(err);
    });
  }

  function extractAbemaChannelSlug(chId, pageUrl) {
    var cid = String(chId || '').trim();
    if (cid && cid.indexOf('http') !== 0 && cid.indexOf('/') === -1) return cid;
    var u = String(pageUrl || cid || '');
    var m = u.match(/\/now-on-air\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : cid;
  }

  function findActiveAbemaLiveRecording(chId, pageUrl) {
    var slug = extractAbemaChannelSlug(chId, pageUrl);
    if (!slug) return null;
    var slugLow = slug.toLowerCase();
    var rsvs = state.abemaReserves || [];
    for (var i = 0; i < rsvs.length; i++) {
      var r = rsvs[i];
      if (r && r.status === 'recording' && String(r.channelId || '').toLowerCase() === slugLow) {
        return r;
      }
    }
    var jobs = state.abemaLiveJobs || [];
    for (var j = 0; j < jobs.length; j++) {
      var jb = jobs[j];
      if (!jb || (jb.status !== 'queued' && jb.status !== 'downloading')) continue;
      var jSlug = extractAbemaChannelSlug(jb.episodeId, jb.url).toLowerCase();
      if (jSlug === slugLow) {
        return {
          id: '',
          jobId: jb.id,
          channelId: slug,
          status: 'recording',
          isManualLiveJob: true,
          title: jb.title || slug,
          jobStatusText: jb.statusText || ''
        };
      }
    }
    return null;
  }

  /**
   * GR / BS / BS4K / CS / ABEMAライブ / VOD すべてにおいて、
   * 下部ガイドバー (#btn-guide-rec) と OSD (#osd-rec-btn) の録画状態表示を統一同期する
   */
  function updateRecButtonsUi() {
    if (!dom.btnGuideRec && !dom.osdRecBtn) return;

    var mode = 'idle'; // 'recording' | 'reserved' | 'live' | 'vod' | 'vod_saved' | 'vod_active'
    if (state.mode === 'LIVE' && state.currentService) {
      var svc = state.currentService;
      var pn = window.MirakurunClient.getCurrentAndNext(state.programsMap, svc);
      var curPid = pn.current ? pn.current.id : null;
      var curStartAt = pn.current ? pn.current.startAt : Date.now();
      if (findActiveRecording(curPid, svc.serviceId, curStartAt)) {
        mode = 'recording';
      } else if (findActiveReserve(curPid, svc.serviceId, curStartAt)) {
        mode = 'reserved';
      } else {
        mode = 'live';
      }
    } else if (state.mode === 'VOD' && state.currentVod) {
      var v = state.currentVod;
      var provU = String(v.provider || '').toUpperCase();
      if (v.isLive && provU === 'ABEMA') {
        if (findActiveAbemaLiveRecording(v.id, v.pageUrl)) {
          mode = 'recording';
        } else {
          mode = 'live';
        }
      } else if (v.isLive) {
        mode = 'live';
      } else {
        var st = getVodSaveStatus(v);
        mode = (st === 'saved') ? 'vod_saved' : (st === 'active' ? 'vod_active' : 'vod');
      }
    }

    // 1. 下部ガイドバー (#btn-guide-rec) 更新
    if (dom.btnGuideRec && dom.keycapRec && dom.labelRec) {
      if (mode === 'recording') {
        dom.btnGuideRec.className = 'guide-btn is-recording';
        dom.keycapRec.textContent = '●録画中';
        dom.labelRec.textContent = '停止・保存';
      } else if (mode === 'reserved') {
        dom.btnGuideRec.className = 'guide-btn is-reserved';
        dom.keycapRec.textContent = '●予約済';
        dom.labelRec.textContent = '取消';
      } else if (mode === 'vod_saved') {
        dom.btnGuideRec.className = 'guide-btn';
        dom.keycapRec.textContent = '✓保存済';
        dom.labelRec.textContent = '完了';
      } else if (mode === 'vod_active') {
        dom.btnGuideRec.className = 'guide-btn is-reserved';
        dom.keycapRec.textContent = '↓保存中';
        dom.labelRec.textContent = 'DL中';
      } else if (mode === 'vod') {
        dom.btnGuideRec.className = 'guide-btn';
        dom.keycapRec.textContent = '↓保存';
        dom.labelRec.textContent = 'DL';
      } else {
        dom.btnGuideRec.className = 'guide-btn';
        dom.keycapRec.textContent = '●録画';
        dom.labelRec.textContent = '開始';
      }
    }

    // 2. OSD 録画ボタン (#osd-rec-btn) 更新
    if (dom.osdRecBtn) {
      if (mode === 'recording') {
        dom.osdRecBtn.textContent = '■ 録画中';
        dom.osdRecBtn.className = 'pill-badge rec-btn is-recording';
      } else if (mode === 'reserved') {
        dom.osdRecBtn.textContent = '● 予約済';
        dom.osdRecBtn.className = 'pill-badge rec-btn is-reserved';
      } else if (mode === 'vod_saved') {
        dom.osdRecBtn.textContent = '✓ 保存済';
        dom.osdRecBtn.className = 'pill-badge rec-btn';
      } else if (mode === 'vod_active') {
        dom.osdRecBtn.textContent = '↓ 保存中';
        dom.osdRecBtn.className = 'pill-badge rec-btn is-reserved';
      } else if (mode === 'vod') {
        dom.osdRecBtn.textContent = '● ダウンロード';
        dom.osdRecBtn.className = 'pill-badge rec-btn';
      } else {
        dom.osdRecBtn.textContent = '● 録画開始';
        dom.osdRecBtn.className = 'pill-badge rec-btn';
      }
    }
  }

  function countActiveAbemaReserves() {
    var cnt = 0;
    var list = state.abemaReserves || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].status === 'scheduled' || list[i].status === 'recording') cnt++;
    }
    return cnt;
  }

  function findAbemaReserveForSlot(slotId, channelId, startAt, endAt) {
    var list = state.abemaReserves || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.status !== 'scheduled' && r.status !== 'recording') continue;
      if (slotId && r.slotId === slotId) return r;
      if (channelId && r.channelId === channelId && startAt && Math.abs((r.startAt || 0) - startAt) < 120000) {
        return r;
      }
    }
    // 番組表外から手動でライブ録画開始している場合も、放送中の該当枠を [録画中] として表示
    var now = Date.now();
    if (channelId && startAt <= now && now < endAt) {
      var ljobs = state.abemaLiveJobs || [];
      for (var j = 0; j < ljobs.length; j++) {
        var jb = ljobs[j];
        if ((jb.status === 'queued' || jb.status === 'downloading') && jb.episodeId === channelId) {
          return {
            id: '',
            jobId: jb.id,
            channelId: channelId,
            status: 'recording',
            isManualLiveJob: true,
            title: jb.title || ''
          };
        }
      }
    }
    return null;
  }

  function registerAbemaReserve(ch, slot, onDone) {
    var payload = {
      slotId: slot.id || '',
      channelId: ch.id,
      channelName: ch.name || ch.id,
      title: slot.title || ch.name,
      series: slot.series || ch.name || 'ABEMA LIVE',
      genre: slot.genre || '',
      description: slot.description || '',
      thumbnail: slot.thumbnail || '',
      url: 'https://abema.tv/now-on-air/' + encodeURIComponent(ch.id),
      startAt: slot.startAt,
      endAt: slot.endAt
    };
    mediaSaveRequest('POST', '/api/abema/reserves', payload, function (err, res) {
      if (err || !res || !res.ok) {
        showRichToast('error', 'ABEMA 録画予約失敗', String(err || (res && res.error) || '不明なエラー'));
        if (onDone) onDone(err || 'failed');
        return;
      }
      var rsv = res.reserve || {};
      var isRecNow = (rsv.status === 'recording');
      showRichToast(
        'success',
        isRecNow ? 'ABEMA ライブ録画を開始しました' : 'ABEMA 録画予約を登録しました',
        (ch.name || ch.id) + '  ' + formatDateWeekHm(slot.startAt) + ' / CM自動スキップ'
      );
      refreshAbemaReserves(function () {
        if (state.epgOpen && state.epgType === 'ABEMA') renderEpgGridContents();
        if (state.recOverlayOpen && state.recServerMode === 'MEDIASAVE') {
          renderRecSidebar();
          if (state.recCategory === 'MS_ABEMA_RESERVES') refreshRecordedOverlayData(true);
        }
        if (onDone) onDone(null, rsv);
      });
    });
  }

  function cancelAbemaReserve(rsv, onDone) {
    if (!rsv) return;
    if (rsv.isManualLiveJob && rsv.jobId) {
      mediaSaveRequest('DELETE', '/api/jobs/' + encodeURIComponent(rsv.jobId), null, function (err) {
        if (err) {
          showRichToast('error', '録画停止エラー', String(err));
        } else {
          showRichToast('info', 'ライブ録画を停止して保存します', rsv.title || '');
        }
        setTimeout(function () {
          refreshAbemaReserves(function () {
            if (state.epgOpen && state.epgType === 'ABEMA') renderEpgGridContents();
            if (state.recOverlayOpen && state.recServerMode === 'MEDIASAVE') {
              renderRecSidebar();
              if (state.recCategory === 'MS_ABEMA_RESERVES') refreshRecordedOverlayData(true);
            }
            if (onDone) onDone(err);
          });
        }, 800);
      });
      return;
    }
    var wasRec = (rsv.status === 'recording');
    mediaSaveRequest('DELETE', '/api/abema/reserves/' + encodeURIComponent(rsv.id), null, function (err) {
      if (err) {
        showRichToast('error', wasRec ? '録画停止失敗' : '予約取り消し失敗', String(err));
        if (onDone) onDone(err);
        return;
      }
      showRichToast(
        'info',
        wasRec ? 'ABEMA ライブ録画を終了して保存します' : 'ABEMA 録画予約を取り消しました',
        rsv.title || ''
      );
      setTimeout(function () {
        refreshAbemaReserves(function () {
          if (state.epgOpen && state.epgType === 'ABEMA') renderEpgGridContents();
          if (state.recOverlayOpen && state.recServerMode === 'MEDIASAVE') {
            renderRecSidebar();
            if (state.recCategory === 'MS_ABEMA_RESERVES') refreshRecordedOverlayData(true);
          }
          if (onDone) onDone(null);
        });
      }, wasRec ? 800 : 150);
    });
  }

  // =========================================================================
  // 保存済み / 進行中 VOD episodeId 同期 & シリーズ一括保存ヘルパー
  // =========================================================================
  var lastMediaSavedIdsSyncAt = 0;

  function pruneDeletedMediaServerHistory(fileIds, storageMounted) {
    // ドライブ未マウント時や異常応答時は暴走防止のため削除を行わない
    if (storageMounted === false || !fileIds || typeof fileIds.length !== 'number') return false;
    var bucket = state.history.RECORDED || [];
    if (bucket.length === 0) return false;
    var validMap = {};
    for (var v = 0; v < fileIds.length; v++) {
      validMap[String(fileIds[v])] = true;
    }
    var kept = [];
    var removed = 0;
    for (var i = 0; i < bucket.length; i++) {
      var e = bucket[i];
      if (!e) continue;
      var idStr = String(e.id || '');
      var isMs = !!(e.isMediaServerItem || idStr.indexOf('ms_') === 0);
      if (isMs) {
        var fid = e.mediaItemId || (idStr.indexOf('ms_') === 0 ? idStr.slice(3) : '');
        if (fid && !validMap[fid]) {
          removed++;
          continue;
        }
      }
      kept.push(e);
    }
    if (removed > 0) {
      state.history.RECORDED = kept;
      saveHistory();
      if (state.recOverlayOpen) {
        renderRecSidebar();
        if (state.recCategory === 'RESUME') {
          var resList = sortClientRecords(state.history.RECORDED || [], state.recSort);
          state.recItems = resList;
          state.recTotalCount = resList.length;
          dom.recCountLabel.textContent = '視聴途中の録画: ' + resList.length + '件';
          renderRecMainList();
        }
      }
      if (state.drawerOpen && state.currentTab === 'RECORDED') {
        renderCurrentTab();
      }
      return true;
    }
    return false;
  }

  function refreshMediaSavedIds(callback, forceNow) {
    var base = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
    if (!base) {
      state.mediaSavedIdMap = {};
      state.mediaActiveIdMap = {};
      if (callback) callback(null);
      return;
    }
    var nowMs = Date.now();
    if (!forceNow && (nowMs - lastMediaSavedIdsSyncAt) < 3500) {
      if (callback) callback(null);
      return;
    }
    lastMediaSavedIdsSyncAt = nowMs;
    mediaSaveRequest('GET', '/api/saved_ids', null, function (err, data) {
      if (!err && data) {
        var sMap = {};
        var aMap = {};
        var sArr = data.savedIds || [];
        var aArr = data.activeIds || [];
        for (var i = 0; i < sArr.length; i++) sMap[String(sArr[i]).toLowerCase()] = true;
        for (var j = 0; j < aArr.length; j++) aMap[String(aArr[j]).toLowerCase()] = true;
        state.mediaSavedIdMap = sMap;
        state.mediaActiveIdMap = aMap;
        if (data.fileIds) {
          pruneDeletedMediaServerHistory(data.fileIds, data.storageMounted);
        }
      }
      if (callback) callback(err);
    });
  }

  function extractVodEpisodeId(item) {
    if (!item || item.isLive || item.itemType === 'series') return '';
    if (item.id && String(item.id).indexOf('http') !== 0) {
      return String(item.id).trim();
    }
    var u = String(item.pageUrl || item.targetUrl || '');
    var m = u.match(/\/episodes?\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : '';
  }

  function getVodSaveStatus(item) {
    var eid = extractVodEpisodeId(item);
    if (!eid) return '';
    var low = eid.toLowerCase();
    if (state.mediaSavedIdMap && state.mediaSavedIdMap[low]) return 'saved';
    if (state.mediaActiveIdMap && state.mediaActiveIdMap[low]) return 'active';
    return '';
  }

  function batchSaveAbemaSeriesEpisodes(ser) {
    if (!ser || !ser.items || ser.items.length === 0) return;
    if (!isRecordingFeatureEnabled()) {
      showRichToast('info', '現在は視聴専用モードです', '[設定] タブから録画・保存連携モードを有効にしてください');
      return;
    }
    var saveBase = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
    if (!saveBase) {
      showRichToast('error', '配信保存サーバー未設定', '[設定] タブで配信保存サーバーの URL を設定してください');
      return;
    }

    var freeEps = [];
    var unsavedEps = [];
    var alreadySavedCnt = 0;
    var alreadyActiveCnt = 0;
    for (var i = 0; i < ser.items.length; i++) {
      var ep = ser.items[i];
      if (ep.isFree === false) continue;
      if (!ep.pageUrl) continue;
      freeEps.push(ep);
      var st = getVodSaveStatus(ep);
      if (st === 'saved') alreadySavedCnt++;
      else if (st === 'active') alreadyActiveCnt++;
      else unsavedEps.push(ep);
    }

    if (freeEps.length === 0) {
      showRichToast('info', '無料エピソードがありません', 'この作品には現在無料で保存できるエピソードがありません');
      return;
    }
    if (unsavedEps.length === 0) {
      showRichToast(
        'info',
        'すべての無料エピソードは保存済 / 進行中です',
        ser.title + ' (保存済 ' + alreadySavedCnt + '話 / 保存中 ' + alreadyActiveCnt + '話)'
      );
      return;
    }

    var MAX_BATCH_EPISODES = 10;
    function sendChunkSave(takeCount) {
      var slice = unsavedEps.slice(0, Math.min(takeCount, MAX_BATCH_EPISODES));
      var payloadItems = [];
      for (var k = 0; k < slice.length; k++) {
        var e = slice[k];
        payloadItems.push({
          url: e.pageUrl,
          episodeId: extractVodEpisodeId(e),
          title: e.title || (ser.title + ' #' + (k + 1)),
          series: e.seriesTitle || ser.title || '',
          genre: e.genreName || ser.genreName || '',
          broadcaster: e.broadcasterName || 'ABEMA VOD',
          provider: 'ABEMA',
          thumbnail: e.thumbnail || '',
          description: e.description || ser.content || '',
          durationSec: e.duration || 0,
          isLive: false
        });
      }
      mediaSaveRequest('POST', '/api/save/batch', { items: payloadItems }, function (err, res) {
        if (err || !res || !res.ok) {
          showRichToast('error', '保存の送信に失敗しました', String(err || (res && res.error) || '不明'));
          return;
        }
        var qCnt = res.queued || 0;
        var skS = res.skippedSaved || 0;
        var skA = res.skippedActive || 0;
        var skipNote = (skS > 0 || skA > 0)
          ? (' / スキップ: 保存済 ' + skS + '・進行中 ' + skA)
          : '';
        showRichToast(
          qCnt > 0 ? 'success' : 'info',
          qCnt > 0 ? (qCnt + ' 話を保存キューへ登録しました') : '新規登録対象はありませんでした',
          ser.title + skipNote,
          6000
        );
        refreshMediaSavedIds(function () {
          if (state.currentTab === 'ABEMA' && state.abemaViewMode === 'VOD') {
            renderCurrentTab();
          }
        }, true);
      });
    }

    var bodyLines = [
      '作品: ' + ser.title,
      '未保存の無料話: ' + unsavedEps.length + ' 話' +
        ((alreadySavedCnt > 0 || alreadyActiveCnt > 0)
          ? ('（保存済 ' + alreadySavedCnt + '・進行中 ' + alreadyActiveCnt + ' は自動スキップ）')
          : '')
    ];
    if (unsavedEps.length > MAX_BATCH_EPISODES) {
      bodyLines.push('');
      bodyLines.push('容量・回線負荷を抑えるため、1 回あたり最大 ' + MAX_BATCH_EPISODES + ' 話ずつ保存します。');
      bodyLines.push('保存完了後に再度実行すると、続きの未保存エピソードを順番に保存できます。');
    } else {
      bodyLines.push('');
      bodyLines.push('配信保存サーバーのキューへ登録し、順番に MP4 保存します。');
    }

    var batchBtns = [];
    if (unsavedEps.length <= 5) {
      batchBtns.push({
        label: '● ' + unsavedEps.length + ' 話を保存',
        primary: true,
        onClick: function () { sendChunkSave(unsavedEps.length); }
      });
    } else if (unsavedEps.length <= MAX_BATCH_EPISODES) {
      batchBtns.push({
        label: '● 先頭 5 話を保存',
        primary: true,
        onClick: function () { sendChunkSave(5); }
      });
      batchBtns.push({
        label: '● 全 ' + unsavedEps.length + ' 話を保存',
        onClick: function () { sendChunkSave(unsavedEps.length); }
      });
    } else {
      batchBtns.push({
        label: '● 未保存の先頭 5 話を保存',
        primary: true,
        onClick: function () { sendChunkSave(5); }
      });
      batchBtns.push({
        label: '● 未保存の先頭 ' + MAX_BATCH_EPISODES + ' 話を保存',
        onClick: function () { sendChunkSave(MAX_BATCH_EPISODES); }
      });
    }
    batchBtns.push({ label: 'キャンセル' });

    openModal(
      'まとめて保存',
      ser.title,
      bodyLines.join('\n'),
      batchBtns
    );
  }

  // =========================================================================
  // 録画・ダウンロード保存指定 UI (EPGStation API 連携 + TVer/ABEMA 保存キュー統合)
  // =========================================================================
  function promptRecordingAction(targetItem) {
    if (!isRecordingFeatureEnabled()) {
      showRichToast('info', '現在は視聴専用モードです', '[設定] タブから録画・保存連携モードを有効にできます');
      return;
    }

    if (!targetItem) {
      if (state.mode === 'VOD' && state.currentVod) {
        var cv = state.currentVod;
        var cvTitle = (cv.title && cv.title !== cv.seriesTitle)
          ? (cv.seriesTitle ? (cv.seriesTitle + ' ' + cv.title) : cv.title)
          : (cv.seriesTitle || cv.title || cv.broadcaster || '配信番組');
        targetItem = {
          kind: String(cv.provider || '').toUpperCase(),
          isLive: !!cv.isLive,
          channelId: cv.id || '',
          slotId: cv.slotId || '',
          title: cvTitle,
          series: cv.seriesTitle || cv.broadcaster || '',
          channel: cv.broadcaster || cv.provider || '',
          timeLabel: cv.broadcastDateLabel || (cv.isLive ? '現在放送中' : '見逃し配信'),
          targetUrl: cv.pageUrl,
          thumbnail: cv.thumbnail || '',
          description: cv.description || '',
          endAt: cv.endAt || 0,
          startAt: cv.startAt || 0
        };
      } else if (state.mode === 'LIVE' && state.currentService) {
        var pn = window.MirakurunClient.getCurrentAndNext(state.programsMap, state.currentService);
        var curP = pn.current;
        targetItem = {
          kind: 'DTV',
          isLive: true,
          title: curP ? curP.name : (state.currentService.name + ' ライブ録画'),
          channel: state.currentService.name,
          channelType: state.currentService.channelType || '',
          networkId: state.currentService.networkId || 0,
          timeLabel: curP ? (formatHm(curP.startAt) + '〜' + formatHm(curP.endAt)) : '現在放送中',
          startAt: curP ? curP.startAt : Date.now(),
          serviceId: state.currentService.serviceId || state.currentService.id,
          programId: curP ? curP.id : null
        };
      } else {
        showRichToast('warn', '録画・保存対象が未選択です', '放送視聴中・配信視聴中・または番組表から選択してください');
        return;
      }
    }

    var isVodTarget = (targetItem.kind === 'TVER' || targetItem.kind === 'ABEMA');
    var isAbemaLiveTarget = (targetItem.kind === 'ABEMA' && (!!targetItem.isLive || String(targetItem.targetUrl || '').indexOf('/now-on-air/') !== -1));
    var abemaActiveRec = isAbemaLiveTarget ? findActiveAbemaLiveRecording(targetItem.channelId, targetItem.targetUrl) : null;
    var wantBs4k = isTargetBs4k(targetItem);
    var targetServer = isVodTarget ? null : resolveEpgStationServer(wantBs4k);
    var activeRec = isVodTarget ? null : findActiveRecording(targetItem.programId, targetItem.serviceId, targetItem.startAt);
    var activeRsv = isVodTarget ? null : findActiveReserve(targetItem.programId, targetItem.serviceId, targetItem.startAt);

    var modalBtns = [];
    var kindLabel = isAbemaLiveTarget ? 'ABEMA LIVE' : targetItem.kind;
    var bodyMsg = '種別: ' + kindLabel + ' (' + targetItem.channel + ')\n日時: ' + targetItem.timeLabel + '\n\n';

    if (isAbemaLiveTarget && abemaActiveRec) {
      bodyMsg += '現在この ABEMA ライブチャンネルを録画中です（TVCM 自動カット）。\n録画を停止すると、ここまでの映像を MP4 ファイルとして保存完了します。';
      modalBtns.push({
        label: '■ 録画停止',
        danger: true,
        primary: true,
        onClick: function () {
          cancelAbemaReserve(abemaActiveRec, function () {
            setTimeout(function () { refreshAbemaReserves(); }, 1000);
          });
        }
      });
    } else if (isAbemaLiveTarget) {
      var abSaveBase = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
      if (abSaveBase && targetItem.targetUrl) {
        bodyMsg += '現在放送中の ABEMA ライブを無劣化 MP4 として録画します（TVCM 自動カット対応）。\n録画中にもう一度録画ボタンを押すと、その時点までの映像を保存して録画停止できます。';
        modalBtns.push({
          label: '● 録画開始',
          primary: true,
          onClick: function () {
            mediaSaveRequest('POST', '/api/save', {
              url: targetItem.targetUrl,
              slotId: targetItem.slotId || '',
              title: targetItem.title,
              series: targetItem.series || targetItem.channel || 'ABEMA LIVE',
              broadcaster: targetItem.channel || 'ABEMA',
              provider: 'ABEMA',
              thumbnail: targetItem.thumbnail || '',
              description: targetItem.description || '',
              isLive: true,
              startAt: targetItem.startAt || Date.now(),
              endAt: targetItem.endAt || 0
            }, function (err, res) {
              if (err) {
                showRichToast('error', '録画開始失敗', String(err) + ' (配信保存サーバーの起動を確認してください)');
              } else if (res && res.skipped) {
                showRichToast('info', 'このチャンネルはすでに録画中です', targetItem.title);
                refreshAbemaReserves();
              } else {
                showRichToast('success', 'ABEMA ライブ録画を開始しました', targetItem.title);
                refreshAbemaReserves();
                setTimeout(function () { refreshAbemaReserves(); }, 1000);
              }
            });
          }
        });
      } else {
        bodyMsg += '配信保存サーバーが未設定のためライブ録画できません。\n[設定] タブで配信保存サーバーを設定してください。';
      }
    } else if (!isVodTarget && activeRec) {
      var recSrv = findEpgServerByUrl(activeRec.serverUrl || (targetServer && targetServer.url));
      bodyMsg += '現在 ' + formatServerDisplayName(recSrv) + ' で録画中です。\n録画を停止すると、ここまでの映像を保存したまま録画を終了します。';
      if (!recSrv.readOnly) {
        modalBtns.push({
          label: '■ 録画停止',
          danger: true,
          primary: true,
          onClick: function () {
            window.EpgStationClient.stopRecording(recSrv.url, activeRec, function (err) {
              if (err) {
                showRichToast('error', '録画停止エラー', String(err));
              } else {
                showRichToast('info', '録画を停止して保存完了しました', targetItem.title);
                setTimeout(function () { refreshEpgStationLiveStatus(); }, 500);
                setTimeout(function () { refreshEpgStationLiveStatus(); }, 1800);
              }
            });
          }
        });
      } else {
        bodyMsg += '\n※対象サーバーの保護ロックが ON のため停止できません（[設定] から解除できます）。';
      }
      modalBtns.push({
        label: '▶ 追っかけ再生',
        onClick: function () {
          playRecordedItem(activeRec, 0, false);
        }
      });
    } else if (!isVodTarget && activeRsv) {
      var rsvSrv = findEpgServerByUrl(activeRsv.serverUrl || (targetServer && targetServer.url));
      bodyMsg += 'この番組は ' + formatServerDisplayName(rsvSrv) + ' に録画予約済みです。';
      if (!rsvSrv.readOnly) {
        modalBtns.push({
          label: '× 予約取消',
          danger: true,
          primary: true,
          onClick: function () {
            window.EpgStationClient.deleteReserve(rsvSrv.url, activeRsv.id, function (err) {
              if (err) {
                showRichToast('error', '予約取消エラー', String(err));
              } else {
                showRichToast('info', '録画予約を取り消しました', targetItem.title);
                setTimeout(function () { refreshEpgStationLiveStatus(); }, 500);
              }
            });
          }
        });
      } else {
        bodyMsg += '\n※対象サーバーの保護ロックが ON のため取り消せません（[設定] から解除できます）。';
      }
    } else if (!isVodTarget && targetServer && targetServer.url && targetItem.programId && !targetServer.readOnly) {
      var isOnAirDtv = (targetItem.startAt && targetItem.startAt <= Date.now() + 60000);
      bodyMsg += '送信先: ' + formatServerDisplayName(targetServer) + '\n' +
        (isOnAirDtv ? '現在放送中の番組の録画を開始します。録画中にもう一度録画ボタンを押すと停止・保存できます。' : '録画予約を登録します。');
      modalBtns.push({
        label: isOnAirDtv ? '● 録画開始' : '● 録画予約',
        primary: true,
        onClick: function () {
          window.EpgStationClient.addProgramReserve(targetServer.url, targetItem.programId, function (err) {
            if (err) {
              showRichToast('error', '録画予約失敗', String(err));
            } else {
              showRichToast('success', isOnAirDtv ? '録画を開始しました' : '録画予約を登録しました', targetItem.title);
              refreshEpgStationLiveStatus();
              setTimeout(function () { refreshEpgStationLiveStatus(); }, 1200);
              setTimeout(function () { refreshEpgStationLiveStatus(); }, 3000);
            }
          });
        }
      });
    } else if (!isVodTarget && targetServer && targetServer.url && targetServer.readOnly) {
      bodyMsg += formatServerDisplayName(targetServer) + ' は現在保護ロックが ON のため、直接書き込みは行わず待機リストへ登録します。\n（[設定] タブでロックを解除できます）';
    } else if (isVodTarget) {
      var saveBase = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
      if (saveBase && targetItem.targetUrl) {
        bodyMsg += 'この見逃し配信をダウンロード保存します。\n完了後は録画一覧の [配信保存サーバー] から再生できます。';
        modalBtns.push({
          label: '● ダウンロード',
          primary: true,
          onClick: function () {
            mediaSaveRequest('POST', '/api/save', {
              url: targetItem.targetUrl,
              episodeId: (state.currentVod && !state.currentVod.isLive) ? extractVodEpisodeId(state.currentVod) : '',
              title: targetItem.title,
              series: (state.currentVod && state.currentVod.seriesTitle) ? state.currentVod.seriesTitle : '',
              genre: (state.currentVod && state.currentVod.genreName) ? state.currentVod.genreName : '',
              broadcaster: targetItem.channel,
              provider: targetItem.kind,
              thumbnail: targetItem.thumbnail || '',
              description: (state.currentVod && state.currentVod.description) ? state.currentVod.description : '',
              durationSec: (state.currentVod && state.currentVod.duration) ? state.currentVod.duration : (dom.video && isFinite(dom.video.duration) ? Math.round(dom.video.duration) : 0),
              isLive: false,
              endAt: 0
            }, function (err, res) {
              if (err) {
                showRichToast('error', '保存サーバー送信失敗', String(err) + ' (サーバー起動を確認してください)');
              } else if (res && res.skipped) {
                var dupTitle = (res.reason === 'already_saved')
                  ? 'すでに保存済みです (重複スキップ)'
                  : 'すでにダウンロード待機・進行中です';
                showRichToast('info', dupTitle, targetItem.title);
              } else {
                showRichToast('success', 'ダウンロード保存を開始しました', targetItem.title);
                refreshMediaSavedIds(function () { updateRecButtonsUi(); }, true);
              }
            });
          }
        });
      } else {
        bodyMsg += 'アプリ内の「配信保存リスト (TVer / ABEMA)」へ登録します。\n（[設定] タブで配信保存サーバーを設定すると MP4 ダウンロード保存にも対応します）';
      }
    } else {
      bodyMsg += 'アプリ内の録画・保存待機リストへ登録します。';
    }

    if (!activeRec && !activeRsv && !abemaActiveRec && modalBtns.length === 0) {
      modalBtns.push({
        label: '● リストに追加',
        primary: true,
        onClick: function () {
          state.recQueue.unshift({
            id: 'rec_' + Date.now(),
            kind: targetItem.kind,
            title: targetItem.title,
            channel: targetItem.channel,
            timeLabel: targetItem.timeLabel,
            targetUrl: targetItem.targetUrl || '',
            thumbnail: targetItem.thumbnail || '',
            serviceId: targetItem.serviceId || null,
            programId: targetItem.programId || null,
            status: isVodTarget ? '配信保存リスト登録済' : '待機リスト登録済',
            createdAt: Date.now()
          });
          if (state.recQueue.length > 80) state.recQueue.pop();
          saveRecQueue();
          showRichToast('success', 'リストに登録しました', targetItem.title);
          if (state.currentTab === 'SETTINGS' || state.currentTab === 'RECORDED') renderCurrentTab();
        }
      });
    }

    modalBtns.push({
      label: '録画一覧',
      onClick: function () {
        openRecordedOverlay(isAbemaLiveTarget ? 'SAVED_VOD' : (isVodTarget ? 'SAVED_VOD' : (activeRec ? 'RECORDING_NOW' : (activeRsv ? 'RESERVES' : 'ALL'))));
      }
    });
    modalBtns.push({ label: 'キャンセル' });

    var modalHeader = abemaActiveRec
      ? '録画中'
      : (isAbemaLiveTarget
        ? 'ABEMA ライブ録画'
        : (activeRec ? '録画中' : (activeRsv ? '録画予約済み' : (isVodTarget ? 'ダウンロード保存' : '録画'))));
    openModal(
      modalHeader,
      targetItem.title,
      bodyMsg,
      modalBtns,
      (isVodTarget && targetItem.targetUrl && !isAbemaLiveTarget) ? { qrUrl: targetItem.targetUrl } : null
    );
  }

  // =========================================================================
  // ライブ配信・VOD・録画再生中の番組詳細モーダル (リモコン ↓→↓ で全系統共通表示)
  // =========================================================================
  function getCurrentAbemaLiveSlotPair(vod) {
    var cur = null;
    var next = null;
    if (!vod || !vod.isLive || String(vod.provider || '').toUpperCase() !== 'ABEMA') {
      return { current: null, next: null };
    }
    var cid = vod.id || '';
    var nowMs = Date.now();
    var tt = state.abemaTimetable;
    if (tt && tt.slotsByChannel && cid && Array.isArray(tt.slotsByChannel[cid])) {
      var list = tt.slotsByChannel[cid];
      for (var i = 0; i < list.length; i++) {
        var sl = list[i];
        if (sl && sl.startAt <= nowMs && nowMs < sl.endAt) {
          cur = sl;
          if (i + 1 < list.length) next = list[i + 1];
          break;
        }
      }
    }
    return { current: cur, next: next };
  }

  function openCurrentVodDetailModal() {
    var v = state.currentVod;
    if (!v) return;
    var isAbemaLive = !!(v.isLive && String(v.provider || '').toUpperCase() === 'ABEMA');
    var pair = isAbemaLive ? getCurrentAbemaLiveSlotPair(v) : { current: null, next: null };
    var slot = pair.current;
    var nextSlot = pair.next;

    var dispTitle = (slot && slot.title)
      ? slot.title
      : (v.seriesTitle + (v.title && v.title !== v.seriesTitle ? ('  ' + v.title) : ''));
    var startAt = (slot && slot.startAt) ? slot.startAt : Number(v.startAt || 0);
    var endAt = (slot && slot.endAt) ? slot.endAt : Number(v.endAt || 0);
    var subParts = [v.broadcaster || v.provider || '配信'];
    if (v.isLive) {
      if (startAt > 0 && endAt > startAt) {
        subParts.push(formatHm(startAt) + ' 〜 ' + formatHm(endAt));
      } else {
        subParts.push('LIVE 配信中');
      }
      if (slot && slot.genre) subParts.push('[' + slot.genre + ']');
    } else {
      if (v.broadcastDateLabel) subParts.push(v.broadcastDateLabel);
      var durSec = Math.floor((dom.video.duration && isFinite(dom.video.duration)) ? dom.video.duration : (v.duration || 0));
      var curSec = Math.floor(dom.video.currentTime || 0);
      if (durSec > 0) subParts.push(formatSec(curSec) + ' / ' + formatSec(durSec));
      var expLbl = formatExpireLabel(v.expireAt);
      if (expLbl) subParts.push(expLbl);
    }

    var descParts = [];
    var mainDesc = (slot && slot.description) ? slot.description : (v.description || '');
    if (mainDesc) descParts.push(mainDesc);
    var nextTitle = (nextSlot && nextSlot.title) ? nextSlot.title : (v.nextTitle || '');
    var nextStart = (nextSlot && nextSlot.startAt) ? nextSlot.startAt : Number(v.nextStartAt || 0);
    if (v.isLive && nextTitle) {
      descParts.push('次の番組: ' + (nextStart > 0 ? (formatHm(nextStart) + '〜  ') : '') + nextTitle);
    }
    var bodyTxt = descParts.length > 0 ? descParts.join('\n\n') : '番組詳細情報はありません。';

    var btns = [];
    if (!v.isLive) {
      btns.push({
        label: (dom.video && dom.video.paused) ? '▶ 再生を再開' : '❚❚ 一時停止',
        primary: true,
        onClick: function () {
          if (dom.video.paused) {
            dom.video.play();
            showRichToast('info', '再生再開', '');
          } else {
            dom.video.pause();
            flushCurrentVodProgress();
            showRichToast('info', '一時停止', '再生位置を保存しました');
          }
        }
      });
    }
    if (isRecordingFeatureEnabled()) {
      if (isAbemaLive) {
        var abAct = findActiveAbemaLiveRecording(v.id);
        btns.push({
          label: abAct ? '■ 録画停止' : '● 録画開始',
          primary: !abAct,
          danger: !!abAct,
          onClick: function () {
            promptRecordingAction();
          }
        });
      } else if (!v.isLive && normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl)) {
        var savedNow = (getVodSaveStatus(v) === 'saved');
        btns.push({
          label: savedNow ? '保存済' : '● ダウンロード',
          onClick: function () {
            promptRecordingAction();
          }
        });
      }
    }
    if (isAbemaLive) {
      btns.push({
        label: 'ABEMA 番組表',
        onClick: function () {
          openEpgGrid('ABEMA');
        }
      });
    }
    btns.push({ label: '閉じる' });

    var targetPageUrl = (!v.isLive) ? (v.pageUrl || v.targetUrl || v.url || '') : '';
    var modalOpts = targetPageUrl ? { qrUrl: targetPageUrl } : null;
    openModal(subParts.join('  |  '), dispTitle, bodyTxt, btns, modalOpts);
  }

  function openCurrentRecordedDetailModal() {
    var rec = state.currentRecorded;
    if (!rec) return;
    var vDur = (dom.video && isFinite(dom.video.duration) && dom.video.duration > 1) ? dom.video.duration : 0;
    var rCur = Math.floor(getCurrentPlaybackSec());
    var rDur = Math.floor((!state.recIsRawTs && vDur > 0) ? vDur : (rec.realDurationSec || rec.durationSec || vDur || 0));
    var subParts = [rec.channelName || (rec.isMediaServerItem ? '保存動画' : '録画')];
    if (rec.startAt) subParts.push(formatYmdHm(rec.startAt));
    if (rDur > 0) subParts.push(formatSec(rCur) + ' / ' + formatSec(rDur));

    var btns = [
      {
        label: (dom.video && dom.video.paused) ? '▶ 再生を再開' : '❚❚ 一時停止',
        primary: true,
        onClick: function () {
          if (dom.video.paused) {
            dom.video.play();
            showRichToast('info', '再生再開', '');
          } else {
            dom.video.pause();
            flushCurrentVodProgress();
            showRichToast('info', '一時停止', '再生位置を保存しました');
          }
        }
      },
      {
        label: '録画一覧',
        onClick: function () {
          openRecordedOverlay(rec.isMediaServerItem ? 'SAVED_VOD' : 'ALL');
        }
      },
      { label: '閉じる' }
    ];

    openModal(
      subParts.join('  |  '),
      rec.name || '録画番組',
      rec.description || '番組詳細情報はありません。',
      btns
    );
  }

  // =========================================================================
  // OSD バナー表示更新
  // =========================================================================
  function refreshOsdContent() {
    syncRecordingModeUi();

    if (state.mode === 'RECORDED' && state.currentRecorded) {
      var rec = state.currentRecorded;
      dom.osdRemocon.textContent = rec.isMediaServerItem ? '保存' : '録画';
      attachChannelLogo(dom.osdLogo, rec);
      dom.osdChName.textContent = rec.channelName + (rec.startAt ? ('  ' + formatYmdHm(rec.startAt)) : '');
      dom.osdModeBadge.textContent = state.recIsRawTs ? (rec.isRecording ? '追っかけ再生' : '録画 TS') : '録画 MP4';
      dom.osdProgTitle.textContent = rec.name;

      var vDur = (dom.video && isFinite(dom.video.duration) && dom.video.duration > 1) ? dom.video.duration : 0;
      if (!state.recIsRawTs && vDur > 0) {
        rec.durationSec = Math.round(vDur);
      }
      var rCur = state.osdScrubbing ? Math.floor(state.osdScrubTargetSec) : Math.floor(getCurrentPlaybackSec());
      var rDur = Math.floor((!state.recIsRawTs && vDur > 0) ? vDur : (rec.realDurationSec || rec.durationSec || vDur || 0));
      if (rDur > 0 && rCur > rDur) rDur = rCur;
      if (dom.osdProgressTrack) {
        dom.osdProgressTrack.className = 'osd-progress-track seekable' + (state.osdScrubbing ? ' scrubbing' : '');
      }
      dom.osdTimeText.textContent = formatSec(rCur) + ' / ' + (rDur > 0 ? formatSec(rDur) : '--:--');
      var rPct = rDur > 0 ? Math.min(100, Math.round((rCur / rDur) * 100)) : 0;
      dom.osdProgress.style.width = rPct + '%';
      dom.osdDesc.textContent = rec.description || '';
      dom.osdNext.textContent = '操作: ◀(-15秒)/▶(+30秒) ・ [決定]一時停止/再開 ・ [↓]番組詳細';
      return;
    }
    if (state.mode === 'VOD' && state.currentVod) {
      var v = state.currentVod;
      var pair = v.isLive ? getCurrentAbemaLiveSlotPair(v) : { current: null, next: null };
      var curSlot = pair.current;
      var nxtSlot = pair.next;
      dom.osdRemocon.textContent = v.provider;
      dom.osdLogo.style.display = 'none';
      dom.osdChName.textContent = v.broadcaster + (v.broadcastDateLabel ? ('  ' + v.broadcastDateLabel) : '');
      dom.osdModeBadge.textContent = v.isLive ? (v.provider + ' LIVE') : (v.provider + ' 見逃し配信');
      updateRecButtonsUi();
      dom.osdProgTitle.textContent = (curSlot && curSlot.title)
        ? curSlot.title
        : (v.seriesTitle + (v.title && v.title !== v.seriesTitle ? ('  ' + v.title) : ''));

      if (v.isLive) {
        if (dom.osdProgressTrack) dom.osdProgressTrack.className = 'osd-progress-track';
        var lvStart = (curSlot && curSlot.startAt) ? curSlot.startAt : Number(v.startAt || 0);
        var lvEnd = (curSlot && curSlot.endAt) ? curSlot.endAt : Number(v.endAt || 0);
        if (lvStart > 0 && lvEnd > lvStart) {
          dom.osdTimeText.textContent = formatHm(lvStart) + ' 〜 ' + formatHm(lvEnd);
          var lvPct = Math.max(0, Math.min(100, Math.round(((Date.now() - lvStart) / (lvEnd - lvStart)) * 100)));
          dom.osdProgress.style.width = lvPct + '%';
        } else {
          dom.osdTimeText.textContent = 'LIVE 配信中';
          dom.osdProgress.style.width = '100%';
        }
      } else {
        if (dom.osdProgressTrack) {
          dom.osdProgressTrack.className = 'osd-progress-track seekable' + (state.osdScrubbing ? ' scrubbing' : '');
        }
        var curSec = state.osdScrubbing ? Math.floor(state.osdScrubTargetSec) : Math.floor(dom.video.currentTime || 0);
        var durSec = Math.floor((dom.video.duration && isFinite(dom.video.duration)) ? dom.video.duration : (v.duration || 0));
        dom.osdTimeText.textContent = formatSec(curSec) + ' / ' + (durSec > 0 ? formatSec(durSec) : '--:--');
        var pct = durSec > 0 ? Math.min(100, Math.round((curSec / durSec) * 100)) : 0;
        dom.osdProgress.style.width = pct + '%';
      }
      dom.osdDesc.textContent = (curSlot && curSlot.description) ? curSlot.description : (v.description || '');
      if (v.isLive) {
        var nTitle = (nxtSlot && nxtSlot.title) ? nxtSlot.title : (v.nextTitle || '');
        var nStart = (nxtSlot && nxtSlot.startAt) ? nxtSlot.startAt : Number(v.nextStartAt || 0);
        dom.osdNext.textContent = nTitle
          ? ('次の番組: ' + (nStart > 0 ? (formatHm(nStart) + '〜  ') : '') + nTitle)
          : '表示中にもう一度[↓]または[決定]を押すと番組詳細を開きます';
      } else {
        dom.osdNext.textContent = '操作: ◀(-15秒)/▶(+30秒) ・ [決定]一時停止/再生 ・ [↓]番組詳細';
      }
      return;
    }

    if (dom.osdProgressTrack) dom.osdProgressTrack.className = 'osd-progress-track';

    var svc = state.currentService;
    if (!svc) {
      dom.osdRemocon.textContent = '--';
      dom.osdChName.textContent = 'チャンネル未選択';
      dom.osdProgTitle.textContent = '青ボタンでメニューを開き、放送局を選択してください';
      return;
    }

    dom.osdRemocon.textContent = svc.displayNum || svc.channelNumber || String(svc.serviceId);
    attachChannelLogo(dom.osdLogo, svc);
    dom.osdChName.textContent = svc.name;
    dom.osdModeBadge.textContent = 'LIVE';

    var pn = window.MirakurunClient.getCurrentAndNext(state.programsMap, svc);
    updateRecButtonsUi();
    if (pn.current) {
      var c = pn.current;
      dom.osdProgTitle.textContent = c.name;
      dom.osdTimeText.textContent = formatHm(c.startAt) + ' 〜 ' + formatHm(c.endAt);
      var elapsed = Date.now() - c.startAt;
      var ratio = c.duration > 0 ? Math.max(0, Math.min(100, Math.round((elapsed / c.duration) * 100))) : 0;
      dom.osdProgress.style.width = ratio + '%';
      dom.osdDesc.textContent = c.description || '';
    } else {
      dom.osdProgTitle.textContent = svc.name + ' 放送中';
      dom.osdTimeText.textContent = '--:-- 〜 --:--';
      dom.osdProgress.style.width = '0%';
      dom.osdDesc.textContent = '';
    }

    if (pn.next) {
      dom.osdNext.textContent = '次の番組: ' + formatHm(pn.next.startAt) + '〜  ' + pn.next.name;
    } else {
      dom.osdNext.textContent = '表示中にもう一度[決定]を押すと番組詳細・録画メニューを開きます';
    }
  }

  function showOsdBanner() {
    refreshOsdContent();
    state.osdVisible = true;
    dom.osd.className = 'visible';
    wakeBottomGuide();
    if (state.osdTimer) clearTimeout(state.osdTimer);
    state.osdTimer = setTimeout(function () {
      state.osdVisible = false;
      dom.osd.className = '';
      wakeBottomGuide();
    }, 6000);
  }

  function hideOsdBanner() {
    state.osdVisible = false;
    dom.osd.className = '';
    if (state.osdTimer) clearTimeout(state.osdTimer);
  }

  // =========================================================================
  // 音声切替 & 実況切替
  // =========================================================================
  var AUDIO_MODES = [
    { label: '主音声', dualMonoCode: 1, trackIdx: 0 },
    { label: '副音声', dualMonoCode: 2, trackIdx: 1 },
    { label: '主＋副', dualMonoCode: 0, trackIdx: 0 }
  ];

  function updateAudioBadgeLabel() {
    var text = '音声: ' + AUDIO_MODES[state.audioModeIndex].label;
    dom.osdAudioBadge.textContent = text;
    dom.labelGreen.textContent = text;
  }

  function cycleAudioMode() {
    state.audioModeIndex = (state.audioModeIndex + 1) % AUDIO_MODES.length;
    var target = AUDIO_MODES[state.audioModeIndex];
    updateAudioBadgeLabel();

    var mediaId = dom.video.mediaId || '';
    window.WebOSBridge.setAudioDualMono(mediaId, target.dualMonoCode, function () {});
    if (dom.video.audioTracks && dom.video.audioTracks.length > 1) {
      for (var i = 0; i < dom.video.audioTracks.length; i++) {
        dom.video.audioTracks[i].enabled = (i === target.trackIdx);
      }
    } else if (mediaId) {
      window.WebOSBridge.selectAudioTrack(mediaId, target.trackIdx, function () {});
    }
    showRichToast('info', '音声モード切替', target.label + ' に切り替えました');
    showOsdBanner();
  }

  function updateRedLabel() {
    dom.labelRed.textContent = '実況: ' + (state.settings.jikkyoEnabled ? 'ON' : 'OFF');
  }

  function toggleJikkyo() {
    if (state.mode === 'RECORDED') return;
    state.settings.jikkyoEnabled = !state.settings.jikkyoEnabled;
    jikkyo.setEnabled(state.settings.jikkyoEnabled);
    saveSettings();
    updateRedLabel();
    showRichToast('info', 'ニコニコ実況表示', state.settings.jikkyoEnabled ? 'コメント表示を ON にしました' : 'コメント表示を OFF にしました');
  }

  function toggleCommentPanel() {
    if (state.mode === 'RECORDED') return;
    state.commentPanelOpen = !state.commentPanelOpen;
    dom.rightPanel.className = state.commentPanelOpen ? '' : 'closed';
    wakeBottomGuide();
  }

  function setDrawerOpen(open) {
    state.drawerOpen = !!open;
    dom.leftDrawer.className = state.drawerOpen ? '' : 'closed';
    wakeBottomGuide();
    if (state.drawerOpen) {
      hideOsdBanner();
      applyFocus(state.focusIndex);
      if (state.currentTab === 'GR' || state.currentTab === 'BS' || state.currentTab === 'BS4K' || state.currentTab === 'CS') {
        refreshJikkyoForces(false);
      } else if (state.currentTab === 'TVER' && state.tverViewMode !== 'LIVE') {
        loadTverGoodCountsForVisibleItems();
      }
      if (state.currentTab === 'ABEMA' && state.abemaViewMode === 'LIVE' && !state.abemaLoading) {
        if (!state.abemaChannels) loadAbemaChannels(false);
        else if (Date.now() - (state.abemaUpdatedAt || 0) > 60000) loadAbemaChannels(true);
      } else if (state.currentTab === 'TVER' && state.tverViewMode === 'LIVE' && !state.tverLiveLoading) {
        if (!state.tverLiveChannels || Date.now() - (state.tverLiveUpdatedAt || 0) > 60000) {
          loadTverLiveChannels();
        }
      }
    }
  }

  // =========================================================================
  // 2次元ラテ欄 EPG グリッド番組表 (DTV Plus)
  // =========================================================================
  var EPG_PX_PER_HOUR = 260;
  var EPG_HOURS_SPAN  = 6;

  function ensureAbemaTimetableLoaded(force) {
    var cur = state.abemaTimetable;
    var stale = !cur || !cur.updatedAt || ((Date.now() - cur.updatedAt) > 30 * 60 * 1000);
    if (force || stale) {
      if (state.abemaTimetableLoading) return;
      renderEpgGridContents();
      fetchAbemaTimetable(!!force, function () {
        if (state.epgOpen && state.epgType === 'ABEMA') {
          // 現在視聴中の ABEMA ライブチャンネルがあればその列に初期フォーカス
          if (state.epgColIdx === 0 && state.mode === 'VOD' && state.currentVod && state.currentVod.provider === 'ABEMA' && state.abemaTimetable) {
            var cid = state.currentVod.id || '';
            var chs = state.abemaTimetable.channels || [];
            for (var i = 0; i < chs.length; i++) {
              if (chs[i].id === cid) {
                state.epgColIdx = i;
                break;
              }
            }
          }
          renderEpgGridContents();
        }
      });
    } else {
      refreshAbemaReserves(function () {
        if (state.epgOpen && state.epgType === 'ABEMA') renderEpgGridContents();
      });
    }
  }

  function openEpgGrid(initialType) {
    var defaultType = (state.mode === 'VOD' && state.currentVod && state.currentVod.provider === 'ABEMA')
      ? 'ABEMA'
      : ((state.currentService && state.currentService.channelType) || 'GR');
    state.epgType = initialType || defaultType;
    var d = new Date();
    d.setMinutes(0, 0, 0);
    state.epgBaseHourMs = d.getTime();
    state.epgColIdx = 0;
    state.epgRowIdx = 0;
    state.epgInToolbar = false;
    state.epgOpen = true;

    if (state.epgType === 'ABEMA' && state.mode === 'VOD' && state.currentVod && state.currentVod.provider === 'ABEMA' && state.abemaTimetable) {
      var curCid = state.currentVod.id || '';
      var abChs = state.abemaTimetable.channels || [];
      for (var ac = 0; ac < abChs.length; ac++) {
        if (abChs[ac].id === curCid) {
          state.epgColIdx = ac;
          break;
        }
      }
    }

    setDrawerOpen(false);
    hideOsdBanner();
    dom.epgOverlay.className = '';
    renderEpgGridContents();
    if (state.epgType === 'ABEMA') {
      ensureAbemaTimetableLoaded(false);
    } else {
      refreshEpgStationLiveStatus();
    }
  }

  function closeEpgGrid() {
    state.epgOpen = false;
    dom.epgOverlay.className = 'hidden';
    wakeBottomGuide();
  }

  function renderAbemaEpgGrid(startMs, endMs, totalHeight, now) {
    var saveSrvBase = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
    if (!saveSrvBase) {
      var noSrv = document.createElement('div');
      noSrv.className = 'setting-group';
      noSrv.style.margin = '24px';
      noSrv.textContent = 'ABEMA 番組表と録画予約機能を利用するには、[設定] タブで配信保存サーバーを設定してください。';
      dom.epgColsWrap.appendChild(noSrv);
      state.epgChannels = [];
      state.epgColsCells = [];
      applyEpgFocus();
      return;
    }

    var tt = state.abemaTimetable;
    if (!tt || !tt.channels || tt.channels.length === 0) {
      var msgEl = document.createElement('div');
      msgEl.className = 'setting-group';
      msgEl.style.margin = '24px';
      msgEl.textContent = state.abemaTimetableLoading
        ? 'ABEMA 番組表 (保存サーバーキャッシュ / 7日分) を読み込んでいます…'
        : (state.abemaTimetableError || 'ABEMA 番組表データを取得できませんでした。保存サーバーが起動しているか確認してください。');
      dom.epgColsWrap.appendChild(msgEl);
      state.epgChannels = [];
      state.epgColsCells = [];
      applyEpgFocus();
      return;
    }

    var chList = tt.channels || [];
    var slotsMap = tt.slotsByChannel || {};
    state.epgChannels = chList;
    state.epgColsCells = [];

    for (var c = 0; c < chList.length; c++) {
      (function (ch, colIdx) {
        var svcObj = {
          id: ch.id,
          name: ch.name,
          isAbemaChannel: true
        };
        var hdr = document.createElement('div');
        hdr.className = 'epg-ch-hdr-cell';
        var hTxt = document.createElement('span');
        hTxt.textContent = ch.name;
        hdr.appendChild(hTxt);
        dom.epgChHeaders.appendChild(hdr);

        var colEl = document.createElement('div');
        colEl.className = 'epg-col';
        colEl.style.height = totalHeight + 'px';

        var allSlots = slotsMap[ch.id] || [];
        var colCells = [];

        for (var pIdx = 0; pIdx < allSlots.length; pIdx++) {
          var sl = allSlots[pIdx];
          if (sl.endAt <= startMs || sl.startAt >= endMs) continue;

          var visStart = Math.max(startMs, sl.startAt);
          var visEnd   = Math.min(endMs, sl.endAt);
          var topPx    = Math.round(((visStart - startMs) / 3600000) * EPG_PX_PER_HOUR);
          var heightPx = Math.max(48, Math.round(((visEnd - visStart) / 3600000) * EPG_PX_PER_HOUR) - 3);

          (function (slot, rowIdx) {
            var cell = document.createElement('div');
            var onAir = (slot.startAt <= now && now < slot.endAt);
            var rsv = findAbemaReserveForSlot(slot.id, ch.id, slot.startAt, slot.endAt);
            var isRec = !!(rsv && rsv.status === 'recording');
            var isRsv = !!(rsv && rsv.status === 'scheduled');
            cell.className = 'epg-cell' +
              (slot.isOffAir ? ' is-off-air' : '') +
              (onAir && !slot.isOffAir ? ' on-air' : '') +
              (isRec ? ' is-recording' : (isRsv ? ' is-reserved' : ''));
            cell.style.top = topPx + 'px';
            cell.style.height = heightPx + 'px';

            var tm = document.createElement('div');
            tm.className = 'epg-cell-time';
            tm.textContent = formatHm(slot.startAt) + '〜' + formatHm(slot.endAt);
            if (isRec) {
              var bRec = document.createElement('span');
              bRec.className = 'epg-rec-badge recording';
              bRec.textContent = '録画中';
              tm.appendChild(bRec);
            } else if (isRsv) {
              var bRsv = document.createElement('span');
              bRsv.className = 'epg-rec-badge reserved';
              bRsv.textContent = '予約済';
              tm.appendChild(bRsv);
            }

            var ttEl = document.createElement('div');
            ttEl.className = 'epg-cell-title';
            ttEl.textContent = slot.title || ch.name;

            cell.appendChild(tm);
            cell.appendChild(ttEl);
            if (heightPx >= 110 && slot.description) {
              var ds = document.createElement('div');
              ds.className = 'epg-cell-desc';
              ds.textContent = slot.description;
              cell.appendChild(ds);
            }

            cell.onclick = function (ev) {
              ev.stopPropagation();
              state.epgInToolbar = false;
              state.epgColIdx = colIdx;
              state.epgRowIdx = rowIdx;
              applyEpgFocus();
              openAbemaEpgProgramDetail(svcObj, slot);
            };

            colEl.appendChild(cell);
            colCells.push({ el: cell, prog: slot, svc: svcObj, topPx: topPx, heightPx: heightPx });
          })(sl, colCells.length);
        }

        if (colCells.length === 0) {
          var emptyCell = document.createElement('div');
          emptyCell.className = 'epg-cell is-off-air';
          emptyCell.style.top = '4px';
          emptyCell.style.height = '120px';
          emptyCell.innerHTML = '<div class="epg-cell-title">この時間帯の番組データなし</div>';
          emptyCell.onclick = function () {
            openAbemaEpgProgramDetail(svcObj, null);
          };
          colEl.appendChild(emptyCell);
          colCells.push({ el: emptyCell, prog: null, svc: svcObj, topPx: 4, heightPx: 120 });
        }

        dom.epgColsWrap.appendChild(colEl);
        state.epgColsCells.push(colCells);
      })(chList[c], c);
    }

    if (now >= startMs && now <= endMs) {
      var nowTop = Math.round(((now - startMs) / 3600000) * EPG_PX_PER_HOUR);
      var line = document.createElement('div');
      line.className = 'epg-now-line';
      line.style.top = nowTop + 'px';
      line.style.width = (chList.length * 288) + 'px';
      dom.epgColsWrap.appendChild(line);
    }

    dom.epgGridScroll.onscroll = function () {
      dom.epgChHeaders.scrollLeft = dom.epgGridScroll.scrollLeft;
      dom.epgTimeAxis.scrollTop = dom.epgGridScroll.scrollTop;
    };

    if (state.epgColIdx >= state.epgColsCells.length) state.epgColIdx = 0;
    applyEpgFocus();
  }

  function renderEpgGridContents() {
    // ツールバーのアクティブ表示更新
    var ctrlBtns = dom.epgControls.querySelectorAll('button');
    for (var b = 0; b < ctrlBtns.length; b++) {
      var bt = ctrlBtns[b].getAttribute('data-epg-type');
      var cls = 'btn-action';
      if (bt && bt === state.epgType) cls += ' epg-active';
      if (state.epgInToolbar && state.epgToolbarIdx === b) cls += ' focused';
      ctrlBtns[b].className = cls;
    }

    var startMs = state.epgBaseHourMs;
    var endMs = startMs + EPG_HOURS_SPAN * 3600 * 1000;
    var sd = new Date(startMs);
    var wk = ['日', '月', '火', '水', '木', '金', '土'][sd.getDay()];
    var extraHint = '';
    if (state.epgType === 'ABEMA') {
      var abRsvCnt = countActiveAbemaReserves();
      extraHint = abRsvCnt > 0 ? ('  [ABEMA予約 ' + abRsvCnt + '件]') : '';
    }
    dom.epgRangeLabel.textContent =
      (sd.getMonth() + 1) + '/' + sd.getDate() + '(' + wk + ') ' +
      formatHm(startMs) + '〜' + formatHm(endMs) + extraHint;

    dom.epgChHeaders.innerHTML = '';
    dom.epgTimeAxis.innerHTML = '';
    dom.epgColsWrap.innerHTML = '';

    var totalHeight = EPG_HOURS_SPAN * EPG_PX_PER_HOUR;
    dom.epgTimeAxis.style.height = totalHeight + 'px';
    dom.epgColsWrap.style.height = totalHeight + 'px';

    for (var h = 0; h < EPG_HOURS_SPAN; h++) {
      var hl = document.createElement('div');
      hl.className = 'epg-hour-label';
      hl.style.top = (h * EPG_PX_PER_HOUR) + 'px';
      hl.style.height = EPG_PX_PER_HOUR + 'px';
      var hd = new Date(startMs + h * 3600 * 1000);
      hl.textContent = pad2(hd.getHours()) + ':00';
      dom.epgTimeAxis.appendChild(hl);
    }

    var now = Date.now();

    if (state.epgType === 'ABEMA') {
      renderAbemaEpgGrid(startMs, endMs, totalHeight, now);
      return;
    }

    var chList = getFilteredChannels(state.epgType);
    state.epgChannels = chList;
    state.epgColsCells = [];

    for (var c = 0; c < chList.length; c++) {
      (function (svc, colIdx) {
        var hdr = document.createElement('div');
        hdr.className = 'epg-ch-hdr-cell';
        if (svc.logoUrl) {
          var hLogo = document.createElement('img');
          hLogo.className = 'epg-ch-logo';
          attachChannelLogo(hLogo, svc);
          hdr.appendChild(hLogo);
        }
        var hTxt = document.createElement('span');
        var chLabelNum = svc.displayNum || svc.channelNumber || '';
        hTxt.textContent = (chLabelNum ? (chLabelNum + ' ') : '') + svc.name;
        hdr.appendChild(hTxt);
        dom.epgChHeaders.appendChild(hdr);

        var colEl = document.createElement('div');
        colEl.className = 'epg-col';
        colEl.style.height = totalHeight + 'px';

        var key = svc.networkId + '_' + svc.serviceId;
        var allProgs = state.programsMap[key] || [];
        var colCells = [];

        for (var pIdx = 0; pIdx < allProgs.length; pIdx++) {
          var p = allProgs[pIdx];
          if (p.endAt <= startMs || p.startAt >= endMs) continue;

          var visStart = Math.max(startMs, p.startAt);
          var visEnd   = Math.min(endMs, p.endAt);
          var topPx    = Math.round(((visStart - startMs) / 3600000) * EPG_PX_PER_HOUR);
          var heightPx = Math.max(48, Math.round(((visEnd - visStart) / 3600000) * EPG_PX_PER_HOUR) - 3);

          (function (prog, rowIdx) {
            var cell = document.createElement('div');
            var onAir = (prog.startAt <= now && now < prog.endAt);
            var cellRec = findActiveRecording(prog.id, svc.serviceId, prog.startAt);
            var cellRsv = !cellRec ? findActiveReserve(prog.id, svc.serviceId, prog.startAt) : null;
            cell.className = 'epg-cell' +
              (onAir ? ' on-air' : '') +
              (cellRec ? ' is-recording' : (cellRsv ? ' is-reserved' : ''));
            cell.style.top = topPx + 'px';
            cell.style.height = heightPx + 'px';

            var tm = document.createElement('div');
            tm.className = 'epg-cell-time';
            tm.textContent = formatHm(prog.startAt) + '〜' + formatHm(prog.endAt);
            if (cellRec) {
              var bRec = document.createElement('span');
              bRec.className = 'epg-rec-badge recording';
              bRec.textContent = '録画中';
              tm.appendChild(bRec);
            } else if (cellRsv) {
              var bRsv = document.createElement('span');
              bRsv.className = 'epg-rec-badge reserved';
              bRsv.textContent = cellRsv.isConflict ? '競合' : '予約済';
              tm.appendChild(bRsv);
            }

            var tt = document.createElement('div');
            tt.className = 'epg-cell-title';
            tt.textContent = prog.name;

            cell.appendChild(tm);
            cell.appendChild(tt);
            if (heightPx >= 110 && prog.description) {
              var ds = document.createElement('div');
              ds.className = 'epg-cell-desc';
              ds.textContent = prog.description;
              cell.appendChild(ds);
            }

            cell.onclick = function (ev) {
              ev.stopPropagation();
              state.epgInToolbar = false;
              state.epgColIdx = colIdx;
              state.epgRowIdx = rowIdx;
              applyEpgFocus();
              openEpgProgramDetail(svc, prog);
            };

            colEl.appendChild(cell);
            colCells.push({ el: cell, prog: prog, svc: svc, topPx: topPx, heightPx: heightPx });
          })(p, colCells.length);
        }

        // 番組情報が空のチャンネルにもプレースホルダセルを置く
        if (colCells.length === 0) {
          var emptyCell = document.createElement('div');
          emptyCell.className = 'epg-cell';
          emptyCell.style.top = '4px';
          emptyCell.style.height = '120px';
          emptyCell.innerHTML = '<div class="epg-cell-title">番組データ未取得</div>';
          emptyCell.onclick = function () {
            closeEpgGrid();
            playLiveChannel(svc);
          };
          colEl.appendChild(emptyCell);
          colCells.push({ el: emptyCell, prog: null, svc: svc, topPx: 4, heightPx: 120 });
        }

        dom.epgColsWrap.appendChild(colEl);
        state.epgColsCells.push(colCells);
      })(chList[c], c);
    }

    // 現在時刻ライン描画
    if (now >= startMs && now <= endMs) {
      var nowTop = Math.round(((now - startMs) / 3600000) * EPG_PX_PER_HOUR);
      var line = document.createElement('div');
      line.className = 'epg-now-line';
      line.style.top = nowTop + 'px';
      line.style.width = (chList.length * 288) + 'px';
      dom.epgColsWrap.appendChild(line);
    }

    // スクロール連動 (横スクロールで局ヘッダ、縦スクロールで時刻軸を同期)
    dom.epgGridScroll.onscroll = function () {
      dom.epgChHeaders.scrollLeft = dom.epgGridScroll.scrollLeft;
      dom.epgTimeAxis.scrollTop = dom.epgGridScroll.scrollTop;
    };

    if (state.epgColIdx >= state.epgColsCells.length) state.epgColIdx = 0;
    applyEpgFocus();
  }

  function applyEpgFocus() {
    var ctrlBtns = dom.epgControls.querySelectorAll('button');
    for (var b = 0; b < ctrlBtns.length; b++) {
      var baseCls = ctrlBtns[b].className.replace(/\s*focused/g, '');
      if (state.epgInToolbar && state.epgToolbarIdx === b) baseCls += ' focused';
      ctrlBtns[b].className = baseCls;
    }

    for (var c = 0; c < state.epgColsCells.length; c++) {
      var col = state.epgColsCells[c];
      for (var r = 0; r < col.length; r++) {
        col[r].el.className = col[r].el.className.replace(/\s*focused/g, '');
      }
    }

    if (state.epgInToolbar || state.epgColsCells.length === 0) return;

    var curCol = state.epgColsCells[state.epgColIdx] || [];
    if (state.epgRowIdx >= curCol.length) state.epgRowIdx = Math.max(0, curCol.length - 1);
    var item = curCol[state.epgRowIdx];
    if (!item) return;

    item.el.className += ' focused';

    // スクロール位置自動追従
    var colLeft = state.epgColIdx * 288;
    var colRight = colLeft + 288;
    var sc = dom.epgGridScroll;
    if (colLeft < sc.scrollLeft + 40) {
      sc.scrollLeft = Math.max(0, colLeft - 40);
    } else if (colRight > sc.scrollLeft + sc.clientWidth - 40) {
      sc.scrollLeft = colRight - sc.clientWidth + 40;
    }

    if (item.topPx < sc.scrollTop + 40) {
      sc.scrollTop = Math.max(0, item.topPx - 40);
    } else if (item.topPx + item.heightPx > sc.scrollTop + sc.clientHeight - 40) {
      sc.scrollTop = item.topPx + item.heightPx - sc.clientHeight + 40;
    }
  }

  function playAbemaChannelById(chId, chName, slot) {
    var latest = findLatestAbemaLiveChannel(chId);
    if (latest) {
      playVodItem(latest, false);
      return;
    }
    playVodItem({
      id: chId,
      provider: 'ABEMA',
      pageUrl: 'https://abema.tv/now-on-air/' + encodeURIComponent(chId),
      seriesTitle: chName || chId,
      title: (slot && slot.title) || chName || chId,
      thumbnail: (slot && slot.thumbnail) ? proxyAbemaThumbUrl(slot.thumbnail) : '',
      startAt: (slot && slot.startAt) || 0,
      endAt: (slot && slot.endAt) || 0,
      isLive: true
    }, false);
  }

  function openAbemaEpgProgramDetail(ch, slot) {
    var isDrmCh = !!ch.isDrm;
    if (!isDrmCh) {
      var latestChDrm = findLatestAbemaLiveChannel({ id: ch.id });
      if (latestChDrm && latestChDrm.isDrm) isDrmCh = true;
    }
    if (isDrmCh) {
      openModal(
        ch.name + '  |  DRM保護',
        (slot && slot.title) || ch.name,
        'このチャンネルは DRM 保護対象のため、DTV Plus からの視聴・録画には対応していません。',
        [{ label: '閉じる' }]
      );
      return;
    }

    if (!slot) {
      openModal(
        ch.name,
        'この時間帯の番組データなし',
        'この時間帯の番組情報は取得されていません。現在放送中のチャンネルを視聴できます。',
        [
          {
            label: 'このチャンネルを視聴する',
            primary: true,
            onClick: function () {
              closeEpgGrid();
              playAbemaChannelById(ch.id, ch.name, null);
            }
          },
          { label: '閉じる' }
        ]
      );
      return;
    }

    var now = Date.now();
    var isOnAir = (slot.startAt <= now && now < slot.endAt);
    var isPast = (slot.endAt <= now + 10000);
    var timeStr = formatDateWeekHm(slot.startAt) + ' 〜 ' + formatHm(slot.endAt);
    var rsv = findAbemaReserveForSlot(slot.id, ch.id, slot.startAt, slot.endAt);
    var isRec = !!(rsv && rsv.status === 'recording');
    var isRsv = !!(rsv && rsv.status === 'scheduled');

    var btns = [];
    if (isOnAir && !slot.isOffAir) {
      btns.push({
        label: 'このチャンネルを視聴する',
        primary: true,
        onClick: function () {
          closeEpgGrid();
          playAbemaChannelById(ch.id, ch.name, slot);
        }
      });
    }

    if (isRecordingFeatureEnabled() && normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl) && !isPast && !slot.isOffAir) {
      if (isRec) {
        btns.push({
          label: '■ 録画を終了して保存',
          danger: true,
          onClick: function () {
            cancelAbemaReserve(rsv);
          }
        });
      } else if (isRsv) {
        btns.push({
          label: '× 録画予約を取り消す',
          danger: true,
          onClick: function () {
            cancelAbemaReserve(rsv);
          }
        });
      } else {
        btns.push({
          label: isOnAir ? '● 録画開始' : '● 録画予約',
          primary: !isOnAir,
          onClick: function () {
            registerAbemaReserve(ch, slot);
          }
        });
      }
    }

    if (!isOnAir && !slot.isOffAir) {
      btns.push({
        label: 'このチャンネルの現在放送を視聴',
        onClick: function () {
          closeEpgGrid();
          playAbemaChannelById(ch.id, ch.name, null);
        }
      });
    }

    btns.push({
      label: 'ABEMA 予約一覧を開く',
      onClick: function () {
        closeEpgGrid();
        state.recServerMode = 'MEDIASAVE';
        openRecordedOverlay('MS_ABEMA_RESERVES');
      }
    });
    btns.push({ label: '閉じる' });

    var subTxt = ch.name + '  |  ' + timeStr + (slot.genre ? ('  [' + slot.genre + ']') : '');
    var bodyTxt = slot.description || '番組詳細情報はありません。';
    if (isRec) {
      bodyTxt = '【現在録画中】配信保存サーバーで CM 自動スキップ録画を実行中です。\n\n' + bodyTxt;
    } else if (isRsv) {
      bodyTxt = '【録画予約済】放送開始時刻に配信保存サーバーが自動で CM カット録画を実行します。\n\n' + bodyTxt;
    } else if (isPast) {
      bodyTxt = '【放送終了】この番組は放送が終了しています。\n\n' + bodyTxt;
    }

    openModal(subTxt, slot.title || ch.name, bodyTxt, btns);
  }

  function openEpgProgramDetail(svc, prog) {
    if (svc && svc.isAbemaChannel) {
      openAbemaEpgProgramDetail(svc, prog);
      return;
    }
    if (!prog) {
      closeEpgGrid();
      playLiveChannel(svc);
      return;
    }
    var timeStr = formatHm(prog.startAt) + ' 〜 ' + formatHm(prog.endAt);
    var fullDesc = prog.description || '';
    if (prog.extendedText) {
      fullDesc += (fullDesc ? '\n\n' : '') + prog.extendedText;
    }

    var epgModalBtns = [
      {
        label: 'このチャンネルを視聴する',
        primary: true,
        onClick: function () {
          closeEpgGrid();
          playLiveChannel(svc);
        }
      }
    ];
    if (isRecordingFeatureEnabled()) {
      var epgRec = findActiveRecording(prog.id, svc.serviceId, prog.startAt);
      var epgRsv = !epgRec ? findActiveReserve(prog.id, svc.serviceId, prog.startAt) : null;
      epgModalBtns.push({
        label: epgRec ? '■ 録画停止' : (epgRsv ? '× 予約取消' : '● 録画予約'),
        danger: !!(epgRec || epgRsv),
        onClick: function () {
          promptRecordingAction({
            kind: 'DTV (EPG予約)',
            title: prog.name,
            channel: svc.name,
            channelType: svc.channelType || '',
            networkId: svc.networkId || 0,
            timeLabel: timeStr,
            startAt: prog.startAt,
            serviceId: svc.serviceId || svc.id,
            programId: prog.id
          });
        }
      });
    }
    epgModalBtns.push({ label: '閉じる' });

    openModal(
      svc.name + '  |  ' + timeStr,
      prog.name,
      fullDesc || '番組詳細情報はありません。',
      epgModalBtns
    );
  }

  // EPG上部ツールバーのクリック動作
  (function bindEpgToolbar() {
    var ctrlBtns = dom.epgControls.querySelectorAll('button');
    for (var i = 0; i < ctrlBtns.length; i++) {
      (function (btn) {
        btn.onclick = function () {
          var t = btn.getAttribute('data-epg-type');
          var sh = btn.getAttribute('data-epg-shift');
          if (t) {
            var alreadySame = (state.epgType === t);
            state.epgType = t;
            state.epgColIdx = 0;
            state.epgRowIdx = 0;
            renderEpgGridContents();
            if (t === 'ABEMA') {
              if (alreadySame) showRichToast('info', 'ABEMA 番組表を更新中…', '保存サーバーのキャッシュを最新化します');
              ensureAbemaTimetableLoaded(alreadySame);
            } else {
              refreshEpgStationLiveStatus();
            }
          } else if (sh !== null) {
            var delta = parseInt(sh, 10);
            if (delta === 0) {
              var d = new Date();
              d.setMinutes(0, 0, 0);
              state.epgBaseHourMs = d.getTime();
            } else {
              state.epgBaseHourMs += delta * 3600 * 1000;
            }
            state.epgRowIdx = 0;
            renderEpgGridContents();
          } else if (btn.id === 'btn-epg-close') {
            closeEpgGrid();
          }
        };
      })(ctrlBtns[i]);
    }
  })();

  // =========================================================================
  // 6b. 全画面 録画・保存ライブラリ (EPGStation 録画閲覧/ソート/検索 + TVer/ABEMA 保存一覧)
  // =========================================================================
  var REC_PAGE_SIZE = 30;

  function loadEpgStationConnection(showToast, onDone) {
    if (!isRecordingFeatureEnabled()) {
      if (onDone) onDone(false);
      return;
    }
    var base = window.EpgStationClient.normalizeBaseUrl(state.settings.epgstationUrl);
    if (!base) {
      state.epgstationVersion = null;
      state.epgstationStorageText = '';
      if (onDone) onDone(false);
      return;
    }

    window.EpgStationClient.checkVersion(base, function (err, ver) {
      if (err || !ver) {
        state.epgstationVersion = null;
        if (showToast) {
          showRichToast('error', 'EPGStation 接続エラー', String(err || '応答なし'));
        }
        if (state.currentTab === 'SETTINGS' || state.currentTab === 'RECORDED') renderCurrentTab();
        if (onDone) onDone(false);
        return;
      }

      state.epgstationVersion = ver.version + ' (' + ver.latencyMs + 'ms)';
      if (showToast) {
        showRichToast('success', 'EPGStation 接続成功', 'Ver ' + ver.version + ' (' + base + ')');
      }

      window.EpgStationClient.fetchStorages(base, function (sErr, st) {
        if (!sErr && st) {
          state.epgstationStorageText = st.summaryText;
          if (dom.recStorageBadge) dom.recStorageBadge.textContent = st.summaryText;
        }
      });

      window.EpgStationClient.fetchFilterMetadata(base, state.settings.mirakurunUrl, function (mErr, meta) {
        if (!mErr && meta) {
          state.epgstationMeta = meta;
        }
        if (state.currentTab === 'SETTINGS' || state.currentTab === 'RECORDED') renderCurrentTab();
        if (state.recOverlayOpen) {
          renderRecSidebar();
          refreshRecordedOverlayData();
        }
        if (onDone) onDone(true);
      });
    });
  }

  function fetchMediaSavePing(callback) {
    var base = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
    if (!base) {
      state.mediaSaveMeta = null;
      if (callback) callback(false);
      return;
    }
    mediaSaveRequest('GET', '/api/ping', null, function (err, info) {
      if (!err && info && info.ok) {
        if (!state.mediaSaveMeta) state.mediaSaveMeta = {};
        state.mediaSaveMeta.itemCount = Number(info.itemCount) || 0;
        state.mediaSaveMeta.activeJobs = Number(info.activeJobs) || 0;
        state.mediaSaveMeta.freeGb = info.freeGb;
        if (state.recOverlayOpen) {
          renderRecSidebar();
          if (state.recServerMode === 'MEDIASAVE' && info.freeGb != null && dom.recStorageBadge) {
            dom.recStorageBadge.textContent = '空き ' + info.freeGb + ' GB';
          }
        }
        if (callback) callback(true, info);
      } else {
        if (callback) callback(false, null);
      }
    });
  }

  function openRecordedOverlay(initialCategory) {
    if (!isRecordingFeatureEnabled()) {
      showRichToast('info', '現在は視聴専用モードです', '[設定] タブから録画・保存連携モードを有効にしてください');
      return;
    }
    if (initialCategory === 'SAVED_VOD' || (initialCategory && initialCategory.indexOf('MS_') === 0)) {
      state.recServerMode = 'MEDIASAVE';
      state.recCategory = initialCategory;
      state.recPage = 0;
    } else if (initialCategory) {
      state.recServerMode = 'EPGSTATION';
      state.recCategory = initialCategory;
      state.recPage = 0;
    }
    state.recOverlayOpen = true;
    state.recZone = 'LIST';
    state.recListIdx = 0;

    if (state.epgOpen) closeEpgGrid();
    setDrawerOpen(false);
    hideOsdBanner();
    dom.recOverlay.className = '';
    dom.recStorageBadge.textContent = (state.recServerMode === 'MEDIASAVE' && state.mediaSaveMeta && state.mediaSaveMeta.freeGb != null)
      ? ('空き ' + state.mediaSaveMeta.freeGb + ' GB')
      : (state.epgstationStorageText || '');

    if (!state.epgstationMeta && state.settings.epgstationUrl) {
      loadEpgStationConnection(false, function () {});
    }
    fetchMediaSavePing();
    refreshMediaSavedIds(null, true);
    refreshAbemaReserves(function () {
      if (state.recOverlayOpen && state.recServerMode === 'MEDIASAVE') renderRecSidebar();
    });
    renderRecSidebar();
    refreshRecordedOverlayData();
  }

  function closeRecordedOverlay() {
    state.recOverlayOpen = false;
    dom.recOverlay.className = 'hidden';
    wakeBottomGuide();
  }

  function buildRecSidebarDefs() {
    var defs = [];
    var srvList = state.settings.epgstationServers || [];
    var saveSrvBase = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
    if (srvList.length > 0 || saveSrvBase) {
      defs.push({ section: '接続先メディアサーバー' });
      for (var sv = 0; sv < srvList.length; sv++) {
        var srv = srvList[sv];
        var isCurSrv = (state.recServerMode === 'EPGSTATION') && (srv.id === state.settings.activeEpgstationId);
        defs.push({
          id: 'SERVER:' + srv.id,
          isServerSwitch: true,
          serverId: srv.id,
          isActiveServer: isCurSrv,
          label: (isCurSrv ? '● ' : '○ ') + formatServerDisplayName(srv),
          count: srv.readOnly !== false ? '保護' : ''
        });
      }
      if (saveSrvBase) {
        var isMsAct = (state.recServerMode === 'MEDIASAVE');
        var msCnt = (state.mediaSaveMeta && state.mediaSaveMeta.itemCount !== undefined)
          ? state.mediaSaveMeta.itemCount
          : '';
        defs.push({
          id: 'SERVER:MEDIASAVE',
          isMediaSaveSwitch: true,
          isActiveServer: isMsAct,
          label: (isMsAct ? '● ' : '○ ') + '配信保存サーバー',
          count: msCnt
        });
      }
    }

    var resumeCnt = (state.history.RECORDED || []).length;

    // 配信保存サーバー選択時は、TVer/ABEMA区分・ジャンル別・TVer放送局別・番組名別のサイドバーを表示
    if (state.recServerMode === 'MEDIASAVE' && saveSrvBase) {
      var msAllCnt = (state.mediaSaveMeta && state.mediaSaveMeta.itemCount !== undefined)
        ? state.mediaSaveMeta.itemCount
        : (state.recTotalCount || '');
      var tverCnt = 0;
      var abemaCnt = 0;
      var pCounts = (state.mediaSaveMeta && state.mediaSaveMeta.providerCounts) || [];
      for (var pi = 0; pi < pCounts.length; pi++) {
        if (pCounts[pi].name === 'TVER') tverCnt = pCounts[pi].count;
        else if (pCounts[pi].name === 'ABEMA') abemaCnt = pCounts[pi].count;
      }

      var abemaRsvCnt = countActiveAbemaReserves();
      defs.push({ section: 'ライブラリ・保存区分' });
      defs.push({ id: 'SAVED_VOD', label: 'すべての保存動画', count: msAllCnt });
      defs.push({ id: 'MS_ABEMA_RESERVES', label: 'ABEMA 録画予約', count: abemaRsvCnt || '' });
      defs.push({ id: 'MS_PROV:TVER', label: 'TVer', count: tverCnt });
      defs.push({ id: 'MS_PROV:ABEMA', label: 'ABEMA', count: abemaCnt });
      defs.push({ id: 'RESUME', label: '視聴途中', count: resumeCnt });

      if (state.mediaSaveMeta && state.mediaSaveMeta.genreCounts && state.mediaSaveMeta.genreCounts.length > 0) {
        defs.push({ section: 'ジャンル別' });
        for (var mg = 0; mg < state.mediaSaveMeta.genreCounts.length; mg++) {
          var gItem = state.mediaSaveMeta.genreCounts[mg];
          defs.push({ id: 'MS_GENRE:' + gItem.name, label: gItem.name, count: gItem.count });
        }
      }
      if (state.mediaSaveMeta && state.mediaSaveMeta.tverBroadcasterCounts && state.mediaSaveMeta.tverBroadcasterCounts.length > 0) {
        defs.push({ section: 'TVer 放送局別' });
        for (var bc = 0; bc < state.mediaSaveMeta.tverBroadcasterCounts.length; bc++) {
          var bItem = state.mediaSaveMeta.tverBroadcasterCounts[bc];
          defs.push({ id: 'MS_TVER_CH:' + bItem.name, label: bItem.name, count: bItem.count });
        }
      }
      if (state.mediaSaveMeta && state.mediaSaveMeta.seriesCounts && state.mediaSaveMeta.seriesCounts.length > 0) {
        defs.push({ section: '番組名・シリーズ別' });
        for (var sr = 0; sr < state.mediaSaveMeta.seriesCounts.length; sr++) {
          var sc = state.mediaSaveMeta.seriesCounts[sr];
          defs.push({ id: 'MS_SERIES:' + sc.name, label: sc.name, count: sc.count });
        }
      }
      return defs;
    }

    var recNowCnt = (state.activeRecordingList || []).length;
    var rsvNowCnt = (state.activeReserveList || []).length;

    defs.push({ section: 'ライブラリ・保存区分' });
    defs.push({ id: 'ALL', label: 'すべての録画番組', count: state.recTotalCount || '' });
    defs.push({ id: 'RECORDING_NOW', label: '録画中', count: recNowCnt || '' });
    defs.push({ id: 'RESERVES', label: '録画予約一覧', count: rsvNowCnt || '' });
    defs.push({ id: 'RESUME', label: '視聴途中', count: resumeCnt });
    if (!saveSrvBase) {
      var vodSavedCnt = 0;
      for (var q = 0; q < state.recQueue.length; q++) {
        if (state.recQueue[q].kind === 'TVER' || state.recQueue[q].kind === 'ABEMA') vodSavedCnt++;
      }
      defs.push({ id: 'SAVED_VOD', label: '配信保存リスト', count: vodSavedCnt });
    }

    if (state.epgstationMeta) {
      if (state.epgstationMeta.rules && state.epgstationMeta.rules.length > 0) {
        defs.push({ section: '自動予約ルール・シリーズ別' });
        for (var r = 0; r < state.epgstationMeta.rules.length; r++) {
          var rl = state.epgstationMeta.rules[r];
          defs.push({ id: 'RULE:' + rl.id, label: rl.keyword, count: '' });
        }
      }
      if (state.epgstationMeta.genreCounts && state.epgstationMeta.genreCounts.length > 0) {
        defs.push({ section: 'ジャンル別' });
        for (var g = 0; g < state.epgstationMeta.genreCounts.length; g++) {
          var gc = state.epgstationMeta.genreCounts[g];
          defs.push({ id: 'GENRE:' + gc.genre, label: gc.name, count: gc.count });
        }
      }
      if (state.epgstationMeta.channelCounts && state.epgstationMeta.channelCounts.length > 0) {
        defs.push({ section: '放送局別' });
        for (var c = 0; c < state.epgstationMeta.channelCounts.length; c++) {
          var cc = state.epgstationMeta.channelCounts[c];
          defs.push({ id: 'CH:' + cc.channelId, label: cc.name, count: cc.count });
        }
      }
    }
    return defs;
  }

  function renderRecSidebar() {
    dom.recSidebar.innerHTML = '';
    var rawDefs = buildRecSidebarDefs();
    state.recSideDefs = [];

    for (var i = 0; i < rawDefs.length; i++) {
      var d = rawDefs[i];
      if (d.section) {
        var sh = document.createElement('div');
        sh.className = 'rec-side-hdr';
        sh.textContent = d.section;
        dom.recSidebar.appendChild(sh);
        continue;
      }
      (function (itemDef, sIdx) {
        var el = document.createElement('div');
        var isAct = (itemDef.isServerSwitch || itemDef.isMediaSaveSwitch) ? !!itemDef.isActiveServer : (state.recCategory === itemDef.id);
        el.className = 'rec-side-item' + (isAct ? ' active' : '');

        var lb = document.createElement('span');
        lb.className = 'rec-side-label';
        lb.textContent = itemDef.label;
        el.appendChild(lb);

        if (itemDef.count !== '' && itemDef.count !== undefined) {
          var cnt = document.createElement('span');
          cnt.className = 'rec-side-cnt';
          cnt.textContent = String(itemDef.count);
          el.appendChild(cnt);
        }

        el.onclick = function () {
          state.recSideIdx = sIdx;
          if (itemDef.isMediaSaveSwitch) {
            state.recServerMode = 'MEDIASAVE';
            state.recCategory = 'SAVED_VOD';
            state.recPage = 0;
            state.recListIdx = 0;
            if (state.mediaSaveMeta && state.mediaSaveMeta.freeGb != null && dom.recStorageBadge) {
              dom.recStorageBadge.textContent = '空き ' + state.mediaSaveMeta.freeGb + ' GB';
            }
            renderRecSidebar();
            refreshRecordedOverlayData();
            return;
          }
          if (itemDef.isServerSwitch) {
            var wasMs = (state.recServerMode === 'MEDIASAVE');
            state.recServerMode = 'EPGSTATION';
            if (wasMs || state.recCategory === 'SAVED_VOD' ||
                state.recCategory.indexOf('MS_') === 0 ||
                state.recCategory.indexOf('GENRE:') === 0 ||
                state.recCategory.indexOf('CH:') === 0 ||
                state.recCategory.indexOf('RULE:') === 0) {
              state.recCategory = 'ALL';
            }
            if (dom.recStorageBadge) {
              dom.recStorageBadge.textContent = state.epgstationStorageText || '';
            }
            setActiveEpgServerById(itemDef.serverId, true);
            renderRecSidebar();
            return;
          }
          state.recCategory = itemDef.id;
          state.recPage = 0;
          state.recListIdx = 0;
          renderRecSidebar();
          refreshRecordedOverlayData();
        };
        el.onmouseenter = function () {
          state.recZone = 'SIDEBAR';
          state.recSideIdx = sIdx;
          applyRecOverlayFocus(true);
        };

        dom.recSidebar.appendChild(el);
        state.recSideDefs.push({ el: el, def: itemDef });
      })(d, state.recSideDefs.length);
    }
  }

  function sortClientRecords(arr, sortKey) {
    var copy = arr.slice();
    if (sortKey === 'date_asc') {
      copy.sort(function (a, b) { return (a.startAt || 0) - (b.startAt || 0); });
    } else if (sortKey === 'title_asc') {
      copy.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ja'); });
    } else if (sortKey === 'duration_desc') {
      copy.sort(function (a, b) { return (b.durationSec || 0) - (a.durationSec || 0); });
    } else if (sortKey === 'resume_first') {
      copy.sort(function (a, b) {
        var ra = findRecordedResumeSec(a.id) > 0 ? 1 : 0;
        var rb = findRecordedResumeSec(b.id) > 0 ? 1 : 0;
        if (ra !== rb) return rb - ra;
        return (b.startAt || 0) - (a.startAt || 0);
      });
    } else {
      copy.sort(function (a, b) { return (b.startAt || 0) - (a.startAt || 0); });
    }
    return copy;
  }

  function refreshRecordedOverlayData(silent) {
    updateRecToolbarButtons();
    var cat = state.recCategory;

    // 1. 視聴途中の録画 (ローカル履歴 + 保存サーバー実在チェックで削除済み自動消去)
    if (cat === 'RESUME') {
      var rawRes = state.history.RECORDED || [];
      for (var rh = 0; rh < rawRes.length; rh++) ensureMediaServerFields(rawRes[rh]);
      var resList = sortClientRecords(rawRes, state.recSort);
      state.recItems = resList;
      state.recTotalCount = resList.length;
      dom.recCountLabel.textContent = '視聴途中の録画: ' + resList.length + '件';
      renderRecMainList();
      refreshMediaSavedIds(null, true);
      return;
    }

    // 1b. 配信保存サーバー: ABEMA 録画予約一覧
    if (cat === 'MS_ABEMA_RESERVES') {
      var saveBaseRsv = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
      if (!saveBaseRsv) {
        state.recItems = [];
        dom.recCountLabel.textContent = '配信保存サーバー未設定';
        renderRecMainList();
        return;
      }
      if (!silent) {
        state.recLoading = true;
        dom.recCountLabel.textContent = 'ABEMA 録画予約一覧を取得中…';
        renderRecMainList();
      }
      mediaSaveRequest('GET', '/api/abema/reserves', null, function (err, data) {
        state.recLoading = false;
        if (!state.recOverlayOpen || state.recCategory !== 'MS_ABEMA_RESERVES') return;
        if (err || !data) {
          state.recItems = [];
          dom.recCountLabel.textContent = 'ABEMA 予約取得エラー';
          renderRecMainList();
          return;
        }
        var rawRsvs = data.reserves || [];
        state.abemaReserves = rawRsvs;
        state.abemaLiveJobs = data.activeLiveJobs || [];
        var cards = [];
        var kwLow = (state.recKeyword || '').toLowerCase();
        for (var ri = 0; ri < rawRsvs.length; ri++) {
          var r = rawRsvs[ri];
          if (kwLow) {
            var hay = ((r.title || '') + ' ' + (r.channelName || '') + ' ' + (r.series || '') + ' ' + (r.description || '')).toLowerCase();
            if (hay.indexOf(kwLow) === -1) continue;
          }
          var stLabel = '予約待機';
          if (r.status === 'recording') stLabel = '録画中 ' + Math.round(r.jobProgress || 0) + '%';
          else if (r.status === 'done') stLabel = '録画完了';
          else if (r.status === 'error') stLabel = 'エラー';
          else if (r.status === 'missed') stLabel = '終了済';
          else if (r.status === 'cancelled') stLabel = 'キャンセル済';
          var durS = (r.endAt && r.startAt && r.endAt > r.startAt) ? Math.round((r.endAt - r.startAt) / 1000) : 0;
          var descLine = (r.status === 'recording' && r.jobStatusText)
            ? (r.jobStatusText + (r.description ? (' / ' + r.description) : ''))
            : ((r.status === 'error' && r.error) ? ('エラー: ' + r.error) : (stLabel + '  |  ' + (r.description || 'CM自動カット録画予約')));
          cards.push({
            isAbemaReserveEntry: true,
            isReserveEntry: (r.status === 'scheduled'),
            isRecording: (r.status === 'recording'),
            abemaReserveData: r,
            id: r.id,
            name: (r.status === 'scheduled' || r.status === 'recording' ? '' : ('[' + stLabel + '] ')) + (r.title || r.channelName),
            channelName: 'ABEMA / ' + (r.channelName || r.channelId),
            startAt: r.startAt || 0,
            durationSec: durS,
            genreLabel: r.genre || 'ABEMA',
            thumbnailUrl: r.thumbnail ? proxyAbemaThumbUrl(r.thumbnail) : '',
            description: descLine
          });
        }
        state.recItems = cards;
        state.recTotalCount = cards.length;
        dom.recCountLabel.textContent = 'ABEMA 録画予約一覧: ' + countActiveAbemaReserves() + '件有効 (全' + cards.length + '件)';
        renderRecSidebar();
        renderRecMainList();
      });
      return;
    }

    // 2. 配信保存サーバー (TVer/ABEMA区分・ジャンル別・TVer放送局別・番組名別)
    var isMediaSaveCat = (cat === 'SAVED_VOD' || cat.indexOf('MS_') === 0);
    if (isMediaSaveCat) {
      var saveSrvBase = normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl);
      if (saveSrvBase) {
        if (!silent) {
          state.recLoading = true;
          dom.recCountLabel.textContent = '配信保存ライブラリを取得中…';
          renderRecMainList();
        }

        var qsArr = [];
        if (state.recKeyword) qsArr.push('q=' + encodeURIComponent(state.recKeyword));
        if (cat.indexOf('MS_PROV:') === 0) qsArr.push('provider=' + encodeURIComponent(cat.slice(8)));
        if (cat.indexOf('MS_GENRE:') === 0) qsArr.push('genre=' + encodeURIComponent(cat.slice(9)));
        if (cat.indexOf('MS_TVER_CH:') === 0) {
          qsArr.push('provider=TVER');
          qsArr.push('broadcaster=' + encodeURIComponent(cat.slice(11)));
        }
        if (cat.indexOf('MS_SERIES:') === 0) qsArr.push('series=' + encodeURIComponent(cat.slice(10)));
        if (cat.indexOf('MS_CH:') === 0) qsArr.push('broadcaster=' + encodeURIComponent(cat.slice(6)));
        var qParam = qsArr.length > 0 ? ('?' + qsArr.join('&')) : '';
        var jobsData = null;
        var itemsData = null;
        var itemsErr = null;
        var waitCnt = 2;

        function finishSavedVodLoad() {
          waitCnt--;
          if (waitCnt > 0) return;
          state.recLoading = false;
          // 取得完了前に別カテゴリや閉じた状態へ移っていたら何もしない
          if (!state.recOverlayOpen || state.recCategory !== cat) return;
          if (itemsErr && !itemsData) {
            if (!silent) {
              // 保存サーバー未起動時は従来のアプリ内保存リストにフォールバック
              loadLocalSavedVodFallback('保存サーバー未接続 (ローカルリスト表示)');
            }
            return;
          }
          // サイドバー用の全集計メタデータを最新化
          var prevMetaJson = state.mediaSaveMeta ? JSON.stringify({
            c: state.mediaSaveMeta.itemCount,
            p: state.mediaSaveMeta.providerCounts,
            g: state.mediaSaveMeta.genreCounts,
            tb: state.mediaSaveMeta.tverBroadcasterCounts,
            s: state.mediaSaveMeta.seriesCounts
          }) : '';
          if (!state.mediaSaveMeta) state.mediaSaveMeta = {};
          state.mediaSaveMeta.itemCount = (itemsData.allTotal !== undefined) ? itemsData.allTotal : (itemsData.total || 0);
          if (itemsData.providerCounts) state.mediaSaveMeta.providerCounts = itemsData.providerCounts;
          if (itemsData.genreCounts) state.mediaSaveMeta.genreCounts = itemsData.genreCounts;
          if (itemsData.tverBroadcasterCounts) state.mediaSaveMeta.tverBroadcasterCounts = itemsData.tverBroadcasterCounts;
          if (itemsData.seriesCounts) state.mediaSaveMeta.seriesCounts = itemsData.seriesCounts;
          if (itemsData.broadcasterCounts) state.mediaSaveMeta.broadcasterCounts = itemsData.broadcasterCounts;
          var nextMetaJson = JSON.stringify({
            c: state.mediaSaveMeta.itemCount,
            p: state.mediaSaveMeta.providerCounts,
            g: state.mediaSaveMeta.genreCounts,
            tb: state.mediaSaveMeta.tverBroadcasterCounts,
            s: state.mediaSaveMeta.seriesCounts
          });
          if (prevMetaJson !== nextMetaJson) {
            renderRecSidebar();
          }

          var merged = [];
          var showJobs = (cat === 'SAVED_VOD' || cat === 'MS_PROV:TVER' || cat === 'MS_PROV:ABEMA');
          var jArr = (showJobs && jobsData && jobsData.jobs) ? jobsData.jobs : [];
          for (var j = 0; j < jArr.length; j++) {
            var jb = jArr[j];
            if (jb.status !== 'queued' && jb.status !== 'downloading' && jb.status !== 'error') continue;
            if (cat === 'MS_PROV:TVER' && jb.provider !== 'TVER') continue;
            if (cat === 'MS_PROV:ABEMA' && jb.provider !== 'ABEMA') continue;
            var pctTxt = jb.status === 'downloading'
              ? ('保存中 ' + Math.round(jb.progress || 0) + '%')
              : (jb.status === 'queued' ? '待機中' : '保存エラー');
            merged.push({
              isMediaServerJob: true,
              jobData: jb,
              isRecording: (jb.status === 'downloading'),
              id: jb.id,
              name: '[' + pctTxt + '] ' + (jb.title || jb.url),
              channelName: (jb.provider || 'WEB') + (jb.broadcaster ? (' / ' + jb.broadcaster) : ''),
              startAt: jb.createdAt || 0,
              durationSec: 0,
              thumbnailUrl: jb.thumbnail || '',
              description: jb.error ? ('エラー: ' + jb.error) : (jb.statusText || pctTxt)
            });
          }
          var sArr = (itemsData && itemsData.items) ? itemsData.items : [];
          for (var k = 0; k < sArr.length; k++) {
            var it = sArr[k];
            merged.push({
              isMediaServerItem: true,
              mediaItemId: it.id,
              directVideoUrl: saveSrvBase + '/api/video/' + encodeURIComponent(it.id),
              id: 'ms_' + it.id,
              name: it.title || it.fileName,
              channelName: (it.provider === 'TVER' && it.broadcaster && it.broadcaster !== 'その他')
                ? ('TVer / ' + it.broadcaster)
                : (it.provider || it.broadcaster || 'LOCAL'),
              startAt: it.mtimeMs || 0,
              durationSec: it.durationSec || 0,
              sizeLabel: it.sizeLabel || '',
              hasEncoded: true,
              genreLabel: it.genre || it.series || '',
              thumbnailUrl: saveSrvBase + '/api/thumb/' + encodeURIComponent(it.id),
              description: it.description || (it.fileName + (it.width ? (' (' + it.width + 'x' + it.height + ')') : ''))
            });
          }
          var jobEntries = [];
          var fileEntries = [];
          for (var m = 0; m < merged.length; m++) {
            if (merged[m].isMediaServerJob) jobEntries.push(merged[m]);
            else fileEntries.push(merged[m]);
          }
          fileEntries = sortClientRecords(fileEntries, state.recSort);
          var nextItems = jobEntries.concat(fileEntries);
          var prevItems = state.recItems || [];
          var sameLayout = silent && (nextItems.length === prevItems.length);
          if (sameLayout) {
            for (var si = 0; si < nextItems.length; si++) {
              if (nextItems[si].id !== prevItems[si].id) {
                sameLayout = false;
                break;
              }
            }
          }

          state.recItems = nextItems;
          state.recTotalCount = fileEntries.length;
          var labelPrefix = '配信保存済み';
          if (cat === 'MS_PROV:TVER') labelPrefix = 'TVer 保存済み';
          else if (cat === 'MS_PROV:ABEMA') labelPrefix = 'ABEMA 保存済み';
          else if (cat.indexOf('MS_GENRE:') === 0) labelPrefix = 'ジャンル「' + cat.slice(9) + '」';
          else if (cat.indexOf('MS_TVER_CH:') === 0) labelPrefix = 'TVer 放送局「' + cat.slice(11) + '」';
          else if (cat.indexOf('MS_SERIES:') === 0) labelPrefix = '番組「' + cat.slice(10) + '」';
          dom.recCountLabel.textContent = labelPrefix + ': ' + fileEntries.length + '件' + (jobEntries.length > 0 ? (' / 処理中 ' + jobEntries.length + '件') : '');

          if (sameLayout) {
            // 並び順・件数が同じなら DOM を作り直さず、進捗ジョブカードのテキストのみインプレース更新 (チラつき・読み込み中表示ゼロ)
            var cards = dom.recMainList.querySelectorAll('.rec-item-card');
            for (var ci = 0; ci < nextItems.length && ci < cards.length; ci++) {
              if (!nextItems[ci].isMediaServerJob) continue;
              var tEl = cards[ci].querySelector('.rec-card-title');
              if (tEl && tEl.textContent !== nextItems[ci].name) {
                tEl.textContent = nextItems[ci].name;
              }
              var dEl = cards[ci].querySelector('.rec-card-desc span');
              if (dEl && dEl.textContent !== (nextItems[ci].description || '')) {
                dEl.textContent = nextItems[ci].description || '';
              }
            }
          } else {
            var prevScroll = dom.recMainList ? dom.recMainList.scrollTop : 0;
            renderRecMainList();
            if (silent && dom.recMainList) {
              dom.recMainList.scrollTop = prevScroll;
            }
          }

          // 保存中/待機中ジョブがある間は 3 秒ごとに静穏更新 (silent=true)
          if (state.saveJobsPollTimer) {
            clearTimeout(state.saveJobsPollTimer);
            state.saveJobsPollTimer = null;
          }
          if (jobEntries.length > 0 && state.recOverlayOpen && state.recCategory === cat) {
            state.saveJobsPollTimer = setTimeout(function () {
              state.saveJobsPollTimer = null;
              if (state.recOverlayOpen && state.recCategory === cat && !state.modalOpen) {
                refreshRecordedOverlayData(true);
              }
            }, 3000);
          }
        }

        mediaSaveRequest('GET', '/api/jobs', null, function (err, d) {
          if (!err && d) jobsData = d;
          finishSavedVodLoad();
        });
        mediaSaveRequest('GET', '/api/items' + qParam, null, function (err, d) {
          itemsErr = err;
          if (!err && d) itemsData = d;
          finishSavedVodLoad();
        });
        return;
      }

      loadLocalSavedVodFallback(null);
      return;
    }

    function loadLocalSavedVodFallback(prefixNote) {
      var vItems = [];
      for (var i = 0; i < state.recQueue.length; i++) {
        var q = state.recQueue[i];
        if (q.kind === 'TVER' || q.kind === 'ABEMA') {
          if (state.recKeyword && q.title.toLowerCase().indexOf(state.recKeyword.toLowerCase()) === -1) continue;
          vItems.push({
            isSavedVodEntry: true,
            queueItem: q,
            id: q.id,
            name: q.title,
            channelName: q.channel || q.kind,
            startAt: q.createdAt || 0,
            durationSec: 0,
            thumbnailUrl: q.thumbnail || '',
            description: '状態: ' + q.status + (q.targetUrl ? (' / URL: ' + q.targetUrl) : '')
          });
        }
      }
      vItems = sortClientRecords(vItems, state.recSort);
      state.recItems = vItems;
      state.recTotalCount = vItems.length;
      dom.recCountLabel.textContent = (prefixNote ? (prefixNote + ' / ') : '') + '配信保存リスト: ' + vItems.length + '件';
      renderRecMainList();
    }

    var base = window.EpgStationClient.normalizeBaseUrl(state.settings.epgstationUrl);
    if (!base) {
      state.recItems = [];
      dom.recCountLabel.textContent = 'EPGStation 未設定';
      renderRecMainList();
      return;
    }

    var chMap = (state.epgstationMeta && state.epgstationMeta.channelMap) || {};

    // 2b. EPGStation 現在録画中一覧
    if (cat === 'RECORDING_NOW') {
      state.recLoading = true;
      dom.recCountLabel.textContent = '録画中一覧を取得中…';
      renderRecMainList();
      window.EpgStationClient.fetchRecording(base, chMap, function (err, data) {
        state.recLoading = false;
        if (err || !data) {
          state.recItems = [];
          dom.recCountLabel.textContent = '録画中取得エラー';
          renderRecMainList();
          return;
        }
        var recs = data.records || [];
        state.recItems = recs;
        state.recTotalCount = data.total;
        dom.recCountLabel.textContent = '録画中一覧: ' + data.total + '件';
        renderRecMainList();
        refreshEpgStationLiveStatus();
      });
      return;
    }

    // 3. EPGStation 録画予約一覧
    if (cat === 'RESERVES') {
      state.recLoading = true;
      dom.recCountLabel.textContent = '予約一覧を取得中…';
      renderRecMainList();
      window.EpgStationClient.fetchReserves(base, chMap, function (err, data) {
        state.recLoading = false;
        if (err || !data) {
          state.recItems = [];
          dom.recCountLabel.textContent = '予約取得エラー';
          renderRecMainList();
          return;
        }
        var rsv = data.reserves || [];
        for (var r = 0; r < rsv.length; r++) rsv[r].isReserveEntry = true;
        state.recItems = rsv;
        state.recTotalCount = data.total;
        dom.recCountLabel.textContent = '録画予約一覧: ' + data.total + '件';
        renderRecMainList();
        refreshEpgStationLiveStatus();
      });
      return;
    }

    // 4. EPGStation 録画済み番組一覧 (ソート・ジャンル・放送局・ルール・キーワード対応)
    state.recLoading = true;
    dom.recCountLabel.textContent = '録画一覧を取得中…';
    renderRecMainList();

    var useClientSort = (state.recSort === 'title_asc' || state.recSort === 'duration_desc' || state.recSort === 'resume_first');
    var queryParams = {
      offset: useClientSort ? 0 : (state.recPage * REC_PAGE_SIZE),
      limit: useClientSort ? 120 : REC_PAGE_SIZE,
      isReverse: (state.recSort === 'date_asc'),
      keyword: state.recKeyword || ''
    };
    if (cat.indexOf('GENRE:') === 0) queryParams.genre = parseInt(cat.split(':')[1], 10);
    if (cat.indexOf('CH:') === 0) queryParams.channelId = cat.split(':')[1];
    if (cat.indexOf('RULE:') === 0) queryParams.ruleId = cat.split(':')[1];

    window.EpgStationClient.fetchRecordedList(base, queryParams, chMap, function (err, res) {
      state.recLoading = false;
      if (err || !res) {
        state.recItems = [];
        dom.recCountLabel.textContent = 'EPGStation 取得エラー';
        showRichToast('error', '録画リスト取得失敗', String(err || '不明'));
        renderRecMainList();
        return;
      }

      var list = res.records || [];
      if (useClientSort) {
        list = sortClientRecords(list, state.recSort);
        var startIdx = state.recPage * REC_PAGE_SIZE;
        list = list.slice(startIdx, startIdx + REC_PAGE_SIZE);
      }

      state.recItems = list;
      state.recTotalCount = res.total;
      dom.recCountLabel.textContent = '全 ' + res.total + ' 件' + (state.recKeyword ? (' (検索: "' + state.recKeyword + '")') : '');
      if (cat === 'ALL') renderRecSidebar();
      renderRecMainList();
    });
  }

  function updateRecToolbarButtons() {
    var btns = dom.recToolbar.querySelectorAll('button, input');
    for (var i = 0; i < btns.length; i++) {
      var el = btns[i];
      if (el.tagName === 'INPUT') {
        el.className = 'rec-search-input' + (state.recZone === 'TOOLBAR' && state.recToolbarIdx === i ? ' focused' : '');
        continue;
      }
      var sKey = el.getAttribute('data-rec-sort');
      var cls = 'btn-action';
      if (sKey && sKey === state.recSort) cls += ' epg-active';
      if (state.recZone === 'TOOLBAR' && state.recToolbarIdx === i) cls += ' focused';
      el.className = cls;
    }
  }

  function renderRecMainList() {
    dom.recMainList.innerHTML = '';
    dom.recPagerBar.innerHTML = '';

    if (state.recLoading) {
      var ld = document.createElement('div');
      ld.className = 'setting-group';
      ld.textContent = state.recServerMode === 'MEDIASAVE'
        ? '配信保存サーバーからデータを読み込んでいます…'
        : 'EPGStation からデータを読み込んでいます…';
      dom.recMainList.appendChild(ld);
      return;
    }

    if (state.recItems.length === 0) {
      var emp = document.createElement('div');
      emp.className = 'setting-group';
      if (state.recCategory === 'MS_ABEMA_RESERVES') {
        emp.textContent = 'ABEMA の録画予約はまだありません。番組表の [ABEMA] タブから予約したい番組を選択して登録できます。';
      } else if (state.recCategory === 'SAVED_VOD') {
        emp.textContent = 'TVer / ABEMA の配信保存リストはまだ空です。配信再生中または一覧から保存指定した番組がここに表示されます。';
      } else {
        emp.textContent = '該当する録画番組はありません。';
      }
      dom.recMainList.appendChild(emp);
      if (state.recZone === 'LIST' || state.recZone === 'PAGER') {
        state.recZone = state.recSideDefs.length > 0 ? 'SIDEBAR' : 'TOOLBAR';
      }
      applyRecOverlayFocus(false);
      return;
    }

    for (var i = 0; i < state.recItems.length; i++) {
      (function (item, idx) {
        var card = document.createElement('div');
        card.className = 'rec-item-card';

        var thumbWrap = document.createElement('div');
        thumbWrap.className = 'rec-thumb-wrap';
        if (item.thumbnailUrl) {
          var img = document.createElement('img');
          img.className = 'rec-thumb-img';
          img.src = item.thumbnailUrl;
          img.onerror = function () { img.style.display = 'none'; };
          thumbWrap.appendChild(img);
        } else {
          var noImg = document.createElement('span');
          noImg.style.color = '#64748b';
          noImg.style.fontSize = '20px';
          noImg.textContent = item.isReserveEntry ? '予約待機' : 'NO IMAGE';
          thumbWrap.appendChild(noImg);
        }
        if (item.durationSec > 0) {
          var durTag = document.createElement('span');
          durTag.className = 'rec-thumb-dur';
          durTag.textContent = Math.max(1, Math.round(item.durationSec / 60)) + '分';
          thumbWrap.appendChild(durTag);
        }
        card.appendChild(thumbWrap);

        var body = document.createElement('div');
        body.className = 'rec-card-body';

        var topMeta = document.createElement('div');
        topMeta.className = 'rec-card-meta-top';

        if (item.logoUrl) {
          var lg = document.createElement('img');
          lg.className = 'epg-ch-logo';
          attachChannelLogo(lg, item);
          topMeta.appendChild(lg);
        }

        var chSpan = document.createElement('span');
        chSpan.className = 'rec-card-ch';
        chSpan.textContent = item.channelName || '';
        topMeta.appendChild(chSpan);

        var tmSpan = document.createElement('span');
        tmSpan.className = 'rec-card-time';
        tmSpan.textContent = item.startAt ? formatYmdHm(item.startAt) : '';
        topMeta.appendChild(tmSpan);

        if (item.isRecording) {
          var recPill = document.createElement('span');
          recPill.className = 'rec-type-pill recording';
          recPill.textContent = '● 録画中';
          topMeta.appendChild(recPill);
        } else if (item.isReserveEntry) {
          var rsvPill = document.createElement('span');
          rsvPill.className = 'rec-type-pill';
          rsvPill.textContent = item.isConflict ? '競合注意' : '予約済';
          topMeta.appendChild(rsvPill);
        } else if (item.isSavedVodEntry) {
          var vodPill = document.createElement('span');
          vodPill.className = 'rec-type-pill';
          vodPill.textContent = item.queueItem.kind + ' 保存枠';
          topMeta.appendChild(vodPill);
        } else {
          if (item.genreLabel) {
            var gPill = document.createElement('span');
            gPill.className = 'rec-type-pill';
            gPill.textContent = item.genreLabel;
            topMeta.appendChild(gPill);
          }
          if (item.sizeLabel) {
            var sPill = document.createElement('span');
            sPill.className = 'rec-type-pill';
            sPill.textContent = (item.hasEncoded ? 'MP4 ' : 'TS ') + item.sizeLabel;
            topMeta.appendChild(sPill);
          }
        }

        var titleDiv = document.createElement('div');
        titleDiv.className = 'rec-card-title';
        titleDiv.textContent = item.name;

        var descDiv = document.createElement('div');
        descDiv.className = 'rec-card-desc';
        var resumePos = (!item.isReserveEntry && !item.isSavedVodEntry) ? findRecordedResumeSec(item.id) : 0;
        if (resumePos > 5) {
          var rBadge = document.createElement('span');
          rBadge.className = 'resume-pill';
          rBadge.style.marginRight = '12px';
          rBadge.style.marginTop = '0';
          rBadge.textContent = '▶ 続き: ' + formatSec(resumePos) + ' / ' + formatSec(item.durationSec);
          descDiv.appendChild(rBadge);
        }
        var dText = document.createElement('span');
        dText.textContent = item.description || '番組概要なし';
        descDiv.appendChild(dText);

        body.appendChild(topMeta);
        body.appendChild(titleDiv);
        body.appendChild(descDiv);
        card.appendChild(body);

        card.onclick = function (ev) {
          ev.stopPropagation();
          state.recZone = 'LIST';
          state.recListIdx = idx;
          applyRecOverlayFocus(true);
          openRecordedItemDialog(item);
        };
        card.onmouseenter = function () {
          state.recZone = 'LIST';
          state.recListIdx = idx;
          applyRecOverlayFocus(true);
        };

        dom.recMainList.appendChild(card);
      })(state.recItems[i], i);
    }

    // ページネーション描画 (十字キーだけで上部バー・前ページ・次ページすべてに到達可能)
    var totalPages = Math.max(1, Math.ceil((state.recTotalCount || state.recItems.length) / REC_PAGE_SIZE));
    var pageInfo = document.createElement('div');
    pageInfo.style.fontSize = '20px';
    pageInfo.style.color = '#b8bec8';
    pageInfo.textContent = 'ページ ' + (state.recPage + 1) + ' / ' + totalPages;
    dom.recPagerBar.appendChild(pageInfo);

    var pBtns = document.createElement('div');
    pBtns.className = 'rec-pager-btns';

    var toTopB = document.createElement('button');
    toTopB.className = 'btn-action';
    toTopB.textContent = '▲ 検索・並び替えへ';
    toTopB.onclick = function () {
      state.recZone = 'TOOLBAR';
      applyRecOverlayFocus(false);
    };
    pBtns.appendChild(toTopB);

    if (state.recPage > 0) {
      var prevB = document.createElement('button');
      prevB.className = 'btn-action';
      prevB.textContent = '◀ 前の30件';
      prevB.onclick = function () {
        state.recPage--;
        state.recListIdx = 0;
        dom.recMainList.scrollTop = 0;
        refreshRecordedOverlayData();
      };
      pBtns.appendChild(prevB);
    }
    if (state.recPage + 1 < totalPages) {
      var nextB = document.createElement('button');
      nextB.className = 'btn-action';
      nextB.setAttribute('data-pager-next', '1');
      nextB.textContent = '次の30件 ▶';
      nextB.onclick = function () {
        state.recPage++;
        state.recListIdx = 0;
        dom.recMainList.scrollTop = 0;
        refreshRecordedOverlayData();
      };
      pBtns.appendChild(nextB);
    }
    dom.recPagerBar.appendChild(pBtns);

    if (state.recListIdx >= state.recItems.length) {
      state.recListIdx = Math.max(0, state.recItems.length - 1);
    }
    applyRecOverlayFocus(false);
  }

  function applyRecOverlayFocus(noScroll) {
    updateRecToolbarButtons();

    for (var s = 0; s < state.recSideDefs.length; s++) {
      var sDef = state.recSideDefs[s].def;
      var sEl = state.recSideDefs[s].el;
      var isAct = (sDef.isServerSwitch || sDef.isMediaSaveSwitch) ? !!sDef.isActiveServer : (state.recCategory === sDef.id);
      var sCls = 'rec-side-item' + (isAct ? ' active' : '');
      if (state.recZone === 'SIDEBAR' && state.recSideIdx === s) sCls += ' focused';
      sEl.className = sCls;
      if (!noScroll && state.recZone === 'SIDEBAR' && state.recSideIdx === s) {
        if (sEl.offsetTop < dom.recSidebar.scrollTop + 30) {
          dom.recSidebar.scrollTop = Math.max(0, sEl.offsetTop - 30);
        } else if (sEl.offsetTop + sEl.offsetHeight > dom.recSidebar.scrollTop + dom.recSidebar.clientHeight - 30) {
          dom.recSidebar.scrollTop = sEl.offsetTop + sEl.offsetHeight - dom.recSidebar.clientHeight + 30;
        }
      }
    }

    var cards = dom.recMainList.querySelectorAll('.rec-item-card');
    for (var c = 0; c < cards.length; c++) {
      var cCls = 'rec-item-card';
      if (state.recZone === 'LIST' && state.recListIdx === c) cCls += ' focused';
      cards[c].className = cCls;
      if (!noScroll && state.recZone === 'LIST' && state.recListIdx === c) {
        var top = cards[c].offsetTop - dom.recMainList.offsetTop;
        var bot = top + cards[c].offsetHeight;
        if (top < dom.recMainList.scrollTop + 30) {
          dom.recMainList.scrollTop = Math.max(0, top - 30);
        } else if (bot > dom.recMainList.scrollTop + dom.recMainList.clientHeight - 30) {
          dom.recMainList.scrollTop = bot - dom.recMainList.clientHeight + 30;
        }
      }
    }

    var pgBtns = dom.recPagerBar.querySelectorAll('button');
    if (pgBtns.length > 0 && state.recPagerIdx >= pgBtns.length) {
      state.recPagerIdx = pgBtns.length - 1;
    }
    for (var p = 0; p < pgBtns.length; p++) {
      pgBtns[p].className = 'btn-action' + (state.recZone === 'PAGER' && state.recPagerIdx === p ? ' focused' : '');
    }
  }

  function openRecordedItemDialog(item) {
    if (!item) return;
    ensureMediaServerFields(item);

    // 0a-2. ABEMA 録画予約エントリ
    if (item.isAbemaReserveEntry && item.abemaReserveData) {
      var ar = item.abemaReserveData;
      var arBtns = [];
      if (ar.status === 'recording') {
        arBtns.push({
          label: '■ 録画を終了して保存',
          danger: true,
          onClick: function () { cancelAbemaReserve(ar); }
        });
      } else if (ar.status === 'scheduled') {
        arBtns.push({
          label: '× 録画予約を取り消す',
          danger: true,
          onClick: function () { cancelAbemaReserve(ar); }
        });
      } else {
        arBtns.push({
          label: '履歴から消去する',
          onClick: function () { cancelAbemaReserve(ar); }
        });
      }
      arBtns.push({
        label: 'このチャンネルを視聴する',
        onClick: function () {
          closeRecordedOverlay();
          playAbemaChannelById(ar.channelId, ar.channelName, ar);
        }
      });
      arBtns.push({
        label: 'ABEMA 番組表を開く',
        onClick: function () {
          closeRecordedOverlay();
          openEpgGrid('ABEMA');
        }
      });
      arBtns.push({ label: '閉じる' });
      var arTime = formatDateWeekHm(ar.startAt) + ' 〜 ' + formatHm(ar.endAt);
      openModal(
        (ar.channelName || ar.channelId) + '  |  ' + arTime,
        ar.title || ar.channelName,
        item.description || 'ABEMA 録画予約',
        arBtns
      );
      return;
    }

    // 0a. 配信保存サーバー ダウンロード中/待機中ジョブ
    if (item.isMediaServerJob && item.jobData) {
      var jb = item.jobData;
      var jbBtns = [];
      if (jb.status === 'queued' || jb.status === 'downloading') {
        jbBtns.push({
          label: jb.isLive ? '■ 録画を終了して保存' : '■ ダウンロードを中止する',
          danger: true,
          onClick: function () {
            mediaSaveRequest('DELETE', '/api/jobs/' + encodeURIComponent(jb.id), null, function (err) {
              if (err) showRichToast('error', '停止エラー', String(err));
              else {
                showRichToast('info', jb.isLive ? 'ライブ録画を停止して保存します' : 'ダウンロードを中止しました', jb.title || '');
                setTimeout(function () { refreshRecordedOverlayData(true); }, 1200);
              }
            });
          }
        });
      } else {
        jbBtns.push({
          label: 'エラー表示を消す',
          onClick: function () {
            mediaSaveRequest('POST', '/api/cleanup', {}, function (err) {
              if (err) showRichToast('error', '消去失敗', String(err));
              else {
                showRichToast('info', 'エラー表示を消去しました', '');
                refreshRecordedOverlayData();
              }
            });
          }
        });
      }
      jbBtns.push({ label: '最新状態に更新', onClick: function () { refreshRecordedOverlayData(); } });
      jbBtns.push({ label: '閉じる' });
      openModal('配信ダウンロード状況', jb.title || jb.url, item.description || '', jbBtns);
      return;
    }

    // 0b. 配信保存サーバー 保存済み MP4 動画
    if (item.isMediaServerItem && item.directVideoUrl) {
      var msResume = findRecordedResumeSec(item.id);
      var msBtns = [];
      if (msResume > 5) {
        msBtns.push({
          label: '▶ 続きから再生 (' + formatSec(msResume) + '〜)',
          primary: true,
          onClick: function () { playRecordedItem(item, msResume, false); }
        });
        msBtns.push({
          label: '最初から再生',
          onClick: function () { playRecordedItem(item, 0, false); }
        });
      } else {
        msBtns.push({
          label: '▶ 再生する',
          primary: true,
          onClick: function () { playRecordedItem(item, 0, false); }
        });
      }
      msBtns.push({ label: '閉じる' });
      var msDetail =
        '区分: ' + (item.channelName || '保存動画') +
        '  /  長さ: ' + (item.durationSec > 0 ? formatSec(item.durationSec) : '--:--') +
        (item.sizeLabel ? ('  /  容量: ' + item.sizeLabel) : '') + '\n\n' +
        (item.description || '');
      openModal('配信保存済み動画', item.name, msDetail, msBtns);
      return;
    }

    // 1. TVer / ABEMA 配信保存リスト項目
    if (item.isSavedVodEntry && item.queueItem) {
      var qi = item.queueItem;
      var qBtns = [];
      if (qi.targetUrl) {
        qBtns.push({
          label: '▶ ストリーミング再生する',
          primary: true,
          onClick: function () {
            closeRecordedOverlay();
            playVodItem({
              id: qi.targetUrl,
              provider: qi.kind,
              pageUrl: qi.targetUrl,
              seriesTitle: qi.channel || qi.kind,
              title: qi.title,
              thumbnail: qi.thumbnail || '',
              isLive: false
            }, false);
          }
        });
      }
      qBtns.push({
        label: 'リストから削除',
        danger: true,
        onClick: function () {
          var nextQ = [];
          for (var i = 0; i < state.recQueue.length; i++) {
            if (state.recQueue[i].id !== qi.id) nextQ.push(state.recQueue[i]);
          }
          state.recQueue = nextQ;
          saveRecQueue();
          refreshRecordedOverlayData();
          renderRecSidebar();
        }
      });
      qBtns.push({ label: '閉じる' });
      openModal(qi.kind + ' 配信保存リスト', qi.title, item.description || '', qBtns);
      return;
    }

    // 2. EPGStation 予約項目
    if (item.isReserveEntry) {
      var rsvSrv = findEpgServerByUrl(item.serverUrl || state.settings.epgstationUrl);
      var rBtns = [];
      if (!rsvSrv.readOnly) {
        rBtns.push({
          label: '× 予約を取り消す',
          danger: true,
          onClick: function () {
            window.EpgStationClient.deleteReserve(rsvSrv.url, item.id, function (err) {
              if (err) showRichToast('error', '予約取消エラー', String(err));
              else {
                showRichToast('info', '録画予約を取り消しました', item.name);
                refreshRecordedOverlayData();
                setTimeout(function () { refreshEpgStationLiveStatus(); }, 500);
              }
            });
          }
        });
      }
      rBtns.push({ label: '閉じる' });
      openModal(item.channelName + '  |  ' + formatYmdHm(item.startAt), item.name, item.description || '予約詳細なし', rBtns);
      return;
    }

    // 3. EPGStation 録画済み番組
    var resumeSec = findRecordedResumeSec(item.id);
    var detailText =
      '放送局: ' + item.channelName + '  /  日時: ' + formatYmdHm(item.startAt) +
      ' (' + Math.max(1, Math.round((item.durationSec || 0) / 60)) + '分 / ' + (item.sizeLabel || '') + ')\n\n' +
      (item.description || '') +
      (item.extended ? ('\n\n' + item.extended) : '');

    var btns = [];
    if (resumeSec > 5) {
      btns.push({
        label: '▶ 続きから再生 (' + formatSec(resumeSec) + '〜)',
        primary: true,
        onClick: function () {
          playRecordedItem(item, resumeSec, false);
        }
      });
      btns.push({
        label: '最初から再生',
        onClick: function () {
          playRecordedItem(item, 0, false);
        }
      });
    } else {
      btns.push({
        label: '▶ 再生する',
        primary: true,
        onClick: function () {
          playRecordedItem(item, 0, false);
        }
      });
    }

    var recItemSrv = findEpgServerByUrl(item.serverUrl || state.settings.epgstationUrl);
    if (item.isRecording && !recItemSrv.readOnly) {
      btns.push({
        label: '■ 録画を停止する',
        danger: true,
        onClick: function () {
          window.EpgStationClient.stopRecording(recItemSrv.url, item, function (err) {
            if (err) {
              showRichToast('error', '録画停止エラー', String(err));
            } else {
              showRichToast('info', '録画を停止しました', item.name);
              refreshRecordedOverlayData();
              setTimeout(function () { refreshEpgStationLiveStatus(); }, 500);
            }
          });
        }
      });
    }
    btns.push({ label: '閉じる' });

    openModal('録画番組詳細・再生', item.name, detailText, btns);
  }

  (function bindRecOverlayToolbar() {
    var sortBtns = dom.recToolbar.querySelectorAll('button[data-rec-sort]');
    for (var i = 0; i < sortBtns.length; i++) {
      (function (btn) {
        btn.onclick = function () {
          state.recSort = btn.getAttribute('data-rec-sort') || 'date_desc';
          state.recPage = 0;
          state.recListIdx = 0;
          refreshRecordedOverlayData();
        };
      })(sortBtns[i]);
    }
    dom.recSearchInput.onkeydown = function (ev) {
      if (ev.keyCode === 13) {
        ev.stopPropagation();
        dom.recSearchInput.blur();
        state.recKeyword = dom.recSearchInput.value.trim();
        state.recPage = 0;
        refreshRecordedOverlayData();
      }
    };
    document.getElementById('btn-rec-search').onclick = function () {
      state.recKeyword = dom.recSearchInput.value.trim();
      state.recPage = 0;
      refreshRecordedOverlayData();
    };
    document.getElementById('btn-rec-reload').onclick = function () {
      loadEpgStationConnection(false, function () {});
      refreshRecordedOverlayData();
    };
    document.getElementById('btn-rec-close').onclick = closeRecordedOverlay;
  })();

  function renderRecordedDrawerTab() {
    // 削除済み保存サーバー動画が履歴に残らないようバックグラウンドで実在チェック
    refreshMediaSavedIds();
    var topBox = document.createElement('div');
    topBox.style.marginBottom = '16px';

    var openFullBtn = document.createElement('button');
    openFullBtn.className = 'btn-action';
    openFullBtn.style.width = '100%';
    openFullBtn.style.padding = '18px 22px';
    openFullBtn.style.fontSize = '26px';
    openFullBtn.style.backgroundColor = '#cf0652';
    openFullBtn.style.textAlign = 'left';
    openFullBtn.textContent = '録画・保存ライブラリを開く';
    registerFocusable(openFullBtn, function () {
      openRecordedOverlay('ALL');
    });
    topBox.appendChild(openFullBtn);
    dom.drawerBody.appendChild(topBox);

    var quickRow = document.createElement('div');
    quickRow.className = 'preset-row';
    var qDefs = [
      { label: '新着録画', cat: 'ALL' },
      { label: '視聴途中', cat: 'RESUME' },
      { label: '配信保存', cat: 'SAVED_VOD' },
      { label: '録画予約', cat: 'RESERVES' }
    ];
    for (var q = 0; q < qDefs.length; q++) {
      (function (qd) {
        var b = document.createElement('button');
        b.className = 'btn-action';
        b.textContent = qd.label;
        registerFocusable(b, function () { openRecordedOverlay(qd.cat); });
        quickRow.appendChild(b);
      })(qDefs[q]);
    }
    dom.drawerBody.appendChild(quickRow);

    var statusCard = document.createElement('div');
    statusCard.className = 'setting-group';
    var curSrv = getActiveEpgServer();
    statusCard.innerHTML =
      '<div class="setting-label">接続中メディアサーバー</div>' +
      '<div class="setting-desc">' +
      (curSrv ? (formatServerDisplayName(curSrv) + '  /  ') : '') +
      (state.epgstationVersion
        ? (state.epgstationStorageText || '接続中')
        : '未接続 ― [設定] タブから接続先を確認してください') +
      '</div>';

    var srvList = state.settings.epgstationServers || [];
    if (srvList.length > 1) {
      var srvSwitchRow = document.createElement('div');
      srvSwitchRow.className = 'preset-row';
      for (var sv = 0; sv < srvList.length; sv++) {
        (function (sObj) {
          var isAct = sObj.id === state.settings.activeEpgstationId;
          var sb = document.createElement('button');
          sb.className = 'btn-action' + (isAct ? ' active-toggle' : '');
          sb.textContent = (isAct ? '● ' : '') + formatServerDisplayName(sObj);
          registerFocusable(sb, function () {
            setActiveEpgServerById(sObj.id, true);
            renderCurrentTab();
          });
          srvSwitchRow.appendChild(sb);
        })(srvList[sv]);
      }
      statusCard.appendChild(srvSwitchRow);
    }
    dom.drawerBody.appendChild(statusCard);

    // 直近視聴していた録画番組があればすぐ再開できるようドロワーにも表示
    var recHist = state.history.RECORDED || [];
    if (recHist.length > 0) {
      var hHdr = document.createElement('div');
      hHdr.className = 'section-heading';
      hHdr.textContent = '最近の録画視聴履歴';
      dom.drawerBody.appendChild(hHdr);

      var lim = Math.min(5, recHist.length);
      for (var i = 0; i < lim; i++) {
        (function (rh) {
          var card = document.createElement('div');
          card.className = 'tver-card history-card';
          var tw = document.createElement('div');
          tw.className = 'tver-thumb-wrap';
          var dBrand = document.createElement('span');
          dBrand.className = 'tver-thumb-dummy-brand';
          dBrand.textContent = 'RECORDED';
          tw.appendChild(dBrand);
          var dSub = document.createElement('span');
          dSub.className = 'tver-thumb-dummy-sub';
          dSub.textContent = rh.channelName || '録画番組';
          tw.appendChild(dSub);
          if (rh.thumbnailUrl) {
            var img = document.createElement('img');
            img.className = 'tver-thumb';
            img.alt = '';
            img.src = rh.thumbnailUrl;
            img.onerror = function () { img.style.display = 'none'; };
            tw.appendChild(img);
          }
          card.appendChild(tw);
          var info = document.createElement('div');
          info.className = 'tver-info';
          var tt = document.createElement('div');
          tt.className = 'tver-series';
          tt.textContent = rh.name;
          var mt = document.createElement('div');
          mt.className = 'tver-meta';
          mt.textContent = (rh.channelName || '') + '  ' + formatYmdHm(rh.startAt);
          info.appendChild(tt);
          info.appendChild(mt);
          if (rh.resumeSec > 5) {
            var rp = document.createElement('div');
            rp.className = 'resume-pill';
            rp.textContent = '▶ 続きから復帰: ' + formatSec(rh.resumeSec) + ' / ' + formatSec(rh.durationSec);
            info.appendChild(rp);
          }
          card.appendChild(info);
          registerFocusable(card, function () {
            playRecordedItem(rh, rh.resumeSec || 0, false);
          });
          dom.drawerBody.appendChild(card);
        })(recHist[i]);
      }
    }
  }

  // =========================================================================
  // 左ドロワー タブ描画 (履歴トップ表示・TVer・Abema・設定)
  // =========================================================================
  function switchTab(tabId) {
    state.currentTab = tabId;
    state.focusIndex = 0;
    renderNavTabs();

    if (tabId === 'GR' || tabId === 'BS' || tabId === 'BS4K' || tabId === 'CS') {
      refreshJikkyoForces(false);
    } else if (tabId === 'TVER') {
      pruneExpiredVodHistory();
      if (state.tverViewMode === 'LIVE') {
        if (!state.tverLiveChannels && !state.tverLiveLoading) {
          loadTverLiveChannels();
        }
      } else {
        syncVodHistoryExpiry('TVER', false);
        loadTverGoodCountsForVisibleItems();
        if (!state.tverHomeSections && !state.tverLoading) {
          loadTverHome();
        }
      }
    } else if (tabId === 'ABEMA') {
      pruneExpiredVodHistory();
      if (state.abemaViewMode === 'VOD') {
        syncVodHistoryExpiry('ABEMA_VOD', false);
        if (!state.abemaVodHomeSections && !state.abemaVodLoading) {
          loadAbemaVodHome(state.abemaVodGenre);
        }
      } else if (!state.abemaChannels && !state.abemaLoading) {
        loadAbemaChannels(false);
      } else if (!state.abemaLoading && (Date.now() - (state.abemaUpdatedAt || 0) > 60000)) {
        loadAbemaChannels(true);
      }
    } else if (tabId === 'RECORDED' && !state.epgstationVersion && state.settings.epgstationUrl) {
      loadEpgStationConnection(false, function () {});
    } else if (tabId === 'SETTINGS') {
      window.VodStreamClient.getDaemonInfo(function (err, info) {
        if (!err && info) {
          if (info.ytdlpVersion) state.ytdlpVersion = info.ytdlpVersion;
          if (info.lanIp) state.deviceLanIp = info.lanIp;
          if (state.currentTab === 'SETTINGS') renderCurrentTab();
        }
      });
      if (!window.DtvPlusPcSync) {
        checkIncomingSyncedSettings(true);
      }
    }
    renderCurrentTab();
  }

  function getFilteredChannels(chType) {
    var srcList = (chType === 'BS4K' && state.bs4kServices.length > 0) ? state.bs4kServices : state.services;
    var list = [];
    for (var i = 0; i < srcList.length; i++) {
      var s = srcList[i];
      if (s.channelType !== chType) continue;
      if (!state.settings.showSubChannels && s.isSubChannel) continue;
      list.push(s);
    }
    return list;
  }

  function findServiceById(id, preferChType, fallbackNid, fallbackSid) {
    var lists = (preferChType === 'BS4K')
      ? [state.bs4kServices, state.services]
      : [state.services, state.bs4kServices];
    for (var li = 0; li < lists.length; li++) {
      var arr = lists[li] || [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === id && (!preferChType || arr[i].channelType === preferChType)) {
          return arr[i];
        }
      }
    }
    if (fallbackNid && fallbackSid) {
      for (var li2 = 0; li2 < lists.length; li2++) {
        var arr2 = lists[li2] || [];
        for (var j = 0; j < arr2.length; j++) {
          if (arr2[j].networkId === fallbackNid && arr2[j].serviceId === fallbackSid &&
              (!preferChType || arr2[j].channelType === preferChType)) {
            return arr2[j];
          }
        }
      }
    }
    for (var li3 = 0; li3 < lists.length; li3++) {
      var arr3 = lists[li3] || [];
      for (var k = 0; k < arr3.length; k++) {
        if (arr3[k].id === id) return arr3[k];
      }
    }
    return null;
  }

  function renderCurrentTab() {
    renderNavTabs();
    dom.drawerBody.innerHTML = '';
    state.focusables = [];

    var tab = state.currentTab;
    if (tab === 'GR' || tab === 'BS' || tab === 'BS4K' || tab === 'CS') {
      renderChannelListWithHistory(tab);
    } else if (tab === 'RECORDED') {
      renderRecordedDrawerTab();
    } else if (tab === 'TVER') {
      renderTverTab();
    } else if (tab === 'ABEMA') {
      renderAbemaTab();
    } else if (tab === 'SETTINGS') {
      renderSettingsTab();
    }

    if (state.drawerOpen) {
      if (state.focusIndex >= state.focusables.length) {
        state.focusIndex = Math.max(0, state.focusables.length - 1);
      }
      applyFocus(state.focusIndex);
    }
  }

  function registerFocusable(el, onActivate) {
    var idx = state.focusables.length;
    el.className += ' focusable';
    el.setAttribute('data-fidx', String(idx));
    el._onActivate = onActivate;
    el.onclick = function (ev) {
      ev.stopPropagation();
      state.focusIndex = idx;
      applyFocus(idx);
      if (onActivate) onActivate();
    };
    el.onmouseenter = function () {
      state.focusIndex = idx;
      applyFocus(idx, true);
    };
    state.focusables.push(el);
  }

  function applyFocus(idx, noScroll) {
    for (var i = 0; i < state.focusables.length; i++) {
      state.focusables[i].className = state.focusables[i].className.replace(/\s*focused/g, '');
    }
    if (idx < 0 || idx >= state.focusables.length) return;
    var target = state.focusables[idx];
    target.className += ' focused';

    if (!noScroll) {
      var body = dom.drawerBody;
      var top = target.offsetTop - body.offsetTop;
      var bottom = top + target.offsetHeight;
      if (top < body.scrollTop + 48) {
        body.scrollTop = Math.max(0, top - 48);
      } else if (bottom > body.scrollTop + body.clientHeight - 48) {
        body.scrollTop = bottom - body.clientHeight + 48;
      }
    }
  }

  function createChannelCardElement(svc, isHistoryItem) {
    var card = document.createElement('div');
    var isPlaying = state.mode === 'LIVE' && state.currentService && state.currentService.id === svc.id;
    card.className = 'ch-card' + (isPlaying ? ' playing' : '') + (isHistoryItem ? ' history-card' : '');

    var topRow = document.createElement('div');
    topRow.className = 'ch-card-top';

    var nameWrap = document.createElement('div');
    nameWrap.className = 'ch-card-name-wrap';

    var numBadge = document.createElement('span');
    numBadge.className = 'ch-num';
    numBadge.textContent = svc.displayNum || svc.channelNumber || String(svc.serviceId);
    nameWrap.appendChild(numBadge);

    // チャンネル番号の右隣に放送局ロゴアイコンを表示 (Mirakurun + LGTV内蔵jlogo統合)
    if (svc.logoUrl) {
      var logoImg = document.createElement('img');
      logoImg.className = 'ch-card-logo';
      logoImg.alt = '';
      attachChannelLogo(logoImg, svc);
      nameWrap.appendChild(logoImg);
    }

    var nameSpan = document.createElement('span');
    nameSpan.className = 'ch-name';
    // LGTV内蔵フォントで未定義グリフ記号による先頭空白が入らないよう純粋な局名のみトリムして表示
    nameSpan.textContent = String(svc.name || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');

    nameWrap.appendChild(nameSpan);
    topRow.appendChild(nameWrap);

    if (svc.jkId) {
      var jkWrap = document.createElement('div');
      jkWrap.className = 'ch-jk-wrap';
      var jkTag = document.createElement('span');
      jkTag.className = 'ch-jk-tag';
      jkTag.textContent = svc.jkId.toUpperCase();
      jkWrap.appendChild(jkTag);

      var jkKey = String(svc.jkId).toLowerCase();
      if (state.jikkyoForces && typeof state.jikkyoForces[jkKey] === 'number') {
        var fVal = state.jikkyoForces[jkKey];
        var fLv = getJikkyoForceLevel(fVal);
        var fTag = document.createElement('span');
        fTag.className = 'ch-force-tag force-' + fLv;
        fTag.textContent = '勢い ' + fVal;
        jkWrap.appendChild(fTag);
      }
      topRow.appendChild(jkWrap);
    }

    var pn = window.MirakurunClient.getCurrentAndNext(state.programsMap, svc);
    var progDiv = document.createElement('div');
    progDiv.className = 'ch-prog-name';
    var paidPrefix = (pn.current && pn.current.isFree === false) ? '【有料】' : '';
    progDiv.textContent = pn.current ? (paidPrefix + pn.current.name) : '番組情報なし';

    var metaRow = document.createElement('div');
    metaRow.className = 'ch-prog-meta';

    var timeSpan = document.createElement('span');
    timeSpan.className = 'ch-prog-time';
    var pct = 0;
    if (pn.current) {
      timeSpan.textContent = formatHm(pn.current.startAt) + '〜' + formatHm(pn.current.endAt);
      if (pn.current.duration > 0) {
        pct = Math.max(0, Math.min(100, Math.round(((Date.now() - pn.current.startAt) / pn.current.duration) * 100)));
      }
    } else {
      timeSpan.textContent = '--:--〜--:--';
    }

    var bar = document.createElement('div');
    bar.className = 'ch-mini-bar';
    var fill = document.createElement('div');
    fill.className = 'ch-mini-fill';
    fill.style.width = pct + '%';
    bar.appendChild(fill);

    metaRow.appendChild(timeSpan);
    metaRow.appendChild(bar);

    card.appendChild(topRow);
    card.appendChild(progDiv);
    card.appendChild(metaRow);

    registerFocusable(card, function () {
      playLiveChannel(svc);
      setDrawerOpen(false);
    });
    return card;
  }

  function renderChannelListWithHistory(chType) {
    // 0. 番組表起動ボタン (通常リモコンの十字キーだけでも即アクセス可能)
    var epgBtnRow = document.createElement('div');
    epgBtnRow.style.marginBottom = '14px';
    var openEpgBtn = document.createElement('button');
    openEpgBtn.className = 'btn-action';
    openEpgBtn.style.width = '100%';
    openEpgBtn.style.textAlign = 'left';
    openEpgBtn.textContent = 'すべての' + (chType === 'GR' ? '地上デジタル' : chType) + 'の 番組表 を開く';
    registerFocusable(openEpgBtn, function () {
      openEpgGrid(chType);
    });
    epgBtnRow.appendChild(openEpgBtn);
    dom.drawerBody.appendChild(epgBtnRow);

    // 1. トップに「視聴履歴」を表示 (最新視聴順・現在視聴中も含めて最大3件を素直に表示)
    var histBucket = state.history[chType] || [];
    var recentServices = [];
    var seenHistIds = {};
    for (var h = 0; h < histBucket.length; h++) {
      var hEntry = histBucket[h];
      if (!hEntry) continue;
      var hSvc = findServiceById(hEntry.id, chType, hEntry.networkId, hEntry.serviceId);
      if (!hSvc || hSvc.channelType !== chType) continue;
      if (seenHistIds[hSvc.id]) continue;
      seenHistIds[hSvc.id] = true;
      recentServices.push(hSvc);
      if (recentServices.length >= 3) break;
    }

    if (recentServices.length > 0) {
      var hHdr = document.createElement('div');
      hHdr.className = 'section-heading';
      hHdr.textContent = '視聴履歴';
      dom.drawerBody.appendChild(hHdr);
      for (var p = 0; p < recentServices.length; p++) {
        dom.drawerBody.appendChild(createChannelCardElement(recentServices[p], true));
      }
    }

    // 2. 全チャンネル一覧
    var allHdr = document.createElement('div');
    allHdr.className = 'section-heading';
    allHdr.textContent = (chType === 'GR' ? '地上デジタル' : chType) + ' 放送局一覧';
    dom.drawerBody.appendChild(allHdr);

    var list = getFilteredChannels(chType);
    if (list.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'setting-group';
      if (chType === 'BS4K' && !state.settings.bs4kMirakurunUrl) {
        empty.innerHTML =
          '<div class="setting-label">BS4K 専用 Mirakurun が未設定です（将来拡張対応枠）</div>' +
          '<div class="setting-desc">[設定] タブの「BS4K 専用 Mirakurun サーバー URL」を入力して保存すると、BS4K 放送リストと番組表がここに表示されます。不要な場合は設定から BS4K タブを非表示にもできます。</div>';
        var goSetBtn = document.createElement('button');
        goSetBtn.className = 'btn-action';
        goSetBtn.textContent = '設定タブを開いて BS4K URL を設定する';
        registerFocusable(goSetBtn, function () { switchTab('SETTINGS'); });
        empty.appendChild(goSetBtn);
      } else {
        empty.textContent = chType + ' のチャンネルが読み込まれていません。[設定] タブで Mirakurun URL を確認してください。';
      }
      dom.drawerBody.appendChild(empty);
      return;
    }

    for (var i = 0; i < list.length; i++) {
      dom.drawerBody.appendChild(createChannelCardElement(list[i], false));
    }
  }

  // =========================================================================
  // KonomiTV 準拠 ニコニコ実況勢い取得 & TVer グッド数取得
  // =========================================================================
  function getJikkyoForceLevel(force) {
    if (force >= 500) return 'festival';
    if (force >= 200) return 'so-many';
    if (force >= 100) return 'many';
    return 'normal';
  }

  function rerenderPreservingFocus() {
    var prevFocus = state.focusIndex;
    renderCurrentTab();
    if (state.focusables.length > 0 && prevFocus > 0) {
      state.focusIndex = Math.min(prevFocus, state.focusables.length - 1);
      applyFocus(state.focusIndex);
    }
  }

  function refreshJikkyoForces(forceReload) {
    if (!window.VodStreamClient || !window.VodStreamClient.fetchJikkyoForces) return;
    if (state.jikkyoForcesFetching) return;
    var now = Date.now();
    if (!forceReload && (now - (state.jikkyoForcesUpdatedAt || 0)) < 30000) return;
    state.jikkyoForcesFetching = true;
    window.VodStreamClient.fetchJikkyoForces(function (err, data) {
      state.jikkyoForcesFetching = false;
      if (!err && data && data.forces) {
        state.jikkyoForces = data.forces;
        state.jikkyoForcesUpdatedAt = Date.now();
        if (state.drawerOpen && (state.currentTab === 'GR' || state.currentTab === 'BS' || state.currentTab === 'BS4K' || state.currentTab === 'CS')) {
          rerenderPreservingFocus();
        }
      }
    });
  }

  function formatGoodCount(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) return '';
    if (v >= 10000) return '👍 ' + (Math.round((v / 10000) * 10) / 10) + '万';
    return '👍 ' + v.toLocaleString();
  }

  function loadTverGoodCountsForVisibleItems() {
    if (!window.VodStreamClient || !window.VodStreamClient.fetchTverGoodCounts) return;
    var ids = [];
    var seen = {};
    function pushId(idOrItem) {
      if (!idOrItem) return;
      var rawId = (typeof idOrItem === 'string') ? idOrItem : (idOrItem.id || extractVodEpisodeId(idOrItem) || '');
      if (!rawId) return;
      var m = String(rawId).match(/(ep[a-z0-9]{6,})/i);
      var eid = m ? m[1].toLowerCase() : '';
      if (!eid || seen[eid]) return;
      seen[eid] = true;
      if (typeof state.tverGoodCounts[eid] === 'number' || state.tverGoodCountsPending[eid]) return;
      ids.push(eid);
    }
    var hist = state.history.TVER || [];
    for (var hi = 0; hi < Math.min(8, hist.length); hi++) {
      if (hist[hi]) pushId(hist[hi]);
    }
    if (state.tverSearchItems && state.tverSearchItems.length > 0) {
      for (var si = 0; si < state.tverSearchItems.length && ids.length < 24; si++) {
        if (state.tverSearchItems[si]) pushId(state.tverSearchItems[si]);
      }
    } else if (state.tverHomeSections && state.tverHomeSections.length > 0) {
      for (var sc = 0; sc < state.tverHomeSections.length && ids.length < 24; sc++) {
        var arr = state.tverHomeSections[sc].items || [];
        for (var j = 0; j < arr.length && ids.length < 24; j++) {
          if (arr[j]) pushId(arr[j]);
        }
      }
    }
    if (ids.length === 0) return;
    for (var k = 0; k < ids.length; k++) state.tverGoodCountsPending[ids[k]] = true;
    window.VodStreamClient.fetchTverGoodCounts(ids, function (err, data) {
      for (var m = 0; m < ids.length; m++) delete state.tverGoodCountsPending[ids[m]];
      if (!err && data && data.counts) {
        var updated = false;
        for (var key in data.counts) {
          if (data.counts.hasOwnProperty(key) && typeof data.counts[key] === 'number') {
            state.tverGoodCounts[key.toLowerCase()] = data.counts[key];
            updated = true;
          }
        }
        if (updated && state.drawerOpen && state.currentTab === 'TVER' && state.tverViewMode !== 'LIVE') {
          rerenderPreservingFocus();
        }
      }
    });
  }

  // =========================================================================
  // TVer ビューワー (履歴＋再生時間レジューム対応・yt-dlp抽出)
  // =========================================================================
  function loadTverHome() {
    state.tverLoading = true;
    renderCurrentTab();
    window.VodStreamClient.fetchTverHome(function (err, data) {
      state.tverLoading = false;
      if (!err && data && data.sections) {
        state.tverHomeSections = data.sections;
        loadTverGoodCountsForVisibleItems();
      } else {
        showRichToast('error', 'TVer 一覧取得エラー', String(err || '不明'));
      }
      if (state.currentTab === 'TVER') renderCurrentTab();
    });
  }

  function runTverSearch(kw) {
    state.tverKeyword = kw;
    if (!kw) {
      state.tverSearchItems = null;
      renderCurrentTab();
      return;
    }
    if (kw.indexOf('http://') === 0 || kw.indexOf('https://') === 0) {
      playVodItem({
        id: kw,
        provider: 'TVER',
        pageUrl: kw,
        seriesTitle: 'TVer ビデオ',
        title: kw,
        isCustomUrl: true,
        isLive: kw.indexOf('/live/') !== -1
      }, false);
      return;
    }
    state.tverLoading = true;
    renderCurrentTab();
    window.VodStreamClient.searchTver(kw, function (err, data) {
      state.tverLoading = false;
      if (!err && data && data.items) {
        state.tverSearchItems = data.items;
        loadTverGoodCountsForVisibleItems();
      } else {
        showRichToast('error', 'TVer 検索エラー', String(err || '不明'));
      }
      if (state.currentTab === 'TVER') renderCurrentTab();
    });
  }

  function formatExpireLabel(expireAtMs) {
    var ms = Number(expireAtMs || 0);
    if (!ms || ms <= Date.now()) return '';
    // 30日以上先の長期配信は冗長なので省略
    if (ms - Date.now() > 30 * 86400 * 1000) return '';
    var d = new Date(ms);
    return '〜' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + 'まで';
  }

  function renderVodHistorySection(providerKey, labelText) {
    if (providerKey === 'TVER' || providerKey === 'ABEMA_VOD') {
      pruneExpiredVodHistory();
    }
    var bucket = state.history[providerKey] || [];
    if (bucket.length === 0) return;

    var hdr = document.createElement('div');
    hdr.className = 'section-heading';
    hdr.textContent = labelText;
    dom.drawerBody.appendChild(hdr);

    var limit = Math.min(4, bucket.length);
    for (var i = 0; i < limit; i++) {
      appendVodCard(bucket[i], true);
    }
  }

  function findLatestTverLiveChannelById(id) {
    var lists = [state.tverLiveChannels || [], state.tverSpecialLiveChannels || []];
    for (var li = 0; li < lists.length; li++) {
      var arr = lists[li];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].id === id) return arr[i];
      }
    }
    return null;
  }

  function findLatestAbemaLiveChannel(item) {
    var arr = state.abemaChannels || [];
    if (!item || arr.length === 0) return null;
    var itemId = String(item.id || '');
    var itemUrl = String(item.pageUrl || '');
    var mItemSlug = itemUrl.match(/\/now-on-air\/([^/?#]+)/);
    var itemSlug = mItemSlug ? mItemSlug[1] : '';
    for (var i = 0; i < arr.length; i++) {
      var ch = arr[i];
      if (!ch) continue;
      if (itemId && String(ch.id || '') === itemId) return ch;
      if (itemUrl && String(ch.pageUrl || '') === itemUrl) return ch;
      if (itemSlug) {
        var mChSlug = String(ch.pageUrl || '').match(/\/now-on-air\/([^/?#]+)/);
        if (mChSlug && mChSlug[1] === itemSlug) return ch;
      }
    }
    return null;
  }

  function syncAbemaLiveHistoryWithLatest(channels) {
    if (!channels || channels.length === 0) return;
    var bucket = state.history.ABEMA_LIVE || [];
    if (bucket.length === 0) return;
    var changed = false;
    for (var i = 0; i < bucket.length; i++) {
      var h = bucket[i];
      var latest = findLatestAbemaLiveChannel(h);
      if (!latest) continue;
      var newTitle = latest.title || h.title;
      var newSeries = latest.seriesTitle || h.seriesTitle;
      var newThumb = latest.thumbnail || h.thumbnail;
      var newLabel = latest.broadcastDateLabel || h.broadcastDateLabel;
      var newDesc = latest.description || h.description;
      if (h.title !== newTitle || h.seriesTitle !== newSeries || h.thumbnail !== newThumb || h.broadcastDateLabel !== newLabel) {
        h.title = newTitle;
        h.seriesTitle = newSeries;
        h.broadcaster = latest.broadcaster || h.broadcaster;
        h.thumbnail = newThumb;
        h.broadcastDateLabel = newLabel;
        h.description = newDesc;
        if (latest.startAt) h.startAt = latest.startAt;
        if (latest.endAt) h.endAt = latest.endAt;
        changed = true;
      }
    }
    if (changed) saveHistory();
  }

  function formatAudienceCount(n) {
    var v = Number(n) || 0;
    if (v <= 0) return '';
    if (v >= 10000) return (Math.round((v / 10000) * 10) / 10) + '万視聴';
    return v.toLocaleString() + '視聴';
  }

  function appendVodCard(item, isHistoryCard) {
    var provUpper = String(item.provider || '').toUpperCase();
    // TVer / ABEMA ライブ履歴カードは最新の EPG 状態（現在放送中の番組名・サムネ・時間）へ常に追従させる
    var displayItem = item;
    if (isHistoryCard && provUpper === 'TVER' && item.isLive) {
      var latestLive = findLatestTverLiveChannelById(item.id);
      if (latestLive) {
        displayItem = latestLive;
      }
    } else if (isHistoryCard && provUpper === 'ABEMA' && item.isLive) {
      var latestAbema = findLatestAbemaLiveChannel(item);
      if (latestAbema) {
        displayItem = latestAbema;
      }
    }

    var isOffAir = !!(displayItem && displayItem.isOffAir) ||
      (displayItem && displayItem.title && String(displayItem.title).indexOf('放送休止') !== -1);
    var isSeriesCard = (displayItem.itemType === 'series');
    var isPremiumLocked = (provUpper === 'ABEMA' && !displayItem.isLive && displayItem.isFree === false);
    var isDrmLocked = (provUpper === 'ABEMA' && !!displayItem.isLive && !!displayItem.isDrm);
    var isLockedCard = isPremiumLocked || isDrmLocked;
    var card = document.createElement('div');
    card.className = 'tver-card' +
      (isHistoryCard ? ' history-card' : '') +
      (isOffAir ? ' off-air-card' : '') +
      (isLockedCard ? ' premium-locked-card' : '');

    // 固定サイズ (224x126) のサムネイル枠を常に描画し、放送休止等で画像が無くてもカードが崩れないようにする
    var thumbWrap = document.createElement('div');
    thumbWrap.className = 'tver-thumb-wrap';

    var dummyBrand = document.createElement('span');
    dummyBrand.className = 'tver-thumb-dummy-brand';
    dummyBrand.textContent = (provUpper === 'ABEMA') ? 'ABEMA' : 'TVer';
    thumbWrap.appendChild(dummyBrand);

    var dummySub = document.createElement('span');
    dummySub.className = 'tver-thumb-dummy-sub';
    dummySub.textContent = isOffAir ? (displayItem.statusLabel || '配信休止中') : (displayItem.channelName || 'NO IMAGE');
    thumbWrap.appendChild(dummySub);

    if (displayItem.thumbnail && !isOffAir) {
      var img = document.createElement('img');
      img.className = 'tver-thumb';
      img.alt = '';
      img.src = normalizeVodThumbUrl(displayItem.thumbnail, displayItem.provider);
      img.onerror = function () { img.style.display = 'none'; };
      thumbWrap.appendChild(img);
    }
    card.appendChild(thumbWrap);

    var info = document.createElement('div');
    info.className = 'tver-info';

    var series = document.createElement('div');
    series.className = 'tver-series';
    series.textContent = (displayItem.seriesTitle || displayItem.channelName || displayItem.title);

    var title = document.createElement('div');
    title.className = 'tver-ep-title';
    var mainSeries = displayItem.seriesTitle || displayItem.channelName || '';
    title.textContent = (mainSeries && displayItem.title !== mainSeries) ? displayItem.title : '';

    var meta = document.createElement('div');
    meta.className = 'tver-meta';
    var statusOrDur = isOffAir
      ? (displayItem.statusLabel || '配信休止中')
      : (displayItem.isLive ? (displayItem.statusLabel || 'LIVE放送中') : (displayItem.duration ? (Math.round(displayItem.duration / 60) + '分') : ''));
    var expLabel = (!displayItem.isLive && displayItem.expireAt) ? formatExpireLabel(displayItem.expireAt) : '';
    var audLabel = (displayItem.isLive && !isOffAir && displayItem.viewCount > 0) ? formatAudienceCount(displayItem.viewCount) : '';
    var cmtLabel = (displayItem.isLive && !isOffAir && displayItem.commentCount > 0) ? (Number(displayItem.commentCount).toLocaleString() + 'コメ') : '';
    var epId = (provUpper === 'TVER') ? (displayItem.id || extractVodEpisodeId(displayItem) || '') : '';
    if (epId) {
      var mEp = String(epId).match(/(ep[a-z0-9]{6,})/i);
      if (mEp) epId = mEp[1].toLowerCase();
    }
    var goodVal = (epId && !displayItem.isLive && state.tverGoodCounts)
      ? state.tverGoodCounts[epId]
      : undefined;
    var goodLabel = (typeof goodVal === 'number') ? formatGoodCount(goodVal) : '';
    var metaParts = [displayItem.broadcasterName || displayItem.channelName, displayItem.broadcastDateLabel, statusOrDur, goodLabel, audLabel, cmtLabel, expLabel];
    // 重複ラベルを除去して見やすく整形
    var uniqMeta = [];
    for (var mp = 0; mp < metaParts.length; mp++) {
      if (metaParts[mp] && uniqMeta.indexOf(metaParts[mp]) === -1) {
        uniqMeta.push(metaParts[mp]);
      }
    }
    meta.textContent = uniqMeta.join('  |  ');

    info.appendChild(series);
    if (title.textContent) info.appendChild(title);
    info.appendChild(meta);

    var resumeSec = (isSeriesCard || displayItem.isLive || isLockedCard) ? 0 : (isHistoryCard ? (displayItem.resumeSec || 0) : findVodResumeSec(displayItem.provider, displayItem.id));
    var saveSt = (isSeriesCard || displayItem.isLive || isLockedCard) ? '' : getVodSaveStatus(displayItem);
    if ((resumeSec > 5 && !displayItem.isLive) || saveSt || isLockedCard) {
      var pillWrap = document.createElement('div');
      if (isDrmLocked) {
        var dPill = document.createElement('span');
        dPill.className = 'vod-saved-pill premium';
        dPill.textContent = 'DRM保護';
        pillWrap.appendChild(dPill);
      } else if (isPremiumLocked) {
        var pPill = document.createElement('span');
        pPill.className = 'vod-saved-pill premium';
        pPill.textContent = 'プレミアム限定';
        pillWrap.appendChild(pPill);
      }
      if (saveSt === 'saved') {
        var sPill = document.createElement('span');
        sPill.className = 'vod-saved-pill saved';
        sPill.textContent = '保存済';
        pillWrap.appendChild(sPill);
      } else if (saveSt === 'active') {
        var aPill = document.createElement('span');
        aPill.className = 'vod-saved-pill active';
        aPill.textContent = '保存中 / 待機中';
        pillWrap.appendChild(aPill);
      }
      if (resumeSec > 5 && !displayItem.isLive) {
        var rPill = document.createElement('span');
        rPill.className = 'resume-pill';
        rPill.textContent = '▶ 続きから復帰: ' + formatSec(resumeSec) + (displayItem.duration ? (' / ' + formatSec(displayItem.duration)) : '');
        pillWrap.appendChild(rPill);
      }
      info.appendChild(pillWrap);
    }

    card.appendChild(info);

    registerFocusable(card, function () {
      if (isSeriesCard && displayItem.seriesId) {
        loadAbemaVodSeries(displayItem.seriesId, displayItem.seriesTitle || displayItem.title || '');
        return;
      }
      if (isDrmLocked) {
        showRichToast('warn', 'DRM保護（視聴不可）', 'このチャンネルは DRM 保護対象のため視聴・録画に対応していません');
        return;
      }
      if (isPremiumLocked) {
        showRichToast('warn', 'プレミアム限定（視聴不可）', 'ログイン不要の無料エピソードのみ視聴・保存に対応しています');
        return;
      }
      var normItem = {
        id: displayItem.id,
        slotId: displayItem.slotId || '',
        provider: provUpper === 'ABEMA' ? 'ABEMA' : (provUpper === 'TVER' ? 'TVER' : provUpper),
        pageUrl: displayItem.pageUrl,
        seriesTitle: displayItem.seriesTitle || displayItem.channelName || '',
        title: displayItem.title || '',
        broadcasterName: displayItem.broadcasterName || displayItem.channelName || '',
        broadcastDateLabel: displayItem.broadcastDateLabel || '',
        genreName: displayItem.genreName || '',
        description: displayItem.description || '',
        nextTitle: displayItem.nextTitle || '',
        nextStartAt: Number(displayItem.nextStartAt || 0),
        startAt: Number(displayItem.startAt || 0),
        endAt: Number(displayItem.endAt || 0),
        duration: displayItem.duration || 0,
        isLive: !!displayItem.isLive,
        liveKind: displayItem.liveKind || '',
        expireAt: Number(displayItem.expireAt || 0),
        thumbnail: displayItem.thumbnail || ''
      };

      // TVer リアルタイム配信が EPG 上「配信休止中 / 配信準備中」の場合は確認モーダルで誤操作を防止
      if (normItem.provider === 'TVER' && normItem.isLive && isOffAir) {
        var chLabel = displayItem.channelName || displayItem.broadcasterName || 'TVer ライブ';
        var stLabel = displayItem.statusLabel || '配信休止中';
        var msgLines = [];
        msgLines.push('現在 ' + chLabel + ' は「' + stLabel + '」の時間帯です。');
        if (displayItem.nextLabel) {
          msgLines.push(displayItem.nextLabel);
        }
        msgLines.push('');
        msgLines.push('局によっては休止中もお知らせ画面を常時配信している場合があります。配信ストリームを開いて確認しますか？');
        openModal(
          chLabel + ' (' + stLabel + ')',
          displayItem.nextLabel || '番組配信時間外です',
          msgLines.join('\n'),
          [
            {
              label: 'ストリームを開いて確認する',
              primary: true,
              onClick: function () {
                playVodItem(normItem, false);
              }
            },
            { label: '閉じる' }
          ]
        );
        return;
      }

      playVodItem(normItem, false);
    });
    dom.drawerBody.appendChild(card);
  }

  function loadTverLiveChannels() {
    state.tverLiveLoading = true;
    renderCurrentTab();
    window.VodStreamClient.fetchTverLiveChannels(function (err, data) {
      state.tverLiveLoading = false;
      if (!err && data) {
        state.tverLiveChannels = data.channels || [];
        state.tverSpecialLiveChannels = data.specialChannels || [];
        state.tverLiveUpdatedAt = data.updatedAt || Date.now();
      } else {
        showRichToast('error', 'TVer ライブ一覧取得エラー', String(err || '不明'));
      }
      if (state.currentTab === 'TVER') renderCurrentTab();
    });
  }

  function switchTverViewMode(mode) {
    if (state.tverViewMode === mode) return;
    state.tverViewMode = mode;
    state.focusIndex = 0;
    if (mode === 'LIVE') {
      if (!state.tverLiveChannels && !state.tverLiveLoading) {
        loadTverLiveChannels();
        return;
      }
    } else {
      pruneExpiredVodHistory();
      syncVodHistoryExpiry('TVER', false);
      if (!state.tverHomeSections && !state.tverLoading) {
        loadTverHome();
        return;
      }
    }
    renderCurrentTab();
  }

  function renderTverLiveBody() {
    var bar = document.createElement('div');
    bar.className = 'preset-row';
    bar.style.marginBottom = '12px';

    var reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn-action';
    reloadBtn.textContent = 'ライブ番組表を更新';
    registerFocusable(reloadBtn, function () { loadTverLiveChannels(); });
    bar.appendChild(reloadBtn);

    if (state.tverLiveUpdatedAt) {
      var updSpan = document.createElement('span');
      updSpan.style.fontSize = '19px';
      updSpan.style.color = '#9ca3af';
      updSpan.style.marginLeft = '12px';
      updSpan.style.lineHeight = '44px';
      updSpan.textContent = '最終更新 ' + formatHm(state.tverLiveUpdatedAt);
      bar.appendChild(updSpan);
    }
    dom.drawerBody.appendChild(bar);

    renderVodHistorySection('TVER_LIVE', 'TVer ライブ 最近の視聴履歴');

    if (state.tverLiveLoading) {
      var ld = document.createElement('div');
      ld.className = 'setting-group';
      ld.textContent = 'TVer ライブ配信状況を取得しています…';
      dom.drawerBody.appendChild(ld);
      return;
    }

    var simulHdr = document.createElement('div');
    simulHdr.className = 'section-heading';
    simulHdr.textContent = '地上波 リアルタイム配信';
    dom.drawerBody.appendChild(simulHdr);

    var simulList = state.tverLiveChannels || [];
    if (simulList.length === 0) {
      var emp = document.createElement('div');
      emp.className = 'setting-group';
      emp.textContent = '同時配信チャンネル情報を取得できませんでした。「ライブ番組表を更新」をお試しください。';
      dom.drawerBody.appendChild(emp);
    } else {
      for (var i = 0; i < simulList.length; i++) {
        var ch = simulList[i];
        ch.provider = 'TVER';
        appendVodCard(ch, false);
      }
    }

    var spList = state.tverSpecialLiveChannels || [];
    if (spList.length > 0) {
      var spHdr = document.createElement('div');
      spHdr.className = 'section-heading';
      spHdr.textContent = 'スペシャルライブ・ニュース';
      dom.drawerBody.appendChild(spHdr);
      for (var si = 0; si < spList.length; si++) {
        var sp = spList[si];
        sp.provider = 'TVER';
        appendVodCard(sp, false);
      }
    }
  }

  function renderTverTab() {
    // 見逃し・VOD / ライブ放送 切り替えバー (ABEMA タブと統一デザイン)
    var modeRow = document.createElement('div');
    modeRow.className = 'preset-row';
    modeRow.style.marginBottom = '14px';

    var btnVodMode = document.createElement('button');
    btnVodMode.className = 'btn-action' + (state.tverViewMode === 'VOD' ? ' active-toggle' : '');
    btnVodMode.textContent = '見逃し・VOD';
    registerFocusable(btnVodMode, function () { switchTverViewMode('VOD'); });

    var btnLiveMode = document.createElement('button');
    btnLiveMode.className = 'btn-action' + (state.tverViewMode === 'LIVE' ? ' active-toggle' : '');
    btnLiveMode.textContent = 'ライブ放送';
    registerFocusable(btnLiveMode, function () { switchTverViewMode('LIVE'); });

    modeRow.appendChild(btnVodMode);
    modeRow.appendChild(btnLiveMode);
    dom.drawerBody.appendChild(modeRow);

    if (state.tverViewMode === 'LIVE') {
      renderTverLiveBody();
      return;
    }

    var bar = document.createElement('div');
    bar.className = 'tver-toolbar';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'tver-input';
    input.placeholder = 'TVer 番組名・出演者キーワード検索…';
    input.value = state.tverKeyword || '';
    input.onkeydown = function (ev) {
      if (ev.keyCode === 13) {
        ev.stopPropagation();
        input.blur();
        runTverSearch(input.value.trim());
      }
    };
    registerFocusable(input, function () { input.focus(); });

    var searchBtn = document.createElement('button');
    searchBtn.className = 'btn-action';
    searchBtn.textContent = '検索';
    searchBtn.style.marginRight = '10px';
    registerFocusable(searchBtn, function () { runTverSearch(input.value.trim()); });

    var homeBtn = document.createElement('button');
    homeBtn.className = 'btn-action';
    homeBtn.textContent = 'トップ更新';
    registerFocusable(homeBtn, function () {
      state.tverSearchItems = null;
      state.tverKeyword = '';
      syncVodHistoryExpiry('TVER', true);
      loadTverHome();
    });

    bar.appendChild(input);
    bar.appendChild(searchBtn);
    bar.appendChild(homeBtn);
    dom.drawerBody.appendChild(bar);

    var quickRow = document.createElement('div');
    quickRow.className = 'preset-row';
    var tags = ['ドラマ', 'バラエティ', 'アニメ', 'ニュース', '北海道'];
    for (var q = 0; q < tags.length; q++) {
      (function (tag) {
        var b = document.createElement('button');
        b.className = 'btn-action';
        b.textContent = '#' + tag;
        registerFocusable(b, function () { runTverSearch(tag); });
        quickRow.appendChild(b);
      })(tags[q]);
    }
    dom.drawerBody.appendChild(quickRow);

    // トップに TVer 見逃し視聴履歴＋再生時間レジュームを表示 (期限切れは自動消去)
    if (!state.tverSearchItems) {
      renderVodHistorySection('TVER', 'TVer 視聴履歴');
    }

    if (state.tverLoading) {
      var ld = document.createElement('div');
      ld.className = 'setting-group';
      ld.textContent = 'TVer 番組リストを読み込んでいます…';
      dom.drawerBody.appendChild(ld);
      return;
    }

    if (state.tverSearchItems) {
      var shdr = document.createElement('div');
      shdr.className = 'section-heading';
      shdr.textContent = '検索結果: "' + state.tverKeyword + '" (' + state.tverSearchItems.length + '件)';
      dom.drawerBody.appendChild(shdr);
      for (var i = 0; i < state.tverSearchItems.length; i++) {
        var it = state.tverSearchItems[i];
        it.provider = 'TVER';
        appendVodCard(it, false);
      }
      return;
    }

    if (state.tverHomeSections) {
      for (var s = 0; s < state.tverHomeSections.length; s++) {
        var sec = state.tverHomeSections[s];
        var hdr = document.createElement('div');
        hdr.className = 'section-heading';
        hdr.textContent = sec.label;
        dom.drawerBody.appendChild(hdr);
        for (var j = 0; j < sec.items.length; j++) {
          sec.items[j].provider = 'TVER';
          appendVodCard(sec.items[j], false);
        }
      }
    }
  }

  // =========================================================================
  // Abema TV (ライブ放送 + 見逃し VOD 切り替え対応・レジューム履歴対応)
  // =========================================================================
  var ABEMA_VOD_GENRES = [
    { id: '', label: 'おすすめ' },
    { id: 'animation', label: 'アニメ' },
    { id: 'variety', label: 'バラエティ' },
    { id: 'drama', label: 'ドラマ' },
    { id: 'tvcatchup', label: 'テレ朝見逃し' },
    { id: 'news', label: 'ニュース' },
    { id: 'sports', label: 'スポーツ' },
    { id: 'movie', label: '映画' }
  ];

  function loadAbemaChannels(silent) {
    if (!silent) {
      state.abemaLoading = true;
      renderCurrentTab();
    }
    window.VodStreamClient.fetchAbemaChannels(function (err, data) {
      state.abemaLoading = false;
      if (!err && data && data.channels) {
        var chs = data.channels;
        for (var i = 0; i < chs.length; i++) {
          chs[i].provider = 'ABEMA';
          chs[i].isLive = true;
          if (chs[i].startAt && chs[i].endAt) {
            chs[i].broadcastDateLabel = formatHm(chs[i].startAt) + '〜' + formatHm(chs[i].endAt);
          }
        }
        state.abemaChannels = chs;
        state.abemaUpdatedAt = Date.now();
        syncAbemaLiveHistoryWithLatest(chs);
      } else if (!silent) {
        showRichToast('error', 'ABEMA 番組表取得エラー', String(err || '不明'));
      }
      if (state.currentTab === 'ABEMA' && state.abemaViewMode === 'LIVE') {
        var prevScroll = dom.drawerBody ? dom.drawerBody.scrollTop : 0;
        renderCurrentTab();
        if (silent && dom.drawerBody) {
          dom.drawerBody.scrollTop = prevScroll;
        }
      }
    });
  }

  function loadAbemaVodHome(genreId) {
    state.abemaVodGenre = genreId || '';
    state.abemaVodSearchItems = null;
    state.abemaVodSeries = null;
    state.abemaVodLoading = true;
    renderCurrentTab();
    window.VodStreamClient.fetchAbemaVodHome(state.abemaVodGenre, function (err, data) {
      state.abemaVodLoading = false;
      if (!err && data && data.sections) {
        state.abemaVodHomeSections = data.sections;
      } else {
        showRichToast('error', 'ABEMA VOD 取得エラー', String(err || '不明'));
      }
      if (state.currentTab === 'ABEMA') renderCurrentTab();
    });
  }

  function runAbemaVodSearch(keyword) {
    var kw = (keyword || '').trim();
    if (!kw) {
      loadAbemaVodHome(state.abemaVodGenre);
      return;
    }
    // http(s) URL が直接入力された場合はそのまま再生する
    if (kw.indexOf('http://') === 0 || kw.indexOf('https://') === 0) {
      state.abemaCustomUrl = kw;
      playVodItem({
        id: kw,
        provider: 'ABEMA',
        pageUrl: kw,
        seriesTitle: 'ABEMA ビデオ',
        title: kw,
        isCustomUrl: true,
        isLive: kw.indexOf('now-on-air') !== -1
      }, false);
      return;
    }
    state.abemaVodKeyword = kw;
    state.abemaVodSeries = null;
    state.abemaVodLoading = true;
    renderCurrentTab();
    refreshMediaSavedIds();
    window.VodStreamClient.searchAbemaVod(kw, function (err, data) {
      state.abemaVodLoading = false;
      if (!err && data && data.items) {
        state.abemaVodSearchItems = data.items;
        refreshMediaSavedIds(function () {
          if (state.currentTab === 'ABEMA' && state.abemaViewMode === 'VOD' && state.abemaVodSearchItems) {
            renderCurrentTab();
          }
        });
      } else {
        showRichToast('error', 'ABEMA VOD 検索エラー', String(err || '不明'));
      }
      if (state.currentTab === 'ABEMA') renderCurrentTab();
    });
  }

  function loadAbemaVodSeries(seriesId, fallbackTitle, seasonId) {
    if (!seriesId) return;
    state.abemaVodLoading = true;
    renderCurrentTab();
    refreshMediaSavedIds();
    window.VodStreamClient.fetchAbemaVodSeries(seriesId, seasonId || '', function (err, data) {
      state.abemaVodLoading = false;
      if (!err && data && data.items) {
        state.abemaVodSeries = {
          seriesId: seriesId,
          title: data.title || fallbackTitle || seriesId,
          content: data.content || '',
          seasons: data.seasons || [],
          activeSeasonId: data.activeSeasonId || '',
          activeSeasonName: data.activeSeasonName || '',
          freeCount: data.freeCount || 0,
          totalCount: data.totalCount || data.items.length,
          items: data.items
        };
        state.focusIndex = 0;
        refreshMediaSavedIds(function () {
          if (state.currentTab === 'ABEMA' && state.abemaViewMode === 'VOD' && state.abemaVodSeries && state.abemaVodSeries.seriesId === seriesId) {
            renderCurrentTab();
          }
        });
      } else {
        showRichToast('error', 'ABEMA エピソード取得エラー', String(err || '不明'));
      }
      if (state.currentTab === 'ABEMA') renderCurrentTab();
    });
  }

  function switchAbemaViewMode(mode) {
    if (state.abemaViewMode === mode) return;
    state.abemaViewMode = mode;
    state.focusIndex = 0;
    if (mode === 'VOD') {
      pruneExpiredVodHistory();
      syncVodHistoryExpiry('ABEMA_VOD', false);
      refreshMediaSavedIds();
      if (!state.abemaVodHomeSections && !state.abemaVodLoading) {
        loadAbemaVodHome(state.abemaVodGenre);
        return;
      }
    } else {
      if (!state.abemaChannels && !state.abemaLoading) {
        loadAbemaChannels(false);
        return;
      } else if (!state.abemaLoading && (Date.now() - (state.abemaUpdatedAt || 0) > 60000)) {
        loadAbemaChannels(true);
      }
    }
    renderCurrentTab();
  }

  function renderAbemaTab() {
    // ライブ放送 / 見逃し VOD 切り替えバー
    var modeRow = document.createElement('div');
    modeRow.className = 'preset-row';
    modeRow.style.marginBottom = '14px';

    var btnLiveMode = document.createElement('button');
    btnLiveMode.className = 'btn-action' + (state.abemaViewMode === 'LIVE' ? ' active-toggle' : '');
    btnLiveMode.textContent = 'ライブ放送';
    registerFocusable(btnLiveMode, function () { switchAbemaViewMode('LIVE'); });

    var btnVodMode = document.createElement('button');
    btnVodMode.className = 'btn-action' + (state.abemaViewMode === 'VOD' ? ' active-toggle' : '');
    btnVodMode.textContent = '見逃し・VOD';
    registerFocusable(btnVodMode, function () { switchAbemaViewMode('VOD'); });

    var btnAbemaEpg = document.createElement('button');
    btnAbemaEpg.className = 'btn-action';
    btnAbemaEpg.textContent = '番組表';
    registerFocusable(btnAbemaEpg, function () { openEpgGrid('ABEMA'); });

    modeRow.appendChild(btnLiveMode);
    modeRow.appendChild(btnVodMode);
    modeRow.appendChild(btnAbemaEpg);
    dom.drawerBody.appendChild(modeRow);

    if (state.abemaViewMode === 'VOD') {
      renderAbemaVodBody();
      return;
    }

    // --- ライブ放送モード (現行機能をそのまま維持) ---
    var bar = document.createElement('div');
    bar.className = 'tver-toolbar';

    var urlIn = document.createElement('input');
    urlIn.type = 'text';
    urlIn.className = 'tver-input';
    urlIn.placeholder = 'ABEMA ビデオURL を入力';
    urlIn.value = state.abemaCustomUrl || '';
    registerFocusable(urlIn, function () { urlIn.focus(); });

    var playUrlBtn = document.createElement('button');
    playUrlBtn.className = 'btn-action';
    playUrlBtn.style.marginRight = '10px';
    playUrlBtn.textContent = 'URL再生';
    registerFocusable(playUrlBtn, function () {
      var u = urlIn.value.trim();
      if (!u) return;
      state.abemaCustomUrl = u;
      playVodItem({
        id: u,
        provider: 'ABEMA',
        pageUrl: u,
        seriesTitle: 'ABEMA ビデオ',
        title: u,
        isCustomUrl: true,
        isLive: u.indexOf('now-on-air') !== -1
      }, false);
    });

    var reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn-action';
    reloadBtn.textContent = '一覧更新';
    registerFocusable(reloadBtn, function () { loadAbemaChannels(); });

    bar.appendChild(urlIn);
    bar.appendChild(playUrlBtn);
    bar.appendChild(reloadBtn);
    dom.drawerBody.appendChild(bar);

    // トップに ABEMA ライブ専用の視聴履歴を表示
    renderVodHistorySection('ABEMA_LIVE', 'ABEMA ライブ 最近の視聴履歴');

    if (state.abemaLoading) {
      var ld = document.createElement('div');
      ld.className = 'setting-group';
      ld.textContent = 'ABEMA 放送中チャンネル一覧を取得しています…';
      dom.drawerBody.appendChild(ld);
      return;
    }

    var hdr = document.createElement('div');
    hdr.className = 'section-heading';
    hdr.textContent = 'ABEMA 現在放送中のライブチャンネル';
    dom.drawerBody.appendChild(hdr);

    // チャンネル順 / 人気順 (視聴数) 切替バー
    var sortRow = document.createElement('div');
    sortRow.className = 'preset-row';
    sortRow.style.marginBottom = '10px';

    var btnSortCh = document.createElement('button');
    btnSortCh.className = 'btn-action' + (state.abemaLiveSort !== 'popular' ? ' active-toggle' : '');
    btnSortCh.textContent = 'チャンネル順';
    registerFocusable(btnSortCh, function () {
      if (state.abemaLiveSort === 'channel') return;
      state.abemaLiveSort = 'channel';
      renderCurrentTab();
    });

    var btnSortPop = document.createElement('button');
    btnSortPop.className = 'btn-action' + (state.abemaLiveSort === 'popular' ? ' active-toggle' : '');
    btnSortPop.textContent = '人気順';
    registerFocusable(btnSortPop, function () {
      if (state.abemaLiveSort === 'popular') return;
      state.abemaLiveSort = 'popular';
      renderCurrentTab();
    });

    sortRow.appendChild(btnSortCh);
    sortRow.appendChild(btnSortPop);
    dom.drawerBody.appendChild(sortRow);

    var chs = (state.abemaChannels || []).slice();
    if (state.abemaLiveSort === 'popular') {
      chs.sort(function (a, b) {
        var ao = a.isOffAir ? 1 : 0;
        var bo = b.isOffAir ? 1 : 0;
        if (ao !== bo) return ao - bo;
        return (Number(b.viewCount) || 0) - (Number(a.viewCount) || 0);
      });
    }
    for (var i = 0; i < chs.length; i++) {
      var ch = chs[i];
      ch.provider = 'ABEMA';
      if (ch.startAt && ch.endAt) {
        ch.broadcastDateLabel = formatHm(ch.startAt) + '〜' + formatHm(ch.endAt);
      }
      appendVodCard(ch, false);
    }
  }

  function renderAbemaVodBody() {
    // TVer と同じ操作感のキーワード検索・URL直接再生バー
    var bar = document.createElement('div');
    bar.className = 'tver-toolbar';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'tver-input';
    input.placeholder = 'ABEMA 番組名・URL を検索…';
    input.value = state.abemaVodKeyword || '';
    input.onkeydown = function (ev) {
      if (ev.keyCode === 13) {
        ev.stopPropagation();
        input.blur();
        runAbemaVodSearch(input.value.trim());
      }
    };
    registerFocusable(input, function () { input.focus(); });

    var searchBtn = document.createElement('button');
    searchBtn.className = 'btn-action';
    searchBtn.style.marginRight = '10px';
    searchBtn.textContent = '検索';
    registerFocusable(searchBtn, function () { runAbemaVodSearch(input.value.trim()); });

    var homeBtn = document.createElement('button');
    homeBtn.className = 'btn-action';
    homeBtn.textContent = 'トップ更新';
    registerFocusable(homeBtn, function () {
      state.abemaVodSearchItems = null;
      state.abemaVodSeries = null;
      state.abemaVodKeyword = '';
      syncVodHistoryExpiry('ABEMA_VOD', true);
      loadAbemaVodHome(state.abemaVodGenre);
    });

    bar.appendChild(input);
    bar.appendChild(searchBtn);
    bar.appendChild(homeBtn);
    dom.drawerBody.appendChild(bar);

    // ジャンル切替チップ行
    var genreRow = document.createElement('div');
    genreRow.className = 'preset-row';
    for (var g = 0; g < ABEMA_VOD_GENRES.length; g++) {
      (function (gdef) {
        var gb = document.createElement('button');
        var isCur = (!state.abemaVodSearchItems && !state.abemaVodSeries && state.abemaVodGenre === gdef.id);
        gb.className = 'btn-action' + (isCur ? ' active-toggle' : '');
        gb.textContent = gdef.label;
        registerFocusable(gb, function () { loadAbemaVodHome(gdef.id); });
        genreRow.appendChild(gb);
      })(ABEMA_VOD_GENRES[g]);
    }
    dom.drawerBody.appendChild(genreRow);

    if (state.abemaVodLoading) {
      var ld = document.createElement('div');
      ld.className = 'setting-group';
      ld.textContent = 'ABEMA 見逃し・VOD 番組リストを読み込んでいます…';
      dom.drawerBody.appendChild(ld);
      return;
    }

    // 1. シリーズ内エピソード一覧表示中
    if (state.abemaVodSeries) {
      var ser = state.abemaVodSeries;
      var backRow = document.createElement('div');
      backRow.className = 'preset-row';
      backRow.style.marginTop = '8px';
      var backBtn = document.createElement('button');
      backBtn.className = 'btn-action';
      backBtn.textContent = '← 作品一覧に戻る';
      registerFocusable(backBtn, function () {
        state.abemaVodSeries = null;
        state.focusIndex = 0;
        renderCurrentTab();
      });
      backRow.appendChild(backBtn);

      if (isRecordingFeatureEnabled() && normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl) && ser.items && ser.items.length > 0) {
        var freeTotal = 0;
        var unsavedFree = 0;
        for (var fi = 0; fi < ser.items.length; fi++) {
          var fep = ser.items[fi];
          if (fep.isFree === false || !fep.pageUrl) continue;
          freeTotal++;
          if (!getVodSaveStatus(fep)) unsavedFree++;
        }
        if (freeTotal > 0) {
          var batchBtn = document.createElement('button');
          batchBtn.className = 'btn-action' + (unsavedFree > 0 ? ' active-toggle' : '');
          batchBtn.textContent = unsavedFree > 0 ? 'まとめて保存' : '保存済';
          registerFocusable(batchBtn, function () {
            batchSaveAbemaSeriesEpisodes(ser);
          });
          backRow.appendChild(batchBtn);
        }
      }

      dom.drawerBody.appendChild(backRow);

      // 複数シーズンがある作品はシーズン切替チップ行を表示 (公式アプリ準拠)
      if (ser.seasons && ser.seasons.length > 1) {
        var seasonRow = document.createElement('div');
        seasonRow.className = 'preset-row';
        seasonRow.style.marginBottom = '10px';
        for (var si2 = 0; si2 < ser.seasons.length; si2++) {
          (function (seObj) {
            var sb = document.createElement('button');
            var isCurSe = (seObj.id === ser.activeSeasonId);
            sb.className = 'btn-action' + (isCurSe ? ' active-toggle' : '');
            sb.textContent = seObj.name;
            registerFocusable(sb, function () {
              if (seObj.id === ser.activeSeasonId) return;
              loadAbemaVodSeries(ser.seriesId, ser.title, seObj.id);
            });
            seasonRow.appendChild(sb);
          })(ser.seasons[si2]);
        }
        dom.drawerBody.appendChild(seasonRow);
      }

      var shdr = document.createElement('div');
      shdr.className = 'section-heading';
      var seLabel = (ser.seasons && ser.seasons.length > 1 && ser.activeSeasonName) ? ('  ' + ser.activeSeasonName) : '';
      shdr.textContent = ser.title + seLabel + '  全' + ser.totalCount + '話 / 無料 ' + ser.freeCount + '話';
      dom.drawerBody.appendChild(shdr);

      if (!ser.items || ser.items.length === 0) {
        var emp = document.createElement('div');
        emp.className = 'setting-group';
        emp.textContent = '視聴可能なエピソードが見つかりませんでした。';
        dom.drawerBody.appendChild(emp);
        return;
      }
      for (var ei = 0; ei < ser.items.length; ei++) {
        var ep = ser.items[ei];
        ep.provider = 'ABEMA';
        appendVodCard(ep, false);
      }
      return;
    }

    // 2. キーワード検索結果表示中
    if (state.abemaVodSearchItems) {
      var khdr = document.createElement('div');
      khdr.className = 'section-heading';
      khdr.textContent = 'ABEMA VOD 検索結果: "' + state.abemaVodKeyword + '" (' + state.abemaVodSearchItems.length + '件 / 無料優先)';
      dom.drawerBody.appendChild(khdr);
      if (state.abemaVodSearchItems.length === 0) {
        var nres = document.createElement('div');
        nres.className = 'setting-group';
        nres.textContent = '該当する ABEMA VOD 番組が見つかりませんでした。';
        dom.drawerBody.appendChild(nres);
        return;
      }
      if (isRecordingFeatureEnabled() && normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl)) {
        var srFreeEps = [];
        var srUnsaved = 0;
        for (var si = 0; si < state.abemaVodSearchItems.length; si++) {
          var sit = state.abemaVodSearchItems[si];
          if (sit.itemType === 'series' || sit.isFree === false || !sit.pageUrl) continue;
          srFreeEps.push(sit);
          if (!getVodSaveStatus(sit)) srUnsaved++;
        }
        if (srFreeEps.length >= 2) {
          var srBatchRow = document.createElement('div');
          srBatchRow.className = 'preset-row';
          srBatchRow.style.marginBottom = '10px';
          var srBatchBtn = document.createElement('button');
          srBatchBtn.className = 'btn-action' + (srUnsaved > 0 ? ' active-toggle' : '');
          srBatchBtn.textContent = srUnsaved > 0 ? 'まとめて保存' : '保存済';
          registerFocusable(srBatchBtn, function () {
            batchSaveAbemaSeriesEpisodes({
              title: state.abemaVodKeyword || 'ABEMA VOD 検索結果',
              items: srFreeEps
            });
          });
          srBatchRow.appendChild(srBatchBtn);
          dom.drawerBody.appendChild(srBatchRow);
        }
      }
      for (var ki = 0; ki < state.abemaVodSearchItems.length; ki++) {
        var kit = state.abemaVodSearchItems[ki];
        kit.provider = 'ABEMA';
        appendVodCard(kit, false);
      }
      return;
    }

    // 3. VOD ホーム (VOD専用履歴 + ジャンル別無料作品セクション / 期限切れ自動消去)
    renderVodHistorySection('ABEMA_VOD', 'ABEMA VOD 視聴履歴');

    if (state.abemaVodHomeSections && state.abemaVodHomeSections.length > 0) {
      for (var s = 0; s < state.abemaVodHomeSections.length; s++) {
        var sec = state.abemaVodHomeSections[s];
        var hdr = document.createElement('div');
        hdr.className = 'section-heading';
        hdr.textContent = sec.label;
        dom.drawerBody.appendChild(hdr);
        for (var j = 0; j < sec.items.length; j++) {
          sec.items[j].provider = 'ABEMA';
          appendVodCard(sec.items[j], false);
        }
      }
    } else {
      var noSec = document.createElement('div');
      noSec.className = 'setting-group';
      noSec.textContent = '無料で見られる VOD 作品が見つかりませんでした。「トップ更新」をお試しください。';
      dom.drawerBody.appendChild(noSec);
    }
  }

  // =========================================================================
  // LAN サーバー自動検索 / PC→TV 設定受信 / 設定・履歴の完全初期化
  // =========================================================================
  function runLanDiscovery(kind) {
    if (!window.VodStreamClient || !window.VodStreamClient.discoverLanServers) return;
    if (state.lanDiscoverBusy[kind]) return;
    state.lanDiscoverBusy[kind] = true;
    if (state.currentTab === 'SETTINGS') renderCurrentTab();
    window.VodStreamClient.discoverLanServers(kind, function (err, res) {
      state.lanDiscoverBusy[kind] = false;
      if (err || !res || !res.ok) {
        showRichToast('error', 'LAN 検索エラー', String(err || (res && res.error) || '検索に失敗しました'));
      } else {
        if (res.localIp) state.deviceLanIp = res.localIp;
        var items = Array.isArray(res.items) ? res.items : [];
        state.lanDiscover[kind] = items;
        if (items.length > 0) {
          showRichToast('success', 'サーバーを検出しました', items.length + ' 件見つかりました。候補から選択してください');
        } else {
          showRichToast('info', 'サーバーが見つかりませんでした', '同一 LAN 上で対象サーバーが起動しているか確認してください');
        }
      }
      if (state.currentTab === 'SETTINGS') renderCurrentTab();
    });
  }

  function applySyncedSettings(incoming) {
    if (!incoming || typeof incoming !== 'object') return;
    var merged = cloneDefaultSettings();
    var k;
    for (k in state.settings) {
      if (state.settings.hasOwnProperty(k)) merged[k] = state.settings[k];
    }
    for (k in incoming) {
      if (incoming.hasOwnProperty(k)) merged[k] = incoming[k];
    }
    merged.useStreamProxy = true;
    if (!Array.isArray(merged.epgstationServers)) merged.epgstationServers = [];
    var found = null;
    for (var i = 0; i < merged.epgstationServers.length; i++) {
      if (merged.epgstationServers[i].id === merged.activeEpgstationId) {
        found = merged.epgstationServers[i];
        break;
      }
    }
    if (!found && merged.epgstationServers.length > 0) {
      found = merged.epgstationServers[0];
      merged.activeEpgstationId = found.id;
    }
    if (found) {
      merged.epgstationUrl = found.url;
      merged.epgstationReadOnly = found.readOnly !== false;
    } else if (!merged.epgstationUrl) {
      merged.activeEpgstationId = '';
      merged.epgstationReadOnly = true;
    }

    state.settings = merged;
    saveSettings();

    // 実況・UI・接続先を即時反映
    jikkyo.setFontSizeKey(state.settings.jikkyoFontSize);
    jikkyo.setOpacity(state.settings.jikkyoOpacity);
    syncRecordingModeUi();
    renderNavTabs();

    if (state.settings.mirakurunUrl) {
      loadMirakurunData(false);
    } else {
      state.mirakurunVersion = null;
      state.services = [];
    }
    if (state.settings.bs4kMirakurunUrl) {
      loadBs4kMirakurunData(false);
    } else {
      state.bs4kMirakurunVersion = null;
      state.bs4kServices = [];
    }
    if (isRecordingFeatureEnabled() && state.settings.epgstationUrl) {
      loadEpgStationConnection(false, function () { refreshEpgStationLiveStatus(); });
    }
    if (isRecordingFeatureEnabled() && normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl)) {
      refreshAbemaReserves();
    }
    renderCurrentTab();
  }

  function checkIncomingSyncedSettings(silent) {
    if (window.DtvPlusPcSync) return;
    if (!window.VodStreamClient || !window.VodStreamClient.checkPendingSyncedSettings) return;
    if (state.syncPromptOpen) return;
    window.VodStreamClient.checkPendingSyncedSettings(function (err, data) {
      if (err || !data || !data.pending || !data.settings) {
        if (!silent) {
          showRichToast('info', '受信した設定はありません', 'PC 版の [設定] タブからこの TV へ送信してください');
        }
        return;
      }
      var s = data.settings;
      var lines = [];
      lines.push('送信元 PC: ' + (data.fromIp || 'LAN'));
      if (s.mirakurunUrl) lines.push('Mirakurun: ' + s.mirakurunUrl);
      if (s.bs4kMirakurunUrl) lines.push('BS4K Mirakurun: ' + s.bs4kMirakurunUrl);
      lines.push('動作モード: ' + (s.enableRecordingMode ? '録画・保存連携モード' : '視聴専用モード'));
      if (Array.isArray(s.epgstationServers) && s.epgstationServers.length > 0) {
        lines.push('EPGStation: ' + s.epgstationServers.length + ' 件');
      }
      if (s.mediaSaveServerUrl) lines.push('配信保存サーバー: ' + s.mediaSaveServerUrl);

      state.syncPromptOpen = true;
      openModal(
        'PC から設定を受信しました',
        'この設定を TV に適用しますか？',
        lines.join('\n'),
        [
          {
            label: '設定を適用する',
            primary: true,
            onClick: function () {
              state.syncPromptOpen = false;
              applySyncedSettings(s);
              window.VodStreamClient.ackSyncedSettings(function () {});
              showRichToast('success', 'PC の設定を適用しました', '接続先と表示設定を更新しました');
            }
          },
          {
            label: '破棄する',
            danger: true,
            onClick: function () {
              state.syncPromptOpen = false;
              window.VodStreamClient.ackSyncedSettings(function () {});
              showRichToast('info', '受信した設定を破棄しました', '');
            }
          }
        ]
      );
    });
  }

  function resetNetworkSettingsOnly() {
    openModal(
      '通信設定リセットの確認',
      '通信・サーバー接続設定をリセットしますか？',
      'Mirakurun / BS4K / EPGStation / 配信保存サーバーの接続先 URL と登録サーバー一覧を未設定に戻します。\n（視聴履歴・実況設定・メニュー表示設定はそのまま残ります）',
      [
        {
          label: '通信設定をリセット',
          danger: true,
          onClick: function () {
            state.settings.mirakurunUrl = '';
            state.settings.bs4kMirakurunUrl = '';
            state.settings.bs4kMirakurunCleared = false;
            state.settings.enableRecordingMode = false;
            state.settings.epgstationUrl = '';
            state.settings.epgstationReadOnly = true;
            state.settings.epgstationServers = [];
            state.settings.activeEpgstationId = '';
            state.settings.mediaSaveServerUrl = '';
            state.settings.mediaSaveServerCleared = false;
            state.services = [];
            state.bs4kServices = [];
            state.mainProgramsMap = {};
            state.bs4kProgramsMap = {};
            state.programsMap = {};
            state.mirakurunVersion = null;
            state.bs4kMirakurunVersion = null;
            state.epgstationVersion = null;
            state.epgstationStorageText = '';
            state.epgstationMeta = null;
            state.lanDiscover = { mirakurun: [], epgstation: [], mediasave: [] };
            saveSettings();
            syncRecordingModeUi();
            renderNavTabs();
            showRichToast('success', '通信設定をリセットしました', '視聴履歴と表示設定は保持されています');
            renderCurrentTab();
          }
        },
        { label: 'キャンセル' }
      ]
    );
  }

  function resetAllSettingsOnly() {
    openModal(
      '全設定リセットの確認',
      'すべての設定を初期状態に戻しますか？',
      '通信設定・実況設定・メニュー表示設定・動作モードをすべて初期状態に戻します。\n（視聴履歴・レジューム記録はそのまま残ります）',
      [
        {
          label: '全設定をリセット',
          danger: true,
          onClick: function () {
            try {
              localStorage.removeItem(SETTINGS_KEY);
              localStorage.removeItem(JK_PREFS_KEY);
            } catch (e) {}
            state.settings = cloneDefaultSettings();
            state.services = [];
            state.bs4kServices = [];
            state.mainProgramsMap = {};
            state.bs4kProgramsMap = {};
            state.programsMap = {};
            state.mirakurunVersion = null;
            state.bs4kMirakurunVersion = null;
            state.epgstationVersion = null;
            state.epgstationStorageText = '';
            state.epgstationMeta = null;
            state.lanDiscover = { mirakurun: [], epgstation: [], mediasave: [] };
            saveSettings();
            jikkyo.setFontSizeKey(state.settings.jikkyoFontSize);
            jikkyo.setOpacity(state.settings.jikkyoOpacity);
            syncRecordingModeUi();
            renderNavTabs();
            showRichToast('success', 'すべての設定を初期状態に戻しました', '視聴履歴は保持されています');
            renderCurrentTab();
          }
        },
        { label: 'キャンセル' }
      ]
    );
  }

  // =========================================================================
  // 設定タブ (PC同期 / Mirakurun LAN検索 / 実況設定 / メニューON-OFF / 録画設定 / 初期化)
  // =========================================================================
  function renderSettingsTab() {
    // 0. PC ↔ TV 設定同期セクション
    if (window.DtvPlusPcSync && typeof window.DtvPlusPcSync.renderSettingsPanel === 'function') {
      window.DtvPlusPcSync.renderSettingsPanel(
        dom.drawerBody,
        function () { return state.settings; },
        showRichToast,
        registerFocusable,
        renderCurrentTab
      );
    } else {
      var gSync = document.createElement('div');
      gSync.className = 'setting-group';
      gSync.innerHTML =
        '<div class="setting-label">PC からの設定同期（TV 受信）</div>' +
        '<div class="setting-desc">この TV の IP: ' + (state.deviceLanIp || '確認中…') +
        '  /  PC 版の [設定] タブから送信した設定をワンタッチで受信・適用できます。</div>';
      var syncRow = document.createElement('div');
      syncRow.className = 'preset-row';
      var recvBtn = document.createElement('button');
      recvBtn.className = 'btn-action';
      recvBtn.textContent = 'PC からの設定を受信確認';
      registerFocusable(recvBtn, function () {
        checkIncomingSyncedSettings(false);
      });
      syncRow.appendChild(recvBtn);
      gSync.appendChild(syncRow);
      dom.drawerBody.appendChild(gSync);
    }

    // 1. Mirakurun サーバー設定
    var g1 = document.createElement('div');
    g1.className = 'setting-group';
    g1.innerHTML =
      '<div class="setting-label">1. Mirakurun サーバー接続設定</div>' +
      '<div class="setting-desc">現在の状態: ' + (state.mirakurunVersion ? ('接続済 Ver ' + state.mirakurunVersion + ' / ' + state.services.length + 'ch') : '未接続') + '</div>';

    var urlRow = document.createElement('div');
    urlRow.className = 'tver-toolbar';
    var urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'tver-input';
    urlInput.placeholder = 'Mirakurun サーバー URL';
    urlInput.value = state.settings.mirakurunUrl || '';
    registerFocusable(urlInput, function () { urlInput.focus(); });

    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn-action';
    saveBtn.textContent = '接続テスト＆保存';
    registerFocusable(saveBtn, function () {
      state.settings.mirakurunUrl = window.MirakurunClient.normalizeBaseUrl(urlInput.value);
      saveSettings();
      loadMirakurunData(true);
    });
    urlRow.appendChild(urlInput);
    urlRow.appendChild(saveBtn);

    var mkScanRow = document.createElement('div');
    mkScanRow.className = 'preset-row';
    var mkScanBtn = document.createElement('button');
    mkScanBtn.className = 'btn-action';
    mkScanBtn.textContent = state.lanDiscoverBusy.mirakurun ? 'LAN 検索中…' : 'LAN 内の Mirakurun (40772) を検索';
    registerFocusable(mkScanBtn, function () {
      runLanDiscovery('mirakurun');
    });
    mkScanRow.appendChild(mkScanBtn);

    var mkFound = state.lanDiscover.mirakurun || [];
    for (var i = 0; i < mkFound.length; i++) {
      (function (cand) {
        var b = document.createElement('button');
        b.className = 'btn-action' + (state.settings.mirakurunUrl === cand.url ? ' active-toggle' : '');
        var typeText = (cand.types && cand.types.length > 0) ? (' [' + cand.types.join('/') + ']') : '';
        b.textContent = (cand.isLocal ? 'TV内蔵 ' : '') + cand.host + ':40772' + typeText;
        registerFocusable(b, function () {
          urlInput.value = cand.url;
          state.settings.mirakurunUrl = cand.url;
          saveSettings();
          loadMirakurunData(true);
        });
        mkScanRow.appendChild(b);
      })(mkFound[i]);
    }
    g1.appendChild(urlRow);
    g1.appendChild(mkScanRow);

    // BS4K 専用 Mirakurun URL 設定欄
    var bs4kTitle = document.createElement('div');
    bs4kTitle.className = 'setting-label';
    bs4kTitle.style.marginTop = '16px';
    bs4kTitle.textContent = 'BS4K 専用 Mirakurun サーバー URL';
    var bs4kDesc = document.createElement('div');
    bs4kDesc.className = 'setting-desc';
    bs4kDesc.textContent = '現在の状態: ' + (state.bs4kMirakurunVersion ? ('接続済 Ver ' + state.bs4kMirakurunVersion + ' / ' + state.bs4kServices.length + 'ch') : (state.settings.bs4kMirakurunUrl ? '未応答' : '未設定'));

    var bs4kRow = document.createElement('div');
    bs4kRow.className = 'tver-toolbar';
    var bs4kInput = document.createElement('input');
    bs4kInput.type = 'text';
    bs4kInput.className = 'tver-input';
    bs4kInput.placeholder = 'BS4K 専用サーバー URL（未設定時は空欄）';
    bs4kInput.value = state.settings.bs4kMirakurunUrl || '';
    registerFocusable(bs4kInput, function () { bs4kInput.focus(); });

    var bs4kSaveBtn = document.createElement('button');
    bs4kSaveBtn.className = 'btn-action';
    bs4kSaveBtn.textContent = 'BS4K URLを保存';
    registerFocusable(bs4kSaveBtn, function () {
      var v = bs4kInput.value.trim();
      state.settings.bs4kMirakurunUrl = v ? window.MirakurunClient.normalizeBaseUrl(v) : '';
      state.settings.bs4kMirakurunCleared = !v;
      saveSettings();
      if (state.settings.bs4kMirakurunUrl) {
        loadBs4kMirakurunData(true);
      } else {
        state.bs4kServices = [];
        state.bs4kMirakurunVersion = null;
        showRichToast('info', 'BS4K URL を未設定に戻しました', '');
        renderCurrentTab();
      }
    });
    bs4kRow.appendChild(bs4kInput);
    bs4kRow.appendChild(bs4kSaveBtn);

    g1.appendChild(bs4kTitle);
    g1.appendChild(bs4kDesc);
    g1.appendChild(bs4kRow);
    if (mkFound.length > 0) {
      var bs4kPickRow = document.createElement('div');
      bs4kPickRow.className = 'preset-row';
      for (var bi = 0; bi < mkFound.length; bi++) {
        (function (cand) {
          var bb = document.createElement('button');
          bb.className = 'btn-action' + (state.settings.bs4kMirakurunUrl === cand.url ? ' active-toggle' : '');
          bb.textContent = 'BS4Kに設定: ' + cand.host + ':40772';
          registerFocusable(bb, function () {
            bs4kInput.value = cand.url;
            state.settings.bs4kMirakurunUrl = cand.url;
            state.settings.bs4kMirakurunCleared = false;
            saveSettings();
            loadBs4kMirakurunData(true);
          });
          bs4kPickRow.appendChild(bb);
        })(mkFound[bi]);
      }
      g1.appendChild(bs4kPickRow);
    }
    dom.drawerBody.appendChild(g1);

    // 2. ニコニコ実況 文字サイズ & 透過度調整
    var gJk = document.createElement('div');
    gJk.className = 'setting-group';
    gJk.innerHTML =
      '<div class="setting-label">2. ニコニコ実況 文字サイズ・透過度設定</div>' +
      '<div class="setting-desc">現在の文字サイズ: ' +
      (window.JikkyoModule.FONT_SIZE_PRESETS[state.settings.jikkyoFontSize] || {}).label +
      '  /  不透明度: ' + Math.round(state.settings.jikkyoOpacity * 100) + '%</div>';

    var sizeRow = document.createElement('div');
    sizeRow.className = 'preset-row';
    var sizeKeys = ['small', 'medium', 'large', 'xlarge'];
    for (var sk = 0; sk < sizeKeys.length; sk++) {
      (function (k) {
        var preset = window.JikkyoModule.FONT_SIZE_PRESETS[k];
        var sb = document.createElement('button');
        sb.className = 'btn-action' + (state.settings.jikkyoFontSize === k ? ' active-toggle' : '');
        sb.textContent = '文字: ' + preset.label;
        registerFocusable(sb, function () {
          state.settings.jikkyoFontSize = k;
          jikkyo.setFontSizeKey(k);
          saveSettings();
          jikkyo.renderComment('実況文字サイズプレビュー (' + preset.label + ')', 'white', true);
          renderCurrentTab();
        });
        sizeRow.appendChild(sb);
      })(sizeKeys[sk]);
    }

    var opRow = document.createElement('div');
    opRow.className = 'preset-row';
    var opVals = [0.25, 0.50, 0.70, 0.85, 1.0];
    for (var oi = 0; oi < opVals.length; oi++) {
      (function (ov) {
        var ob = document.createElement('button');
        var isCur = Math.abs(state.settings.jikkyoOpacity - ov) < 0.04;
        ob.className = 'btn-action' + (isCur ? ' active-toggle' : '');
        ob.textContent = '透過(不透明度): ' + Math.round(ov * 100) + '%';
        registerFocusable(ob, function () {
          state.settings.jikkyoOpacity = ov;
          jikkyo.setOpacity(ov);
          saveSettings();
          jikkyo.renderComment('不透明度 ' + Math.round(ov * 100) + '% プレビュー弾幕テスト', 'cyan', true);
          renderCurrentTab();
        });
        opRow.appendChild(ob);
      })(opVals[oi]);
    }

    var abemaCmtRow = document.createElement('div');
    abemaCmtRow.className = 'preset-row';
    var abmCmtBtn = document.createElement('button');
    var isAbmCmtOn = state.settings.enableAbemaComments !== false;
    abmCmtBtn.className = 'btn-action' + (isAbmCmtOn ? ' active-toggle' : '');
    abmCmtBtn.textContent = 'ABEMA ライブコメント連動 (試験的): ' + (isAbmCmtOn ? 'ON' : 'OFF');
    registerFocusable(abmCmtBtn, function () {
      state.settings.enableAbemaComments = !(state.settings.enableAbemaComments !== false);
      saveSettings();
      renderCurrentTab();
    });
    abemaCmtRow.appendChild(abmCmtBtn);

    gJk.appendChild(sizeRow);
    gJk.appendChild(opRow);
    gJk.appendChild(abemaCmtRow);
    dom.drawerBody.appendChild(gJk);

    // 3. メニュータブ表示 ON/OFF (地デジ / BS / BS4K / CS / TVer / ABEMA) & yt-dlp 更新
    var gVod = document.createElement('div');
    gVod.className = 'setting-group';
    gVod.innerHTML =
      '<div class="setting-label">3. メニュー項目 表示ON/OFF ＆ yt-dlp エンジン更新</div>' +
      '<div class="setting-desc">利用しない放送波や配信サービスをメニューから非表示にできます。 / TV内蔵 yt-dlp: ' + state.ytdlpVersion + '</div>';

    var tabToggleRow = document.createElement('div');
    tabToggleRow.className = 'preset-row';
    var menuToggleDefs = [
      { key: 'enableGR',    label: '地デジ' },
      { key: 'enableBS',    label: 'BS' },
      { key: 'enableBS4K',  label: 'BS4K' },
      { key: 'enableCS',    label: 'CS' },
      { key: 'enableTver',  label: 'TVer' },
      { key: 'enableAbema', label: 'ABEMA' }
    ];
    for (var mt = 0; mt < menuToggleDefs.length; mt++) {
      (function (def) {
        var isOn = state.settings[def.key] !== false;
        var tb = document.createElement('button');
        tb.className = 'btn-action' + (isOn ? ' active-toggle' : '');
        tb.textContent = def.label + ': ' + (isOn ? '表示' : '非表示');
        registerFocusable(tb, function () {
          state.settings[def.key] = !(state.settings[def.key] !== false);
          saveSettings();
          renderCurrentTab();
        });
        tabToggleRow.appendChild(tb);
      })(menuToggleDefs[mt]);
    }

    var vodRow = document.createElement('div');
    vodRow.className = 'preset-row';

    var updBtn = document.createElement('button');
    updBtn.className = 'btn-action';
    updBtn.textContent = 'yt-dlp を最新版へ更新 (yt-dlp -U)';
    registerFocusable(updBtn, function () {
      showRichToast('info', 'yt-dlp 更新確認中…', 'GitHub 公式リリースから最新バージョンを確認しています', 15000);
      window.VodStreamClient.updateYtdlp(function (err, res) {
        if (err || !res) {
          showRichToast('error', 'yt-dlp 更新失敗', String(err || '不明'));
          return;
        }
        state.ytdlpVersion = res.newVersion || state.ytdlpVersion;
        if (res.updated) {
          showRichToast('success', 'yt-dlp を更新しました', res.oldVersion + ' → ' + res.newVersion + ' (デーモン再起動済)', 6000);
        } else {
          showRichToast('success', 'yt-dlp は最新です', '現在のバージョン: ' + res.newVersion, 4500);
        }
        renderCurrentTab();
      });
    });

    vodRow.appendChild(updBtn);
    gVod.appendChild(tabToggleRow);
    gVod.appendChild(vodRow);
    dom.drawerBody.appendChild(gVod);

    // 4. 動作モード切替 (視聴専用モード / 録画・保存連携モード) & 複数 EPGStation サーバー管理
    var gRec = document.createElement('div');
    gRec.className = 'setting-group';
    var recEnabled = isRecordingFeatureEnabled();
    var curActiveSrv = getActiveEpgServer();
    gRec.innerHTML =
      '<div class="setting-label">4. 録画視聴・保存連携モード設定 (複数 EPGStation 対応)</div>' +
      '<div class="setting-desc">現在の動作モード: ' +
      (recEnabled ? '【録画・保存連携モード】' : '【視聴専用モード】 (録画UI・予約ボタン 非表示)') +
      (recEnabled && curActiveSrv ? ('  /  選択中: ' + curActiveSrv.name) : '') +
      (recEnabled && state.epgstationVersion ? (' (Ver ' + state.epgstationVersion + ' ' + state.epgstationStorageText + ')') : '') +
      '</div>';

    var modeSwitchRow = document.createElement('div');
    modeSwitchRow.className = 'preset-row';

    var btnRecOn = document.createElement('button');
    btnRecOn.className = 'btn-action' + (recEnabled ? ' active-toggle' : '');
    btnRecOn.textContent = '録画・保存連携モード';
    registerFocusable(btnRecOn, function () {
      state.settings.enableRecordingMode = true;
      saveSettings();
      syncRecordingModeUi();
      loadEpgStationConnection(false, function () {});
      renderCurrentTab();
    });

    var btnViewOnly = document.createElement('button');
    btnViewOnly.className = 'btn-action' + (!recEnabled ? ' active-toggle' : '');
    btnViewOnly.textContent = '視聴専用モード';
    registerFocusable(btnViewOnly, function () {
      state.settings.enableRecordingMode = false;
      saveSettings();
      syncRecordingModeUi();
      renderCurrentTab();
    });

    modeSwitchRow.appendChild(btnRecOn);
    modeSwitchRow.appendChild(btnViewOnly);
    gRec.appendChild(modeSwitchRow);

    if (recEnabled) {
      var listTitle = document.createElement('div');
      listTitle.className = 'setting-label';
      listTitle.style.marginTop = '12px';
      listTitle.style.fontSize = '23px';
      listTitle.textContent = '登録済み EPGStation メディアサーバー一覧 (' + state.settings.epgstationServers.length + '件)';
      gRec.appendChild(listTitle);

      for (var si = 0; si < state.settings.epgstationServers.length; si++) {
        (function (srvItem) {
          var isAct = srvItem.id === state.settings.activeEpgstationId;
          var srvBox = document.createElement('div');
          srvBox.style.backgroundColor = isAct ? '#1b2a34' : '#181b22';
          srvBox.style.border = isAct ? '2px solid #00b4d8' : '2px solid #2e323b';
          srvBox.style.borderRadius = '8px';
          srvBox.style.padding = '12px 16px';
          srvBox.style.marginBottom = '10px';

          var srvHdr = document.createElement('div');
          srvHdr.style.fontSize = '22px';
          srvHdr.style.fontWeight = 'bold';
          srvHdr.style.marginBottom = '8px';
          srvHdr.textContent = (isAct ? '● [接続中] ' : '○ ') + formatServerDisplayName(srvItem) + '  (' + srvItem.url + ')';
          srvBox.appendChild(srvHdr);

          var srvBtns = document.createElement('div');
          srvBtns.className = 'preset-row';

          var selB = document.createElement('button');
          selB.className = 'btn-action' + (isAct ? ' active-toggle' : '');
          selB.textContent = isAct ? '接続テスト' : 'このサーバーに切替';
          registerFocusable(selB, function () {
            setActiveEpgServerById(srvItem.id, true);
            renderCurrentTab();
          });
          srvBtns.appendChild(selB);

          var lockB = document.createElement('button');
          var locked = srvItem.readOnly !== false;
          lockB.className = 'btn-action' + (locked ? ' active-toggle' : '');
          lockB.textContent = '保護ロック: ' + (locked ? 'ON' : 'OFF');
          registerFocusable(lockB, function () {
            srvItem.readOnly = !locked;
            if (srvItem.id === state.settings.activeEpgstationId) {
              state.settings.epgstationReadOnly = srvItem.readOnly;
            }
            saveSettings();
            renderCurrentTab();
          });
          srvBtns.appendChild(lockB);

          if (state.settings.epgstationServers.length > 0) {
            var delB = document.createElement('button');
            delB.className = 'btn-action';
            delB.style.backgroundColor = '#5f1e24';
            delB.textContent = '削除';
            registerFocusable(delB, function () {
              var nextArr = [];
              for (var k = 0; k < state.settings.epgstationServers.length; k++) {
                if (state.settings.epgstationServers[k].id !== srvItem.id) {
                  nextArr.push(state.settings.epgstationServers[k]);
                }
              }
              state.settings.epgstationServers = nextArr;
              if (nextArr.length === 0) {
                state.settings.activeEpgstationId = '';
                state.settings.epgstationUrl = '';
                state.epgstationVersion = null;
                state.epgstationStorageText = '';
                saveSettings();
              } else if (state.settings.activeEpgstationId === srvItem.id) {
                setActiveEpgServerById(nextArr[0].id, true);
              } else {
                saveSettings();
              }
              renderCurrentTab();
            });
            srvBtns.appendChild(delB);
          }

          srvBox.appendChild(srvBtns);
          gRec.appendChild(srvBox);
        })(state.settings.epgstationServers[si]);
      }

      var addLabel = document.createElement('div');
      addLabel.className = 'setting-label';
      addLabel.style.marginTop = '14px';
      addLabel.style.fontSize = '23px';
      addLabel.textContent = '新しい EPGStation メディアサーバーを追加';
      gRec.appendChild(addLabel);

      var epgScanRow = document.createElement('div');
      epgScanRow.className = 'preset-row';
      var epgScanBtn = document.createElement('button');
      epgScanBtn.className = 'btn-action';
      epgScanBtn.textContent = state.lanDiscoverBusy.epgstation ? 'LAN 検索中…' : 'LAN 内の EPGStation を検索';
      registerFocusable(epgScanBtn, function () {
        runLanDiscovery('epgstation');
      });
      epgScanRow.appendChild(epgScanBtn);

      var epgFound = state.lanDiscover.epgstation || [];
      for (var ei = 0; ei < epgFound.length; ei++) {
        (function (cand) {
          var eb = document.createElement('button');
          eb.className = 'btn-action';
          eb.textContent = '＋ ' + cand.url.replace(/^https?:\/\//, '') + (cand.version ? (' (v' + cand.version + ')') : '');
          registerFocusable(eb, function () {
            // すでに同じ URL が登録済みの場合は切替のみ
            for (var exi = 0; exi < state.settings.epgstationServers.length; exi++) {
              if (state.settings.epgstationServers[exi].url === cand.url) {
                setActiveEpgServerById(state.settings.epgstationServers[exi].id, true);
                renderCurrentTab();
                return;
              }
            }
            var newId = 'epg_' + Date.now();
            state.settings.epgstationServers.push({
              id: newId,
              name: nameIn.value.trim() || ('録画サーバー ' + (state.settings.epgstationServers.length + 1)),
              url: cand.url,
              readOnly: false
            });
            setActiveEpgServerById(newId, true);
            renderCurrentTab();
          });
          epgScanRow.appendChild(eb);
        })(epgFound[ei]);
      }
      gRec.appendChild(epgScanRow);

      var addNameRow = document.createElement('div');
      addNameRow.className = 'tver-toolbar';
      var nameIn = document.createElement('input');
      nameIn.type = 'text';
      nameIn.className = 'tver-input';
      nameIn.placeholder = '表示名';
      registerFocusable(nameIn, function () { nameIn.focus(); });
      addNameRow.appendChild(nameIn);
      gRec.appendChild(addNameRow);

      var addUrlRow = document.createElement('div');
      addUrlRow.className = 'tver-toolbar';
      var epgIn = document.createElement('input');
      epgIn.type = 'text';
      epgIn.className = 'tver-input';
      epgIn.placeholder = 'EPGStation サーバー URL';
      registerFocusable(epgIn, function () { epgIn.focus(); });

      var epgAddBtn = document.createElement('button');
      epgAddBtn.className = 'btn-action';
      epgAddBtn.textContent = '＋ 追加して接続';
      registerFocusable(epgAddBtn, function () {
        var normU = window.EpgStationClient.normalizeBaseUrl(epgIn.value);
        if (!normU) {
          showRichToast('warn', 'URLを入力してください', 'LAN 検索から自動選択もできます');
          return;
        }
        var labelStr = nameIn.value.trim() || ('録画サーバー ' + (state.settings.epgstationServers.length + 1));
        var newId = 'epg_' + Date.now();
        state.settings.epgstationServers.push({
          id: newId,
          name: labelStr,
          url: normU,
          readOnly: false
        });
        setActiveEpgServerById(newId, true);
        renderCurrentTab();
      });
      addUrlRow.appendChild(epgIn);
      addUrlRow.appendChild(epgAddBtn);
      gRec.appendChild(addUrlRow);

      // 配信保存サーバー (TVer / ABEMA 保存・再生サーバー) 設定
      var msLabel = document.createElement('div');
      msLabel.className = 'setting-desc';
      msLabel.style.marginTop = '16px';
      msLabel.style.fontWeight = 'bold';
      msLabel.style.color = '#ffffff';
      msLabel.textContent = 'TVer / ABEMA 配信保存サーバー';
      gRec.appendChild(msLabel);

      var msScanRow = document.createElement('div');
      msScanRow.className = 'preset-row';
      var msScanBtn = document.createElement('button');
      msScanBtn.className = 'btn-action';
      msScanBtn.textContent = state.lanDiscoverBusy.mediasave ? 'LAN 検索中…' : 'LAN 内の配信保存サーバー (7020) を検索';
      registerFocusable(msScanBtn, function () {
        runLanDiscovery('mediasave');
      });
      msScanRow.appendChild(msScanBtn);

      var msFound = state.lanDiscover.mediasave || [];
      for (var mi = 0; mi < msFound.length; mi++) {
        (function (cand) {
          var mb = document.createElement('button');
          mb.className = 'btn-action' + (state.settings.mediaSaveServerUrl === cand.url ? ' active-toggle' : '');
          mb.textContent = cand.host + ':7020 (' + (cand.itemCount || 0) + '件)';
          registerFocusable(mb, function () {
            msIn.value = cand.url;
            state.settings.mediaSaveServerUrl = cand.url;
            state.settings.mediaSaveServerCleared = false;
            saveSettings();
            mediaSaveRequest('GET', '/api/ping', null, function (err, info) {
              if (err || !info || !info.ok) {
                showRichToast('error', '保存サーバー接続失敗', String(err || '応答なし'));
              } else {
                showRichToast('success', '保存サーバー接続成功', '保存済 ' + (info.itemCount || 0) + '件');
              }
            });
            renderCurrentTab();
          });
          msScanRow.appendChild(mb);
        })(msFound[mi]);
      }
      gRec.appendChild(msScanRow);

      var msRow = document.createElement('div');
      msRow.className = 'tver-toolbar';
      var msIn = document.createElement('input');
      msIn.type = 'text';
      msIn.className = 'tver-input';
      msIn.value = state.settings.mediaSaveServerUrl || '';
      msIn.placeholder = '配信保存サーバー URL（空欄で無効）';
      registerFocusable(msIn, function () { msIn.focus(); });

      var msSaveBtn = document.createElement('button');
      msSaveBtn.className = 'btn-action';
      msSaveBtn.textContent = '保存＆接続テスト';
      registerFocusable(msSaveBtn, function () {
        var normMs = normalizeMediaSaveUrl(msIn.value);
        state.settings.mediaSaveServerUrl = normMs;
        state.settings.mediaSaveServerCleared = !normMs;
        saveSettings();
        if (!normMs) {
          showRichToast('info', '配信保存サーバーを無効化しました', '');
          return;
        }
        mediaSaveRequest('GET', '/api/ping', null, function (err, info) {
          if (err || !info || !info.ok) {
            showRichToast('error', '保存サーバー接続失敗', String(err || '応答なし'));
          } else {
            showRichToast('success', '保存サーバー接続成功', '保存済 ' + (info.itemCount || 0) + '件');
          }
        });
      });
      msRow.appendChild(msIn);
      msRow.appendChild(msSaveBtn);
      gRec.appendChild(msRow);

      var libBtnRow = document.createElement('div');
      libBtnRow.className = 'preset-row';
      var openLibBtn = document.createElement('button');
      openLibBtn.className = 'btn-action';
      openLibBtn.style.backgroundColor = '#cf0652';
      openLibBtn.textContent = '全画面「録画・保存ライブラリ」を開く';
      registerFocusable(openLibBtn, function () {
        openRecordedOverlay('ALL');
      });
      libBtnRow.appendChild(openLibBtn);
      gRec.appendChild(libBtnRow);
    }

    var recRow = document.createElement('div');
    recRow.className = 'preset-row';
    recRow.style.marginTop = '8px';

    var clearHistBtn = document.createElement('button');
    clearHistBtn.className = 'btn-action';
    clearHistBtn.textContent = '視聴履歴・レジュームをクリア';
    registerFocusable(clearHistBtn, function () {
      openModal(
        '視聴履歴クリアの確認',
        '視聴履歴・レジューム記録をすべて消去しますか？',
        '再生履歴と途中再生位置のみ消去します。（サーバーURLや表示設定はそのまま残ります）',
        [
          {
            label: '履歴をクリア',
            danger: true,
            onClick: function () {
              state.history = { GR: [], BS: [], BS4K: [], CS: [], TVER: [], TVER_LIVE: [], ABEMA_LIVE: [], ABEMA_VOD: [], RECORDED: [] };
              state.recQueue = [];
              saveHistory();
              saveRecQueue();
              showRichToast('info', '視聴履歴をクリアしました', '各種設定は保持されています');
              renderCurrentTab();
            }
          },
          { label: 'キャンセル' }
        ]
      );
    });

    var resetNetBtn = document.createElement('button');
    resetNetBtn.className = 'btn-action';
    resetNetBtn.style.backgroundColor = '#5f1e24';
    resetNetBtn.textContent = '通信設定をリセット';
    registerFocusable(resetNetBtn, function () {
      resetNetworkSettingsOnly();
    });

    var resetAllBtn = document.createElement('button');
    resetAllBtn.className = 'btn-action';
    resetAllBtn.style.backgroundColor = '#5f1e24';
    resetAllBtn.textContent = '全設定を初期状態に戻す';
    registerFocusable(resetAllBtn, function () {
      resetAllSettingsOnly();
    });

    recRow.appendChild(clearHistBtn);
    recRow.appendChild(resetNetBtn);
    recRow.appendChild(resetAllBtn);
    gRec.appendChild(recRow);
    dom.drawerBody.appendChild(gRec);

    // 5. 純正LiveTVオーバーレイ起動 & その他表示設定
    var gSys = document.createElement('div');
    gSys.className = 'setting-group';
    gSys.innerHTML = '<div class="setting-label">5. 純正TVアプリ連携・詳細オプション</div>';

    var sysRow = document.createElement('div');
    sysRow.className = 'preset-row';

    var ovBtn = document.createElement('button');
    ovBtn.className = 'btn-action';
    ovBtn.style.backgroundColor = '#cf0652';
    ovBtn.textContent = '純正LiveTV ＋ ニコニコ実況オーバーレイを起動';
    registerFocusable(ovBtn, function () {
      var jk = (state.currentService && state.currentService.jkId) || 'jk1';
      window.WebOSBridge.launchNativeTvWithOverlay(jk, {
        fontSizeKey: state.settings.jikkyoFontSize,
        opacity: state.settings.jikkyoOpacity
      }, function () {});
    });

    var subBtn = document.createElement('button');
    subBtn.className = 'btn-action' + (state.settings.showSubChannels ? ' active-toggle' : '');
    subBtn.textContent = 'サブCH表示: ' + (state.settings.showSubChannels ? 'ON' : 'OFF');
    registerFocusable(subBtn, function () {
      state.settings.showSubChannels = !state.settings.showSubChannels;
      saveSettings();
      renderCurrentTab();
    });

    var autoBtn = document.createElement('button');
    autoBtn.className = 'btn-action' + (state.settings.autoPlayLastChannel ? ' active-toggle' : '');
    autoBtn.textContent = '起動時ラストCH自動再生: ' + (state.settings.autoPlayLastChannel ? 'ON' : 'OFF');
    registerFocusable(autoBtn, function () {
      state.settings.autoPlayLastChannel = !state.settings.autoPlayLastChannel;
      saveSettings();
      renderCurrentTab();
    });

    var capSettingBtn = document.createElement('button');
    var capIsOn = !!state.settings.captionEnabled;
    capSettingBtn.className = 'btn-action' + (capIsOn ? ' active-toggle' : '');
    capSettingBtn.textContent = '字幕表示 (ARIB): ' + (capIsOn ? 'ON' : 'OFF');
    registerFocusable(capSettingBtn, function () {
      toggleSubtitleMode();
    });

    sysRow.appendChild(capSettingBtn);
    sysRow.appendChild(ovBtn);
    sysRow.appendChild(subBtn);
    sysRow.appendChild(autoBtn);
    gSys.appendChild(sysRow);
    dom.drawerBody.appendChild(gSys);
  }

  // =========================================================================
  // LG純正 SimilarList / SimilarListISDB 完全トレース 番号入力・3桁選局・ワンタッチ選局
  // =========================================================================
  function getBandLabel(band) {
    if (band === 'GR') return '地デジ';
    if (band === 'BS') return 'BS';
    if (band === 'BS4K') return 'BS4K';
    if (band === 'CS') return 'CS';
    return band || 'DTV';
  }

  function resolveActiveDtvBand() {
    if (state.drawerOpen && (state.currentTab === 'GR' || state.currentTab === 'BS' || state.currentTab === 'BS4K' || state.currentTab === 'CS')) {
      return state.currentTab;
    }
    if (state.epgOpen && state.epgType) {
      return state.epgType;
    }
    if (state.currentService && state.currentService.channelType) {
      return state.currentService.channelType;
    }
    return state.lastLiveBand || 'GR';
  }

  /**
   * 指定放送波の全サービス一覧を返す (3桁番号直接入力ではサブチャンネルもヒットさせる純正仕様)
   */
  function getBandAllServices(band, csSubBand) {
    var srcList = (band === 'BS4K' && state.bs4kServices.length > 0) ? state.bs4kServices : state.services;
    var out = [];
    for (var i = 0; i < srcList.length; i++) {
      var s = srcList[i];
      if (s.channelType !== band) continue;
      if (csSubBand && s.csBand && s.csBand !== csSubBand) continue;
      out.push(s);
    }
    return out;
  }

  function closeSimilarList() {
    state.similarOpen = false;
    state.similarDigits = '';
    state.similarThreeDigitOnly = false;
    state.similarCandidates = [];
    state.similarFocusIdx = 0;
    state.similarMoved = false;
    if (state.similarTimer) {
      clearTimeout(state.similarTimer);
      state.similarTimer = null;
    }
    if (dom.similarBox) {
      dom.similarBox.className = 'hidden';
    }
  }

  function commitSimilarSelection(svc) {
    if (!svc) return;
    closeSimilarList();
    if (state.epgOpen) closeEpgGrid();
    if (state.drawerOpen) setDrawerOpen(false);
    playLiveChannel(svc);
  }

  function renderSimilarListDom() {
    if (!dom.similarBox) return;
    dom.simBandBadge.textContent = getBandLabel(state.similarBand);
    if (state.similarDigits === '') {
      dom.simDigits.textContent = '---';
    } else if (state.similarDigits.length < 3) {
      var underscores = state.similarDigits.length === 1 ? '__' : '_';
      dom.simDigits.textContent = state.similarDigits + underscores;
    } else {
      dom.simDigits.textContent = state.similarDigits;
    }

    dom.simModeHint.innerHTML =
      (state.similarThreeDigitOnly ? '3桁番号入力' : '番号選局 (◀▶放送波)') +
      '<br>▲▼選択 / 決定で確定';

    dom.simListBody.innerHTML = '';
    var cands = state.similarCandidates;
    if (cands.length === 0) {
      var emptyEl = document.createElement('div');
      emptyEl.className = 'sim-empty';
      emptyEl.textContent = state.similarDigits
        ? ('「' + state.similarDigits + '」に一致する ' + getBandLabel(state.similarBand) + ' チャンネルがありません')
        : (getBandLabel(state.similarBand) + ' のチャンネルが未取得です');
      dom.simListBody.appendChild(emptyEl);
      return;
    }

    for (var i = 0; i < cands.length; i++) {
      (function (cand, idx) {
        var row = document.createElement('div');
        row.className = 'sim-item' + (idx === state.similarFocusIdx ? ' focused' : '');

        var numSpan = document.createElement('span');
        numSpan.className = 'sim-item-num';
        numSpan.textContent = cand.svc.channelNumber || cand.svc.displayNum;
        row.appendChild(numSpan);

        if (cand.matchType === 'shortcut' && cand.scNum) {
          var scBadge = document.createElement('span');
          scBadge.className = 'sim-item-sc';
          scBadge.textContent = 'リモコン' + cand.scNum;
          row.appendChild(scBadge);
        } else if (cand.svc.shortCut >= 1 && cand.svc.shortCut <= 12) {
          var scSub = document.createElement('span');
          scSub.className = 'sim-item-sc';
          scSub.textContent = 'キー' + cand.svc.shortCut;
          row.appendChild(scSub);
        }

        if (cand.svc.logoUrl) {
          var lg = document.createElement('img');
          lg.className = 'sim-ch-logo';
          lg.alt = '';
          attachChannelLogo(lg, cand.svc);
          row.appendChild(lg);
        }

        var nm = document.createElement('span');
        nm.className = 'sim-item-name';
        nm.textContent = cand.svc.name;
        row.appendChild(nm);

        row.onmouseenter = function () {
          state.similarFocusIdx = idx;
          state.similarMoved = true;
          applySimilarFocus(true);
          restartSimilarTimer();
        };
        row.onclick = function (ev) {
          ev.stopPropagation();
          commitSimilarSelection(cand.svc);
        };

        dom.simListBody.appendChild(row);
      })(cands[i], i);
    }
    applySimilarFocus(false);
  }

  function applySimilarFocus(noScroll) {
    var rows = dom.simListBody.querySelectorAll('.sim-item');
    for (var i = 0; i < rows.length; i++) {
      rows[i].className = i === state.similarFocusIdx ? 'sim-item focused' : 'sim-item';
    }
    if (!noScroll && rows[state.similarFocusIdx]) {
      var target = rows[state.similarFocusIdx];
      var sc = dom.simListBody;
      var top = target.offsetTop;
      var bottom = top + target.offsetHeight;
      if (top < sc.scrollTop) {
        sc.scrollTop = top;
      } else if (bottom > sc.scrollTop + sc.clientHeight) {
        sc.scrollTop = bottom - sc.clientHeight;
      }
    }
  }

  /**
   * LG純正 SimilarList.qml の hideTimer / triggered() 仕様に準拠した自動確定タイマー
   */
  function restartSimilarTimer() {
    if (state.similarTimer) {
      clearTimeout(state.similarTimer);
      state.similarTimer = null;
    }
    if (!state.similarOpen) return;

    var digits = state.similarDigits;
    var cands = state.similarCandidates;
    var waitMs = 5000;

    if (digits === '') {
      waitMs = 6000;
    } else if (state.similarMoved) {
      // 上下キーやホイールで候補を選んでいる最中は純正ISDB仕様と同じ 5.0秒間 待機
      waitMs = 5000;
    } else if (digits.length === 3) {
      if (cands.length === 0) {
        waitMs = 1600;
      } else if (cands.length === 1 && cands[0].svc.channelNumber === digits) {
        // 3桁完全一致が一意に決まった場合は即座に確定
        waitMs = 420;
      } else {
        waitMs = 1500;
      }
    } else if (digits.length === 1 && cands.length > 0 && cands[0].matchType === 'shortcut') {
      // 1桁ワンタッチ割当がある場合: 他に前方一致候補がなければ 1.5秒、続く3桁候補がある場合は追加入力猶予 2.1秒
      waitMs = (cands.length === 1) ? 1500 : 2100;
    } else {
      // CSの1〜2桁途中入力やワンタッチ未割当番号の場合は 5.0秒 待機
      waitMs = 5000;
    }

    state.similarTimer = setTimeout(function () {
      if (!state.similarOpen) return;
      var curDigits = state.similarDigits;
      var curCands = state.similarCandidates;

      if (curDigits === '') {
        closeSimilarList();
        return;
      }

      // 1. ユーザーが候補リストを上下移動して選択していた場合はそのフォーカス局へ選局
      if (state.similarMoved && curCands[state.similarFocusIdx]) {
        commitSimilarSelection(curCands[state.similarFocusIdx].svc);
        return;
      }

      // 2. 3桁チャンネル番号が一致している場合 (SimilarList.qml L240: _chNumMajor === channelNumber)
      if (curCands.length > 0 && curCands[0].svc.channelNumber === curDigits) {
        commitSimilarSelection(curCands[0].svc);
        return;
      }

      // 3. 1桁入力でワンタッチ shortCut が割り当てられている放送波 (GR / BS主要局 等)
      if (curDigits.length === 1 && curCands.length > 0 && curCands[0].matchType === 'shortcut') {
        commitSimilarSelection(curCands[0].svc);
        return;
      }

      // 4. ワンタッチ未割当かつ3桁未満でタイムアウトした場合 (CSで1桁だけ押した等) は誤選局せず案内トーストを出す
      var bandName = getBandLabel(state.similarBand);
      closeSimilarList();
      showRichToast(
        'warn',
        bandName + ' チャンネル番号未確定 (' + curDigits + ')',
        bandName + ' は3桁のチャンネル番号を入力するか、候補リストから[決定]で選択してください'
      );
    }, waitMs);
  }

  function rebuildSimilarCandidates() {
    var all = getBandAllServices(state.similarBand, null);
    var digits = state.similarDigits;
    var cands = [];
    var addedIds = {};

    function pushCand(svc, mType, scNum) {
      if (!svc || addedIds[svc.id]) return;
      addedIds[svc.id] = true;
      cands.push({ svc: svc, matchType: mType, scNum: scNum || 0 });
    }

    if (digits === '') {
      // 3桁入力パネル初期オープン時: 当該放送波の主要チャンネルを一覧表示
      for (var i = 0; i < all.length; i++) {
        if (!state.settings.showSubChannels && all[i].isSubChannel) continue;
        pushCand(all[i], 'list', 0);
      }
    } else {
      // 1桁入力時 (3桁専用モードでない場合): まずワンタッチ shortCut (1〜10) 一致を先頭に配置
      if (digits.length === 1 && !state.similarThreeDigitOnly) {
        var scTarget = digits === '0' ? 10 : parseInt(digits, 10);
        for (var s = 0; s < all.length; s++) {
          if (all[s].shortCut === scTarget) {
            pushCand(all[s], 'shortcut', scTarget);
          }
        }
      }

      // 3桁チャンネル番号 (channelNumber: "101", "211", "055", "218", "011" 等) の前方一致候補
      for (var p = 0; p < all.length; p++) {
        var chNo = all[p].channelNumber || '';
        if (chNo.indexOf(digits) === 0) {
          pushCand(all[p], 'prefix', 0);
        }
      }

      // CS等で先頭0を省略して入力した場合 (例: "055" に対して "55" と入力) も補助候補に追加
      if (digits.length <= 2 && digits.charAt(0) !== '0') {
        var zeroPrefixed = '0' + digits;
        for (var z = 0; z < all.length; z++) {
          var zNo = all[z].channelNumber || '';
          if (zNo.indexOf(zeroPrefixed) === 0) {
            pushCand(all[z], 'subprefix', 0);
          }
        }
      }
    }

    state.similarCandidates = cands;
    state.similarFocusIdx = 0;
    state.similarMoved = false;
    renderSimilarListDom();
    restartSimilarTimer();
  }

  function openThreeDigitInputPanel(bandOverride) {
    if (state.similarOpen && state.similarThreeDigitOnly && state.similarDigits === '') {
      closeSimilarList();
      return;
    }
    state.similarBand = bandOverride || resolveActiveDtvBand();
    state.similarDigits = '';
    state.similarThreeDigitOnly = true;
    state.similarOpen = true;
    dom.similarBox.className = '';
    rebuildSimilarCandidates();
  }

  function appendSimilarDigit(digitChar, bandOverride) {
    if (!state.similarOpen) {
      state.similarBand = bandOverride || resolveActiveDtvBand();
      state.similarDigits = digitChar;
      state.similarThreeDigitOnly = false;
      state.similarOpen = true;
      dom.similarBox.className = '';
    } else {
      if (bandOverride && bandOverride !== state.similarBand) {
        state.similarBand = bandOverride;
        state.similarDigits = digitChar;
      } else if (state.similarDigits.length >= 3) {
        // 既に3桁入力済みの場合は新しい1桁目として再開
        state.similarDigits = digitChar;
      } else {
        state.similarDigits = state.similarDigits + digitChar;
      }
    }
    rebuildSimilarCandidates();
  }

  function backspaceOrCloseSimilar() {
    if (!state.similarOpen) return;
    if (state.similarDigits.length > 1) {
      state.similarDigits = state.similarDigits.substring(0, state.similarDigits.length - 1);
      rebuildSimilarCandidates();
    } else {
      closeSimilarList();
    }
  }

  function cycleSimilarBand(delta) {
    var bands = [];
    if (state.settings.enableGR !== false) bands.push('GR');
    if (state.settings.enableBS !== false) bands.push('BS');
    if (state.settings.enableBS4K !== false && state.bs4kServices.length > 0) bands.push('BS4K');
    if (state.settings.enableCS !== false) bands.push('CS');
    if (bands.length === 0) bands = ['GR', 'BS', 'CS'];
    var idx = bands.indexOf(state.similarBand);
    if (idx === -1) idx = 0;
    state.similarBand = bands[(idx + delta + bands.length) % bands.length];
    rebuildSimilarCandidates();
  }

  /**
   * 日本仕様 LG リモコンのバンド専用ワンタッチキー (BS_1..12 / CS1_1..12 / CS2_1..12 / TER_1..12) 処理
   * 純正 SimilarListISDB.qml の findShortcutKey() を完全トレース
   */
  function triggerDirectBandShortcut(band, csSubBand, shortcutNum) {
    var all = getBandAllServices(band, csSubBand);
    for (var i = 0; i < all.length; i++) {
      if (all[i].shortCut === shortcutNum) {
        commitSimilarSelection(all[i]);
        return;
      }
    }
    // ワンタッチ未登録 (CSの大半や未割当キー) の場合は純正同様にトーストで案内しつつ3桁入力パネルを開く
    showRichToast(
      'info',
      getBandLabel(band) + ' キー[' + shortcutNum + '] はワンタッチ未割当です',
      '3桁のチャンネル番号を入力するか候補リストから選択してください'
    );
    openThreeDigitInputPanel(band);
  }

  function switchBandByDedicatedKey(band, csSubBand) {
    state.lastLiveBand = band;
    var hist = state.history[band] || [];
    for (var h = 0; h < hist.length; h++) {
      var hSvc = findServiceById(hist[h].id);
      if (hSvc && (!csSubBand || !hSvc.csBand || hSvc.csBand === csSubBand)) {
        commitSimilarSelection(hSvc);
        return;
      }
    }
    var list = getBandAllServices(band, csSubBand);
    if (list.length > 0) {
      commitSimilarSelection(list[0]);
    } else {
      setDrawerOpen(true);
      switchTab(band);
    }
  }

  /**
   * 日本向け LG 純正リモコン固有キーコード (KeyCodeModel.qml / SimilarListISDB.qml) のデコード
   */
  function decodeJpSpecialKey(code) {
    // 3桁入力キー / チャンネルダッシュキー
    if (code === 0x0374 || code === 892 || code === 0x01200095 || code === 189 || code === 109) {
      return { type: '3digit' };
    }
    // 放送波ダイレクト切替キー
    if (code === 0x0340 || code === 0x01200091) return { type: 'band', band: 'BS', csSub: null };
    if (code === 0x034D || code === 0x01200092) return { type: 'band', band: 'CS', csSub: 'CS1' };
    if (code === 0x035A || code === 0x01200093) return { type: 'band', band: 'CS', csSub: 'CS2' };
    if (code === 0x0367 || code === 0x01200094) return { type: 'band', band: 'GR', csSub: null };

    // BS 1〜12 (0x0341..0x034C または 0x01200111..0x0120011C)
    if (code >= 0x0341 && code <= 0x034C) return { type: 'bandNum', band: 'BS', csSub: null, num: code - 0x0341 + 1 };
    if (code >= 0x01200111 && code <= 0x0120011C) return { type: 'bandNum', band: 'BS', csSub: null, num: code - 0x01200111 + 1 };

    // CS1 1〜12 (0x034E..0x0359 または 0x01200121..0x0120012C)
    if (code >= 0x034E && code <= 0x0359) return { type: 'bandNum', band: 'CS', csSub: 'CS1', num: code - 0x034E + 1 };
    if (code >= 0x01200121 && code <= 0x0120012C) return { type: 'bandNum', band: 'CS', csSub: 'CS1', num: code - 0x01200121 + 1 };

    // CS2 1〜12 (0x035B..0x0366 または 0x01200131..0x0120013C)
    if (code >= 0x035B && code <= 0x0366) return { type: 'bandNum', band: 'CS', csSub: 'CS2', num: code - 0x035B + 1 };
    if (code >= 0x01200131 && code <= 0x0120013C) return { type: 'bandNum', band: 'CS', csSub: 'CS2', num: code - 0x01200131 + 1 };

    // 地デジ 1〜12 (0x0368..0x0373 または 0x01200141..0x0120014C)
    if (code >= 0x0368 && code <= 0x0373) return { type: 'bandNum', band: 'GR', csSub: null, num: code - 0x0368 + 1 };
    if (code >= 0x01200141 && code <= 0x0120014C) return { type: 'bandNum', band: 'GR', csSub: null, num: code - 0x01200141 + 1 };

    return null;
  }

  // =========================================================================
  // リモコンキー操作 (SimilarList・ワンクッション動作・EPG操作・モーダル操作完全統合)
  // =========================================================================
  function zapChannel(delta) {
    var chType = (state.currentService && state.currentService.channelType) || state.lastLiveBand || 'GR';
    var list = getFilteredChannels(chType);
    if (list.length === 0) list = state.services;
    if (list.length === 0) return;

    var curIdx = 0;
    if (state.currentService) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === state.currentService.id) { curIdx = i; break; }
      }
    }
    var nextIdx = (curIdx + delta + list.length) % list.length;
    playLiveChannel(list[nextIdx]);
  }

  function getSeekableDurationSec() {
    if (state.mode === 'RECORDED' && state.currentRecorded) {
      var rec = state.currentRecorded;
      var vDur = (dom.video && isFinite(dom.video.duration) && dom.video.duration > 1) ? dom.video.duration : 0;
      return (!state.recIsRawTs && vDur > 0) ? vDur : (rec.realDurationSec || rec.durationSec || vDur || 0);
    }
    if (state.mode === 'VOD' && state.currentVod && !state.currentVod.isLive) {
      var vodDur = (dom.video && isFinite(dom.video.duration) && dom.video.duration > 1) ? dom.video.duration : (state.currentVod.duration || 0);
      return vodDur;
    }
    return 0;
  }

  function seekToAbsoluteSec(targetSec) {
    var dur = getSeekableDurationSec();
    if (dur <= 0) return;
    var clamped = Math.max(0, Math.min(Math.max(0, dur - 2), Math.floor(targetSec)));

    if (state.mode === 'RECORDED' && state.currentRecorded) {
      if (state.recIsRawTs) {
        if (state.recSeekDebounceTimer) clearTimeout(state.recSeekDebounceTimer);
        state.recPendingSeekSec = null;
        if (aribManager) aribManager.notifySeek();
        playRecordedItem(state.currentRecorded, clamped, true);
        showRichToast('info', 'シーク移動', formatSec(clamped) + ' / ' + formatSec(dur), 1800);
      } else {
        try {
          dom.video.currentTime = clamped;
          flushCurrentVodProgress();
          showOsdBanner();
        } catch (e) {}
      }
      return;
    }

    if (state.mode === 'VOD' && state.currentVod && !state.currentVod.isLive) {
      try {
        dom.video.currentTime = clamped;
        flushCurrentVodProgress();
        showOsdBanner();
      } catch (e) {}
    }
  }

  function seekVod(deltaSec) {
    if (state.mode === 'RECORDED' && state.currentRecorded) {
      var recDur = state.currentRecorded.durationSec || dom.video.duration || 0;
      var baseCur = state.recPendingSeekSec !== null ? state.recPendingSeekSec : getCurrentPlaybackSec();
      var nextSec = Math.max(0, baseCur + deltaSec);
      if (recDur > 8) {
        nextSec = Math.min(recDur - 5, nextSec);
      }
      if (state.recIsRawTs) {
        state.recPendingSeekSec = nextSec;
        showRichToast('info', (deltaSec > 0 ? '+' : '') + deltaSec + '秒 シーク', formatSec(nextSec) + (recDur > 0 ? (' / ' + formatSec(recDur)) : ''), 2200);
        if (state.recSeekDebounceTimer) clearTimeout(state.recSeekDebounceTimer);
        state.recSeekDebounceTimer = setTimeout(function () {
          var targetToApply = state.recPendingSeekSec;
          state.recPendingSeekSec = null;
          state.recSeekDebounceTimer = null;
          if (state.mode === 'RECORDED' && state.currentRecorded && targetToApply !== null) {
            if (aribManager) aribManager.notifySeek();
            playRecordedItem(state.currentRecorded, targetToApply, true);
          }
        }, 360);
      } else {
        try {
          dom.video.currentTime = nextSec;
          flushCurrentVodProgress();
          showOsdBanner();
          showRichToast('info', (deltaSec > 0 ? '+' : '') + deltaSec + '秒 シーク', formatSec(nextSec));
        } catch (e) {}
      }
      return;
    }

    if (state.mode !== 'VOD' || !state.currentVod || state.currentVod.isLive) return;
    try {
      var target = Math.max(0, (dom.video.currentTime || 0) + deltaSec);
      dom.video.currentTime = target;
      flushCurrentVodProgress();
      showOsdBanner();
      showRichToast('info', (deltaSec > 0 ? '+' : '') + deltaSec + '秒 シーク', formatSec(target));
    } catch (e) {}
  }

  document.addEventListener('keydown', function (ev) {
    var code = ev.keyCode;
    var activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') {
      // リモコンの戻るキー または 上下キー (▲ / ▼) でテキスト入力欄から即座に十字キー操作へ復帰可能にする
      if (code === 461 || code === 27 || code === 38 || code === 40) {
        document.activeElement.blur();
        ev.preventDefault();
        if (state.recOverlayOpen && code === 40) {
          state.recZone = state.recItems.length > 0 ? 'LIST' : 'SIDEBAR';
          applyRecOverlayFocus(false);
        }
      }
      return;
    }

    // 1. モーダルダイアログ表示中のキー操作
    if (state.modalOpen) {
      ev.preventDefault();
      if (code === 37) {
        state.modalFocusIdx = Math.max(0, state.modalFocusIdx - 1);
        applyModalFocus();
      } else if (code === 39) {
        state.modalFocusIdx = Math.min(state.modalButtons.length - 1, state.modalFocusIdx + 1);
        applyModalFocus();
      } else if (code === 13) {
        var mb = state.modalButtons[state.modalFocusIdx];
        if (mb && mb._onActivate) mb._onActivate();
      } else if (code === 461 || code === 27 || code === 8) {
        closeModal();
      }
      return;
    }

    // 1b. LGTV 純正 Subtitle (字幕) / dデータ (BMLデータ放送) キーおよび BML アクティブ時のキー操作ルーティング
    var evKeyLower = String(ev.key || '').toLowerCase();
    if (code === 799 || code === 460 || code === 0x031F || code === 0x01000105 || code === 67) {
      ev.preventDefault();
      toggleSubtitleMode();
      return;
    }
    if (aribManager && aribManager.getStatus().bmlActive && !state.recOverlayOpen && !state.epgOpen && !state.similarOpen) {
      if (aribManager.handleKeyDown(code, ev.key)) {
        ev.preventDefault();
        return;
      }
    }

    // 2. 全画面 録画・保存ライブラリ表示中の十字キー (▲▼◀▶ ポチポチ) 完全ナビゲーション
    if (state.recOverlayOpen) {
      ev.preventDefault();
      if (code === 461 || code === 27 || code === 8) {
        closeRecordedOverlay();
        return;
      }
      var tbEls = dom.recToolbar.querySelectorAll('button, input');
      var pgEls = dom.recPagerBar.querySelectorAll('button');

      if (state.recZone === 'TOOLBAR') {
        if (code === 37) {
          state.recToolbarIdx = Math.max(0, state.recToolbarIdx - 1);
          applyRecOverlayFocus(false);
        } else if (code === 39) {
          state.recToolbarIdx = Math.min(tbEls.length - 1, state.recToolbarIdx + 1);
          applyRecOverlayFocus(false);
        } else if (code === 40) {
          if (state.recToolbarIdx <= 1 && state.recSideDefs.length > 0) {
            state.recZone = 'SIDEBAR';
          } else if (state.recItems.length > 0) {
            state.recZone = 'LIST';
          } else if (pgEls.length > 0) {
            state.recZone = 'PAGER';
          } else {
            state.recZone = 'SIDEBAR';
          }
          applyRecOverlayFocus(false);
        } else if (code === 13) {
          var tEl = tbEls[state.recToolbarIdx];
          if (tEl) {
            if (tEl.tagName === 'INPUT') tEl.focus();
            else tEl.click();
          }
        }
        return;
      }

      if (state.recZone === 'SIDEBAR') {
        if (code === 38) {
          if (state.recSideIdx > 0) state.recSideIdx--;
          else {
            state.recZone = 'TOOLBAR';
            state.recToolbarIdx = 0;
          }
          applyRecOverlayFocus(false);
        } else if (code === 40) {
          if (state.recSideIdx < state.recSideDefs.length - 1) {
            state.recSideIdx++;
          } else if (pgEls.length > 0) {
            state.recZone = 'PAGER';
            state.recPagerIdx = 0;
          }
          applyRecOverlayFocus(false);
        } else if (code === 39) {
          if (state.recItems.length > 0) {
            state.recZone = 'LIST';
          } else if (pgEls.length > 0) {
            state.recZone = 'PAGER';
          } else {
            state.recZone = 'TOOLBAR';
          }
          applyRecOverlayFocus(false);
        } else if (code === 13) {
          var sEntry = state.recSideDefs[state.recSideIdx];
          if (sEntry && sEntry.el) sEntry.el.click();
        }
        return;
      }

      if (state.recZone === 'PAGER') {
        if (code === 37) {
          if (state.recPagerIdx > 0) state.recPagerIdx--;
          else state.recZone = 'SIDEBAR';
          applyRecOverlayFocus(false);
        } else if (code === 39) {
          state.recPagerIdx = Math.min(pgEls.length - 1, state.recPagerIdx + 1);
          applyRecOverlayFocus(false);
        } else if (code === 38) {
          if (state.recItems.length > 0) {
            state.recZone = 'LIST';
          } else {
            state.recZone = 'TOOLBAR';
          }
          applyRecOverlayFocus(false);
        } else if (code === 13) {
          if (pgEls[state.recPagerIdx]) pgEls[state.recPagerIdx].click();
        }
        return;
      }

      // LIST zone (録画カード一覧)
      if (code === 38) {
        if (state.recListIdx > 0) {
          state.recListIdx--;
        } else {
          state.recZone = 'TOOLBAR';
        }
        applyRecOverlayFocus(false);
      } else if (code === 40) {
        if (state.recListIdx < state.recItems.length - 1) {
          state.recListIdx++;
        } else if (pgEls.length > 0) {
          state.recZone = 'PAGER';
          state.recPagerIdx = pgEls.length - 1;
        }
        applyRecOverlayFocus(false);
      } else if (code === 37) {
        state.recZone = 'SIDEBAR';
        applyRecOverlayFocus(false);
      } else if (code === 39) {
        // リスト途中からでも ▶ ボタン1回で「次の30件 / 前の30件 / 検索・並び替えへ」バーへ即ジャンプ可能
        if (pgEls.length > 0) {
          state.recZone = 'PAGER';
          state.recPagerIdx = pgEls.length - 1;
        } else {
          state.recZone = 'TOOLBAR';
        }
        applyRecOverlayFocus(false);
      } else if (code === 13) {
        var curRecItem = state.recItems[state.recListIdx];
        if (curRecItem) openRecordedItemDialog(curRecItem);
      }
      return;
    }

    // 2b. 数字キー (0〜9) および日本向け LG 純正リモコン専用キーのデコード
    var digitKeyChar = null;
    if (code >= 48 && code <= 57) {
      digitKeyChar = String(code - 48);
    } else if (code >= 96 && code <= 105) {
      digitKeyChar = String(code - 96);
    }
    var jpSpec = decodeJpSpecialKey(code);

    if (jpSpec) {
      ev.preventDefault();
      if (jpSpec.type === '3digit') {
        openThreeDigitInputPanel(null);
        return;
      }
      if (jpSpec.type === 'band') {
        if (state.similarOpen) {
          state.similarBand = jpSpec.band;
          rebuildSimilarCandidates();
        } else {
          switchBandByDedicatedKey(jpSpec.band, jpSpec.csSub);
        }
        return;
      }
      if (jpSpec.type === 'bandNum') {
        if (state.similarOpen && jpSpec.num >= 1 && jpSpec.num <= 10) {
          appendSimilarDigit(jpSpec.num === 10 ? '0' : String(jpSpec.num), jpSpec.band);
        } else {
          triggerDirectBandShortcut(jpSpec.band, jpSpec.csSub, jpSpec.num);
        }
        return;
      }
    }

    if (digitKeyChar !== null) {
      ev.preventDefault();
      appendSimilarDigit(digitKeyChar, null);
      return;
    }

    // 2c. LG純正 SimilarList (番号入力・候補リスト) 表示中のナビゲーション操作
    if (state.similarOpen) {
      if (code === 38) { // Up
        ev.preventDefault();
        if (state.similarCandidates.length > 0) {
          state.similarFocusIdx = Math.max(0, state.similarFocusIdx - 1);
          state.similarMoved = true;
          applySimilarFocus(false);
          restartSimilarTimer();
        }
        return;
      }
      if (code === 40) { // Down
        ev.preventDefault();
        if (state.similarCandidates.length > 0) {
          state.similarFocusIdx = Math.min(state.similarCandidates.length - 1, state.similarFocusIdx + 1);
          state.similarMoved = true;
          applySimilarFocus(false);
          restartSimilarTimer();
        }
        return;
      }
      if (code === 37 || code === 39) { // Left / Right: 対象放送波切替
        ev.preventDefault();
        cycleSimilarBand(code === 39 ? 1 : -1);
        return;
      }
      if (code === 13) { // Enter: フォーカス候補へ即時選局
        ev.preventDefault();
        var selCand = state.similarCandidates[state.similarFocusIdx];
        if (selCand && selCand.svc) {
          commitSimilarSelection(selCand.svc);
        } else {
          closeSimilarList();
        }
        return;
      }
      if (code === 461 || code === 27 || code === 8) { // Back: 1文字削除または閉じる
        ev.preventDefault();
        backspaceOrCloseSimilar();
        return;
      }
    }

    // 2d. 番組表オーバーレイ表示中のキー操作
    if (state.epgOpen) {
      ev.preventDefault();
      var ctrlBtns = dom.epgControls.querySelectorAll('button');
      if (code === 461 || code === 27 || code === 8) {
        closeEpgGrid();
        return;
      }
      if (state.epgInToolbar) {
        if (code === 37) {
          state.epgToolbarIdx = Math.max(0, state.epgToolbarIdx - 1);
          applyEpgFocus();
        } else if (code === 39) {
          state.epgToolbarIdx = Math.min(ctrlBtns.length - 1, state.epgToolbarIdx + 1);
          applyEpgFocus();
        } else if (code === 40) {
          state.epgInToolbar = false;
          applyEpgFocus();
        } else if (code === 13) {
          if (ctrlBtns[state.epgToolbarIdx]) ctrlBtns[state.epgToolbarIdx].click();
        }
        return;
      }

      var curCol = state.epgColsCells[state.epgColIdx] || [];
      var curCell = curCol[state.epgRowIdx];
      var refMidY = curCell ? (curCell.topPx + curCell.heightPx / 2) : 0;

      if (code === 38) { // Up
        if (state.epgRowIdx > 0) {
          state.epgRowIdx--;
        } else {
          state.epgInToolbar = true;
        }
        applyEpgFocus();
      } else if (code === 40) { // Down
        if (state.epgRowIdx < curCol.length - 1) {
          state.epgRowIdx++;
          applyEpgFocus();
        }
      } else if (code === 37 || code === 39) { // Left / Right 隣の局の同時間帯セルへ移動
        var nextColIdx = state.epgColIdx + (code === 39 ? 1 : -1);
        if (nextColIdx >= 0 && nextColIdx < state.epgColsCells.length) {
          state.epgColIdx = nextColIdx;
          var targetCol = state.epgColsCells[nextColIdx];
          var bestR = 0;
          var bestDist = 999999;
          for (var r = 0; r < targetCol.length; r++) {
            var mid = targetCol[r].topPx + targetCol[r].heightPx / 2;
            var d = Math.abs(mid - refMidY);
            if (d < bestDist) { bestDist = d; bestR = r; }
          }
          state.epgRowIdx = bestR;
          applyEpgFocus();
        }
      } else if (code === 13) {
        if (curCell) openEpgProgramDetail(curCell.svc, curCell.prog);
      }
      return;
    }

    // 2d-2. dデータ (BMLデータ放送) キー (webOS 4.4 日本リモコン実測: 1019=0x03FB <IR_KEY_BML_DATA> 他)
    if (code === 1019 || code === 885 || code === 893 || code === 807 || code === 779 || code === 459 ||
        code === 0x03FB || code === 0x0327 || code === 0x0375 || code === 0x037D || code === 0x01200096 || code === 68 ||
        evKeyLower === 'teletext' || evKeyLower === 'bmldata' || evKeyLower === 'data') {
      ev.preventDefault();
      toggleDataBroadcast();
      return;
    }

    // 4色カラーキー & 録画キー (常時有効)
    if (code === 403 || code === 82) { ev.preventDefault(); toggleJikkyo(); return; }
    if (code === 404 || code === 71) { ev.preventDefault(); cycleAudioMode(); return; }
    if (code === 405 || code === 89) { ev.preventDefault(); toggleCommentPanel(); return; }
    if (code === 406 || code === 66) { ev.preventDefault(); setDrawerOpen(!state.drawerOpen); return; }
    if (code === 416) { ev.preventDefault(); promptRecordingAction(null); return; } // リモコン録画ボタン

    // CH上下キー
    if (code === 33) { ev.preventDefault(); closeSimilarList(); zapChannel(1); return; }
    if (code === 34) { ev.preventDefault(); closeSimilarList(); zapChannel(-1); return; }

    // メディア専用キー
    if (code === 415) { try { dom.video.play(); showRichToast('info', '再生再開', ''); } catch (e) {} return; }
    if (code === 19)  { try { dom.video.pause(); flushCurrentVodProgress(); showRichToast('info', '一時停止', ''); } catch (e) {} return; }
    if (code === 417) { seekVod(30); return; }
    if (code === 412) { seekVod(-15); return; }

    // 戻るキー
    if (code === 461 || code === 27 || code === 8) {
      ev.preventDefault();
      if (state.drawerOpen) {
        // ABEMA VOD のシリーズ詳細を開いている時は、ドロワーを閉じず作品一覧に戻る
        if (state.currentTab === 'ABEMA' && state.abemaViewMode === 'VOD' && state.abemaVodSeries) {
          state.abemaVodSeries = null;
          state.focusIndex = 0;
          renderCurrentTab();
          return;
        }
        setDrawerOpen(false);
      } else if (state.commentPanelOpen) {
        toggleCommentPanel();
      } else if (state.osdVisible) {
        hideOsdBanner();
      } else {
        flushCurrentVodProgress();
        if (window.PalmSystem && typeof window.PalmSystem.platformBack === 'function') {
          window.PalmSystem.platformBack();
        } else {
          setDrawerOpen(true);
        }
      }
      return;
    }

    // 3. 左ドロワーが開いている時のナビゲーション
    if (state.drawerOpen) {
      wakeBottomGuide();
      if (code === 38) {
        ev.preventDefault();
        if (state.focusables.length > 0) {
          state.focusIndex = Math.max(0, state.focusIndex - 1);
          applyFocus(state.focusIndex);
        }
      } else if (code === 40) {
        ev.preventDefault();
        if (state.focusables.length > 0) {
          state.focusIndex = Math.min(state.focusables.length - 1, state.focusIndex + 1);
          applyFocus(state.focusIndex);
        }
      } else if (code === 37 || code === 39) {
        ev.preventDefault();
        var defs = getActiveTabDefs();
        // EPG_LAUNCH をスキップせずタブ移動できるようにする（ただし決定時ではなく通常タブとして切り替え、EPG_LAUNCH に当たったら次の実タブへ行くか開く）
        var switchable = [];
        for (var s = 0; s < defs.length; s++) {
          if (defs[s].id !== 'EPG_LAUNCH') switchable.push(defs[s].id);
        }
        var ci = switchable.indexOf(state.currentTab);
        var ni = (ci + (code === 39 ? 1 : -1) + switchable.length) % switchable.length;
        switchTab(switchable[ni]);
      } else if (code === 13) {
        ev.preventDefault();
        var f = state.focusables[state.focusIndex];
        if (f && f._onActivate) f._onActivate();
      }
      return;
    }

    // 4. 全画面視聴中のキー操作
    // ★ 映像表示状態で「↓ボタン(40)」: 1回目でOSD番組情報バナー、表示中にもう一度↓で全モード共通の番組詳細モーダルを開く
    // ★ 「決定ボタン(13)」: 1回目でOSD表示、表示中はライブなら番組詳細 / VOD・録画なら一時停止・再開
    function handleConfirmOrDownInFullscreen(keyCode) {
      if (isAllUiHidden()) {
        showOsdBanner();
        return;
      }
      if (keyCode === 40) {
        if (state.mode === 'LIVE' && state.currentService) {
          var pnDown = window.MirakurunClient.getCurrentAndNext(state.programsMap, state.currentService);
          openEpgProgramDetail(state.currentService, pnDown.current);
        } else if (state.mode === 'VOD' && state.currentVod) {
          openCurrentVodDetailModal();
        } else if (state.mode === 'RECORDED' && state.currentRecorded) {
          openCurrentRecordedDetailModal();
        } else {
          setDrawerOpen(true);
        }
        return;
      }
      if ((state.mode === 'VOD' && state.currentVod && !state.currentVod.isLive) || (state.mode === 'RECORDED' && state.currentRecorded)) {
        if (dom.video.paused) {
          dom.video.play();
          showRichToast('info', '再生再開', '');
        } else {
          dom.video.pause();
          flushCurrentVodProgress();
          showRichToast('info', '一時停止', '再生位置を保存しました');
        }
        showOsdBanner();
      } else if (state.mode === 'LIVE' && state.currentService) {
        var pn = window.MirakurunClient.getCurrentAndNext(state.programsMap, state.currentService);
        openEpgProgramDetail(state.currentService, pn.current);
      } else if (state.mode === 'VOD' && state.currentVod && state.currentVod.isLive) {
        openCurrentVodDetailModal();
      } else {
        setDrawerOpen(true);
      }
    }

    if (code === 13 || code === 40) {
      ev.preventDefault();
      handleConfirmOrDownInFullscreen(code);
      return;
    }

    // メニュー消灯中に ↑ / ← / → を押したときは誤選局を防ぐためワンクッションでメニューを開く
    if (isAllUiHidden()) {
      if (code === 37 || code === 38 || code === 39) {
        ev.preventDefault();
        setDrawerOpen(true);
        return;
      }
    }

    // OSD表示中の ← / → / ↑ 操作
    if (code === 37) {
      ev.preventDefault();
      if ((state.mode === 'VOD' && state.currentVod && !state.currentVod.isLive) || (state.mode === 'RECORDED' && state.currentRecorded)) {
        seekVod(-15);
      } else {
        setDrawerOpen(true);
      }
    } else if (code === 39) {
      ev.preventDefault();
      if ((state.mode === 'VOD' && state.currentVod && !state.currentVod.isLive) || (state.mode === 'RECORDED' && state.currentRecorded)) {
        seekVod(30);
      } else {
        openEpgGrid((state.currentService && state.currentService.channelType) || 'GR');
      }
    } else if (code === 38) {
      ev.preventDefault();
      if (state.mode === 'RECORDED' && isRecordingFeatureEnabled()) {
        openRecordedOverlay('ALL');
      } else {
        setDrawerOpen(true);
      }
    }
  });

  // webOS Magic リモコンのポインター出現・消滅を監視し、カーソル表示直後の誤選局を防ぐ
  document.addEventListener('cursorStateChange', function (ev) {
    var vis = !!(ev && ev.detail && ev.detail.visibility);
    if (vis && !state.cursorVisible) {
      state.cursorShownAt = Date.now();
      state.wheelZapArmedAt = 0;
      state.wheelZapArmedDir = 0;
    }
    state.cursorVisible = vis;
  }, false);

  // =========================================================================
  // Magicリモコン 中心コロコロ (ホイール回転) 統合サポート
  // - メニュー / EPG / モーダル表示中: 上下ボタンと同じように項目フォーカスを上下移動
  // - DTV(GR/BS/BS4K/CS) 映像視聴中(メニュー閉): 1コロ目(カーソル呼び出し等)では選局せず、
  //   続けて同方向へ2コロ目以上回した時のみ選局する
  // =========================================================================
  function handleMagicWheel(ev) {
    var rawDelta = 0;
    if (typeof ev.wheelDelta === 'number') {
      rawDelta = -ev.wheelDelta; // 上回転が負(-1)、下回転が正(+1)になるよう正規化
    } else if (typeof ev.deltaY === 'number') {
      rawDelta = ev.deltaY;
    }
    if (rawDelta === 0) return;

    var dir = rawDelta > 0 ? 1 : -1; // +1: 下へ回した, -1: 上へ回した
    var now = Date.now();
    // Chromium 53 で mousewheel / wheel の両イベントが 1ノッチで二重発火するのを正規化
    if (now - state.lastWheelRawTime < 28) {
      ev.preventDefault();
      return;
    }
    state.lastWheelRawTime = now;

    // 1. モーダル表示中
    if (state.modalOpen) {
      ev.preventDefault();
      if (now - state.lastWheelTime < 140) return;
      state.lastWheelTime = now;
      state.modalFocusIdx = Math.max(0, Math.min(state.modalButtons.length - 1, state.modalFocusIdx + dir));
      applyModalFocus();
      return;
    }

    // 1b. SimilarList (チャンネル番号候補リスト) 表示中: コロコロ回転で候補フォーカスを上下移動
    if (state.similarOpen) {
      ev.preventDefault();
      if (now - state.lastWheelTime < 90) return;
      state.lastWheelTime = now;
      if (state.similarCandidates.length > 0) {
        state.similarFocusIdx = Math.max(0, Math.min(state.similarCandidates.length - 1, state.similarFocusIdx + dir));
        state.similarMoved = true;
        applySimilarFocus(false);
        restartSimilarTimer();
      }
      return;
    }

    // 2. 全画面 録画・保存ライブラリ表示中
    if (state.recOverlayOpen) {
      ev.preventDefault();
      if (now - state.lastWheelTime < 90) return;
      state.lastWheelTime = now;
      if (state.recZone === 'SIDEBAR') {
        state.recSideIdx = Math.max(0, Math.min(state.recSideDefs.length - 1, state.recSideIdx + dir));
      } else {
        state.recZone = 'LIST';
        if (state.recItems.length > 0) {
          state.recListIdx = Math.max(0, Math.min(state.recItems.length - 1, state.recListIdx + dir));
        }
      }
      applyRecOverlayFocus(false);
      return;
    }

    // 2b. 2次元 EPG ラテ欄表示中
    if (state.epgOpen) {
      ev.preventDefault();
      if (now - state.lastWheelTime < 120) return;
      state.lastWheelTime = now;
      if (state.epgInToolbar) {
        if (dir > 0) {
          state.epgInToolbar = false;
          applyEpgFocus();
        }
        return;
      }
      var curCol = state.epgColsCells[state.epgColIdx] || [];
      if (dir < 0) {
        if (state.epgRowIdx > 0) state.epgRowIdx--;
        else state.epgInToolbar = true;
      } else {
        if (state.epgRowIdx < curCol.length - 1) state.epgRowIdx++;
      }
      applyEpgFocus();
      return;
    }

    // 3. 左メインメニュー表示中: 上下ボタンと同じくフォーカスを上下移動
    if (state.drawerOpen) {
      ev.preventDefault();
      if (now - state.lastWheelTime < 90) return;
      state.lastWheelTime = now;
      wakeBottomGuide();
      if (state.focusables.length > 0) {
        state.focusIndex = Math.max(0, Math.min(state.focusables.length - 1, state.focusIndex + dir));
        applyFocus(state.focusIndex);
      }
      return;
    }

    // 3b. データ放送 (BML) 表示中はホイールで誤選局しない
    if (aribManager && aribManager.getStatus().bmlActive) {
      ev.preventDefault();
      return;
    }

    // 4. 全画面映像視聴中 (メニュー閉): 1コロ目では選局せず、続けて同方向へ2コロ目以上回した時のみ選局
    ev.preventDefault();
    if (state.mode === 'LIVE' || (state.mode === 'IDLE' && state.services.length > 0)) {
      var sinceArmed = now - state.wheelZapArmedAt;
      var justShowedCursor = (now - state.cursorShownAt) < 450;
      if (justShowedCursor || state.wheelZapArmedAt === 0 || sinceArmed > 1200 || state.wheelZapArmedDir !== dir) {
        // 1コロ目（カーソル呼び出しや単発タッチ）: 選局を入れずアーム状態のみ記録する
        state.wheelZapArmedAt = now;
        state.wheelZapArmedDir = dir;
        return;
      }
      if (now - state.lastWheelTime < 350) return; // 連続選局しすぎ防止のクールダウン
      state.lastWheelTime = now;
      state.wheelZapArmedAt = now;
      state.wheelZapArmedDir = dir;
      // 上に回す(dir < 0) -> 次のチャンネル(+1), 下に回す(dir > 0) -> 前のチャンネル(-1)
      zapChannel(dir < 0 ? 1 : -1);
    } else {
      if (now - state.lastWheelTime < 250) return;
      state.lastWheelTime = now;
      showOsdBanner();
    }
  }

  window.addEventListener('mousewheel', handleMagicWheel, false);
  window.addEventListener('wheel', handleMagicWheel, false);

  // 画面クリック時も「全画面消灯中なら1クリック目はOSD＋ガイド表示のみ（ワンクッション）」にする
  dom.video.onclick = function () {
    if (state.similarOpen) {
      closeSimilarList();
      return;
    }
    if (state.drawerOpen) {
      setDrawerOpen(false);
      return;
    }
    if (isAllUiHidden()) {
      showOsdBanner();
      return;
    }
    setDrawerOpen(true);
  };

  dom.osdRecBtn.onclick = function (ev) {
    ev.stopPropagation();
    promptRecordingAction(null);
  };

  // 下部 OSD タイムバー (赤線) のカーソルクリック＆ドラッグシーク対応 (録画 / VOD)
  (function bindOsdSeekBar() {
    var track = dom.osdProgressTrack;
    if (!track) return;

    function calcSecFromClientX(clientX) {
      var dur = getSeekableDurationSec();
      if (dur <= 0) return null;
      var rect = track.getBoundingClientRect();
      if (!rect || rect.width <= 0) return null;
      var ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(ratio * dur);
    }

    function updateScrubPreview(clientX) {
      var sec = calcSecFromClientX(clientX);
      if (sec === null) return false;
      state.osdScrubTargetSec = sec;
      var dur = getSeekableDurationSec();
      var pct = dur > 0 ? Math.min(100, Math.max(0, (sec / dur) * 100)) : 0;
      dom.osdProgress.style.width = pct.toFixed(2) + '%';
      dom.osdTimeText.textContent = formatSec(sec) + ' / ' + formatSec(dur);
      if (state.osdTimer) clearTimeout(state.osdTimer);
      state.osdTimer = setTimeout(function () {
        if (!state.osdScrubbing) {
          state.osdVisible = false;
          dom.osd.className = '';
          wakeBottomGuide();
        }
      }, 6000);
      return true;
    }

    track.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });

    track.addEventListener('mousedown', function (ev) {
      if (getSeekableDurationSec() <= 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      state.osdScrubbing = true;
      track.className = 'osd-progress-track seekable scrubbing';
      updateScrubPreview(ev.clientX);
    });

    document.addEventListener('mousemove', function (ev) {
      if (!state.osdScrubbing) return;
      updateScrubPreview(ev.clientX);
    });

    document.addEventListener('mouseup', function (ev) {
      if (!state.osdScrubbing) return;
      state.osdScrubbing = false;
      var finalSec = calcSecFromClientX(ev.clientX);
      if (finalSec === null) finalSec = state.osdScrubTargetSec;
      track.className = 'osd-progress-track seekable';
      seekToAbsoluteSec(finalSec);
    });

    track.addEventListener('touchstart', function (ev) {
      if (getSeekableDurationSec() <= 0 || !ev.touches || !ev.touches[0]) return;
      ev.stopPropagation();
      state.osdScrubbing = true;
      track.className = 'osd-progress-track seekable scrubbing';
      updateScrubPreview(ev.touches[0].clientX);
    }, { passive: true });

    document.addEventListener('touchmove', function (ev) {
      if (!state.osdScrubbing || !ev.touches || !ev.touches[0]) return;
      updateScrubPreview(ev.touches[0].clientX);
    }, { passive: true });

    document.addEventListener('touchend', function () {
      if (!state.osdScrubbing) return;
      state.osdScrubbing = false;
      track.className = 'osd-progress-track seekable';
      seekToAbsoluteSec(state.osdScrubTargetSec);
    });

    // OSD バナー上にカーソルを置いている間はクリック・ドラッグしやすいよう自動消灯を延長
    dom.osd.addEventListener('mousemove', function () {
      if (!state.osdVisible) return;
      if (state.osdTimer) clearTimeout(state.osdTimer);
      state.osdTimer = setTimeout(function () {
        if (!state.osdScrubbing) {
          state.osdVisible = false;
          dom.osd.className = '';
          wakeBottomGuide();
        }
      }, 6000);
    });

    dom.video.addEventListener('durationchange', function () {
      if (state.mode === 'RECORDED' && state.currentRecorded && !state.recIsRawTs) {
        if (isFinite(dom.video.duration) && dom.video.duration > 1) {
          state.currentRecorded.durationSec = Math.round(dom.video.duration);
          if (state.osdVisible && !state.osdScrubbing) refreshOsdContent();
        }
      }
    });

    // OSD 表示中は再生時刻と赤バーをリアルタイム追従更新する (ドラッグ操作中は上書きしない)
    function updateOsdProgressRealtime() {
      if (!state.osdVisible || state.osdScrubbing) return;
      if (state.mode === 'RECORDED' && state.currentRecorded) {
        var rec = state.currentRecorded;
        var vDur = (dom.video && isFinite(dom.video.duration) && dom.video.duration > 1) ? dom.video.duration : 0;
        var rCur = Math.floor(getCurrentPlaybackSec());
        var rDur = Math.floor((!state.recIsRawTs && vDur > 0) ? vDur : (rec.realDurationSec || rec.durationSec || vDur || 0));
        if (rDur > 0 && rCur > rDur) rDur = rCur;
        dom.osdTimeText.textContent = formatSec(rCur) + ' / ' + (rDur > 0 ? formatSec(rDur) : '--:--');
        var rPct = rDur > 0 ? Math.min(100, (rCur / rDur) * 100) : 0;
        dom.osdProgress.style.width = rPct.toFixed(2) + '%';
      } else if (state.mode === 'VOD' && state.currentVod && !state.currentVod.isLive) {
        var curSec = Math.floor(dom.video.currentTime || 0);
        var durSec = Math.floor((dom.video.duration && isFinite(dom.video.duration)) ? dom.video.duration : (state.currentVod.duration || 0));
        dom.osdTimeText.textContent = formatSec(curSec) + ' / ' + (durSec > 0 ? formatSec(durSec) : '--:--');
        var pct = durSec > 0 ? Math.min(100, (curSec / durSec) * 100) : 0;
        dom.osdProgress.style.width = pct.toFixed(2) + '%';
      } else if (state.mode === 'LIVE' && state.currentService) {
        var pn = window.MirakurunClient.getCurrentAndNext(state.programsMap, state.currentService);
        if (pn.current && pn.current.duration > 0) {
          var elapsed = Date.now() - pn.current.startAt;
          var ratio = Math.max(0, Math.min(100, (elapsed / pn.current.duration) * 100));
          dom.osdProgress.style.width = ratio.toFixed(2) + '%';
        }
      }
    }

    dom.video.addEventListener('timeupdate', updateOsdProgressRealtime);
    setInterval(updateOsdProgressRealtime, 500);
  })();

  document.getElementById('btn-guide-red').onclick = toggleJikkyo;
  document.getElementById('btn-guide-green').onclick = cycleAudioMode;
  document.getElementById('btn-guide-yellow').onclick = toggleCommentPanel;
  document.getElementById('btn-guide-blue').onclick = function () { setDrawerOpen(!state.drawerOpen); };
  var btn3Digit = document.getElementById('btn-guide-3digit');
  if (btn3Digit) {
    btn3Digit.onclick = function () {
      openThreeDigitInputPanel(null);
    };
  }
  document.getElementById('btn-guide-epg').onclick = function () {
    if (state.epgOpen) closeEpgGrid();
    else openEpgGrid((state.currentService && state.currentService.channelType) || 'GR');
  };
  if (dom.btnGuideRecList) {
    dom.btnGuideRecList.onclick = function () {
      if (state.recOverlayOpen) closeRecordedOverlay();
      else openRecordedOverlay('ALL');
    };
  }
  document.getElementById('btn-guide-rec').onclick = function () { promptRecordingAction(null); };
  document.getElementById('btn-guide-info').onclick = function () {
    if (!state.osdVisible) {
      showOsdBanner();
      return;
    }
    if (state.mode === 'LIVE' && state.currentService) {
      var pnInfo = window.MirakurunClient.getCurrentAndNext(state.programsMap, state.currentService);
      openEpgProgramDetail(state.currentService, pnInfo.current);
    } else if (state.mode === 'VOD' && state.currentVod) {
      openCurrentVodDetailModal();
    } else if (state.mode === 'RECORDED' && state.currentRecorded) {
      openCurrentRecordedDetailModal();
    }
  };
  if (dom.btnGuideSub) dom.btnGuideSub.onclick = toggleSubtitleMode;
  if (dom.btnGuideBml) dom.btnGuideBml.onclick = toggleDataBroadcast;
  var btnBmlBlue = document.getElementById('btn-bml-blue');
  var btnBmlRed = document.getElementById('btn-bml-red');
  var btnBmlGreen = document.getElementById('btn-bml-green');
  var btnBmlYellow = document.getElementById('btn-bml-yellow');
  var btnBmlSub = document.getElementById('btn-bml-sub');
  var btnBmlBack = document.getElementById('btn-bml-back');
  var btnBmlClose = document.getElementById('btn-bml-close');
  if (btnBmlBlue) btnBmlBlue.onclick = function () { if (aribManager) aribManager.handleKeyDown(406); };
  if (btnBmlRed) btnBmlRed.onclick = function () { if (aribManager) aribManager.handleKeyDown(403); };
  if (btnBmlGreen) btnBmlGreen.onclick = function () { if (aribManager) aribManager.handleKeyDown(404); };
  if (btnBmlYellow) btnBmlYellow.onclick = function () { if (aribManager) aribManager.handleKeyDown(405); };
  if (btnBmlSub) btnBmlSub.onclick = toggleSubtitleMode;
  if (btnBmlBack) btnBmlBack.onclick = function () { if (aribManager) aribManager.handleKeyDown(461); };
  if (btnBmlClose) btnBmlClose.onclick = function () { if (aribManager) aribManager.closeBml(false); };

  // =========================================================================
  // 起動シーケンス (KeyMask 解放 & 常駐デーモン起動後に Mirakurun / EPGStation 読込)
  // =========================================================================
  try {
    var fullMasks = [
      'KeyMaskDefault', 'KeyMaskTeletext', 'KeyMaskProgramme', 'KeyMaskPlayback',
      'KeyMaskNumeric', 'KeyMaskRed', 'KeyMaskGreen', 'KeyMaskYellow', 'KeyMaskBlue',
      'KeyMaskLeft', 'KeyMaskRight', 'KeyMaskUp', 'KeyMaskDown', 'KeyMaskOk',
      'KeyMaskBack', 'KeyMaskGuide'
    ];
    if (window.webOSSystem && typeof window.webOSSystem.setKeyMask === 'function') {
      window.webOSSystem.setKeyMask(fullMasks);
    } else if (window.PalmSystem && typeof window.PalmSystem.setKeyMask === 'function') {
      window.PalmSystem.setKeyMask(fullMasks);
    }
  } catch (e) {}
  syncRecordingModeUi();
  renderNavTabs();

  window.WebOSBridge.ensureLocalHelper(function (ok, info) {
    if (ok && info) {
      if (info.ytdlpVersion) state.ytdlpVersion = info.ytdlpVersion;
      if (info.lanIp) state.deviceLanIp = info.lanIp;
    }
    // DTV Plus 側の現在の実況設定を常駐デーモンへ同期しておく
    saveSettings();

    // TV 版起動時: PC からの同期設定が届いていれば即座に確認モーダルを提示
    if (!window.DtvPlusPcSync) {
      checkIncomingSyncedSettings(true);
    }

    if (isRecordingFeatureEnabled() && state.settings.epgstationUrl) {
      loadEpgStationConnection(false, function () {
        refreshEpgStationLiveStatus();
      });
      setInterval(function () {
        refreshEpgStationLiveStatus();
      }, 30000);
    }
    if (isRecordingFeatureEnabled() && normalizeMediaSaveUrl(state.settings.mediaSaveServerUrl)) {
      refreshAbemaReserves();
      setInterval(function () {
        if (state.mode === 'VOD' && state.currentVod && state.currentVod.isLive) {
          refreshAbemaReserves();
        }
      }, 20000);
    }

    if (state.settings.bs4kMirakurunUrl) {
      loadBs4kMirakurunData(false);
    }

    // KonomiTV 準拠: 実況勢いを起動時に取得し、ドロワー表示中は 30 秒ごとに自動更新
    refreshJikkyoForces(true);
    setInterval(function () {
      if (state.drawerOpen && (state.currentTab === 'GR' || state.currentTab === 'BS' || state.currentTab === 'BS4K' || state.currentTab === 'CS')) {
        refreshJikkyoForces(false);
      }
    }, 30000);

    if (!state.settings.mirakurunUrl) {
      // 初回未設定時は設定タブを自動で開いてすぐ LAN 検索・PC 同期できるようにする
      switchTab('SETTINGS');
    }

    loadMirakurunData(false, function (mkOk) {
      if (mkOk && state.settings.autoPlayLastChannel && state.settings.lastServiceId) {
        var svc = findServiceById(state.settings.lastServiceId);
        if (svc) {
          playLiveChannel(svc);
          setDrawerOpen(false);
        }
      }
    });
  });
})();
