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
- `assets/ahvenisto/` — コースのモデルと、そこから作った高さ・路面データ
- `tools/` — 高さ・路面データを元のモデルから作り直すスクリプト

## 素材のクレジット

- コース: "Ahvenisto Race Circuit rallycross track" by Timo Korkalainen — CC BY 4.0
  https://sketchfab.com/3d-models/ahvenisto-race-circuit-rallycross-track-20f5d0c0c1e24f4fbea45270f333988c
  (ポリゴン数の削減と圧縮を行っています)
- 車: "2019 Toyota GR Supra Drift by HKS" by SIU Car Garage — CC BY-NC 4.0(非営利のみ)
  https://sketchfab.com/3d-models/2019-toyota-gr-supra-drift-by-hks-121f2bc836244f2cb107c15a68d01c54
- three.js — MIT License(`lib/three/LICENSE`)

車のモデルが非営利ライセンスのため、このゲームを広告や販売を伴う形で公開することはできません。
