# 拾記 Apps Script 後端

這是 GitHub Pages 的可選 Google 後端。第一次連接會由目前登入的 Google 帳號授權，並自動建立：

- Google Drive 資料夾「拾記 Action Memory」：保存完整 JSON 備份。
- Google Sheets「拾記雲端備份索引」：保存版本、校驗碼及操作紀錄。

## 一次性設定

1. 到 <https://script.new> 建立「獨立指令碼」專案。
2. 用本目錄的單一 `Code.gs` 取代編輯器原有內容並儲存，不必建立其他檔案。
3. 從函式選單選擇 `setup`，按「執行」並完成 Google 授權；它會建立 Drive 資料夾與 Sheets 索引。
4. 選「部署 → 新增部署 → 網頁應用程式」。執行身分選「存取網頁應用程式的使用者」，存取權限限制為自己的 Google 帳號或組織允許的 Google 使用者。
5. 複製結尾為 `/exec` 的網址，在拾記「設定與備份 → Google 雲端備份」貼上後按「連接並驗證」。

Google 的安全機制不允許 GitHub Pages 代替使用者完成授權及網頁應用程式部署。`setup()` 會自動完成資料夾、試算表、欄位與版本初始化；介面會回報實際健康狀態與試算表連結，不能只以「已登入」判定成功。

## 邊界

- 本機 IndexedDB 仍是主要資料來源，離線時照常使用。
- 目前採使用者主動備份，不宣稱 iPhone 背景同步。
- 備份採 `baseRevision` 樂觀鎖；版本不一致時拒絕覆寫。
- 後端只接受 `Code.gs` 中列出的網站來源。若更換 GitHub Pages 網址，必須同步更新 allowlist 並建立新部署版本。
