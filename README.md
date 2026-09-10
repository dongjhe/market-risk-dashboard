# Market Risk Dashboard

台灣與美國市場風險指標 Dashboard。GitHub Pages 顯示每日數據、與前一筆比較升降，並保存歷史趨勢。

## 第一版功能

- VIX、DXY、USD/TWD、黃金期貨、美債 2Y / 10Y / 30Y、WTI：排程自動更新
- Put/Call Ratio、台灣融資維持率、外資台指期淨部位：介面已保留；待官方來源解析器驗證後接入，避免顯示錯誤數據
- 方舟風控運算機：網頁手動輸入，使用瀏覽器 localStorage 保存
- 7 / 30 / 90 日 / 全部歷史趨勢
- 每個指標顯示相較前一筆的上升、下降或持平
- `data/history.json` 最多保留 730 筆

## 自動更新

`.github/workflows/update-data.yml` 於週一至週五台北時間約 15:30 執行，也可從 Actions 手動執行。

> 注意：美國市場商品在台灣 15:30 尚未完成當日美股交易，因此這個排程取得的是當時可用的最新行情。之後可再增加美股收盤後的第二次更新。

## GitHub Pages

專案已包含 `.github/workflows/pages.yml`。首次使用時，請在 repository 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。

預期網址：`https://dongjhe.github.io/market-risk-dashboard/`

## 原則

無法確認來源或公式的指標不填假資料。台灣「大盤融資維持率」並非 TWSE 直接公布的單一官方指標，因此後續會把計算方法、來源與中間值一併保存，方便與方舟運算 App 或其他平台交叉比對。
