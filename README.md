# SLIP ANGLE(仮題)

ドリフトでタイムを競う、ブラウザ用のタイムアタックレースゲームです。
ビルド不要の静的サイトで、Three.js で描画しています。PC のキーボードと、スマホ横持ちのタッチ操作に対応します。

## 遊び方

ローカルで試すときは、このフォルダで簡単なサーバーを立ててブラウザで開きます。

```
python3 -m http.server 8000
# http://localhost:8000 を開く
```

| 操作 | キーボード | スマホ |
|---|---|---|
| ステア | ← → / A D | 左下のスライド |
| アクセル | ↑ / W | GAS |
| ブレーキ(停止中に押し続けると後退) | ↓ / S | BRAKE |
| サイドブレーキ | Space | SIDE |
| グリッドに戻る | R | — |
| 視点切り替え | C | — |
| 音のオン・オフ | M | — |
| 結果画面 | Esc | 右上のボタン |

スタートラインを通過すると計測が始まり、そのまま周回を続けられます。自己ベストはブラウザに保存されます。

## 構成

- `js/car.js` — 車両の物理(4 輪のタイヤ、荷重移動、後輪の空転、エンジンと変速)
- `js/track.js` — コースの中心線・走行範囲・路面の高さと種類
- `js/timing.js` — ラップとセクターの計測、自己ベスト
- `js/main.js` — 読み込み、描画、カメラ、画面の切り替え
- `js/hud.js` `js/input.js` `js/fx.js` `js/audio.js` — 表示、入力、スモークとタイヤ痕、音
- `assets/engine/<車>/` — 実車の録音から作ったエンジン音のループと、回転数への割り当て(`loops.json`)
- `assets/driftpark/` — ドリフトコースのモデルと、そこから作ったデータ
- `assets/ahvenisto/` — コースのモデルと、そこから作った高さ・路面データ
- `assets/lider/` — カートコースのモデルと、そこから作った高さ・路面・走行範囲のデータ
- `tools/` — コースのデータを元のモデルから作り直すスクリプト
  - `usd_to_glb.py` — USD / USDZ のコースを GLB に変換
  - `build_track.py` と `*.build.json` — 素材ごとに分かれたコースから、高さ・路面・中心線・走行範囲を自動で作る
  - `build_heightmap.mjs` `build_surface.mjs` — スキャンで作られた一体のコース(Ahvenisto)用

## 素材のクレジット

コース
- Ahvenisto: "Ahvenisto Race Circuit rallycross track" by Timo Korkalainen — CC BY 4.0
  https://sketchfab.com/3d-models/ahvenisto-race-circuit-rallycross-track-20f5d0c0c1e24f4fbea45270f333988c
  (ポリゴン数の削減と圧縮を行っています)
- Lider Karting: "Karting Club Lider (Outdoor Race Track)" by skril4ek — CC BY-NC 4.0(非営利のみ)
  (ポリゴン数の削減と圧縮を行い、ゲーム内で約 1.5 倍に拡大して表示しています)
- Drift Park: "Drift Race Track Free" by Nicholas-3D — CC BY-ND 4.0(改変したものの再配布は不可)
  (形式の変換と圧縮だけを行い、形状には手を加えていません。約 1.5 倍の拡大はゲーム内の表示で行っています)

車
- GR Supra: "2019 Toyota GR Supra Drift by HKS" by SIU Car Garage — CC BY-NC 4.0(非営利のみ)
  https://sketchfab.com/3d-models/2019-toyota-gr-supra-drift-by-hks-121f2bc836244f2cb107c15a68d01c54
- RX-7: "2006 Mazda RX-7 GT300 RE Amemiya" by Dave Bored SketchFab — CC BY 4.0
- 911 Carrera: "2000 Porsche 911 Carrera (996)" by Ddiaz Design — CC BY-NC-SA 4.0(非営利のみ・改変物は同じライセンスで)
  https://sketchfab.com/3d-models/2000-porsche-911-carrera-996-537f06116f1f40d7bc0de28a7ab653da
- Vanquish: "2012 Aston Martin Vanquish Coupe" by Ddiaz Design — CC BY-NC-SA 4.0(非営利のみ・改変物は同じライセンスで)
  https://sketchfab.com/3d-models/2012-aston-martin-vanquish-coupe-b4bcb1b431b541e6af5b00c6d083f6db
  (この 2 台は車輪を本体から切り分け、圧縮しています。`tools/prep_car.mjs`)

エンジン音(聴き取れる区間を切り出し、回転数が一定になるよう補正してループ素材にしています。`tools/build_engine_loops.py`)
- GR Supra: "6 cyl vintageracecar tostartline burnout startclimb" by ears68(Freesound 185151)
  https://freesound.org/people/ears68/sounds/185151/
- RX-7: "rotary engine" by fuser10(Freesound 100791)
  https://freesound.org/people/fuser10/sounds/100791/
- 911 Carrera: "porsche" by mmplisskin(Freesound 90404)
  https://freesound.org/people/mmplisskin/sounds/90404/
- Vanquish: "Aston Martin V8 Vantage start up" by lmartins(Freesound 547057)
  https://freesound.org/people/lmartins/sounds/547057/
  (録音はアイドリングだけなので、高い回転の音はアイドリングの音から 1 回転ずつ並べ直して作っています)

その他
- three.js — MIT License(`lib/three/LICENSE`)

非営利ライセンスの素材を含むため、このゲームを広告や販売を伴う形で公開することはできません。
