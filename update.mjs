name: 更新強積金價格與長線趨勢提醒

on:
  schedule:
    # 香港時間星期一至五 22:15 執行
    - cron: '15 14 * * 1-5'
  workflow_dispatch:
    inputs:
      backfill:
        description: '下載過去10年積金局歷史價格表（首次設定或補齊數據請選 true）'
        type: boolean
        default: false
      force_notify:
        description: '測試發送 Telegram 報告（即使今日無變盤亦發送）'
        type: boolean
        default: false

permissions:
  contents: write
  issues: write

jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: 安裝依賴套件
        run: |
          npm install --no-save --no-package-lock playwright@1 xlsx@0.18.5
          npx playwright install --with-deps chromium

      - name: 抓取最新數據並執行長線分析
        env:
          TG_BOT_TOKEN: ${{ secrets.TG_BOT_TOKEN }}
          TG_CHAT_ID: ${{ secrets.TG_CHAT_ID }}
          FORCE_NOTIFY: ${{ inputs.force_notify }}
        run: node update.mjs ${{ inputs.backfill && 'backfill' || '' }}

      - name: 若觸發牛熊轉換則自動建立 GitHub Issue 提醒
        if: hashFiles('alert_issue.md') != ''
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const body = fs.readFileSync('alert_issue.md', 'utf8');
            const date = new Date().toISOString().slice(0, 10);
            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `🚨 MPF 長線牛熊訊號警報 (${date})`,
              body: body
            });

      - name: 提交最新數據至 GitHub
        run: |
          rm -f alert_issue.md
          if [ -n "$(git status --porcelain data debug)" ]; then
            git config user.name "github-actions[bot]"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git add data debug
            git commit -m "chore: 更新強積金最新數據與長線訊號"
            git push
          else
            echo "數據已是最新，無需提交"
          fi
