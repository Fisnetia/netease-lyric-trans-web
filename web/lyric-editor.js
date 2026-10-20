// ============================================================================
// web/lyric-editor.js - 歌词与时间轴编辑工作台 (时间轴偏移 · 格式转换 · 精度规整 · 一键去轴 · 简繁转换)
// ============================================================================
(function(window) {
  'use strict';

  let modalEl = null;
  let backdropEl = null;
  let editorEl = null;
  let offsetInputEl = null;
  let statsEl = null;
  let toastEl = null;
  let toastTimer = null;
  const historyStack = [];
  const MAX_HISTORY = 40;

  // 简繁转换字符对照表存放在 web/chinese-conv.js

  const LyricEditor = {
    init() {
      if (modalEl) return;

      // 1. 创建背景蒙层
      backdropEl = document.createElement('div');
      backdropEl.className = 'le-backdrop';
      backdropEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(backdropEl);

      // 2. 创建主悬浮模态弹窗
      modalEl = document.createElement('div');
      modalEl.className = 'le-modal';
      modalEl.setAttribute('role', 'dialog');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.setAttribute('aria-labelledby', 'leTitle');
      modalEl.innerHTML = this.renderTemplate();
      document.body.appendChild(modalEl);

      editorEl = modalEl.querySelector('#leEditorText');
      offsetInputEl = modalEl.querySelector('#leOffsetVal');
      statsEl = modalEl.querySelector('#leStats');
      toastEl = modalEl.querySelector('#leToast');

      this.bindEvents();

      // 3. 注册侧边栏工具箱入口
      if (window.Sidebar) {
        window.Sidebar.register({
          id: 'lyric-editor',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>`,
          label: '歌词编辑',
          title: '歌词时间轴与文本编辑工具',
          order: 15,
          onClick: () => this.open()
        });
      }
    },

    renderTemplate() {
      return `
        <!-- 弹窗顶部栏 -->
        <div class="le-header">
          <div class="le-title-group">
            <span class="le-header-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            </span>
            <div>
              <div class="le-title" id="leTitle">歌词编辑</div>
              <div class="le-subtitle">哇这里有超多功能的说</div>
            </div>
          </div>
          <div class="le-header-actions">
            <button type="button" class="le-close-btn" id="leCloseBtn" title="关闭窗口 (ESC)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        <!-- 功能工具栏 -->
        <div class="le-toolbar">
          <!-- 模块 1: 时间轴整体偏移 -->
          <div class="le-tool-card le-offset-card">
            <div class="le-card-header">
              <span class="le-group-badge">时间轴偏移</span>
              <span class="le-card-hint">正数推迟 · 负数提前</span>
            </div>
            <div class="le-card-content">
              <div class="le-input-group">
                <input type="number" id="leOffsetVal" class="le-num-input" value="500" step="100" placeholder="0" title="偏移量 (毫秒)" />
                <span class="le-input-suffix">ms</span>
                <button type="button" class="primary le-btn-apply" id="leApplyOffsetBtn">应用偏移</button>
              </div>
              <div class="le-steppers-wrap">
                <button type="button" class="le-step-pill neg" data-step="-1000">-1s</button>
                <button type="button" class="le-step-pill neg" data-step="-500">-500ms</button>
                <button type="button" class="le-step-pill neg" data-step="-100">-100ms</button>
                <span class="le-stepper-sep"></span>
                <button type="button" class="le-step-pill pos" data-step="100">+100ms</button>
                <button type="button" class="le-step-pill pos" data-step="500">+500ms</button>
                <button type="button" class="le-step-pill pos" data-step="1000">+1s</button>
              </div>
            </div>
          </div>

          <!-- 模块 2: 格式转换与精度规整 -->
          <div class="le-tool-card">
            <div class="le-card-header">
              <span class="le-group-badge">格式与精度</span>
              <span class="le-card-hint">LRC 格式规整化</span>
            </div>
            <div class="le-card-content">
              <button type="button" class="le-action-btn le-btn-wide" id="leSwapFormatBtn" title="在冒号格式 [01:23:45] 与点号格式 [01:23.45] 之间一键互换">格式互换 (x:x:x ⇄ x:x.x)</button>
              <div class="le-btn-pair">
                <button type="button" class="le-action-btn" id="leNorm2Btn" title="统一规范为网易云标准两位小数 [mm:ss.xx]">规整为标准两位</button>
                <button type="button" class="le-action-btn" id="leNorm3Btn" title="统一转换为三位毫秒格式 [mm:ss.xxx]">规整为三位</button>
              </div>
            </div>
          </div>

          <!-- 模块 3: 文本清洗与简繁转换 -->
          <div class="le-tool-card">
            <div class="le-card-header">
              <span class="le-group-badge">文本处理</span>
              <span class="le-card-hint">去轴、空行与简繁</span>
            </div>
            <div class="le-card-content">
              <div class="le-btn-pair">
                <button type="button" class="le-action-btn" id="leStripBtn" title="剥离所有时间轴，仅保留纯文本歌词">一键去轴</button>
                <button type="button" class="le-action-btn" id="leRemoveBlankLinesBtn" title="清除所有无内容的空白行">去除空行</button>
              </div>
              <div class="le-btn-pair">
                <button type="button" class="le-action-btn" id="leT2SBtn" title="繁体中文转换为规范简体中文">繁体转简体</button>
                <button type="button" class="le-action-btn" id="leS2TBtn" title="简体中文转换为繁体中文">简体转繁体</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 中部主体文本编辑区 -->
        <div class="le-body">
          <div class="le-editor-wrap">
            <textarea id="leEditorText" class="le-textarea" spellcheck="false" placeholder="在此粘贴 LRC 歌词或纯文本，或直接将文件拖拽至此处...&#10;&#10;可用功能：&#10;1. 整体调整时间轴偏移 (毫秒加减)&#10;2. 格式互换：在 [01:23:45] 冒号格式与 [01:23.45] 点号格式间自由互转&#10;3. 精度规整为标准两位小数或三位小数&#10;4. 一键去轴，仅保留纯文本歌词&#10;5. 一键去除多余空白行&#10;6. 简繁体汉字互转"></textarea>
          </div>
        </div>

        <!-- 底部状态栏与主操作按钮 -->
        <div class="le-footer">
          <div class="le-footer-left">
            <div id="leStats" class="le-stats-pill">0 行 · 0 处时间轴 · 0 字符</div>
            <div id="leToast" class="le-inline-toast"></div>
          </div>
            <button type="button" class="le-footer-btn" id="leUndoBtn" disabled title="撤销上一步编辑">撤销</button>
            <button type="button" class="le-footer-btn" id="leClearBtn">清空</button>
            <button type="button" class="le-footer-btn" id="leSaveWorkspaceBtn" title="保存至浏览器工作区沙箱">📁 存入工作区</button>
            <button type="button" class="le-footer-btn" id="leExportBtn">下载文件</button>
            <button type="button" class="primary le-footer-btn le-btn-copy" id="leCopyBtn">复制全文</button>
          </div>
        </div>
      `;
    },

    bindEvents() {
      // 关闭弹窗
      modalEl.querySelector('#leCloseBtn')?.addEventListener('click', () => this.close());
      backdropEl?.addEventListener('click', () => this.close());

      // ESC 键监听
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalEl?.classList.contains('open')) {
          this.close();
        }
      });

      // 文本变动实时同步统计
      editorEl?.addEventListener('input', () => {
        this.updateStats();
      });

      // 拖拽文件进入编辑区
      const editorWrap = modalEl.querySelector('.le-editor-wrap');
      if (editorWrap) {
        ['dragenter', 'dragover'].forEach(name => {
          editorWrap.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            editorWrap.classList.add('dragover');
          });
        });
        ['dragleave', 'drop'].forEach(name => {
          editorWrap.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            editorWrap.classList.remove('dragover');
          });
        });
        editorWrap.addEventListener('drop', (e) => {
          const files = e.dataTransfer?.files;
          if (files && files[0]) {
            this.loadFile(files[0]);
          }
        });
      }

      // 功能 1：调整整体 offset
      modalEl.querySelector('#leApplyOffsetBtn')?.addEventListener('click', () => {
        const delta = parseInt(offsetInputEl?.value, 10);
        if (isNaN(delta) || delta === 0) {
          this.showToast('请输入有效的偏移毫秒数值', 'warn');
          return;
        }
        this.adjustOffset(delta);
      });

      // 快捷步进按钮
      modalEl.querySelectorAll('.le-step-pill, .le-step-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const delta = parseInt(btn.dataset.step, 10);
          if (!isNaN(delta)) {
            if (offsetInputEl) offsetInputEl.value = delta;
            this.adjustOffset(delta);
          }
        });
      });

      // 功能 2：时间轴格式互换 (x:x:x ⇄ x:x.x)
      modalEl.querySelector('#leSwapFormatBtn')?.addEventListener('click', () => {
        this.toggleTimestampFormat();
      });

      // 功能 3：精度规整
      modalEl.querySelector('#leNorm2Btn')?.addEventListener('click', () => {
        this.normalizePrecision(2);
      });
      modalEl.querySelector('#leNorm3Btn')?.addEventListener('click', () => {
        this.normalizePrecision(3);
      });

      // 功能 4：一键去轴
      modalEl.querySelector('#leStripBtn')?.addEventListener('click', () => {
        this.stripTimestamps();
      });

      // 功能 5：去除空行
      modalEl.querySelector('#leRemoveBlankLinesBtn')?.addEventListener('click', () => {
        this.removeBlankLines();
      });

      // 功能 6：简繁转换
      modalEl.querySelector('#leT2SBtn')?.addEventListener('click', () => {
        this.convertTradSimp(true);
      });
      modalEl.querySelector('#leS2TBtn')?.addEventListener('click', () => {
        this.convertTradSimp(false);
      });

      // 撤销、清空、存入工作区、复制、下载
      modalEl.querySelector('#leUndoBtn')?.addEventListener('click', () => this.undo());
      modalEl.querySelector('#leClearBtn')?.addEventListener('click', () => this.clear());
      modalEl.querySelector('#leSaveWorkspaceBtn')?.addEventListener('click', () => this.saveToWorkspace());
      modalEl.querySelector('#leCopyBtn')?.addEventListener('click', () => this.copy());
      modalEl.querySelector('#leExportBtn')?.addEventListener('click', () => this.export());
    },

    open(payload = '') {
      this.init();
      if (!modalEl || !backdropEl) return;
      let text = '';
      if (typeof payload === 'string') {
        text = payload;
      } else if (payload && typeof payload === 'object') {
        if (payload.content) {
          text = payload.content;
        } else if (payload.originalLrc && payload.transLrc) {
          text = (typeof window.mergeBilingualLyrics === 'function')
            ? window.mergeBilingualLyrics(payload.originalLrc, payload.transLrc)
            : (payload.transLrc || payload.originalLrc);
        } else if (payload.transLrc) {
          text = payload.transLrc;
        } else if (payload.originalLrc) {
          text = payload.originalLrc;
        }
        if (payload.songTitle) {
          this._currentTitle = payload.songTitle;
        }
        if (payload.songId) {
          this._currentSongId = payload.songId;
        }
      }
      if (text && editorEl) {
        editorEl.value = text;
      }
      backdropEl.classList.add('open');
      modalEl.classList.add('open');
      document.body.style.overflow = 'hidden';
      this.updateStats();
      if (editorEl) editorEl.focus();
    },

    close() {
      if (!modalEl || !backdropEl) return;
      backdropEl.classList.remove('open');
      modalEl.classList.remove('open');
      document.body.style.overflow = '';
      if (window.Sidebar) window.Sidebar.setActive(null);
    },

    pushHistory() {
      if (!editorEl) return;
      if (historyStack.length >= MAX_HISTORY) {
        historyStack.shift();
      }
      historyStack.push(editorEl.value);
      this.updateUndoState();
    },

    undo() {
      if (!historyStack.length || !editorEl) return;
      const prev = historyStack.pop();
      editorEl.value = prev;
      this.updateUndoState();
      this.updateStats();
      this.showToast('已撤销上一次操作', 'info');
    },

    updateUndoState() {
      const undoBtn = modalEl?.querySelector('#leUndoBtn');
      if (undoBtn) {
        undoBtn.disabled = historyStack.length === 0;
      }
    },

    showToast(msg, type = 'ok') {
      if (!toastEl) return;
      clearTimeout(toastTimer);
      toastEl.textContent = msg;
      toastEl.className = 'le-inline-toast ' + type;
      toastEl.style.opacity = '1';
      toastTimer = setTimeout(() => {
        if (toastEl) toastEl.style.opacity = '0';
      }, 2600);
    },

    updateStats() {
      if (!editorEl || !statsEl) return;
      const val = editorEl.value;
      const lines = val ? val.split('\n').length : 0;
      const matches = val.match(/\[\d{1,2}:\d{1,2}(?:[\.:]\d{1,3})?\]/g);
      const tagCount = matches ? matches.length : 0;
      const charCount = val.replace(/\s/g, '').length;
      statsEl.textContent = `${lines} 行 · ${tagCount} 处时间轴 · ${charCount} 字符`;
    },

    loadFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        this.pushHistory();
        if (editorEl) {
          editorEl.value = e.target?.result || '';
          this.updateStats();
          this.showToast(`已成功载入: ${file.name}`, 'ok');
        }
      };
      reader.readAsText(file, 'utf-8');
    },

    // 1. 调整整体 offset
    adjustOffset(deltaMs) {
      if (!editorEl) return;
      const orig = editorEl.value;
      if (!orig.trim()) {
        this.showToast('编辑器内容为空', 'warn');
        return;
      }

      let count = 0;
      const updated = orig.replace(/\[(\d{1,2}):(\d{1,2})(?:([\.:])(\d{1,3}))?\]/g, (match, mStr, sStr, sep, msStr) => {
        const m = parseInt(mStr, 10);
        const s = parseInt(sStr, 10);
        let ms = 0;
        let precision = 2;
        if (msStr) {
          if (msStr.length === 1) { ms = parseInt(msStr, 10) * 100; precision = 1; }
          else if (msStr.length === 2) { ms = parseInt(msStr, 10) * 10; precision = 2; }
          else if (msStr.length === 3) { ms = parseInt(msStr, 10); precision = 3; }
        }
        const totalMs = m * 60000 + s * 1000 + ms;
        const newTotalMs = Math.max(0, totalMs + deltaMs);
        count++;

        const newM = Math.floor(newTotalMs / 60000);
        const newS = Math.floor((newTotalMs % 60000) / 1000);
        const remMs = newTotalMs % 1000;
        const useSep = sep || '.';

        const mPad = String(newM).padStart(2, '0');
        const sPad = String(newS).padStart(2, '0');

        let msPart = '';
        if (precision === 3) {
          msPart = `${useSep}${String(remMs).padStart(3, '0')}`;
        } else if (precision === 1) {
          msPart = `${useSep}${Math.floor(remMs / 100)}`;
        } else if (msStr || precision === 2) {
          msPart = `${useSep}${String(Math.floor(remMs / 10)).padStart(2, '0')}`;
        }
        return `[${mPad}:${sPad}${msPart}]`;
      });

      if (count === 0) {
        this.showToast('未检测到可调整的时间轴标签', 'warn');
        return;
      }

      this.pushHistory();
      editorEl.value = updated;
      this.updateStats();
      const sign = deltaMs >= 0 ? '+' : '';
      this.showToast(`已调整 ${count} 处时间轴 (偏移 ${sign}${deltaMs}ms)`, 'ok');
    },

    // 2. 格式互换 (x:x:x ⇄ x:x.x)
    toggleTimestampFormat() {
      if (!editorEl) return;
      const orig = editorEl.value;
      if (!orig.trim()) {
        this.showToast('编辑器内容为空', 'warn');
        return;
      }

      // 统计冒号格式 [mm:ss:xx] 和 点号格式 [mm:ss.xx]
      const colonMatches = orig.match(/\[\d{1,2}:\d{1,2}:\d{1,3}\]/g) || [];
      const dotMatches = orig.match(/\[\d{1,2}:\d{1,2}\.\d{1,3}\]/g) || [];

      if (colonMatches.length === 0 && dotMatches.length === 0) {
        this.showToast('未检测到含毫秒/厘秒的时间轴格式', 'warn');
        return;
      }

      // 互换逻辑：若存在冒号格式，优先转为点号 (含混合格式统一)；若当前全为点号，则互换为冒号
      const toDot = colonMatches.length > 0;
      let count = 0;
      let updated = '';

      if (toDot) {
        // 冒号转点号: [mm:ss:xx] -> [mm:ss.xx]
        updated = orig.replace(/\[(\d{1,2}):(\d{1,2}):(\d{1,3})\]/g, (match, mStr, sStr, msStr) => {
          count++;
          const m = String(parseInt(mStr, 10)).padStart(2, '0');
          const s = String(parseInt(sStr, 10)).padStart(2, '0');
          return `[${m}:${s}.${msStr}]`;
        });
        this.pushHistory();
        editorEl.value = updated;
        this.updateStats();
        this.showToast(`已将 ${count} 处冒号时间轴转换为点号格式 [mm:ss.xx]`, 'ok');
      } else {
        // 点号转冒号: [mm:ss.xx] -> [mm:ss:xx]
        updated = orig.replace(/\[(\d{1,2}):(\d{1,2})\.(\d{1,3})\]/g, (match, mStr, sStr, msStr) => {
          count++;
          const m = String(parseInt(mStr, 10)).padStart(2, '0');
          const s = String(parseInt(sStr, 10)).padStart(2, '0');
          return `[${m}:${s}:${msStr}]`;
        });
        this.pushHistory();
        editorEl.value = updated;
        this.updateStats();
        this.showToast(`已将 ${count} 处点号时间轴转换为冒号格式 [mm:ss:xx]`, 'ok');
      }
    },

    // 3. 精度规整 (targetDecimals: 2 or 3)
    normalizePrecision(targetDecimals = 2) {
      if (!editorEl) return;
      const orig = editorEl.value;
      if (!orig.trim()) {
        this.showToast('编辑器内容为空', 'warn');
        return;
      }

      let count = 0;
      const updated = orig.replace(/\[(\d{1,2}):(\d{1,2})(?:([\.:])(\d{1,3}))?\]/g, (match, mStr, sStr, sep, msStr) => {
        count++;
        const m = String(parseInt(mStr, 10)).padStart(2, '0');
        const s = String(parseInt(sStr, 10)).padStart(2, '0');

        let ms = 0;
        if (msStr) {
          if (msStr.length === 1) ms = parseInt(msStr, 10) * 100;
          else if (msStr.length === 2) ms = parseInt(msStr, 10) * 10;
          else if (msStr.length === 3) ms = parseInt(msStr, 10);
        }

        let outMs = '';
        if (targetDecimals === 2) {
          const hundredths = Math.min(99, Math.round(ms / 10));
          outMs = String(hundredths).padStart(2, '0');
        } else {
          outMs = String(ms).padStart(3, '0');
        }

        return `[${m}:${s}.${outMs}]`;
      });

      if (count === 0) {
        this.showToast('未检测到有效时间轴标签', 'warn');
        return;
      }

      this.pushHistory();
      editorEl.value = updated;
      this.updateStats();
      const desc = targetDecimals === 2 ? '标准两位' : '三位';
      this.showToast(`已规整 ${count} 处时间轴精度为 ${desc}`, 'ok');
    },

    // 4. 一键去轴，仅留文本
    stripTimestamps() {
      if (!editorEl) return;
      const orig = editorEl.value;
      if (!orig.trim()) {
        this.showToast('编辑器内容为空', 'warn');
        return;
      }

      let count = 0;
      const lines = orig.split('\n');
      const newLines = lines.map(line => {
        const stripped = line.replace(/\[\d{1,2}:\d{1,2}(?:[\.:]\d{1,3})?\]/g, () => {
          count++;
          return '';
        });
        return stripped.replace(/^\s+/, '');
      });

      if (count === 0) {
        this.showToast('文本中未发现时间轴标签', 'info');
        return;
      }

      this.pushHistory();
      editorEl.value = newLines.join('\n');
      this.updateStats();
      this.showToast(`已剥离 ${count} 处时间轴，仅保留纯文本歌词`, 'ok');
    },

    // 5. 去除多余空行
    removeBlankLines() {
      if (!editorEl) return;
      const orig = editorEl.value;
      if (!orig.trim()) {
        this.showToast('编辑器内容为空', 'warn');
        return;
      }

      const lines = orig.split(/\r?\n/);
      const filtered = lines.filter(line => line.trim().length > 0);
      const removedCount = lines.length - filtered.length;

      if (removedCount === 0) {
        this.showToast('未检测到可清除的空白行', 'info');
        return;
      }

      this.pushHistory();
      editorEl.value = filtered.join('\n');
      this.updateStats();
      this.showToast(`已成功清除 ${removedCount} 行空白行`, 'ok');
    },

    // 6. 简繁转换 (调用独立模块 window.ChineseConv)
    convertTradSimp(toSimp = true) {
      if (!editorEl) return;
      const orig = editorEl.value;
      if (!orig.trim()) {
        this.showToast('编辑器内容为空', 'warn');
        return;
      }

      if (!window.ChineseConv) {
        this.showToast('简繁转换组件尚未就绪，请刷新页面', 'err');
        return;
      }

      const { result, count } = window.ChineseConv.convert(orig, toSimp);

      if (count === 0) {
        const desc = toSimp ? '繁体' : '简体';
        this.showToast(`未检测到需要转换的${desc}汉字`, 'info');
        return;
      }

      this.pushHistory();
      editorEl.value = result;
      this.updateStats();
      const actDesc = toSimp ? '繁体转简体' : '简体转繁体';
      this.showToast(`已完成${actDesc} (共转换 ${count} 字)`, 'ok');
    },

    clear() {
      if (!editorEl) return;
      if (!editorEl.value.trim()) return;
      if (confirm('确认清空编辑器内所有内容吗？')) {
        this.pushHistory();
        editorEl.value = '';
        this.updateStats();
        this.showToast('已清空内容', 'info');
      }
    },

    copy() {
      if (!editorEl) return;
      const val = editorEl.value;
      if (!val.trim()) {
        this.showToast('编辑器无内容可复制', 'warn');
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val).then(() => {
          this.showToast('已将歌词复制到剪贴板', 'ok');
        }).catch(() => {
          this.fallbackCopy(val);
        });
      } else {
        this.fallbackCopy(val);
      }
    },

    fallbackCopy(text) {
      if (!editorEl) return;
      editorEl.select();
      try {
        document.execCommand('copy');
        this.showToast('已将歌词复制到剪贴板', 'ok');
      } catch (_) {
        this.showToast('复制失败，请手动选取复制', 'err');
      }
    },

    saveToWorkspace() {
      if (!editorEl) return;
      const val = editorEl.value;
      if (!val.trim()) {
        this.showToast('编辑器内容为空，无法存入工作区', 'warn');
        return;
      }
      const title = (this._currentTitle || '草稿歌词').trim();
      const isLrc = /\[\d{1,2}:\d{1,2}/.test(val);
      const ext = isLrc ? '.lrc' : '.txt';
      const defaultName = title.endsWith(ext) ? title : `${title}${ext}`;
      const name = prompt('请输入工作区文稿名称：', defaultName);
      if (!name) return;
      if (window.WorkspaceStorage) {
        window.WorkspaceStorage.save({
          name: name,
          content: val,
          songId: this._currentSongId || ''
        });
        this.showToast(`已成功保存《${name}》至本地工作区！`, 'ok');
      } else {
        this.showToast('工作区存储模块未就绪', 'warn');
      }
    },

    export() {
      if (!editorEl) return;
      const val = editorEl.value;
      if (!val.trim()) {
        this.showToast('无内容可导出', 'warn');
        return;
      }
      const isLrc = /\[\d{1,2}:\d{1,2}/.test(val);
      const ext = isLrc ? '.lrc' : '.txt';
      const title = (this._currentTitle || 'lyric_export').replace(/[\\/:*?"<>|]/g, '_');
      const filename = title.endsWith(ext) ? title : `${title}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${ext}`;
      const blob = new Blob([val], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.showToast(`已导出文件: ${filename}`, 'ok');
    }
  };

  window.LyricEditor = LyricEditor;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => LyricEditor.init());
  } else {
    LyricEditor.init();
  }
})(window);
