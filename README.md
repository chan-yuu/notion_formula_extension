# Notion Formula Auto Conversion Tool (MV3)

## 目录
- `manifest.json`
- `content.js`
- `background.js`
- `options.html` / `options.js` / `options.css`

## 安装方式（Chrome / Edge）
1. 打开扩展页  
   - Chrome: `chrome://extensions`  
   - Edge: `edge://extensions`
2. 打开“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：`notion_formula_extension`。

## 首次配置
1. 在扩展卡片点击“详情” -> “扩展程序选项”。
2. 填写 `DashScope API Key`（`sk-...`）。
3. 其他参数保持默认即可：
   - Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
   - Model: `qwen-plus`
4. 点击“保存”。
5. 刷新 Notion 页面。

## 使用
1. 打开 `https://www.notion.so/*` 页面。
2. 右下角会出现转换面板。
3. 点击按钮执行“识别+转换”。

## 调试
- 打开开发者工具 Console，可看到：
  - `[FormulaDebug] AI原始输出 ...`
  - `[FormulaHelper] 转换中 ...`
- 只识别不转换：
  - 在 Console 执行：`await window.__formulaDebugTest()`
