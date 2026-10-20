// ============================================================================
// web/jp-dict.js - 日文在线词典 (基于 Dict.Asia 词库 · 日汉/汉日互译 · 假名音调 · 例句解析 · 历史查询)
// ============================================================================
(function(window) {
  'use strict';

  const STORAGE_KEY = 'ncm_jp_dict_history';
  const MAX_HISTORY = 60;

  let modalEl = null;
  let backdropEl = null;
  let inputEl = null;
  let searchBtnEl = null;
  let clearInputBtnEl = null;
  let resultAreaEl = null;
  let historyDrawerEl = null;
  let historyBadgeEl = null;
  let quickChipsEl = null;
  let currentMode = 'auto'; // 'auto' | 'jc' | 'cj'
  let isHistoryOpen = false;
  let toastEl = null;
  let toastTimer = null;

  const JpDict = {
    init() {
      if (modalEl) return;

      // 预热浏览器原生语音合成列表
      if ('speechSynthesis' in window) {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.onvoiceschanged = () => {
          window.speechSynthesis.getVoices();
        };
      }

      // 1. 创建背景蒙层
      backdropEl = document.createElement('div');
      backdropEl.className = 'jd-backdrop';
      backdropEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(backdropEl);

      // 2. 创建主悬浮模态弹窗
      modalEl = document.createElement('div');
      modalEl.className = 'jd-modal';
      modalEl.setAttribute('role', 'dialog');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.setAttribute('aria-labelledby', 'jdTitle');
      modalEl.innerHTML = this.renderTemplate();
      document.body.appendChild(modalEl);

      inputEl = modalEl.querySelector('#jdInput');
      searchBtnEl = modalEl.querySelector('#jdSearchBtn');
      clearInputBtnEl = modalEl.querySelector('#jdClearInputBtn');
      resultAreaEl = modalEl.querySelector('#jdResultArea');
      historyDrawerEl = modalEl.querySelector('#jdHistoryDrawer');
      historyBadgeEl = modalEl.querySelector('#jdHistoryCount');
      quickChipsEl = modalEl.querySelector('#jdQuickChips');
      toastEl = modalEl.querySelector('#jdToast');

      this.bindEvents();
      this.updateHistoryBadge();
      this.renderQuickChips();

      // 3. 向侧边栏工具箱注册入口 (图标风格与其他工具统一无 emoji，order: 25)
      if (window.Sidebar) {
        window.Sidebar.register({
          id: 'jp-dict',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
          </svg>`,
          label: '日文词典',
          title: '日文在线词典 (Dict.Asia)',
          order: 25,
          onClick: () => this.open()
        });
      }
    },

    renderTemplate() {
      return `
        <!-- 弹窗顶部栏 -->
        <div class="jd-header">
          <div class="jd-title-group">
            <span class="jd-header-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
              </svg>
            </span>
            <div>
              <div class="jd-title" id="jdTitle">日文词典</div>
              <div class="jd-subtitle">基于 Dict.Asia 词库 · 日汉 / 汉日互译 · 假名音调 · 例句解析</div>
            </div>
          </div>
          <div class="jd-header-actions">
            <button type="button" class="jd-header-btn" id="jdToggleHistoryBtn" title="查看或清空历史查询记录">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              <span>历史记录</span>
              <span class="jd-history-badge" id="jdHistoryCount">0</span>
            </button>
            <button type="button" class="jd-close-btn" id="jdCloseBtn" title="关闭窗口 (ESC)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        <!-- 搜索与模式控制栏 -->
        <div class="jd-search-section">
          <div class="jd-search-bar">
            <!-- 模式切换分段按钮 -->
            <div class="jd-mode-tabs" role="radiogroup" aria-label="查询模式">
              <button type="button" class="jd-mode-tab active" data-mode="auto" title="自动识别日文假名或中文">智能匹配</button>
              <button type="button" class="jd-mode-tab" data-mode="jc" title="日文查中文 (日中词典)">日中</button>
              <button type="button" class="jd-mode-tab" data-mode="cj" title="中文查日文 (中日词典)">中日</button>
            </div>

            <!-- 输入框容器 -->
            <div class="jd-input-wrap">
              <svg class="jd-input-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <input type="text" id="jdInput" class="jd-input" placeholder="输入日文词汇、汉字或中文 (支持回车查询)..." autocomplete="off" spellcheck="false" />
              <button type="button" class="jd-input-clear-btn" id="jdClearInputBtn" title="清空输入" style="display:none">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            <!-- 查询按钮 -->
            <button type="button" class="jd-search-btn" id="jdSearchBtn">
              <span class="jd-search-btn-txt">查询</span>
              <span class="jd-search-btn-spinner" style="display:none"></span>
            </button>
          </div>

          <!-- 快速便捷标签 / 最近搜索建议 -->
          <div class="jd-quick-bar">
            <span class="jd-quick-label">快捷搜索：</span>
            <div class="jd-quick-chips" id="jdQuickChips"></div>
          </div>
        </div>

        <!-- 主内容区域 (结果展示 + 右侧/浮层历史记录抽屉) -->
        <div class="jd-body">
          <!-- 词典释义结果视窗 -->
          <div class="jd-result-area" id="jdResultArea">
            ${this.renderInitialGuideHtml()}
          </div>

          <!-- 历史查询抽屉面板 -->
          <div class="jd-history-drawer" id="jdHistoryDrawer" style="display:none">
            <div class="jd-drawer-header">
              <div class="jd-drawer-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span>历史查询记录</span>
              </div>
              <div class="jd-drawer-actions">
                <button type="button" class="jd-drawer-btn danger" id="jdClearAllHistoryBtn" title="清空全部历史记录">清空全部</button>
                <button type="button" class="jd-drawer-btn" id="jdCloseDrawerBtn" title="关闭历史记录">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>
            <div class="jd-drawer-body" id="jdHistoryList"></div>
          </div>
        </div>

        <!-- 浮层轻量 Toast 提示 -->
        <div class="jd-toast" id="jdToast" style="display:none"></div>
      `;
    },

    bindEvents() {
      // 1. 弹窗打开/关闭
      backdropEl?.addEventListener('click', () => this.close());
      modalEl?.querySelector('#jdCloseBtn')?.addEventListener('click', () => this.close());

      // 键盘全局 ESC 退出
      window.addEventListener('keydown', (e) => {
        if (!modalEl || !modalEl.classList.contains('open')) return;
        if (e.key === 'Escape') {
          if (isHistoryOpen) {
            this.toggleHistory(false);
          } else {
            this.close();
          }
        }
      });

      // 2. 模式切换
      modalEl?.querySelectorAll('.jd-mode-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          modalEl.querySelectorAll('.jd-mode-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          currentMode = tab.dataset.mode || 'auto';
          // 若已有输入词条，切换模式时直接重新查询
          const val = inputEl ? inputEl.value.trim() : '';
          if (val) {
            this.search(val, currentMode);
          }
        });
      });

      // 3. 搜索与回车
      searchBtnEl?.addEventListener('click', () => {
        const val = inputEl ? inputEl.value.trim() : '';
        this.search(val, currentMode);
      });

      inputEl?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = inputEl.value.trim();
          this.search(val, currentMode);
        }
      });

      // 输入框清空按钮显隐
      inputEl?.addEventListener('input', () => {
        if (clearInputBtnEl) {
          clearInputBtnEl.style.display = inputEl.value ? 'flex' : 'none';
        }
      });

      clearInputBtnEl?.addEventListener('click', () => {
        if (inputEl) {
          inputEl.value = '';
          inputEl.focus();
        }
        if (clearInputBtnEl) clearInputBtnEl.style.display = 'none';
      });

      // 4. 历史记录面板切换
      modalEl?.querySelector('#jdToggleHistoryBtn')?.addEventListener('click', () => {
        this.toggleHistory(!isHistoryOpen);
      });

      modalEl?.querySelector('#jdCloseDrawerBtn')?.addEventListener('click', () => {
        this.toggleHistory(false);
      });

      modalEl?.querySelector('#jdClearAllHistoryBtn')?.addEventListener('click', () => {
        this.clearAllHistory();
      });
    },

    open(word = '') {
      this.init();
      modalEl?.classList.add('open');
      backdropEl?.classList.add('open');
      this.updateHistoryBadge();
      this.renderQuickChips();

      if (word && word.trim()) {
        if (inputEl) inputEl.value = word.trim();
        if (clearInputBtnEl) clearInputBtnEl.style.display = 'flex';
        this.search(word.trim(), currentMode);
      } else {
        setTimeout(() => inputEl?.focus(), 80);
      }
    },

    close() {
      modalEl?.classList.remove('open');
      backdropEl?.classList.remove('open');
      this.toggleHistory(false);
      if ('speechSynthesis' in window) {
        try { window.speechSynthesis.cancel(); } catch (_) {}
      }
    },

    // 核心查词方法
    async search(word, mode = 'auto') {
      const q = (word || '').trim();
      if (!q) {
        this.showToast('请输入要查询的词条', 'warn');
        inputEl?.focus();
        return;
      }

      if (inputEl && inputEl.value !== q) {
        inputEl.value = q;
      }
      if (clearInputBtnEl) clearInputBtnEl.style.display = 'flex';

      // 显示加载中状态
      this.setLoading(true);
      if (isHistoryOpen) {
        this.toggleHistory(false);
      }

      resultAreaEl.innerHTML = `
        <div class="jd-loading-card">
          <div class="jd-loading-spinner"></div>
          <div class="jd-loading-text">正在查询 dict.asia 词库...</div>
          <div class="jd-loading-sub">检索关键词: 「${this.escapeHtml(q)}」</div>
        </div>
      `;

      try {
        const resp = await fetch(`/api/dict/search?word=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}`);
        const data = await resp.json();

        this.setLoading(false);

        if (!data || !data.ok) {
          this.renderErrorHtml(q, data?.message || '网络连接或词典解析异常');
          return;
        }

        if (!data.found || !data.entries || data.entries.length === 0) {
          this.renderNotFoundHtml(q, data.actual_mode || mode);
          return;
        }

        // 成功获取结果，保存到查询历史
        const firstEntry = data.entries[0];
        this.saveHistoryItem({
          word: q,
          displayWord: firstEntry.word || q,
          kana: firstEntry.kana || '',
          mode: data.actual_mode || mode,
          time: Date.now()
        });

        // 渲染词条结果
        this.renderResultsHtml(data);

      } catch (err) {
        this.setLoading(false);
        this.renderErrorHtml(q, `请求超时或连接服务失败 (${err.message})`);
      }
    },

    setLoading(loading) {
      if (!searchBtnEl) return;
      const txt = searchBtnEl.querySelector('.jd-search-btn-txt');
      const spinner = searchBtnEl.querySelector('.jd-search-btn-spinner');
      if (loading) {
        searchBtnEl.disabled = true;
        if (txt) txt.style.display = 'none';
        if (spinner) spinner.style.display = 'inline-block';
      } else {
        searchBtnEl.disabled = false;
        if (txt) txt.style.display = 'inline-block';
        if (spinner) spinner.style.display = 'none';
      }
    },

    // 渲染词典查询成功结果
    renderResultsHtml(data) {
      const { query, entries, related, source_url, actual_mode } = data;
      const modeDesc = actual_mode === 'cj' ? '中日' : '日中';

      let html = `
        <div class="jd-results-container">
          <!-- 检索状态条 -->
          <div class="jd-results-meta">
            <span class="jd-meta-left">
              <span>检索词: <strong class="jd-meta-query">${this.escapeHtml(query)}</strong></span>
              <span class="jd-meta-mode-tag">${modeDesc}</span>
              <span class="jd-meta-count">共 ${entries.length} 个释义词条</span>
            </span>
            <div class="jd-meta-right">
              <a href="https://www.mojidict.com/search?keyword=${encodeURIComponent(query)}" target="_blank" rel="noopener noreferrer" class="jd-meta-link" title="在 MOJi 辞书查看更多权威解析">
                <span>MOJi 辞书 ↗</span>
              </a>
              <a href="https://www.weblio.jp/content/${encodeURIComponent(query)}" target="_blank" rel="noopener noreferrer" class="jd-meta-link" title="在 Weblio 查看词条">
                <span>Weblio ↗</span>
              </a>
            </div>
          </div>
      `;

      // 遍历渲染词条卡片
      entries.forEach((item, idx) => {
        const cleanWord = this.cleanTag(item.word || query);
        const cleanKana = this.cleanTag(item.kana);
        const cleanRoma = this.cleanTag(item.romaji);
        const cleanTone = this.cleanTag(item.tone);
        const cleanType = this.cleanTag(item.type);
        const kanaHtml = cleanKana ? `<span class="jd-kana" title="假名读音">【${this.escapeHtml(cleanKana)}】</span>` : '';
        const romajiHtml = cleanRoma ? `<span class="jd-romaji" title="罗马音">【${this.escapeHtml(cleanRoma)}】</span>` : '';
        const toneHtml = cleanTone ? `<span class="jd-tone" title="声调音调">音调: ${this.escapeHtml(cleanTone)}</span>` : '';
        const typeHtml = cleanType ? `<span class="jd-wordtype">${this.escapeHtml(cleanType)}</span>` : '';

        // 详细释义
        let defsHtml = '';
        if (item.definitions && item.definitions.length > 0) {
          defsHtml = `
            <div class="jd-def-group">
              <div class="jd-sec-title">详细释义</div>
              <ol class="jd-def-list">
                ${item.definitions.map(d => `<li class="jd-def-item">${this.escapeHtml(this.cleanTag(d, false))}</li>`).join('')}
              </ol>
            </div>
          `;
        }

        // 参考例句
        let examplesHtml = '';
        if (item.examples && item.examples.length > 0) {
          examplesHtml = `
            <div class="jd-ex-group">
              <div class="jd-sec-title">参考例句</div>
              <ul class="jd-ex-list">
                ${item.examples.map(ex => {
                  const parts = ex.split('／');
                  const ja = this.cleanTag(parts[0] || ex, false);
                  const zh = this.cleanTag(parts[1] || '', false);
                  return `
                    <li class="jd-ex-item">
                      <div class="jd-ex-ja">${this.escapeHtml(ja)}</div>
                      ${zh ? `<div class="jd-ex-zh">${this.escapeHtml(zh)}</div>` : ''}
                    </li>
                  `;
                }).join('')}
              </ul>
            </div>
          `;
        }

        html += `
          <div class="jd-card" data-index="${idx}">
            <!-- 词头栏 -->
            <div class="jd-card-head">
              <div class="jd-head-main">
                <div class="jd-headword-wrap">
                  <span class="jd-headword">${this.escapeHtml(cleanWord)}</span>
                  ${kanaHtml}
                  ${romajiHtml}
                  ${toneHtml}
                  ${typeHtml}
                </div>
              </div>
              <div class="jd-card-actions">
                <button type="button" class="jd-action-btn jd-btn-speak" data-word="${this.escapeHtml(cleanKana || cleanWord || query)}" title="播放日文发音">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                  </svg>
                  <span>发音</span>
                </button>
                <button type="button" class="jd-action-btn jd-btn-copy" data-index="${idx}" title="复制该词条释义文本">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                  <span>复制</span>
                </button>
              </div>
            </div>

            <!-- 词条内容 -->
            <div class="jd-card-body">
              ${defsHtml}
              ${examplesHtml}
            </div>
          </div>
        `;
      });

      // 相关词汇模块
      if (related && related.length > 0) {
        html += `
          <div class="jd-related-card">
            <div class="jd-sec-title">相关衍生词汇</div>
            <div class="jd-related-chips">
              ${related.map(w => `<button type="button" class="jd-rel-chip" data-word="${this.escapeHtml(w)}">${this.escapeHtml(w)}</button>`).join('')}
            </div>
          </div>
        `;
      }

      html += `</div>`;
      resultAreaEl.innerHTML = html;

      // 绑定词条卡片内部事件 (发音、复制、相关词点击)
      this.bindResultCardEvents(entries);
    },

    bindResultCardEvents(entries) {
      if (!resultAreaEl) return;

      // 发音按钮 (纯本地原生 TTS，即点即读，零死链延迟)
      resultAreaEl.querySelectorAll('.jd-btn-speak').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const word = btn.dataset.word;
          this.playPronunciation(word, btn);
        });
      });

      // 复制按钮
      resultAreaEl.querySelectorAll('.jd-btn-copy').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.index, 10);
          const entry = entries[idx];
          if (entry) {
            this.copyEntryToClipboard(entry);
          }
        });
      });

      // 相关词芯片点击
      resultAreaEl.querySelectorAll('.jd-rel-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const w = btn.dataset.word;
          if (w) this.search(w, 'auto');
        });
      });
    },

    // 播放日文发音 (Web Speech API)
    playPronunciation(word, buttonEl) {
      if (buttonEl) buttonEl.classList.add('playing');

      const cleanup = () => {
        if (buttonEl) buttonEl.classList.remove('playing');
      };

      this.speakNative(word, cleanup);
    },

    speakNative(text, onEnd) {
      if (!('speechSynthesis' in window)) {
        this.showToast('当前浏览器不支持语音发音', 'info');
        if (onEnd) onEnd();
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'ja-JP';
        utter.rate = 0.92;

        // 优先匹配高质量/自然日文语音
        const voices = window.speechSynthesis.getVoices();
        const jaVoices = voices.filter(v => v.lang === 'ja-JP' || v.lang.startsWith('ja'));
        if (jaVoices.length > 0) {
          const natural = jaVoices.find(v => /natural|online|premium|nanami|keita|ayumi|haruka/i.test(v.name));
          utter.voice = natural || jaVoices[0];
        }

        utter.onend = onEnd;
        utter.onerror = onEnd;
        window.speechSynthesis.speak(utter);
      } catch (err) {
        if (onEnd) onEnd();
      }
    },

    // 复制词条内容到剪贴板
    copyEntryToClipboard(entry) {
      const lines = [];
      const kanaStr = entry.kana ? `（${entry.kana}）` : '';
      const romajiStr = entry.romaji ? ` [${entry.romaji}]` : '';
      const toneStr = entry.tone ? ` 音调:${entry.tone}` : '';
      const typeStr = entry.type ? ` ${entry.type}` : '';
      lines.push(`【${entry.word}${kanaStr}】${romajiStr}${toneStr}${typeStr}`);

      if (entry.definitions && entry.definitions.length > 0) {
        entry.definitions.forEach((d, i) => lines.push(`${i + 1}. ${d}`));
      }

      if (entry.examples && entry.examples.length > 0) {
        lines.push('例句：');
        entry.examples.forEach(ex => lines.push(`· ${ex}`));
      }

      const text = lines.join('\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          this.showToast('已复制词条释义', 'ok');
        }).catch(() => {
          this.fallbackCopy(text);
        });
      } else {
        this.fallbackCopy(text);
      }
    },

    fallbackCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        this.showToast('已复制词条释义', 'ok');
      } catch (_) {
        this.showToast('复制失败，请手动选取', 'err');
      }
      document.body.removeChild(ta);
    },

    // 未找到词条视图
    renderNotFoundHtml(query, currentActualMode) {
      const altMode = currentActualMode === 'jc' ? 'cj' : 'jc';
      const altDesc = altMode === 'cj' ? '中日 (中文查日文)' : '日中 (日文查中文)';

      resultAreaEl.innerHTML = `
        <div class="jd-notfound-card">
          <div class="jd-notfound-icon">
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              <line x1="8" y1="11" x2="14" y2="11"></line>
            </svg>
          </div>
          <div class="jd-notfound-title">未找到关于「${this.escapeHtml(query)}」的词条</div>
          <div class="jd-notfound-desc">dict.asia 词库中暂无该词条的确切解释。您可以尝试：</div>
          <div class="jd-notfound-actions">
            <button type="button" class="jd-btn-primary jd-retry-alt-btn" data-word="${this.escapeHtml(query)}" data-mode="${altMode}">
              切换至「${altDesc}」重试
            </button>
            <a href="https://www.mojidict.com/search?keyword=${encodeURIComponent(query)}" target="_blank" rel="noopener noreferrer" class="jd-btn-secondary" title="前往 MOJi 辞书进行扩展检索">
              在 MOJi 辞书搜索 ↗
            </a>
            <a href="https://www.weblio.jp/content/${encodeURIComponent(query)}" target="_blank" rel="noopener noreferrer" class="jd-btn-secondary" title="前往 Weblio 进行权威检索">
              在 Weblio 搜索 ↗
            </a>
          </div>
        </div>
      `;

      resultAreaEl.querySelector('.jd-retry-alt-btn')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const w = btn.dataset.word;
        const m = btn.dataset.mode;
        // 同步更新顶部模式分段按钮
        modalEl?.querySelectorAll('.jd-mode-tab').forEach(t => {
          t.classList.toggle('active', t.dataset.mode === m);
        });
        currentMode = m;
        this.search(w, m);
      });
    },

    // 错误视图
    renderErrorHtml(query, errorMsg) {
      resultAreaEl.innerHTML = `
        <div class="jd-error-card">
          <div class="jd-error-icon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
          </div>
          <div class="jd-error-title">查询遇到问题</div>
          <div class="jd-error-desc">${this.escapeHtml(errorMsg)}</div>
          <div class="jd-error-actions">
            <button type="button" class="jd-btn-primary jd-retry-btn">重新查询</button>
            <a href="https://www.mojidict.com/search?keyword=${encodeURIComponent(query)}" target="_blank" rel="noopener noreferrer" class="jd-btn-secondary">
              在 MOJi 辞书搜索 ↗
            </a>
          </div>
        </div>
      `;

      resultAreaEl.querySelector('.jd-retry-btn')?.addEventListener('click', () => {
        this.search(query, currentMode);
      });
    },

    // 初始指引视图
    renderInitialGuideHtml() {
      const history = this.getHistory();
      let recentHtml = '';
      if (history.length > 0) {
        recentHtml = `
          <div class="jd-guide-history">
            <div class="jd-sec-title">最近查询记录</div>
            <div class="jd-guide-chips">
              ${history.slice(0, 10).map(item => {
                const w = this.cleanTag(item.word, true);
                const k = this.cleanTag(item.kana, true);
                const showKana = k && k.toLowerCase() !== w.toLowerCase();
                return `
                  <button type="button" class="jd-guide-chip" data-word="${this.escapeHtml(w)}" data-mode="${item.mode || 'auto'}">
                    <span class="jd-chip-word">${this.escapeHtml(w)}</span>
                    ${showKana ? `<span class="jd-chip-kana">${this.escapeHtml(k)}</span>` : ''}
                  </button>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }

      return `
        <div class="jd-guide-card">
          <div class="jd-guide-badge">DICT.ASIA JAPANESE DICTIONARY</div>
          <h2 class="jd-guide-title">日文歌词翻译与词汇工作台</h2>
          <p class="jd-guide-desc">使用 dict.asia 词库，提供假名标音、罗马注音、词性、释义及例句，帮助日文歌曲翻译核对。</p>
          
          <div class="jd-guide-features">
            <div class="jd-feat-item">
              <span class="jd-feat-bullet">1</span>
              <div>
                <div class="jd-feat-title">日汉 / 汉日双向互译</div>
                <div class="jd-feat-sub">智能识别日文假名与汉字，自动选择最匹配的查词词典方向。</div>
              </div>
            </div>
            <div class="jd-feat-item">
              <span class="jd-feat-bullet">2</span>
              <div>
                <div class="jd-feat-title">假名·罗马音·音调全标注</div>
                <div class="jd-feat-sub">标明准确的平假名读法、声调标记与纯正语音朗读。</div>
              </div>
            </div>
            <div class="jd-feat-item">
              <span class="jd-feat-bullet">3</span>
              <div>
                <div class="jd-feat-title">本地历史查询随身记录</div>
                <div class="jd-feat-sub">自动留存查词历史，支持快速回溯、一键复查与批量管理。</div>
              </div>
            </div>
          </div>

          ${recentHtml}

          <div class="jd-guide-rec">
            <div class="jd-sec-title">推荐常用歌词词汇：</div>
            <div class="jd-guide-chips">
              <button type="button" class="jd-guide-chip sample" data-word="桜">桜 (樱花)</button>
              <button type="button" class="jd-guide-chip sample" data-word="走る">走る (奔跑)</button>
              <button type="button" class="jd-guide-chip sample" data-word="愛">愛 (爱)</button>
              <button type="button" class="jd-guide-chip sample" data-word="友達">友達 (朋友)</button>
              <button type="button" class="jd-guide-chip sample" data-word="切ない">切ない (难过感伤)</button>
              <button type="button" class="jd-guide-chip sample" data-word="木漏れ日">木漏れ日 (树影光斑)</button>
              <button type="button" class="jd-guide-chip sample" data-word="絆">絆 (羁绊)</button>
              <button type="button" class="jd-guide-chip sample" data-word="運命">運命 (命运)</button>
            </div>
          </div>
        </div>
      `;
    },

    // 渲染搜索栏下方的快捷标签
    renderQuickChips() {
      if (!quickChipsEl) return;
      const history = this.getHistory();
      let chips = [];

      if (history.length > 0) {
        chips = history.slice(0, 8).map(h => {
          const w = this.cleanTag(h.word, true);
          const k = this.cleanTag(h.kana, true);
          const hasKana = k && k.toLowerCase() !== w.toLowerCase();
          return {
            word: w,
            label: hasKana ? `${w} (${k})` : w,
            mode: h.mode || 'auto'
          };
        });
      } else {
        chips = [
          { word: '桜', label: '桜', mode: 'auto' },
          { word: '走る', label: '走る', mode: 'auto' },
          { word: '愛', label: '愛', mode: 'auto' },
          { word: '友達', label: '友達', mode: 'auto' },
          { word: '切ない', label: '切ない', mode: 'auto' }
        ];
      }

      quickChipsEl.innerHTML = chips.map(c => `
        <button type="button" class="jd-quick-chip" data-word="${this.escapeHtml(c.word)}" data-mode="${c.mode}">
          ${this.escapeHtml(c.label)}
        </button>
      `).join('');

      quickChipsEl.querySelectorAll('.jd-quick-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const w = btn.dataset.word;
          const m = btn.dataset.mode || 'auto';
          this.search(w, m);
        });
      });

      // 绑定初始引导页中的芯片点击
      resultAreaEl?.querySelectorAll('.jd-guide-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const w = btn.dataset.word;
          const m = btn.dataset.mode || 'auto';
          this.search(w, m);
        });
      });
    },

    // ========================================================================
    // 历史查询管理
    // ========================================================================

    getHistory() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];

        let hasDirty = false;
        const cleaned = arr.map(item => {
          if (!item || typeof item !== 'object') return null;
          const origWord = String(item.word || '');
          const origKana = String(item.kana || '');
          const origDisplay = String(item.displayWord || '');
          const cleanWord = this.cleanTag(origWord, true);
          const cleanKana = this.cleanTag(origKana, true);
          const cleanDisplay = this.cleanTag(origDisplay, true);

          if (origWord !== cleanWord || origKana !== cleanKana || origDisplay !== cleanDisplay) {
            hasDirty = true;
          }

          return {
            ...item,
            word: cleanWord,
            displayWord: cleanDisplay || cleanWord,
            kana: cleanKana
          };
        }).filter(item => item && item.word);

        // 如果包含旧版残留的 dirty HTML (如 <font color=red>)，自动洗净覆写本地缓存
        if (hasDirty) {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
          } catch (_) {}
        }
        return cleaned;
      } catch (_) {
        return [];
      }
    },

    saveHistoryItem(item) {
      if (!item || !item.word) return;
      const cleanWord = this.cleanTag(item.word, true);
      if (!cleanWord) return;

      const cleanItem = {
        ...item,
        word: cleanWord,
        displayWord: this.cleanTag(item.displayWord, true) || cleanWord,
        kana: this.cleanTag(item.kana, true)
      };

      const list = this.getHistory();
      // 过滤重复项 (保持最新一次在最前)
      const filtered = list.filter(x => x.word.toLowerCase() !== cleanWord.toLowerCase());
      filtered.unshift(cleanItem);
      const capped = filtered.slice(0, MAX_HISTORY);

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
      } catch (_) {}

      this.updateHistoryBadge();
      this.renderQuickChips();
      if (isHistoryOpen) {
        this.renderHistoryList();
      }
    },

    deleteHistoryItem(word) {
      const target = this.cleanTag(word, true).toLowerCase();
      const list = this.getHistory();
      const updated = list.filter(x => this.cleanTag(x.word, true).toLowerCase() !== target);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch (_) {}

      this.updateHistoryBadge();
      this.renderQuickChips();
      this.renderHistoryList();
      this.showToast('已删除该历史记录', 'info');
    },

    clearAllHistory() {
      const list = this.getHistory();
      if (list.length === 0) return;
      if (!confirm('确认清空全部历史查询记录吗？')) return;

      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (_) {}

      this.updateHistoryBadge();
      this.renderQuickChips();
      this.renderHistoryList();
      this.showToast('已清空全部查询历史', 'ok');
    },

    updateHistoryBadge() {
      if (!historyBadgeEl) return;
      const count = this.getHistory().length;
      historyBadgeEl.textContent = count;
      historyBadgeEl.style.display = count > 0 ? 'inline-flex' : 'none';
    },

    toggleHistory(show) {
      isHistoryOpen = !!show;
      if (!historyDrawerEl) return;

      if (isHistoryOpen) {
        historyDrawerEl.style.display = 'flex';
        this.renderHistoryList();
      } else {
        historyDrawerEl.style.display = 'none';
      }
    },

    renderHistoryList() {
      const container = modalEl?.querySelector('#jdHistoryList');
      if (!container) return;

      const history = this.getHistory();
      if (history.length === 0) {
        container.innerHTML = `
          <div class="jd-drawer-empty">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            <div class="jd-empty-title">暂无查询历史</div>
            <div class="jd-empty-sub">在此查询日文或中文词汇后，记录将自动留存于此方便回看</div>
          </div>
        `;
        return;
      }

      container.innerHTML = history.map(item => {
        const timeStr = this.formatTimeAgo(item.time);
        const modeTag = item.mode === 'cj' ? '中日' : (item.mode === 'jc' ? '日中' : '自动');
        const cleanWord = this.cleanTag(item.word, true);
        const cleanKana = this.cleanTag(item.kana, true);
        const showKana = cleanKana && cleanKana.toLowerCase() !== cleanWord.toLowerCase();
        return `
          <div class="jd-hist-card" data-word="${this.escapeHtml(cleanWord)}" data-mode="${item.mode || 'auto'}">
            <div class="jd-hist-left">
              <div class="jd-hist-word-row">
                <span class="jd-hist-word">${this.escapeHtml(cleanWord)}</span>
                ${showKana ? `<span class="jd-hist-kana">【${this.escapeHtml(cleanKana)}】</span>` : ''}
                <span class="jd-hist-mode">${modeTag}</span>
              </div>
              <div class="jd-hist-time">${timeStr}</div>
            </div>
            <button type="button" class="jd-hist-del-btn" data-del-word="${this.escapeHtml(cleanWord)}" title="删除此记录">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        `;
      }).join('');

      // 绑定历史行点击事件
      container.querySelectorAll('.jd-hist-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.jd-hist-del-btn')) return;
          const w = card.dataset.word;
          const m = card.dataset.mode || 'auto';
          this.search(w, m);
        });
      });

      // 绑定删除按钮
      container.querySelectorAll('.jd-hist-del-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const w = btn.dataset.delWord;
          if (w) this.deleteHistoryItem(w);
        });
      });
    },

    formatTimeAgo(ts) {
      if (!ts) return '';
      const now = Date.now();
      const diffSec = Math.floor((now - ts) / 1000);
      if (diffSec < 60) return '刚刚';
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin} 分钟前`;
      const diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24) return `${diffHour} 小时前`;
      const d = new Date(ts);
      return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },

    showToast(msg, type = 'info') {
      if (!toastEl) return;
      if (toastTimer) clearTimeout(toastTimer);

      toastEl.textContent = msg;
      toastEl.className = `jd-toast show ${type}`;
      toastEl.style.display = 'block';

      toastTimer = setTimeout(() => {
        toastEl.className = 'jd-toast';
        setTimeout(() => { toastEl.style.display = 'none'; }, 200);
      }, 2600);
    },

    cleanHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .trim();
    },

    cleanTag(str, stripOuterBrackets = true) {
      if (!str) return '';
      let clean = this.cleanHtml(str);
      if (stripOuterBrackets) {
        clean = clean.replace(/^[【\s\t　]+|[】\s\t　]+$/g, '').trim();
      }
      return clean;
    },

    escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  };

  window.JpDict = JpDict;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => JpDict.init());
  } else {
    JpDict.init();
  }
})(window);
