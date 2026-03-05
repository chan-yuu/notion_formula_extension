const DEFAULTS = {
  aiEnabled: true,
  apiKey: '',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-plus',
  timeoutMs: 45000,
  debugMode: true
};

const $ = id => document.getElementById(id);

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.style.color = isError ? '#dc2626' : '#2563eb';
}

function readForm() {
  return {
    apiKey: $('apiKey').value.trim(),
    baseUrl: $('baseUrl').value.trim() || DEFAULTS.baseUrl,
    model: $('model').value.trim() || DEFAULTS.model,
    timeoutMs: Math.max(1000, Number($('timeoutMs').value || DEFAULTS.timeoutMs)),
    aiEnabled: $('aiEnabled').checked,
    debugMode: $('debugMode').checked
  };
}

function fillForm(cfg) {
  $('apiKey').value = cfg.apiKey || '';
  $('baseUrl').value = cfg.baseUrl || DEFAULTS.baseUrl;
  $('model').value = cfg.model || DEFAULTS.model;
  $('timeoutMs').value = Number(cfg.timeoutMs || DEFAULTS.timeoutMs);
  $('aiEnabled').checked = cfg.aiEnabled !== false;
  $('debugMode').checked = cfg.debugMode !== false;
}

async function loadConfig() {
  const cfg = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  fillForm({ ...DEFAULTS, ...cfg });
}

async function saveConfig() {
  const cfg = readForm();
  await chrome.storage.sync.set(cfg);
  setStatus('保存成功');
}

async function resetConfig() {
  await chrome.storage.sync.set(DEFAULTS);
  fillForm(DEFAULTS);
  setStatus('已恢复默认配置');
}

$('saveBtn').addEventListener('click', () => {
  saveConfig().catch(err => setStatus(`保存失败: ${err.message}`, true));
});

$('resetBtn').addEventListener('click', () => {
  resetConfig().catch(err => setStatus(`重置失败: ${err.message}`, true));
});

loadConfig().catch(err => setStatus(`加载失败: ${err.message}`, true));
