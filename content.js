
// Notion Formula Auto Conversion - Browser Extension (MV3 Content Script)

(function () {
  'use strict';

  // 默认配置（可在扩展 options 页面修改）
  let AI_ENABLED = true;
  let QWEN_API_KEY = '';
  let QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  let QWEN_MODEL = 'qwen-plus';
  let TIMEOUT_MS = 45000;
  const CHUNK_SIZE = 1600;
  const CHUNK_OVERLAP = 320;
  const MAX_CONVERT_PER_ROUND = 12;
  const MAX_ROUNDS = 8;
  // 调试模式：true=打印AI识别日志
  let DEBUG_MODE = true;
  const CONFIG_KEYS = ['aiEnabled', 'apiKey', 'baseUrl', 'model', 'timeoutMs', 'debugMode'];
  let configLoaded = false;

  let panel, btn, status, bar;
  let running = false;
  let stopFlag = false;
  let lastAiTotal = 0;
  const cache = new Map();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function dbg(...args) {
    if (DEBUG_MODE) console.log('[FormulaDebug]', ...args);
  }

  function shortText(s, n = 180) {
    const t = String(s || '').replace(/\n/g, '\\n');
    return t.length > n ? `${t.slice(0, n)}...` : t;
  }

  function printFormulaList(title, formulas) {
    if (!DEBUG_MODE) return;
    console.group(`[FormulaDebug] ${title} (count=${formulas.length})`);
    formulas.forEach((f, i) => {
      console.log(
        `#${i + 1}`,
        {
          raw: f.formula || f.raw || '',
          type: f.type || '',
          content: f.content || '',
          start: f.start,
          end: f.end,
          source: f.source || 'ai'
        }
      );
    });
    console.groupEnd();
  }

  function printAiSummary(formulas) {
    if (!DEBUG_MODE) return;
    const normalized = formulas.map(x => ({
      raw: x.formula || x.raw || '',
      type: x.type || 'inline',
      content: x.content || '',
      start: x.start,
      end: x.end
    }));
    printFormulaList('AI最终识别公式清单', normalized);
  }

  function injectStyle(cssText) {
    const style = document.createElement('style');
    style.textContent = cssText;
    document.head.appendChild(style);
  }

  async function loadConfig() {
    try {
      const data = await chrome.storage.sync.get(CONFIG_KEYS);
      AI_ENABLED = data.aiEnabled !== false;
      QWEN_API_KEY = String(data.apiKey || '').trim();
      QWEN_BASE_URL = String(data.baseUrl || QWEN_BASE_URL).trim();
      QWEN_MODEL = String(data.model || QWEN_MODEL).trim();
      TIMEOUT_MS = Number(data.timeoutMs || TIMEOUT_MS) || 45000;
      DEBUG_MODE = data.debugMode !== false;
    } catch (e) {
      console.warn('[FormulaHelper] 读取配置失败，使用默认值', e);
    } finally {
      configLoaded = true;
    }
  }

  async function ensureConfig() {
    if (!configLoaded) {
      await loadConfig();
    }
  }

  injectStyle(`
    #formula-helper{position:fixed;right:20px;bottom:90px;z-index:9999;width:188px;background:#fff;border-radius:10px;box-shadow:rgba(0,0,0,.12) 0 10px 30px;padding:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    #formula-helper button{width:100%;border:none;border-radius:7px;color:#fff;background:#2563eb;padding:6px 8px;cursor:pointer;font-weight:500;font-size:12px;margin-bottom:6px}
    #formula-helper button.processing{background:#ef4444}
    #formula-helper #status-text{font-size:11px;color:#4b5563;line-height:1.35;min-height:30px;margin-bottom:7px;word-break:break-word}
    #formula-helper #progress{height:5px;background:#e5e7eb;border-radius:999px;overflow:hidden}
    #formula-helper #bar{height:100%;width:0%;background:linear-gradient(90deg,#2563eb,#3b82f6);transition:width .2s ease}
  `);

  function initUI() {
    panel = document.createElement('div');
    panel.id = 'formula-helper';
    panel.innerHTML = `
      <button id="convert-btn">🔄 扫描中...</button>
      <div id="status-text">就绪</div>
      <div id="progress"><div id="bar"></div></div>
    `;
    document.body.appendChild(panel);
    btn = panel.querySelector('#convert-btn');
    status = panel.querySelector('#status-text');
    bar = panel.querySelector('#bar');
  }

  function setStatus(t, timeout = 0) {
    status.textContent = t;
    console.log('[FormulaHelper]', t);
    if (timeout) setTimeout(() => { if (!running) status.textContent = '就绪'; }, timeout);
  }

  function setProgress(cur, total) {
    const p = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : 0;
    bar.style.width = `${p}%`;
  }

  function visible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function editors() {
    const all = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter(el => visible(el) && (el.textContent || '').trim())
      .filter(el => !el.closest('#formula-helper'));

    // 只保留“叶子编辑区”，避免父子contenteditable重复计数/重复转换
    const leaf = all.filter(el => !all.some(other => other !== el && el.contains(other)));
    return leaf;
  }

  function maybeHasFormulaCandidate(text) {
    const t = (text || '').trim();
    if (!t) return false;
    // 纯数字或极短普通文本跳过
    if (t.length <= 2 && /^[\d\W]+$/.test(t)) return false;

    return /\\[a-zA-Z]+|[$`_^]|\\\(|\\\[|->|←|→|∈|≤|≥|∞|∑|∫|Π|λ|τ|π|α|β|γ/.test(t);
  }

  function isTextNodeConvertible(node, rootEditor) {
    if (!node || !node.parentElement) return false;
    if ((node.textContent || '').length === 0) return false;

    const parent = node.parentElement;
    if (parent.closest('.katex, .katex-display, .notion-equation-block')) return false;

    let el = parent;
    while (el && el !== rootEditor) {
      const ce = el.getAttribute && el.getAttribute('contenteditable');
      if (ce === 'false') return false;
      el = el.parentElement;
    }
    return true;
  }

  function collectEditorTextNodes(editor) {
    const out = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!isTextNodeConvertible(node, editor)) continue;
      out.push(node);
    }
    return out;
  }

  function getEditorSnapshot(editor) {
    const nodes = collectEditorTextNodes(editor);
    let text = '';
    for (const n of nodes) text += n.textContent || '';
    return { nodes, text };
  }

  function norm(s) { return (s || '').replace(/^\s+|\s+$/g, '').replace(/\\\\/g, '\\'); }
  function overlap(a, b) { return a.start < b.end && b.start < a.end; }

  function hasBalancedOuterPair(text, left, right) {
    const s = String(text || '').trim();
    if (!s.startsWith(left) || !s.endsWith(right)) return false;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === left) depth += 1;
      else if (ch === right) {
        depth -= 1;
        if (depth < 0) return false;
        // 最外层在结尾之前闭合，说明不是完整包裹
        if (depth === 0 && i < s.length - 1) return false;
      }
    }
    return depth === 0;
  }

  function stripOuterParens(text) {
    let s = String(text || '').trim();
    // 反复剥离完整外层括号: (...) 或 （...）
    for (let i = 0; i < 3; i++) {
      if (hasBalancedOuterPair(s, '(', ')')) {
        s = s.slice(1, -1).trim();
        continue;
      }
      if (hasBalancedOuterPair(s, '（', '）')) {
        s = s.slice(1, -1).trim();
        continue;
      }
      break;
    }
    return s;
  }

  function isOuterParenWrapped(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    return hasBalancedOuterPair(s, '(', ')') || hasBalancedOuterPair(s, '（', '）');
  }

  function shouldConvertRaw(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    if (isOuterParenWrapped(s)) return true;
    if (s.startsWith('$$') && s.endsWith('$$')) return true;
    if (s.startsWith('$') && s.endsWith('$')) return true;
    if (s.startsWith('\\(') && s.endsWith('\\)')) return true;
    if (s.startsWith('\\[') && s.endsWith('\\]')) return true;
    if (s.startsWith('`') && s.endsWith('`')) return true;
    return false;
  }

  function findParenLatexFallback(text, offset = 0) {
    const out = [];
    const s = String(text || '');
    if (!s) return out;

    const openers = new Set(['(', '（']);
    const pair = { '(': ')', '（': '）' };

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (!openers.has(ch)) continue;

      const right = pair[ch];
      let depth = 0;
      let end = -1;
      for (let j = i; j < s.length; j++) {
        const c = s[j];
        if (c === ch) depth += 1;
        else if (c === right) {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end < 0) continue;

      const raw = s.slice(i, end + 1);
      const inner = stripOuterParens(raw);
      const hasBackslash = /\\[a-zA-Z]+/.test(inner);
      if (!hasBackslash) {
        i = end;
        continue;
      }
      if (raw.length > 260 || /[\n\r]/.test(raw) || !likelyLatex(inner)) {
        i = end;
        continue;
      }

      out.push({
        start: offset + i,
        end: offset + end + 1,
        formula: raw,
        type: 'inline',
        content: stripWrap(raw),
        priority: 260 + raw.length,
        source: 'fallback'
      });
      i = end;
    }

    return out;
  }

  function stripWrap(raw, content = '') {
    if ((content || '').trim()) return norm(stripOuterParens(content));
    let s = norm(raw);
    if (!s) return '';
    if (s.startsWith('`') && s.endsWith('`')) s = s.slice(1, -1).trim();
    if (s.startsWith('$$') && s.endsWith('$$')) s = s.slice(2, -2).trim();
    else if (s.startsWith('$') && s.endsWith('$')) s = s.slice(1, -1).trim();
    else if (s.startsWith('\\(') && s.endsWith('\\)')) s = s.slice(2, -2).trim();
    else if (s.startsWith('\\[') && s.endsWith('\\]')) s = s.slice(2, -2).trim();
    s = stripOuterParens(s);
    return norm(s);
  }

  function typeOf(raw, hint) {
    if (hint === 'block' || hint === 'inline') return hint;
    const s = (raw || '').trim();
    return (s.startsWith('$$') || s.startsWith('\\[')) ? 'block' : 'inline';
  }

  function likelyLatex(s) {
    const t = (s || '').trim();
    if (!t || t.length < 2 || t.length > 180) return false;
    if (/^\\(?:ref|eqref|label|cite|autoref|pageref)\{[^{}]+\}$/.test(t)) return false;
    if (/[，。！？；、“”‘’\n]/.test(t)) return false;
    return /\\[a-zA-Z]+/.test(t) || /[_^]\{[^{}\n]+\}|[_^][a-zA-Z0-9]/.test(t);
  }

  function parseBackslashRun(text, start) {
    if (text[start] !== '\\') return null;
    let i = start, stack = [], signal = false;
    const n = text.length;
    const push = c => { if (c === '{') stack.push('}'); if (c === '(') stack.push(')'); if (c === '[') stack.push(']'); };
    while (i < n) {
      const ch = text[i];
      if (ch === '`' || ch === '\n' || ch === '\r') break;
      if (ch === '\\') {
        signal = true; i++;
        if (i >= n) break;
        if (/[a-zA-Z]/.test(text[i])) { while (i < n && /[a-zA-Z]/.test(text[i])) i++; }
        else i++;
        continue;
      }
      if (ch === '{' || ch === '(' || ch === '[') { push(ch); i++; continue; }
      if (ch === '}' || ch === ')' || ch === ']') {
        if (!stack.length) break;
        if (ch === stack[stack.length - 1]) { stack.pop(); i++; continue; }
        break;
      }
      if (/\s/.test(ch)) {
        if (stack.length) { i++; continue; }
        const j = (() => { let k = i + 1; while (k < n && /\s/.test(text[k])) k++; return k; })();
        if (j < n && /[\\^_+\-*/=<>(){}\[\]|&~,%0-9]/.test(text[j])) { i = j; continue; }
        break;
      }
      if (!stack.length && (/[\u4e00-\u9fff]/.test(ch) || /[，。！？；、,!?;:]/.test(ch))) break;
      if (/[A-Za-z0-9_^+\-*/=<>|&~.%,:]/.test(ch)) { signal = true; i++; continue; }
      if (stack.length) { i++; continue; }
      break;
    }
    const raw = (text.slice(start, i) || '').trim();
    if (!raw || raw === '\\' || !signal) return null;
    return { raw, end: i };
  }
  function findLocal(text) {
    const out = [];
    const add = (start, formula, type, content, priority) => {
      const c = norm(content);
      if (!formula || !c) return;
      out.push({ start, end: start + formula.length, formula, type, content: c, priority, source: 'local' });
    };

    let m;
    const reBack = /`(\$\$[\s\S]*?\$\$|\$[^\$\n]+?\$|\\\([^\n]+?\\\)|\\\[[\s\S]+?\\\])`/g;
    while ((m = reBack.exec(text)) !== null) add(m.index, m[0], m[1].startsWith('$$') || m[1].startsWith('\\[') ? 'block' : 'inline', stripWrap(m[1]), 100);

    const rePlainBack = /`([^`\n]+)`/g;
    while ((m = rePlainBack.exec(text)) !== null) {
      const inner = norm(m[1]);
      if (!inner || !likelyLatex(inner)) continue;
      add(m.index, m[0], 'inline', inner, 95);
    }

    const reExp = /\$\$([\s\S]*?)\$\$|\$([^\$\n]+?)\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
    while ((m = reExp.exec(text)) !== null) {
      const full = m[0], content = m[1] || m[2] || m[3] || m[4] || '';
      add(m.index, full, full.startsWith('$$') || full.startsWith('\\[') ? 'block' : 'inline', content, 90);
    }

    const strong = (s, e) => out.some(x => x.priority >= 90 && overlap({ start: s, end: e }, x));

    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '\\') continue;
      const p = parseBackslashRun(text, i);
      if (!p) continue;
      const s = i, e = s + p.raw.length;
      if (strong(s, e) || !likelyLatex(p.raw)) { i = Math.max(i, p.end - 1); continue; }
      add(s, p.raw, 'inline', p.raw, 45);
      i = Math.max(i, p.end - 1);
    }

    out.sort((a, b) => a.start - b.start || b.priority - a.priority || (b.end - b.start) - (a.end - a.start));
    const filtered = [];
    for (const item of out) if (!filtered.some(x => overlap(item, x))) filtered.push(item);
    return filtered.sort((a, b) => a.start - b.start);
  }

  function splitChunks(text) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + CHUNK_SIZE, text.length);
      chunks.push({ start, text: text.slice(start, end) });
      if (end >= text.length) break;
      start = Math.max(0, end - CHUNK_OVERLAP);
    }
    return chunks;
  }

  function postJSON(url, data, headers) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'formulaHelperPostJSON',
          url,
          body: data,
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
          timeoutMs: TIMEOUT_MS
        },
        response => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            reject(new Error(`扩展通信失败: ${lastErr.message}`));
            return;
          }
          if (!response) {
            reject(new Error('扩展通信失败: 空响应'));
            return;
          }
          if (!response.ok) {
            reject(new Error(response.error || '请求失败'));
            return;
          }
          resolve({ status: response.status, text: response.text || '' });
        }
      );
    });
  }

  function parseModelJSON(content) {
    if (!content) return null;
    let text = content;
    if (Array.isArray(text)) text = text.map(x => x?.text || x?.content || '').join('\n');
    if (typeof text !== 'string') return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) text = fenced[1];
    text = text.trim();
    try { return JSON.parse(text); } catch (_) {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { return JSON.parse(m[0]); } catch (_) { return null; }
    }
  }

  async function aiExtract(chunkText) {
    const sys = [
      '你是“零漏检，零误检”的LaTeX公式抽取器。',
      '目标: 对输入文本做穷举抽取，不能漏报也不能误报（千万不能误报，否则文档会出错）。',
      '你只能输出JSON，禁止输出任何解释文字。',
      '输出格式固定: {"formulas":[{"raw":"原文子串","type":"inline|block","content":"可选"}]}',
      '硬性规则:',
      '1) raw必须是输入文本中的逐字连续子串，不能改写、不能补字、不能删字。',
      '2) 按原文顺序输出；同一公式出现多次要多次输出保证不漏。',
      '3) 若一个公式内部有多个反斜杠命令，必须作为一个整体输出，不能拆分。',
      '4) 必须识别: $...$, $$...$$, \\(...\\), \\[...\\], 反引号公式, 反引号中的隐式LaTeX, 反斜杠复杂表达式。',
      '5) 混合表达式必须整体输出，例如 \\mathcal{C}_{\\text{nat}}(\\tau^{\\text{Adv}}\\mid\\mathcal{X})、\\Pi_{\\mathcal{C}_{\\text{corr}}}、p_{\\text{pred}}(\\cdot\\mid\\mathcal{X})。',
      '6) @notion、Markdown、中文段落中的公式同样要抽取，不可忽略。',
      '7) 重点不要漏: (\\mathcal{C}_{\\text{corr}})、(\\mathbf{p}^{\\text{Adv}}[k]\\in\\mathbb{R}^2)、(\\mathbf{p}^{\\text{Adv}}[k]) 等“被普通括号包裹”的公式。',
      '8) 即使公式书写不规范（例如缺少下划线、括号风格混用），只要是明显LaTeX片段也要抽取，raw仍必须原样拷贝。',
      '9) 如果同一个符号在不同位置出现，必须全部列出，不得去重。',
      '10) 排除非公式的描写性的，他们并不是公式。比如\\label \\cite \\autoref \\pageref \\eqref \\ref。',
      '无公式时输出 {"formulas":[]}'
    ].join('\n');

    const payload = {
      model: QWEN_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `请对下面文本进行“穷举公式抽取”，确保不漏报，并严格按JSON返回:\n\n${chunkText}` }
      ]
    };

    const res = await postJSON(`${QWEN_BASE_URL}/chat/completions`, payload, { Authorization: `Bearer ${QWEN_API_KEY}` });
    if (res.status < 200 || res.status >= 300) throw new Error(`Qwen错误(${res.status}): ${res.text.slice(0, 240)}`);

    const obj = JSON.parse(res.text || '{}');
    const content = obj?.choices?.[0]?.message?.content || '';
    dbg('AI原始输出', shortText(content, 800));
    const parsed = parseModelJSON(content);
    if (!parsed || !Array.isArray(parsed.formulas)) return [];

    const items = [];
    for (const it of parsed.formulas) {
      if (typeof it === 'string') {
        const raw = norm(it);
        if (raw) items.push({ raw, type: typeOf(raw, 'inline'), content: stripWrap(raw) });
        continue;
      }
      const raw = norm(it?.raw || it?.formula || it?.text || '');
      if (!raw) continue;
      items.push({ raw, type: typeOf(raw, it.type), content: stripWrap(raw, it.content || '') });
    }
    // 调试模式只需要看最终清单，这里不再逐层打印
    return items;
  }

  function findIdxNonOverlap(text, variant, from, occupied) {
    let idx = text.indexOf(variant, Math.max(0, from));
    while (idx >= 0) {
      const r = { start: idx, end: idx + variant.length };
      if (!occupied.some(x => overlap(x, r))) return idx;
      idx = text.indexOf(variant, idx + 1);
    }
    return -1;
  }

  function findAllOccurrences(text, variant) {
    const out = [];
    if (!variant) return out;
    let idx = 0;
    while (true) {
      idx = text.indexOf(variant, idx);
      if (idx < 0) break;
      out.push(idx);
      idx += Math.max(1, variant.length);
    }
    return out;
  }

  function mapAI(text, aiItems, offset) {
    const candidates = [];
    const uniqueItems = [];
    const seenRaw = new Set();

    for (const item of aiItems) {
      const key = norm(item.raw);
      if (!key || seenRaw.has(key)) continue;
      seenRaw.add(key);
      uniqueItems.push(item);
    }

    for (const item of uniqueItems) {
      const vars = [...new Set([
        norm(item.raw),
        norm(item.raw).replace(/\\\\/g, '\\'),
        norm(item.raw).replace(/^`|`$/g, '')
      ].filter(Boolean))];

      const localHits = [];
      for (const v of vars) {
        for (const idx of findAllOccurrences(text, v)) {
          localHits.push({ idx, raw: v });
        }
      }

      const dedupHits = [];
      const seen = new Set();
      for (const h of localHits) {
        const k = `${h.idx}:${h.raw.length}`;
        if (seen.has(k)) continue;
        seen.add(k);
        dedupHits.push(h);
      }

      for (const h of dedupHits) {
        candidates.push({
          start: offset + h.idx,
          end: offset + h.idx + h.raw.length,
          formula: h.raw,
          type: typeOf(h.raw, item.type),
          content: stripWrap(h.raw, item.content || ''),
          priority: 1000 + h.raw.length,
          source: 'ai'
        });
      }
    }

    // 长公式优先，移除重叠
    candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const kept = [];
    for (const c of candidates) {
      if (kept.some(k => overlap(k, c))) continue;
      kept.push(c);
    }

    return kept.sort((a, b) => a.start - b.start);
  }

  function merge(primary, fallback) {
    const out = [];
    const add = x => { if (!x) return; if (out.some(y => y.start === x.start && y.end === x.end)) return; if (out.some(y => overlap(x, y))) return; out.push(x); };
    primary.sort((a, b) => a.start - b.start).forEach(add);
    fallback.sort((a, b) => a.start - b.start).forEach(add);
    return out.sort((a, b) => a.start - b.start);
  }

  function uniqByRange(list) {
    const seen = new Set();
    const out = [];
    for (const x of list) {
      const key = `${x.start}:${x.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(x);
    }
    return out;
  }

  function expandRangeIfWrappedByParens(text, start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return { start, end };
    const s = String(text || '');
    if (!s) return { start, end };

    let l = start;
    let r = end;
    while (l > 0 && /\s/.test(s[l - 1])) l -= 1;
    while (r < s.length && /\s/.test(s[r])) r += 1;

    const left = s[l - 1];
    const right = s[r];
    if ((left === '(' && right === ')') || (left === '（' && right === '）')) {
      return { start: l - 1, end: r + 1 };
    }
    return { start, end };
  }

  function buildGlobalDocument(editorList) {
    const separator = '\n@@__EDITOR_BOUNDARY__@@\n';
    const segments = [];
    const parts = [];
    let cursor = 0;

    const picked = [];
    for (let i = 0; i < editorList.length; i++) {
      const editor = editorList[i];
      const snap = getEditorSnapshot(editor);
      const text = snap.text || '';
      if (!text.trim()) continue;
      if (!maybeHasFormulaCandidate(text)) continue;
      picked.push({ editor, index: i, text });
    }

    for (let i = 0; i < picked.length; i++) {
      const item = picked[i];
      const start = cursor;
      parts.push(item.text);
      cursor += item.text.length;
      const end = cursor;
      segments.push({
        editor: item.editor,
        index: item.index,
        start,
        end,
        textLength: item.text.length,
        text: item.text
      });

      if (i < picked.length - 1) {
        parts.push(separator);
        cursor += separator.length;
      }
    }

    return { fullText: parts.join(''), segments };
  }

  function distributeFormulasToEditors(globalFormulas, segments) {
    const byEditor = new Map();

    for (const seg of segments) {
      byEditor.set(seg.editor, []);
    }

    const sorted = (globalFormulas || []).slice().sort((a, b) => a.start - b.start || a.end - b.end);
    let segIdx = 0;
    for (const f of sorted) {
      while (segIdx < segments.length && f.start >= segments[segIdx].end) segIdx++;
      const seg = segments[segIdx];
      if (!seg) break;
      if (f.start < seg.start || f.end > seg.end) continue;

      const mappedStart = f.start - seg.start;
      const mappedEnd = f.end - seg.start;
      const expanded = expandRangeIfWrappedByParens(seg.text, mappedStart, mappedEnd);
      const localStart = expanded.start;
      const localEnd = expanded.end;
      const leftCtx = seg.text.slice(Math.max(0, localStart - 24), localStart);
      const rightCtx = seg.text.slice(localEnd, Math.min(seg.text.length, localEnd + 24));
      const exactRaw = seg.text.slice(localStart, localEnd) || f.formula;
      if (!shouldConvertRaw(exactRaw)) continue;

      byEditor.get(seg.editor).push({
        ...f,
        formula: exactRaw,
        start: localStart,
        end: localEnd,
        leftCtx,
        rightCtx
      });
    }

    const targets = [];
    let total = 0;

    for (const seg of segments) {
      const arr = uniqByRange((byEditor.get(seg.editor) || []).sort((a, b) => a.start - b.start));
      if (!arr.length) continue;
      targets.push({ editor: seg.editor, formulas: arr });
      total += arr.length;
    }

    return { targets, total };
  }
  async function detect(text, onProgress) {
    await ensureConfig();
    if (cache.has(text)) return cache.get(text).map(x => ({ ...x }));
    if (!AI_ENABLED || !QWEN_API_KEY) { cache.set(text, []); return []; }
    try {
      const chunks = splitChunks(text);
      let aiAll = [];
      let failCount = 0;
      let firstFailMsg = '';

      for (let i = 0; i < chunks.length; i++) {
        if (stopFlag) break;
        if (typeof onProgress === 'function') onProgress(i + 1, chunks.length);

        let mapped = [];
        try {
          const items = await aiExtract(chunks[i].text);
          mapped = mapAI(chunks[i].text, items, chunks[i].start);
        } catch (chunkErr) {
          failCount += 1;
          if (!firstFailMsg) firstFailMsg = chunkErr?.message || 'unknown';
          if (DEBUG_MODE) {
            dbg(`分块识别失败 ${i + 1}/${chunks.length}`, chunkErr?.message || chunkErr);
          }
        }

        const fallback = findParenLatexFallback(chunks[i].text, chunks[i].start);
        aiAll = merge(aiAll, mapped);
        aiAll = merge(aiAll, fallback);
        await sleep(80);
      }

      if (failCount > 0) {
        console.warn(`[FormulaHelper] AI分块识别失败 ${failCount}/${chunks.length}，已自动跳过失败分块。首个错误: ${firstFailMsg}`);
      }

      const result = uniqByRange(aiAll.sort((a, b) => a.start - b.start));
      cache.set(text, result);
      return result;
    } catch (e) {
      console.warn(`[FormulaHelper] AI识别流程失败: ${e?.message || e}`);
      if (DEBUG_MODE) console.debug(e);
      cache.set(text, []);
      return [];
    }
  }

  async function collectTargets() {
    const es = editors();
    const { fullText, segments } = buildGlobalDocument(es);
    if (!fullText.trim()) return { targets: [], total: 0 };

    const globalFormulas = await detect(fullText, (cur, total) => {
      setStatus(`AI识别中 ${cur}/${total}...`);
    });
    printAiSummary(globalFormulas);

    const distributed = distributeFormulasToEditors(globalFormulas, segments);
    return distributed;
  }

  function locateRangeInSnapshot(snapshot, start, end) {
    if (!snapshot || !Array.isArray(snapshot.nodes)) return null;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;

    let pos = 0;
    let sNode = null, eNode = null, sOff = 0, eOff = 0;

    for (const node of snapshot.nodes) {
      const len = (node.textContent || '').length;
      const a = pos;
      const b = pos + len;

      if (!sNode && start >= a && start < b) {
        sNode = node;
        sOff = start - a;
      }
      if (!eNode && end > a && end <= b) {
        eNode = node;
        eOff = end - a;
        break;
      }
      pos = b;
    }

    if (!sNode || !eNode) return null;
    return { sNode, eNode, sOff, eOff };
  }

  function locateByOffsets(editor, start, end, snapshot) {
    return locateRangeInSnapshot(snapshot || getEditorSnapshot(editor), start, end);
  }

  function matchTextKey(s) {
    return norm(s || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
  }

  function locationMatchesFormula(loc, formula) {
    if (!loc) return false;
    const range = document.createRange();
    range.setStart(loc.sNode, loc.sOff);
    range.setEnd(loc.eNode, loc.eOff);
    const selected = matchTextKey(range.toString());
    if (!selected) return false;
    return formulaVariants(formula).some(v => matchTextKey(v) === selected);
  }

  function locateByAnchor(editor, f, snapshot) {
    const snap = snapshot || getEditorSnapshot(editor);
    const text = snap.text || '';
    if (!text) return null;

    const vars = formulaVariants(f.formula);
    const candidates = [];

    for (const v of vars) {
      if (!v) continue;
      let from = 0;
      while (true) {
        const idx = text.indexOf(v, from);
        if (idx < 0) break;

        let score = 0;
        if (f.leftCtx) {
          const left = text.slice(Math.max(0, idx - f.leftCtx.length), idx);
          if (left === f.leftCtx) score += 6;
        }
        if (f.rightCtx) {
          const right = text.slice(idx + v.length, idx + v.length + f.rightCtx.length);
          if (right === f.rightCtx) score += 6;
        }
        if (Number.isInteger(f.start)) score -= Math.abs(idx - f.start) / 24;

        candidates.push({ idx, len: v.length, score });
        from = idx + Math.max(1, v.length);
      }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score || b.len - a.len || a.idx - b.idx);
    const best = candidates[0];
    return locateRangeInSnapshot(snap, best.idx, best.idx + best.len);
  }

  async function clickFocus(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    await sleep(20);

    const active = document.activeElement;
    if (active && (active === el || el.contains(active))) return;

    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + Math.min(18, r.height / 2);
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    });
    await sleep(25);
  }

  async function shortcutEquation(target) {
    const active = document.activeElement || document.body;
    const primary = (target && target.isConnected) ? target : active;
    const isMac = /mac|iphone|ipad/i.test(navigator.platform);
    const ctrl = !isMac, meta = isMac;
    const targets = [];
    if (primary) targets.push(primary);
    if (active && active !== primary) targets.push(active);

    const dispatchAll = (type, k, c, keyCode, extra = {}) => {
      const init = Object.assign({ key: k, code: c, keyCode, bubbles: true, cancelable: true }, extra);
      for (const t of targets) t.dispatchEvent(new KeyboardEvent(type, init));
      document.dispatchEvent(new KeyboardEvent(type, init));
    };
    const kd = (k, c, keyCode, extra = {}) => dispatchAll('keydown', k, c, keyCode, extra);
    const ku = (k, c, keyCode, extra = {}) => dispatchAll('keyup', k, c, keyCode, extra);
    if (ctrl) kd('Control', 'ControlLeft', 17);
    if (meta) kd('Meta', 'MetaLeft', 91);
    kd('Shift', 'ShiftLeft', 16);
    kd('e', 'KeyE', 69, { ctrlKey: ctrl, shiftKey: true, metaKey: meta });
    ku('e', 'KeyE', 69, { ctrlKey: ctrl, shiftKey: true, metaKey: meta });
    ku('Shift', 'ShiftLeft', 16);
    if (ctrl) ku('Control', 'ControlLeft', 17);
    if (meta) ku('Meta', 'MetaLeft', 91);
    await sleep(80);
  }

  async function shortcutCtrlE(target) {
    const active = document.activeElement || document.body;
    const primary = (target && target.isConnected) ? target : active;
    const isMac = /mac|iphone|ipad/i.test(navigator.platform);
    const ctrl = !isMac, meta = isMac;
    const targets = [];
    if (primary) targets.push(primary);
    if (active && active !== primary) targets.push(active);

    const dispatchAll = (type, k, c, keyCode, extra = {}) => {
      const init = Object.assign({ key: k, code: c, keyCode, bubbles: true, cancelable: true }, extra);
      for (const t of targets) t.dispatchEvent(new KeyboardEvent(type, init));
      document.dispatchEvent(new KeyboardEvent(type, init));
    };
    const kd = (k, c, keyCode, extra = {}) => dispatchAll('keydown', k, c, keyCode, extra);
    const ku = (k, c, keyCode, extra = {}) => dispatchAll('keyup', k, c, keyCode, extra);

    if (ctrl) kd('Control', 'ControlLeft', 17);
    if (meta) kd('Meta', 'MetaLeft', 91);
    kd('e', 'KeyE', 69, { ctrlKey: ctrl, metaKey: meta });
    ku('e', 'KeyE', 69, { ctrlKey: ctrl, metaKey: meta });
    if (ctrl) ku('Control', 'ControlLeft', 17);
    if (meta) ku('Meta', 'MetaLeft', 91);
    await sleep(60);
  }

  async function keyEnter(target) {
    const t = target || document.activeElement || document.body;
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    await sleep(20);
    t.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }

  async function waitEquationInput(editor, timeout = 900) {
    const st = Date.now();
    while (Date.now() - st < timeout) {
      const active = document.activeElement;
      if (active && visible(active) && (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        const inside = editor && editor.contains(active);
        if (!inside && (active.closest('.notion-overlay-container') || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return active;
      }
      const cands = Array.from(document.querySelectorAll('.notion-overlay-container [contenteditable="true"], .notion-overlay-container textarea, .notion-overlay-container input[type="text"]')).filter(visible);
      if (cands.length) return cands[cands.length - 1];
      await sleep(40);
    }
    return null;
  }

  async function fillInput(input, text) {
    if (!input) return false;
    if (input.isContentEditable) {
      input.focus();
      document.execCommand('selectAll');
      await sleep(15);
      document.execCommand('insertText', false, text);
      return true;
    }
    if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') {
      input.focus(); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); return true;
    }
    return false;
  }

  async function waitKatex(editor, before, timeout = 1400) {
    const st = Date.now();
    while (Date.now() - st < timeout) {
      if (editor.querySelectorAll('.katex').length > before) return true;
      await sleep(60);
    }
    return false;
  }

  function countOccurrences(text, needle) {
    if (!needle) return 0;
    let idx = 0;
    let cnt = 0;
    while (true) {
      idx = text.indexOf(needle, idx);
      if (idx < 0) break;
      cnt += 1;
      idx += Math.max(1, needle.length);
    }
    return cnt;
  }

  function formulaVariants(raw) {
    const set = new Set();
    const r = norm(raw);
    if (!r) return [];
    set.add(r);
    set.add(r.replace(/\\\\/g, '\\'));
    if (r.startsWith('`') && r.endsWith('`')) set.add(r.slice(1, -1));
    return [...set].filter(Boolean);
  }

  async function waitConversionSuccess(editor, beforeKatex, rawFormula, timeout = 1500) {
    const variants = formulaVariants(rawFormula);
    const beforeText = getEditorSnapshot(editor).text || '';
    const beforeCounts = variants.map(v => countOccurrences(beforeText, v));
    const beforeReadOnly = editor.querySelectorAll('[contenteditable="false"]').length;

    const st = Date.now();
    while (Date.now() - st < timeout) {
      const nowText = getEditorSnapshot(editor).text || '';
      const katexIncreased = editor.querySelectorAll('.katex').length > beforeKatex;
      const readOnlyIncreased = editor.querySelectorAll('[contenteditable="false"]').length > beforeReadOnly;
      const countDecreased = variants.some((v, i) => countOccurrences(nowText, v) < beforeCounts[i]);
      // 既要看到原文本数量下降，也接受KaTeX增加作为强信号；
      // 避免“在错误位置插入了公式但原位置未替换”被误判成功。
      if (countDecreased && katexIncreased) return true;
      if (countDecreased && readOnlyIncreased) return true;
      if (countDecreased && Date.now() - st > 350) return true;
      if (readOnlyIncreased && nowText !== beforeText && Date.now() - st > 450) return true;
      await sleep(60);
    }
    return false;
  }

  async function convertOne(editor, f) {
    // 先稳定焦点，再定位，避免聚焦动作导致节点重建后偏移失效
    await clickFocus(editor);

    const snapshot = getEditorSnapshot(editor);
    let r = locateByOffsets(editor, f.start, f.end, snapshot);

    // 偏移命中但文本不一致，说明发生漂移；改用上下文锚点重新定位
    if (r && !locationMatchesFormula(r, f.formula)) {
      r = null;
    }
    if (!r) {
      r = locateByAnchor(editor, f, snapshot);
    }
    if (!r || !locationMatchesFormula(r, f.formula)) {
      return { ok: false, reason: 'not-found' };
    }

    // 已是公式渲染节点则跳过，防止重复转换
    const alreadyEquation =
      (r.sNode?.parentElement && r.sNode.parentElement.closest('.katex, .katex-display, .notion-equation-block')) ||
      (r.eNode?.parentElement && r.eNode.parentElement.closest('.katex, .katex-display, .notion-equation-block'));
    if (alreadyEquation) {
      return { ok: false, reason: 'already-converted' };
    }

    const range = document.createRange();
    range.setStart(r.sNode, r.sOff);
    range.setEnd(r.eNode, r.eOff);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const selectedKey = matchTextKey(sel.toString());
    const expectedKeys = formulaVariants(f.formula).map(matchTextKey);
    if (!expectedKeys.includes(selectedKey)) {
      dbg('选区校验失败，跳过该项', { expected: expectedKeys, selected: selectedKey, formula: f.formula });
      return { ok: false, reason: 'selection-mismatch' };
    }

    let content = f.content;
    if (f.type === 'block' && !content.startsWith('\\displaystyle')) content = `\\displaystyle ${content}`.trim();

    const beforeKatex = editor.querySelectorAll('.katex').length;
    const beforeSnapshot = getEditorSnapshot(editor).text || '';
    const beforeReadOnly = editor.querySelectorAll('[contenteditable="false"]').length;
    const variantList = formulaVariants(f.formula);
    const beforeTotalCount = variantList.reduce((sum, v) => sum + countOccurrences(beforeSnapshot, v), 0);

    // 先执行 Ctrl+E（或 Mac 上 Meta+E），再执行原有公式快捷键
    await shortcutCtrlE(editor);
    await sleep(45);
    await shortcutEquation(editor);
    await sleep(80);

    const input = await waitEquationInput(editor, 700);
    if (input) {
      await fillInput(input, content);
      await sleep(30);
      await keyEnter(input);
    } else {
      await keyEnter();
    }

    const ok = await waitConversionSuccess(editor, beforeKatex, f.formula, 1700);
    if (!ok) {
      // 容错兜底：如果只是在判定上漏报，但文本/结构已发生目标性变化，则判为成功
      const afterSnapshot = getEditorSnapshot(editor).text || '';
      const afterReadOnly = editor.querySelectorAll('[contenteditable="false"]').length;
      const afterTotalCount = variantList.reduce((sum, v) => sum + countOccurrences(afterSnapshot, v), 0);

      const likelyConverted =
        afterTotalCount < beforeTotalCount ||
        (afterReadOnly > beforeReadOnly && afterSnapshot !== beforeSnapshot);

      if (likelyConverted) {
        if (DEBUG_MODE) {
          dbg('转换成功(兜底判定)', {
            formula: f.formula,
            beforeTotalCount,
            afterTotalCount,
            beforeReadOnly,
            afterReadOnly
          });
        }
        return { ok: true, reason: 'heuristic-success' };
      }
      return { ok: false, reason: 'convert-failed' };
    }
    return { ok: true };
  }

  function buildRoundQueue(targets, limit) {
    const queue = [];
    for (const group of targets.slice().reverse()) {
      for (const f of group.formulas.slice().reverse()) {
        queue.push({ editor: group.editor, formula: f });
        if (queue.length >= limit) return queue;
      }
    }
    return queue;
  }

  async function runConvert() {
    if (running) return;
    running = true; stopFlag = false;
    btn.classList.add('processing'); btn.textContent = '取消转换';
    setProgress(0, 0);

    try {
      await ensureConfig();
      if (!QWEN_API_KEY) {
        setStatus('未配置API Key，请先打开扩展选项填写', 4000);
        return;
      }
      let ok = 0, fail = 0, skipped = 0;
      let round = 0;

      while (!stopFlag && round < MAX_ROUNDS) {
        round += 1;
        cache.clear();

        const { targets, total } = await collectTargets();
        lastAiTotal = total;

        if (!total) {
          if (round === 1) setStatus('AI未识别到可转换公式', 2500);
          break;
        }

        const queue = buildRoundQueue(targets, MAX_CONVERT_PER_ROUND);
        if (!queue.length) break;

        let roundDone = 0;
        let roundSuccess = 0;
        setStatus(`第${round}轮：识别到 ${total} 个，准备转换 ${queue.length} 个...`);

        for (const item of queue) {
          if (stopFlag) break;
          const f = item.formula;
          const res = await convertOne(item.editor, f);

          roundDone++;
          if (res.ok) {
            ok++;
            roundSuccess++;
          } else if (res.reason === 'already-converted') {
            skipped++;
            roundSuccess++;
          } else {
            fail++;
          }

          if (!res.ok && DEBUG_MODE) {
            dbg('转换失败', { reason: res.reason, formula: f.formula, start: f.start, end: f.end });
          }

          setProgress(roundDone, queue.length);
          setStatus(`第${round}轮 ${roundDone}/${queue.length}，累计成功 ${ok}，跳过 ${skipped}，失败 ${fail}`);
          await sleep(80);
        }

        if (roundSuccess === 0 && roundDone > 0) {
          setStatus(`第${round}轮未成功命中，停止以避免重复空转`, 3000);
          break;
        }
      }

      if (stopFlag) setStatus(`已取消，累计成功 ${ok}`, 3000);
      else setStatus(`完成：成功 ${ok}，跳过 ${skipped}，失败 ${fail}`, 3500);
    } catch (e) {
      console.error(e);
      setStatus(`发生错误：${e.message}`, 5000);
    } finally {
      running = false;
      btn.classList.remove('processing');
      refreshCount();
      setTimeout(() => setProgress(0, 0), 900);
    }
  }

  function refreshCount() {
    if (running) return;
    btn.textContent = `🤖 AI转换公式 (${lastAiTotal})`;
  }

  initUI();
  refreshCount();

  // 调试模式下，暴露一个“只识别不转换”的测试函数
  // 控制台执行: await window.__formulaDebugTest()
  window.__formulaDebugTest = async function () {
    try {
      setStatus('调试测试: 开始AI识别...');
      const res = await collectTargets();
      lastAiTotal = res.total;
      printAiSummary(res.targets.flatMap(x => x.formulas));
      setStatus(`调试测试完成: 共识别 ${res.total} 个公式`, 3000);
      return res;
    } catch (e) {
      console.error('[FormulaDebug] 调试测试异常', e);
      setStatus(`调试测试失败: ${e.message}`, 5000);
      throw e;
    }
  };

  btn.addEventListener('click', () => {
    if (running) { stopFlag = true; setStatus('正在取消...'); return; }
    runConvert();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && running) { stopFlag = true; setStatus('正在取消...'); }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (Object.prototype.hasOwnProperty.call(changes, 'aiEnabled')) AI_ENABLED = changes.aiEnabled.newValue !== false;
    if (Object.prototype.hasOwnProperty.call(changes, 'apiKey')) QWEN_API_KEY = String(changes.apiKey.newValue || '').trim();
    if (Object.prototype.hasOwnProperty.call(changes, 'baseUrl')) QWEN_BASE_URL = String(changes.baseUrl.newValue || QWEN_BASE_URL).trim();
    if (Object.prototype.hasOwnProperty.call(changes, 'model')) QWEN_MODEL = String(changes.model.newValue || QWEN_MODEL).trim();
    if (Object.prototype.hasOwnProperty.call(changes, 'timeoutMs')) TIMEOUT_MS = Number(changes.timeoutMs.newValue || TIMEOUT_MS) || 45000;
    if (Object.prototype.hasOwnProperty.call(changes, 'debugMode')) DEBUG_MODE = changes.debugMode.newValue !== false;
    cache.clear();
  });

  setInterval(() => { if (!running) refreshCount(); }, 2500);
  loadConfig().catch(e => console.warn('[FormulaHelper] 初始化配置失败', e));
  console.log('Notion Formula Auto Conversion Tool v3.1 loaded');
})();
