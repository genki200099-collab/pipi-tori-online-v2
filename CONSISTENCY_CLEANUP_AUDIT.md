# 整合性・冗長性点検メモ

## 修正した重要点

### 再接続時の競合
古いWebSocketを閉じたあとに close イベントが遅れて走ると、新しい接続を `null` にしてしまう可能性があったため、close処理を `p.ws === ws` の時だけ席を切断扱いにするよう修正。

### 設定ログの重複
部屋作成ログとゲーム開始ログで長い設定説明が重複していたため、`roomOptionSummary()` に集約。

### マッド・ピッグ得点表示
数字分失点モードでは、手札のマッド・ピッグは「残り手札失点」に含まれ、得点パイルのマッド・ピッグだけが別途-40点になる。
この点がUI上で誤解されやすかったため、得点内訳の文言を整理。

## 確認した状態遷移

- lobby → playing
- lobby → passing → playing
- lobby → initialPair → playing
- lobby → passing → initialPair → playing
- playing → roundEnd → playing
- playing → finished
- disconnected → reconnect → same seat

## 維持確認

- ラウンド数 1〜6
- マッド・ピッグON/OFF
- ババブタ失点任意設定
- 残り手札失点モード選択
- 開始時3枚パス
- 開始時ペア捨て
- ピック後ペア選択/スキップ
- カード重複防止
- 最弱判定
- 再接続
