chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'formulaHelperPostJSON') {
    return false;
  }

  const url = String(message.url || '');
  const headers = message.headers || {};
  const body = message.body || {};
  const timeoutMs = Number(message.timeoutMs || 45000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal
  })
    .then(async res => {
      const text = await res.text();
      sendResponse({ ok: true, status: res.status, text });
    })
    .catch(err => {
      sendResponse({
        ok: false,
        error: `请求失败: ${err && err.message ? err.message : 'unknown'}`
      });
    })
    .finally(() => {
      clearTimeout(timer);
    });

  return true;
});
