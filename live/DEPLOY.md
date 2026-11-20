# 部署到 Cloud Run

照順序做完，大約 15 分鐘。不需要在自己電腦安裝任何東西，全部在瀏覽器裡的 Cloud Shell 完成。

## 0. 先準備

- 一個 Google Cloud 專案，並且**已經綁定帳單**（Cloud Run 要求）。
- 你在這個專案有 Owner 或 Editor 權限。
- 決定一組**工作人員密碼**（主持台與讀牌器要輸入的），下面用 `你的密碼` 代表。

## 1. 打開 Cloud Shell

到 https://shell.cloud.google.com ，等終端機出現。先指定專案（把 `你的專案ID` 換掉）：

```bash
gcloud config set project 你的專案ID
```

## 2. 開啟需要的服務

第一次使用才需要，大約一分鐘：

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

## 3. 把工作人員密碼存進 Secret Manager

伺服器要知道正確的密碼，才能比對主持人輸入的對不對。這一步把密碼存進 Google 的「保險箱」（Secret Manager），部署時只告訴伺服器去保險箱拿，密碼就不會明文出現在指令紀錄與 Cloud Run 設定頁。不想多這一步的話，看本節最後的簡化版。

**3-1 把密碼存進保險箱**（把 `你的密碼` 換成你要的密碼，保留單引號）：

```bash
printf '%s' '你的密碼' | gcloud secrets create tap-duel-staff-key --data-file=-
```

- `tap-duel-staff-key` 是保險箱裡這個項目的名稱，不是密碼。
- 用 `printf` 而不用 `echo`：`echo` 會在結尾多一個看不見的換行，存進去的密碼就永遠對不上。
- 成功時顯示 `Created version [1] of the secret [tap-duel-staff-key].`

**3-2 允許伺服器讀取保險箱**。保險箱預設誰都不能讀，Cloud Run 執行時用的是一個機器身分（Compute Engine 預設服務帳號），要授權給它：

```bash
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding tap-duel-staff-key \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

- 第一行查出專案編號（一串數字，跟專案 ID 不同），不會印出東西是正常的。
- 第二個指令給那個服務帳號「只能讀取內容」的權限，成功時會印出 `bindings:` 開頭、含有該服務帳號的設定。

部署指令（第 5 步）最後的 `--set-secrets STAFF_KEY=tap-duel-staff-key:latest`，就是要伺服器啟動時去保險箱拿最新版本當作密碼。部署後若 log 出現 `STAFF_KEY is not set`，代表 3-2 的授權沒成功，伺服器改用了自己產生的隨機密碼（印在同一行）。

**簡化版（內部測試用）**：跳過整個第 3 步，第 5 步最後一行改成 `--set-env-vars STAFF_KEY=你的密碼`。功能一樣，只是密碼會出現在 Cloud Run 的設定頁上。

## 4. 取得程式碼

```bash
git clone https://github.com/swwwagcy/tap-duel.git
cd tap-duel
```

## 5. 部署

```bash
gcloud run deploy tap-duel-live \
  --source live \
  --region asia-east1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --concurrency 1000 \
  --session-affinity \
  --timeout 3600 \
  --set-secrets STAFF_KEY=tap-duel-staff-key:latest
```

第一次會問要不要建立 Artifact Registry 的存放區，回答 `Y`。Cloud Build 會用 `live/Dockerfile` 建置映像，約 3 到 5 分鐘。完成時會印出網址，形如：

```
Service URL: https://tap-duel-live-xxxxxxxxxx.asia-east1.run.app
```

每個參數為什麼要這樣設：

| 參數 | 原因 |
|---|---|
| `--max-instances 1` | **必要。** 回合、點數、讀到的牌都在伺服器記憶體裡；開兩個執行個體，觀眾和主持台會各自看到不同的回合。 |
| `--min-instances 1` | 縮到零就等於重開，所有點數與紀錄歸零。代價是會持續計費。 |
| `--concurrency 1000` | **必要。** 每位觀眾、主持台、讀牌器各佔一條連線，Cloud Run 預設每個執行個體只收 80 條，加上只有一個執行個體，第 81 個人就連不上。1000 是上限。 |
| `--session-affinity` | 讓同一個瀏覽器的連線盡量回到同一個執行個體。 |
| `--timeout 3600` | 每條連線最長一小時，到時頁面會自動重連。 |
| `--allow-unauthenticated` | 觀眾不用登入 Google 就能打開。主持台與讀牌器另外靠工作人員密碼保護。 |
| `--region asia-east1` | 台灣機房，延遲最低。 |

## 6. 確認

把網址存成變數，檢查伺服器活著：

```bash
URL=$(gcloud run services describe tap-duel-live --region asia-east1 --format='value(status.url)')
curl -s $URL/health      # 應該印出 ok
echo $URL
```

三個頁面：

| 頁面 | 網址 | 裝置 |
|---|---|---|
| 觀眾 | `網址/play.html` | 每位觀眾的手機 |
| 主持台 | `網址/host.html#key=你的密碼` | iPad |
| 讀牌器 | `網址/reader.html#key=你的密碼` | 牌桌上方的手機 |

