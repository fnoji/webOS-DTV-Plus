# DTV Plus for LG webOS

LG webOS 搭載 TV で [Mirakurun](https://github.com/Chinachu/Mirakurun) / [EPGStation](https://github.com/l3tnun/EPGStation) と連携し、
**地デジ・BS・CS・BS4K の視聴、録画予約、録画済みライブラリの再生** を 1 つのアプリで行うためのフロントエンド（メディアクライアント）アプリケーションです。

試験的機能として **TVer / ABEMA** の VOD・ライブ再生にも対応しており、これらが公式アプリとして提供されていない **webOS 4 の機種でも視聴が可能**になります。

さらに本アプリは **PC のブラウザ上でも WebUI として動作**します。TV 側と同等の UI をプライベートネットワーク上で利用でき、
PC 側で設定した内容を LGTV へ送信する設定同期機能も備えています。**LGTV を所持していない環境でも PC 単体で動作**します。

> 本アプリは webOS 4（Chromium 53 / ES5）環境での動作を主目的として設計されています。
> 実装上の制約から `gap` / `grid` / `inset` / `@layer` などのモダン CSS や `Promise` / `fetch` をあえて使用しておらず、
> 結果として PC 上では非常に軽量に動作する WebUI クライアントになっています。

---

## 主な機能

### 地デジ / BS / CS

- Mirakurun サーバーを指定し、それを経由してコピーフリー環境で視聴できます。
- 当方が提供している **webOS DTV Tuner Bridge** を実行している LGTV の場合は、
  接続先に `localhost` を指定することで **TV 内蔵チューナーから直接再生**できます。
- **NX-jikkyo** 経由でニコニコ実況に対応しています（実装は [KonomiTV](https://github.com/tsukumijima/KonomiTV) を参考にしています）。
- LG 純正 TV アプリ準拠の **3 桁選局番号**・ワンタッチ選局（shortCut 1〜12）に対応し、LG 純正の局ロゴ（`/mnt/lg/user/jlogo`）も補完表示します。
- **2 次元ラテ欄 EPG**（横軸＝放送局 / 縦軸＝時間帯）と番組詳細モーダルを搭載しています。

### BS4K

- BS4K に対応した Mirakurun サーバーを指定し、それを経由してコピーフリー環境で視聴できます。
- 動作確認済みの環境は **PIX-SMB400** を Mirakurun 対応にしたものを経由した構成です。
- BS4K の MMT/TLV ストリームは同梱の `mmt2ts`（ARIB STD-B32 / STD-B60 準拠のリマキサー）で
  HEVC + AAC の MPEG-2 TS へ**リアルタイム無劣化変換**して再生します。

### 試験的対応: TVer / ABEMA

- webOS 4 環境では TVer / ABEMA の公式アプリが提供されていません。本アプリで再生・視聴が可能になります。
- 双方で **VOD** と **ライブ配信** に対応しています。
- **ABEMA** は番組表表示に対応し、TV 側の EPG 情報と合わせたユーザーインターフェースで動作します。
- 受信されるコメントは放送波受信と同様のインターフェースで**ニコニコ実況風**に確認できます。
- ストリーム抽出は TV 内の chroot 環境に構築した **公式 `yt-dlp`** に一本化しており、
  TVer / ABEMA 側の仕様変更時も**リモコン操作だけで `yt-dlp` を最新版へ自己更新**できます。

### 視聴専用モード

- 初期状態では **視聴専用モード** がセットされています。
- このモードでは Mirakurun サーバーの指定のみが可能で、一貫して**視聴専用のビューワー**として機能します。
- 録画タブ・録画ボタン・EPGStation 連携は UI 上から無効化されます。

### 録画・保存連携モード

- このモードを有効にすると **EPGStation と連携**することを前提として、放送波の録画データの視聴管理が可能になります。
- **ライブラリ経由で録画データを確認**でき、視聴 UI や EPG 上からも**ダウンロードや録画予約**が可能です。
- EPGStation は**複数サーバー登録**に対応し、サーバーごとに**読み取り専用ロック**を設定できます。
- 試験的対応の TVer / ABEMA 側でも録画・保存を実行できます。
  これらのサービスの保存は**専用 API を立てるサーバー（配信保存サーバー）**を用意して行います。
  このサーバーのアドレスを指定することによって、保存処理および保存済み映像の配信を行うワークサーバーを利用できます。
- このサーバー内に過去に保存した TVer 映像データなどを入れておくことによって、DTV Plus 上でデータの視聴管理が可能となります。

### ニコニコ実況

- NX-jikkyo の WebSocket API に接続し、実況コメントを**弾幕**および**右側のコメントログ**として表示します。
- **文字サイズ**（小 32px / 標準 42px / 大 54px / 特大 66px）と**透過度**（25%〜100%）を変更できます。
  文字サイズに応じて弾幕レーン間隔も自動再計算されます。
- 局名・サービス ID からニコニコ実況のチャンネル ID を自動判定します（BS はサービス ID、地上波は局名で判定）。
- **純正 LiveTV 用の透過オーバーレイアプリ**（`tv.dtvplus.webos.overlay`）と設定を共有します。

### 字幕・データ放送（ARIB）

- **ARIB STD-B24 字幕 / 文字スーパー**を Canvas 描画（aribb24.js）で表示します。
- **BML データ放送**（[web-bml](https://github.com/tsukumijima/web-bml)）に対応し、L 字画面（動画縮小）連動・4 色キー / 十字 / 決定 / 戻る / 数字キー操作・双方向通信に対応します。
- 字幕・データ放送の解析はバックエンドデーモンのサイドバンド API から取得します。

### PC WebUI モード

- PC のブラウザ上で TV 側と同等の UI を実行できます。
- 放送波は `ffmpeg` による **GPU ハードウェアエンコード**（NVENC / QSV / AMF、無い場合は libx264）でブラウザへ配信します。
- **Tailscale 経由の外出先視聴**に対応し、画質を `高画質 / 標準 / モバイル` の 3 段階から選択できます。
- **PC で設定した内容を LGTV へ送信**できます（LAN 内の TV 自動検出 → 設定同期）。

---

## 動作環境

| 項目 | 内容 |
|---|---|
| 対応 TV | LG webOS 4.x 以降（開発・検証機: `55UK7500PJA` / webOS 4.x） |
| 描画エンジン | Chromium 53（Blink 53）/ ES5 前提 |
| 必須 | [webOS Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel)（開発者モード + root 化） |
| 放送波視聴 | Mirakurun サーバー（コピーフリー環境） |
| 録画連携 | EPGStation v2 |
| TVer / ABEMA | TV 内 chroot の公式 `yt-dlp`（初回起動時に自動構築） |
| PC 版 | Windows + Python 3.9 以降 + `ffmpeg` / `ffprobe`（任意で `yt-dlp`、`tailscale`） |

---

## インストール

### 1. IPK の入手

[Releases](../../releases) から以下のいずれかをダウンロードします。

| ファイル | 内容 |
|---|---|
| `tv.dtvplus.webos_x.y.z_all.ipk` | メインアプリ（DTV Plus 本体） |
| `tv.dtvplus.webos.overlay_x.y.z_all.ipk` | 純正 LiveTV 用 ニコニコ実況 透過オーバーレイ（任意） |

`ares-install` / `ares-package` などの webOS SDK は不要です。

### 2. TV へのインストール

Homebrew Channel の「Install from file」から IPK を指定するか、`scripts/deploy_tv.py` で SSH 経由でデプロイします。

```powershell
$env:TV_HOST = "192.168.0.10"   # TV の IP
$env:TV_PASS = "alpine"         # root パスワード（環境に合わせて変更）
python scripts/deploy_tv.py
```

デプロイスクリプトは以下も併せて行います。

- 既にインストール済みの場合は `data.tar.gz` を直接同期（高速更新）
- `/var/lib/webosbrew/init.d/91-dtvplus` への自動起動スクリプト登録
- chroot 環境の構築と `yt-dlp` 常駐デーモンの起動確認（`http://127.0.0.1:7019/api/ping`）

### 3. 初期設定

アプリ起動後、**設定**タブから最低限以下を設定します。

1. **Mirakurun サーバー URL**（例: `http://192.168.0.5:40772`）
   - TV 内蔵チューナー（webOS DTV Tuner Bridge）を使う場合は `http://127.0.0.1:40772`
2. BS4K を見る場合は **BS4K 用 Mirakurun サーバー URL** を指定し、BS4K タブを有効化
3. TVer / ABEMA を見る場合は該当タブを有効化
4. 録画連携を使う場合は **録画・保存連携モード** を有効化し、EPGStation の URL を登録

---

## PC 版（WebUI）の使い方

Releases の `dtvplus-pc-webui-x.y.z.zip` を任意のフォルダへ展開し、`pc\start_pc.bat` を実行します。

1. `launch_pc.py` がバックグラウンドで `pc_server.py` を起動（`http://127.0.0.1:7019/`）
2. Chrome / Edge が `--app` の軽量ウィンドウでアプリを開きます
3. 終了は `pc\stop_pc.bat`

| ファイル | 用途 |
|---|---|
| `pc\start_pc.bat` / `pc\stop_pc.bat` | WebUI 本体の起動 / 停止 |
| `pc\start_save_server.bat` / `pc\stop_save_server.bat` | 配信保存サーバー（`http://127.0.0.1:7020/`）の起動 / 停止 |

- 配信保存サーバーの保存先既定値は `D:\tver_hozon` です（環境変数 `DTVPLUS_SAVE_DIR` / `DTVPLUS_SAVE_PORT` で変更可能）。
- `ffmpeg` / `ffprobe` に PATH が通っている必要があります（GPU エンコーダは自動検出）。
- アクセスはループバック / プライベート IP / Tailscale（`100.64.0.0/10`）からのみ許可されます。
- PC 版のファイルは **IPK には一切同梱されません**。

---

## ビルド

```powershell
python scripts/generate_icons.py   # アイコン / スプラッシュ PNG の生成（Pillow 不要）
python scripts/build_ipk.py        # dist/ に IPK を生成（ares-package 不要）
python scripts/build_pc_bundle.py  # release/ に PC 版 zip を生成
python scripts/deploy_tv.py        # TV 実機へデプロイ
python scripts/verify_tv.py        # TV 実機での統合動作確認
```

- Python 3 標準ライブラリのみで動作します（サードパーティ依存なし）。
- バージョンは `app/appinfo.json` と `overlay-app/appinfo.json` の `version` が唯一の情報源です。
- `build_ipk.py` は `app/js/jikkyo.js` を `overlay-app/jikkyo.js` へ同期してからパッケージします。
- `deploy_tv.py` / `verify_tv.py` は `TV_HOST` / `TV_USER` / `TV_PASS` 環境変数で接続先を指定します。

---

## ディレクトリ構成

```
app/                 TV アプリ本体（IPK の中身）
  appinfo.json       アプリ ID / バージョン / 権限
  index.html         UI（Chromium 53 対応）
  css/app.css        純正 DTV アプリ基調のスタイル
  js/
    app.js           メインコントローラ
    mirakurun.js     Mirakurun / Mirakurun 互換 API クライアント
    epgstation.js    EPGStation v2 API クライアント
    jikkyo.js        ニコニコ実況 ID 判定 + GPU 弾幕エンジン
    tver.js          yt-dlp 常駐デーモン（TVer / ABEMA）クライアント
    arib_manager.js  ARIB 字幕 / 文字スーパー / BML 統合制御
    arib_bundle.js   aribb24.js + web-bml + es2 のバンドル
    luna.js          Luna Service Bus / uMediaServer 連携
    qrcode.js        ローカル QR コード生成
  backend/
    ytdlp_daemon.py  ストリーム抽出・録画中継デーモン（:7019）
    start_daemon.sh  chroot 構築 + デーモン起動
    autostart_init.sh  TV 起動時の自動起動
    mmt2ts.c / bin/mmt2ts-armv7  BS4K MMT/TLV → MPEG-2 TS リマキサー
overlay-app/         純正 LiveTV 用 透過オーバーレイ（別アプリ ID）
pc/                  PC 版（WebUI サーバー / アダプタ / 配信保存サーバー）
scripts/             ビルド・デプロイ・検証スクリプト
```

---

## バックエンドデーモン

TVer / ABEMA の抽出、Mirakurun ストリームの TS 中継、EPGStation の CORS 代理、ARIB サイドバンド配信は
TV 内の常駐デーモン（`http://127.0.0.1:7019`）が担当します。

- chroot 環境: `/mnt/lg/cmn_data/ytdlp-env`（Alpine armv7 + Python 3.12 + 公式 `yt-dlp`）
- 自動起動: `/var/lib/webosbrew/init.d/91-dtvplus`
- `yt-dlp` の自己更新: 設定タブの「`yt-dlp` を最新版へ更新」ボタン（更新後は自動で再起動）
- `tsreadex` が `/usr/local/bin/tsreadex` に存在する場合は TS 正規化に使用し、無い場合は素通しで動作します（必須ではありません）

---

## 既知の制約

- **webOS 4 = Chromium 53** の制約により、JS は ES5、CSS は Blink 53 の範囲で実装されています。
- **TVer はニコニコ実況の対象外**です（ABEMA ライブは独自コメントを実況風に表示します）。
- **ABEMA のコメント取得は試験的**な実装です。API 仕様変更時はコメントが空になるだけで、再生には影響しません。
- EPGStation の番組表 API は使用していません。番組表は Mirakurun の番組情報から構築し、ABEMA のみ配信保存サーバーのキャッシュを使用します。
- デーモンは `0.0.0.0:7019` で待ち受けます。LAN からは設定同期用の API のみ許可していますが、
  **TV 上の他プロセスからのアクセスは IP 判定では制限されません**。信頼できるネットワークでのみ使用してください。
- `pc_server.py` と TV 側デーモンは同一ポート（7019）を使用します。同一ホストで同時に起動した場合、後発は起動せず終了します。
- 本アプリはコピーフリー環境での利用を前提としています。DRM のかかったコンテンツの復号や再配布を目的としたものではありません。

---

## 免責事項

本アプリケーションは個人開発の非公式アプリであり、LG Electronics および各サービス提供元とは一切関係ありません。
本アプリの利用によって生じたいかなる損害についても、作者は責任を負いません。各自の責任において利用してください。

また、TVer / ABEMA などの配信サービスの利用規約は各サービスに帰属します。
取得したコンテンツの録画・保存・再配布が許諾されるかどうかは各サービスの規約に従ってください。

---

## ライセンス

[MIT License](LICENSE)

同梱しているフォント（Kosugi / Kosugi Maru）は [Apache License 2.0](app/fonts/LICENSE.txt) に従います。
`app/js/arib_bundle.js` は aribb24.js（MIT）・web-bml・es2 をバンドルしたものです。各ライブラリのライセンスに従います。
