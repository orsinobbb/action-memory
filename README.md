# 拾記｜代辦記憶庫

手機優先、本機優先的純前端代辦記憶庫。預設所有任務、關聯與事件都儲存在瀏覽器 IndexedDB，不需要帳號；需要跨裝置備份時可選接 Google Apps Script 後端。

## 已實作

- 5 秒快速記錄與收件匣
- 今日戰情：逾期、今天、等待、未來 7 天
- 任務狀態、下一步、提醒、標籤與動態關聯
- 不可覆寫的事件時間軸
- 搜尋與篩選
- 不寫入任務紀錄的隨手計算機（四則、百分比、正負號與複製結果）
- JSON 校驗備份／合併／完整還原
- CSV 與 `.ics` 行事曆匯出
- 行事曆事件可從原任務連結回到系統明細；跨 iPhone 瀏覽環境時仍可顯示不含備註的最小摘要
- PWA 離線快取與瀏覽器通知
- 每日／每週／每月週期任務與前後演化關聯
- 今天／明天／下週快速排程
- 可還原的回收桶
- GitHub Pages 自動部署工作流程
- 可選的 Google Apps Script 後端：Google 授權後自動建立 Drive JSON 備份與 Sheets 版本索引

`/v0.1/` 保留第一階段 MVP 封存版；主目錄目前為 v0.3.1，持續演進。

## 本機執行

```powershell
npm.cmd test
npm.cmd run serve
```

開啟 `http://localhost:8080/`。請勿用 `file://` 直接開啟，IndexedDB、PWA 與 Service Worker 應透過 HTTP 測試。

## GitHub Pages

推送到 `main` 後，`.github/workflows/deploy-pages.yml` 會先執行測試，再部署靜態網站。儲存庫 Settings → Pages → Source 應設定為 **GitHub Actions**。

## 可選 Google 後端

Apps Script 後端骨架、權限邊界與一次性部署步驟請見 [`backend/apps-script/README.md`](./backend/apps-script/README.md)。Google 基於安全規則仍要求使用者親自完成首次網頁應用程式部署與授權；之後拾記可自動初始化儲存資源、檢查實際健康狀態，並以版本衝突保護執行主動備份與還原預覽。

## 隱私與提醒限制

- 資料預設只留在目前瀏覽器；清除網站資料前請先匯出 JSON 備份。
- 瀏覽器／PWA 關閉後的背景通知受作業系統限制；重要提醒請匯出到手機行事曆。
- `.ics` 內含穩定任務連結與提醒；單次匯入不會自動同步後續修改，跨裝置開啟仍需要未來的同步服務。
- Azure OpenAI 僅列為二階後端代理，不會把金鑰或任務內容放進目前純前端版本。

完整設計請見 [PRODUCT_DESIGN.md](./PRODUCT_DESIGN.md)。