`#key=` 只需要開一次，密碼會記在那台裝置上並從網址移除。之後直接開 `host.html`、`reader.html` 就好。**不要把含密碼的網址傳到群組裡**；也可以不帶 `#key=`，頁面會要求輸入。

建議的第一次測試：

1. 讀牌器手機開 `reader.html`，按「開始相機」，允許相機權限（Cloud Run 是 HTTPS，所以可以開相機）。依 `README.md` 的流程調整牌位、拍空桌、登記牌組。
2. iPad 開 `host.html`，按「開始新回合」。
3. 另一支手機開 `play.html`，倒數內選一格。
4. 截止後發牌，主持台確認結果，觀眾的點數應該跟著變。

## 7. 之後更新

改了程式之後，在 Cloud Shell 裡：

```bash
cd ~/tap-duel && git pull
```

然後重跑第 5 步同一個部署指令。**每次部署都會重開伺服器，所有點數與回合紀錄歸零**，讀牌器登記的牌組存在讀牌器手機的瀏覽器裡，不受影響。

## 8. 看 log

```bash
gcloud run services logs read tap-duel-live --region asia-east1 --limit 50
```

或到 Cloud Console 的 Cloud Run → `tap-duel-live` → 記錄。

## 9. 換密碼

先確認部署時用的是哪一種方式：

```bash
gcloud run services describe tap-duel-live --region asia-east1 --format='yaml(spec.template.spec.containers[0].env)'
```

看到 `secretKeyRef` 是 Secret Manager：

```bash
printf '%s' '新密碼' | gcloud secrets versions add tap-duel-staff-key --data-file=-
gcloud run services update tap-duel-live --region asia-east1 --update-secrets STAFF_KEY=tap-duel-staff-key:latest
```

看到 `value:` 是簡化版：

```bash
gcloud run services update tap-duel-live --region asia-east1 --update-env-vars STAFF_KEY=新密碼
```

`services update` 不用重新建置，約 30 秒；服務會重啟，點數與回合紀錄歸零。記住舊密碼的裝置下次連線會被拒絕並跳出輸入框，輸入新密碼即可。

## 10. 不用了

停止計費（刪除服務，網址失效）：

```bash
gcloud run services delete tap-duel-live --region asia-east1
```

密碼與建置出的映像要另外刪：`gcloud secrets delete tap-duel-staff-key`，映像在 Artifact Registry 的 `cloud-run-source-deploy` 存放區。

## 費用

`--min-instances 1` 讓一個執行個體一直開著，即使沒人使用也會計費；讀牌器傳給觀眾的牌桌畫面也會產生對外流量。金額依用量而定，可以用 https://cloud.google.com/products/calculator 估算。只是要偶爾展示的話，展示完執行第 10 步刪除，下次再部署。

## 常見問題

- **`/healthz` 回 Google 的 404 頁面**：Cloud Run 保留結尾是 `z` 的路徑，請求不會送到伺服器。檢查請用 `/health`（2026-11-20 之前部署的版本沒有 `/health`，可以用 `curl -s $URL/ | head -5`，看到 `<title>Tap Duel Live</title>` 就是正常）。

- **觀眾很多時有人連不上**：確認部署時有 `--concurrency 1000`，到 Cloud Console 的服務詳細資料看「每個執行個體的並行要求上限」。
- **主持台和觀眾看到的回合不一樣**：最大執行個體數不是 1，重新部署並確認 `--max-instances 1`。
- **讀牌器開不了相機**：要用 `https://` 開頭的網址，並在瀏覽器允許相機權限；iPhone 請用 Safari。
- **主持台一直要求輸入密碼**：Secret 的權限（第 3 步）沒設好時，伺服器會用自己產生的隨機密碼，log 裡會出現 `STAFF_KEY is not set`。
- **部署時 Cloud Build 權限錯誤**：較新的專案預設不給 Cloud Build 足夠權限，錯誤訊息會指出缺哪個角色，請專案擁有者授予後重跑。
