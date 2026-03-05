# Notion Formula Auto Conversion Tool

进入网页版notion，粘贴，然后开始转换（注意，只支持原生的chatgpt进行的提示词和功能适配，如需其他大模型的需要对应进行修改。否则无法转换）

https://github.com/user-attachments/assets/4c8f55d1-a0cf-49f0-ba77-e8bbf4248fbb

AI识别并转换 Notion 中的 LaTeX 文本公式，主要以chatgpt输出的内容为主

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
<img width="1116" height="1213" alt="PixPin_2026-03-05_20-18-41" src="https://github.com/user-attachments/assets/819f305e-9a13-4baf-96ab-0d585315f618" />


## 使用
1. 打开 `https://www.notion.so/*` 页面。
2. 右下角会出现转换面板。
3. 点击按钮执行“识别+转换”。
4. 复制chatgpt的内容：

<img width="810" height="948" alt="PixPin_2026-03-05_20-20-00" src="https://github.com/user-attachments/assets/4321b09c-c895-4edc-a826-fad49aba018f" />

## 调试
- 打开开发者工具 Console，可看到：
  - `[FormulaDebug] AI原始输出 ...`
  - `[FormulaHelper] 转换中 ...`
- 只识别不转换：
  - 在 Console 执行：`await window.__formulaDebugTest()`

