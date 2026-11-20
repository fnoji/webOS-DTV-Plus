/* -*- coding: utf-8 -*-
 * jikkyo.js - 全国放送局→ニコニコ実況ID判定 & 文字サイズ・透過度可変 GPU弾幕エンジン
 * 55インチ大画面対応・Chromium 53 (ES5) 完全互換
 */
(function (global) {
  'use strict';

  var BS_SERVICE_MAP = {
    101: 'jk101', 102: 'jk101',
    103: 'jk103', 104: 'jk103',
    141: 'jk141', 142: 'jk141', 143: 'jk141',
    151: 'jk151', 152: 'jk151', 153: 'jk151',
    161: 'jk161', 162: 'jk161', 163: 'jk161',
    171: 'jk171', 172: 'jk171', 173: 'jk171',
    181: 'jk181', 182: 'jk181', 183: 'jk181',
    191: 'jk191', 192: 'jk192', 193: 'jk193',
    200: 'jk200', 201: 'jk201', 202: 'jk202',
    211: 'jk211',
    222: 'jk222',
    236: 'jk236',
    252: 'jk252',
    260: 'jk260',
    263: 'jk263',
    265: 'jk265'
  };

  var JIKKYO_CHANNELS = [
    { id: 'jk1', name: 'NHK総合' },
    { id: 'jk2', name: 'NHK Eテレ' },
    { id: 'jk4', name: '日テレ系 (STV等)' },
    { id: 'jk5', name: 'テレ朝系 (HTB等)' },
    { id: 'jk6', name: 'TBS系 (HBC等)' },
    { id: 'jk7', name: 'テレ東系 (TVh等)' },
    { id: 'jk8', name: 'フジ系 (UHB等)' },
    { id: 'jk9', name: 'TOKYO MX' },
    { id: 'jk101', name: 'NHK BS' },
    { id: 'jk141', name: 'BS日テレ' },
    { id: 'jk151', name: 'BS朝日' },
    { id: 'jk161', name: 'BS-TBS' },
    { id: 'jk171', name: 'BSテレ東' },
    { id: 'jk181', name: 'BSフジ' },
    { id: 'jk211', name: 'BS11' },
    { id: 'jk222', name: 'BS12' }
  ];

  // 55インチTV向け 文字サイズプリセット (レーン数も連動再計算)
  var FONT_SIZE_PRESETS = {
    small:  { label: '小 (32px)',   basePx: 32, lanes: 13 },
    medium: { label: '標準 (42px)', basePx: 42, lanes: 10 },
    large:  { label: '大 (54px)',   basePx: 54, lanes: 8 },
    xlarge: { label: '特大 (66px)', basePx: 66, lanes: 6 }
  };

  function toHalfWidth(str) {
    if (!str) return '';
    return str.replace(/[！-～]/g, function (s) {
      return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    }).replace(/　/g, ' ');
  }

  function resolveJikkyoId(serviceOrName) {
    if (!serviceOrName) return null;
    if (typeof serviceOrName === 'object') {
      var netId = serviceOrName.networkId || 0;
      var svcId = serviceOrName.serviceId || 0;
      if (netId === 4 && BS_SERVICE_MAP[svcId]) return BS_SERVICE_MAP[svcId];
      if (BS_SERVICE_MAP[svcId] && svcId >= 101 && svcId <= 299) return BS_SERVICE_MAP[svcId];
    }

    var rawName = typeof serviceOrName === 'string' ? serviceOrName : (serviceOrName.name || '');
    var n = toHalfWidth(rawName).toUpperCase();

    if (n.indexOf('NHK総合') !== -1 || n.indexOf('NHK G') !== -1) return 'jk1';
    if (n.indexOf('Eテレ') !== -1 || n.indexOf('NHK教育') !== -1) return 'jk2';
    if (
      n.indexOf('日本テレビ') !== -1 || n.indexOf('日テレ') !== -1 || n.indexOf('NTV') !== -1 ||
      n.indexOf('札幌テレビ') !== -1 || n.indexOf('STV') !== -1 || n.indexOf('読売テレビ') !== -1 ||
      n.indexOf('中京テレビ') !== -1 || n.indexOf('福岡放送') !== -1 || n.indexOf('ミヤギテレビ') !== -1
    ) return 'jk4';
    if (
      n.indexOf('テレビ朝日') !== -1 || n.indexOf('テレ朝') !== -1 || n.indexOf('HTB') !== -1 ||
      n.indexOf('北海道テレビ') !== -1 || n.indexOf('朝日放送') !== -1 || n.indexOf('ABC') !== -1 ||
      n.indexOf('メ~テレ') !== -1 || n.indexOf('メーテレ') !== -1 || n.indexOf('名古屋テレビ') !== -1 ||
      n.indexOf('九州朝日') !== -1
    ) return 'jk5';
    if (
      n.indexOf('TBS') !== -1 || n.indexOf('HBC') !== -1 || n.indexOf('北海道放送') !== -1 ||
      n.indexOf('毎日放送') !== -1 || n.indexOf('MBS') !== -1 || n.indexOf('CBC') !== -1 ||
      n.indexOf('RKB') !== -1 || n.indexOf('東北放送') !== -1
    ) return 'jk6';
    if (
      n.indexOf('テレビ東京') !== -1 || n.indexOf('テレ東') !== -1 || n.indexOf('TVH') !== -1 ||
      n.indexOf('テレビ北海道') !== -1 || n.indexOf('テレビ大阪') !== -1 || n.indexOf('テレビ愛知') !== -1 ||
      n.indexOf('TVQ') !== -1 || n.indexOf('テレビせとうち') !== -1
    ) return 'jk7';
    if (
      n.indexOf('フジテレビ') !== -1 || n.indexOf('UHB') !== -1 || n.indexOf('北海道文化') !== -1 ||
      n.indexOf('関西テレビ') !== -1 || n.indexOf('カンテレ') !== -1 || n.indexOf('東海テレビ') !== -1 ||
      n.indexOf('テレビ西日本') !== -1 || n.indexOf('仙台放送') !== -1
    ) return 'jk8';

    if (n.indexOf('MX') !== -1) return 'jk9';
    if (n.indexOf('TVK') !== -1 || n.indexOf('テレビ神奈川') !== -1) return 'jk11';
    if (n.indexOf('サンテレビ') !== -1) return 'jk13';
    if (n.indexOf('KBS') !== -1) return 'jk14';
    if (n.indexOf('BS11') !== -1) return 'jk211';
    if (n.indexOf('BS12') !== -1 || n.indexOf('トゥエルビ') !== -1) return 'jk222';

    return null;
  }

  var COLOR_MAP = {
    white: '#FFFFFF', red: '#FF3B30', pink: '#FF80AB', orange: '#FF9500',
    yellow: '#FFD60A', green: '#34C759', cyan: '#32ADE6', blue: '#0A84FF',
    purple: '#BF5AF2', black: '#222222', white2: '#CCCC99', niconicowhite: '#CCCC99',
    red2: '#CC0033', truered: '#CC0033', pink2: '#FF33CC', orange2: '#FF6600',
    passionorange: '#FF6600', yellow2: '#999900', madyellow: '#999900',
    green2: '#00CC66', elementalgreen: '#00CC66', cyan2: '#00CCCC',
    blue2: '#3399FF', marineblue: '#3399FF', purple2: '#6633CC', nobleviolet: '#6633CC'
  };

  function parseMailStyle(mailStr) {
    var result = { color: '#FFFFFF', pos: 'naka', size: 'medium' };
    if (!mailStr) return result;
    var parts = mailStr.toLowerCase().split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (p === 'ue' || p === 'shita' || p === 'naka') result.pos = p;
      else if (p === 'big' || p === 'small' || p === 'medium') result.size = p;
      else if (COLOR_MAP[p]) result.color = COLOR_MAP[p];
      else if (/^#[0-9a-f]{6}$/.test(p)) result.color = p;
    }
    return result;
  }

  function JikkyoEngine(containerEl, options) {
    this.container = containerEl;
    this.opts = options || {};
    this.enabled = true;
    this.opacity = 0.85;
    this.fontSizeKey = 'medium';
    this.durationSec = 7.5;
    this.lanes = [];
    this._rebuildLanes();

    this.currentJkId = null;
    this.watchWs = null;
    this.commentWs = null;
    this.keepSeatTimer = null;
    this.reconnectTimer = null;
    this.abemaPollTimer = null;
    this.abemaDispatchTimers = [];
    this.destroyed = false;

    this.recentTimestamps = [];
    this.totalReceived = 0;
    this.logBuffer = [];
    this.onCommentCallback = this.opts.onComment || null;
    this.onStatusCallback = this.opts.onStatus || null;
  }

  JikkyoEngine.prototype._rebuildLanes = function () {
    var preset = FONT_SIZE_PRESETS[this.fontSizeKey] || FONT_SIZE_PRESETS.medium;
    this.baseFontPx = preset.basePx;
    this.laneCount = preset.lanes;
    this.lanes = [];
    for (var i = 0; i < this.laneCount; i++) {
      this.lanes.push(0);
    }
  };

  JikkyoEngine.prototype.setFontSizeKey = function (key) {
    if (!FONT_SIZE_PRESETS[key]) key = 'medium';
    this.fontSizeKey = key;
    this._rebuildLanes();
  };

  JikkyoEngine.prototype.setEnabled = function (flag) {
    this.enabled = !!flag;
    if (this.container) {
      this.container.style.display = this.enabled ? 'block' : 'none';
      if (!this.enabled) this.clearScreen();
    }
  };

  JikkyoEngine.prototype.setOpacity = function (val) {
    var v = Math.max(0.1, Math.min(1.0, Number(val) || 0.85));
    this.opacity = v;
    if (this.container) {
      this.container.style.opacity = String(v);
    }
  };

  JikkyoEngine.prototype.clearScreen = function () {
    if (!this.container) return;
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }
    for (var i = 0; i < this.laneCount; i++) {
      this.lanes[i] = 0;
    }
  };

  JikkyoEngine.prototype.getForcePerMin = function () {
    var now = Date.now();
    var cutoff = now - 60000;
    while (this.recentTimestamps.length > 0 && this.recentTimestamps[0] < cutoff) {
      this.recentTimestamps.shift();
    }
    return this.recentTimestamps.length;
  };

  JikkyoEngine.prototype.renderComment = function (text, mailStr, isHistory) {
    if (!text || text.indexOf('/') === 0) return;
    var clean = text.replace(/\r?\n/g, ' ').trim();
    if (!clean) return;

    var now = Date.now();
    if (!isHistory) {
      this.recentTimestamps.push(now);
      this.totalReceived++;
    }

    var styleInfo = parseMailStyle(mailStr);
    var commentObj = {
      text: clean,
      color: styleInfo.color,
      time: new Date().toTimeString().slice(0, 8)
    };
    this.logBuffer.push(commentObj);
    if (this.logBuffer.length > 80) this.logBuffer.shift();
    if (this.onCommentCallback) {
      this.onCommentCallback(commentObj, this.getForcePerMin());
    }

    if (!this.enabled || !this.container) return;
    if (this.container.childNodes.length > 50) return;

    var el = document.createElement('div');
    el.className = 'jk-bullet';
    el.textContent = clean;
    el.style.color = styleInfo.color;

    var scale = styleInfo.size === 'big' ? 1.24 : (styleInfo.size === 'small' ? 0.80 : 1.0);
    var fontSize = Math.round(this.baseFontPx * scale);
    el.style.fontSize = fontSize + 'px';

    if (styleInfo.pos === 'ue' || styleInfo.pos === 'shita') {
      el.style.left = '50%';
      el.style.webkitTransform = 'translate3d(-50%, 0, 0)';
      el.style.transform = 'translate3d(-50%, 0, 0)';
      if (styleInfo.pos === 'ue') el.style.top = '7%';
      else el.style.bottom = '14%';
      this.container.appendChild(el);
      var selfFixed = this;
      setTimeout(function () {
        if (el.parentNode === selfFixed.container) {
          selfFixed.container.removeChild(el);
        }
      }, 4000);
      return;
    }

    var chosenLane = 0;
    var earliest = this.lanes[0];
    for (var i = 0; i < this.laneCount; i++) {
      if (this.lanes[i] <= now) {
        chosenLane = i;
        break;
      }
      if (this.lanes[i] < earliest) {
        earliest = this.lanes[i];
        chosenLane = i;
      }
    }
    var occupyMs = Math.min(3200, 950 + clean.length * (fontSize * 2.4));
    this.lanes[chosenLane] = now + occupyMs;

    var laneHeight = Math.floor(880 / this.laneCount);
    var topPx = 28 + chosenLane * laneHeight;
    el.style.top = topPx + 'px';
    el.style.webkitTransform = 'translate3d(1960px, 0, 0)';
    el.style.transform = 'translate3d(1960px, 0, 0)';
    this.container.appendChild(el);

    var travelPx = 2120 + clean.length * fontSize;
    var dur = this.durationSec;

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.style.webkitTransition = '-webkit-transform ' + dur + 's linear';
        el.style.transition = 'transform ' + dur + 's linear';
        el.style.webkitTransform = 'translate3d(-' + (travelPx - 1920) + 'px, 0, 0)';
        el.style.transform = 'translate3d(-' + (travelPx - 1920) + 'px, 0, 0)';
      });
    });

    var self = this;
    setTimeout(function () {
      if (el.parentNode === self.container) {
        self.container.removeChild(el);
      }
    }, dur * 1000 + 250);
  };

  JikkyoEngine.prototype.connect = function (jkId) {
    this.disconnect();
    this.destroyed = false;
    this.currentJkId = jkId;
    this.recentTimestamps = [];
    this.logBuffer = [];

    if (!jkId) {
      this._notifyStatus('実況枠なし', null);
      return;
    }
    this._notifyStatus('接続中: ' + jkId.toUpperCase(), jkId);
    this._openWatchSession(jkId);
  };

  JikkyoEngine.prototype._notifyStatus = function (text, jkId) {
    if (this.onStatusCallback) {
      this.onStatusCallback(text, jkId || this.currentJkId);
    }
  };

  JikkyoEngine.prototype._openWatchSession = function (jkId) {
    var self = this;
    var watchUrl = 'wss://nx-jikkyo.tsukumijima.net/api/v1/channels/' + jkId + '/ws/watch';
    var commentFallbackUrl = 'wss://nx-jikkyo.tsukumijima.net/api/v1/channels/' + jkId + '/ws/comment';
    var commentOpened = false;

    try {
      var ws = new WebSocket(watchUrl);
      this.watchWs = ws;

      ws.onopen = function () {
        if (self.watchWs !== ws) return;
        ws.send(JSON.stringify({ type: 'startWatching', data: { reconnect: false } }));
      };

      ws.onmessage = function (ev) {
        if (self.watchWs !== ws) return;
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (msg.type === 'seat' && msg.data && msg.data.keepIntervalSec) {
          if (self.keepSeatTimer) clearInterval(self.keepSeatTimer);
          self.keepSeatTimer = setInterval(function () {
            if (self.watchWs && self.watchWs.readyState === 1) {
              self.watchWs.send(JSON.stringify({ type: 'keepSeat' }));
            }
          }, msg.data.keepIntervalSec * 1000);
        } else if (msg.type === 'room' && !commentOpened) {
          commentOpened = true;
          var uri = (msg.data && msg.data.messageServer && msg.data.messageServer.uri) || commentFallbackUrl;
          var threadId = (msg.data && msg.data.threadId) || '';
          var postKey = (msg.data && msg.data.yourPostKey) || undefined;
          self._openCommentSession(uri, threadId, postKey, jkId);
        } else if (msg.type === 'messageServer' && !commentOpened) {
          commentOpened = true;
          var hashed = (msg.data && msg.data.hashedUserId) || '';
          self._openCommentSession(commentFallbackUrl, '', hashed ? ('nicolive:' + hashed) : undefined, jkId);
        }
      };

      ws.onclose = function () {
        if (self.watchWs !== ws || self.destroyed) return;
        self._scheduleReconnect();
      };
    } catch (err) {
      this._scheduleReconnect();
    }
  };

  JikkyoEngine.prototype._openCommentSession = function (uri, threadId, threadKey, jkId) {
    var self = this;
    try {
      var cws = new WebSocket(uri);
      this.commentWs = cws;
      var initialPhase = true;
      var initialTimer = null;

      cws.onopen = function () {
        if (self.commentWs !== cws) return;
        self._notifyStatus('実況中: ' + jkId.toUpperCase(), jkId);
        var threadReq = { version: '20061206', thread: threadId || '', user_id: '', res_from: -20 };
        if (threadKey) threadReq.threadkey = threadKey;

        cws.send(JSON.stringify([
          { ping: { content: 'rs:0' } },
          { ping: { content: 'ps:0' } },
          { thread: threadReq },
          { ping: { content: 'pf:0' } },
          { ping: { content: 'rf:0' } }
        ]));
        initialTimer = setTimeout(function () { initialPhase = false; }, 1200);
      };

      cws.onmessage = function (ev) {
        if (self.commentWs !== cws) return;
        var data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (data && data.ping && data.ping.content === 'rf:0') {
          initialPhase = false;
          if (initialTimer) clearTimeout(initialTimer);
          return;
        }
        if (data && data.chat && data.chat.content) {
          if (initialPhase) {
            self.logBuffer.push({
              text: String(data.chat.content).replace(/\r?\n/g, ' '),
              color: '#b8bec6',
              time: '直前'
            });
            if (self.logBuffer.length > 80) self.logBuffer.shift();
          } else {
            self.renderComment(String(data.chat.content), data.chat.mail || '', false);
          }
        }
      };

      cws.onclose = function () {
        if (self.commentWs !== cws || self.destroyed) return;
        self._scheduleReconnect();
      };
    } catch (e) {
      this._scheduleReconnect();
    }
  };

  JikkyoEngine.prototype._scheduleReconnect = function () {
    var self = this;
    if (this.destroyed || !this.currentJkId) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    var targetJk = this.currentJkId;
    this._notifyStatus('再接続中: ' + targetJk.toUpperCase(), targetJk);
    this.reconnectTimer = setTimeout(function () {
      if (!self.destroyed && self.currentJkId === targetJk) {
        self.connect(targetJk);
      }
    }, 4000);
  };

  /**
   * ABEMA ライブ放送のコメントを定期ポーリングして弾幕および右側コメント欄へ流す (試験的・フェイルセーフ)
   */
  JikkyoEngine.prototype.connectAbemaSlot = function (channelId, slotId) {
    this.disconnect();
    this.destroyed = false;
    this.recentTimestamps = [];
    this.logBuffer = [];

    if (!channelId && !slotId) {
      this._notifyStatus('ABEMA コメント対象外', null);
      return;
    }

    var self = this;
    var activeSlot = slotId || '';
    var lastTimestampMs = 0;
    var seenIds = {};
    var isFirstFetch = true;

    this._notifyStatus('ABEMA コメント接続中…', 'ABEMA');

    function pollOnce() {
      if (self.destroyed) return;
      var url = 'http://127.0.0.1:7019/api/abema/comments?channelId=' +
        encodeURIComponent(channelId || '') + '&slotId=' + encodeURIComponent(activeSlot);

      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 5000;
      xhr.onload = function () {
        if (self.destroyed || xhr.status !== 200) return;
        var res;
        try { res = JSON.parse(xhr.responseText); } catch (e) { return; }
        if (!res || !res.ok) {
          self._notifyStatus('ABEMA コメントなし', 'ABEMA');
          return;
        }
        if (res.slotId) activeSlot = res.slotId;
        self._notifyStatus('ABEMA コメント連動中', 'ABEMA');

        var list = res.comments || [];
        if (isFirstFetch) {
          isFirstFetch = false;
          // 初回は過去ログ欄に直近15件を入れ、最新タイムスタンプを記録して画面一括飽和を防ぐ
          var startIdx = Math.max(0, list.length - 15);
          for (var i = 0; i < list.length; i++) {
            var item0 = list[i];
            seenIds[item0.id] = true;
            if (item0.createdAtMs > lastTimestampMs) lastTimestampMs = item0.createdAtMs;
            if (i >= startIdx) {
              var dt = item0.createdAtMs ? new Date(item0.createdAtMs).toTimeString().slice(0, 8) : '直前';
              var cObj = { text: item0.message, color: '#e2e8f0', time: dt };
              self.logBuffer.push(cObj);
              if (self.onCommentCallback) self.onCommentCallback(cObj, self.getForcePerMin());
            }
          }
          return;
        }

        var fresh = [];
        for (var j = 0; j < list.length; j++) {
          var c = list[j];
          if (!c.id || seenIds[c.id]) continue;
          if (c.createdAtMs && c.createdAtMs < lastTimestampMs - 5000) continue;
          seenIds[c.id] = true;
          if (c.createdAtMs > lastTimestampMs) lastTimestampMs = c.createdAtMs;
          fresh.push(c);
        }

        // ポーリング間隔(3秒)内で自然なタイミングに分散して流す
        for (var k = 0; k < fresh.length; k++) {
          (function (msgText, delayMs) {
            var tid = setTimeout(function () {
              if (!self.destroyed) {
                self.renderComment(msgText, 'white', false);
              }
            }, delayMs);
            self.abemaDispatchTimers.push(tid);
          })(fresh[k].message, Math.min(2700, Math.round((k * 2700) / Math.max(1, fresh.length))));
        }
      };
      xhr.send();
    }

    pollOnce();
    this.abemaPollTimer = setInterval(pollOnce, 3200);
  };

  JikkyoEngine.prototype.disconnect = function () {
    this.destroyed = true;
    this.currentJkId = null;
    if (this.keepSeatTimer) { clearInterval(this.keepSeatTimer); this.keepSeatTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.abemaPollTimer) { clearInterval(this.abemaPollTimer); this.abemaPollTimer = null; }
    if (this.abemaDispatchTimers && this.abemaDispatchTimers.length > 0) {
      for (var i = 0; i < this.abemaDispatchTimers.length; i++) {
        clearTimeout(this.abemaDispatchTimers[i]);
      }
      this.abemaDispatchTimers = [];
    }
    if (this.watchWs) { try { this.watchWs.close(); } catch (e) {} this.watchWs = null; }
    if (this.commentWs) { try { this.commentWs.close(); } catch (e) {} this.commentWs = null; }
    this.clearScreen();
  };

  /**
   * ローカル常駐デーモン (127.0.0.1:7019) を介して DTV Plus 本体とオーバーレイアプリ間で設定を永続共有する
   */
  function syncSharedPrefs(prefs, callback) {
    try {
      var qs = ['save=1'];
      if (prefs.enabled !== undefined) qs.push('enabled=' + (prefs.enabled ? '1' : '0'));
      if (prefs.fontSizeKey) qs.push('fontSizeKey=' + encodeURIComponent(prefs.fontSizeKey));
      if (prefs.opacity !== undefined) qs.push('opacity=' + encodeURIComponent(String(prefs.opacity)));
      if (prefs.jkId) qs.push('jkId=' + encodeURIComponent(prefs.jkId));

      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://127.0.0.1:7019/api/prefs/jikkyo?' + qs.join('&'), true);
      xhr.timeout = 3000;
      xhr.onload = function () {
        if (callback) callback(true);
      };
      xhr.onerror = function () { if (callback) callback(false); };
      xhr.send();
    } catch (e) {
      if (callback) callback(false);
    }
  }

  function fetchSharedPrefs(callback) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://127.0.0.1:7019/api/prefs/jikkyo', true);
      xhr.timeout = 3000;
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            callback(null, JSON.parse(xhr.responseText));
            return;
          } catch (e) {}
        }
        callback('load failed', null);
      };
      xhr.onerror = function () { callback('offline', null); };
      xhr.ontimeout = function () { callback('timeout', null); };
      xhr.send();
    } catch (e) {
      callback(String(e), null);
    }
  }

  global.JikkyoModule = {
    JIKKYO_CHANNELS: JIKKYO_CHANNELS,
    FONT_SIZE_PRESETS: FONT_SIZE_PRESETS,
    resolveJikkyoId: resolveJikkyoId,
    syncSharedPrefs: syncSharedPrefs,
    fetchSharedPrefs: fetchSharedPrefs,
    JikkyoEngine: JikkyoEngine
  };
})(window);
