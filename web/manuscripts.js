// ============================================================================
// web/manuscripts.js - 本地稿件与工作区文档管理
// 基于浏览器本地存储 (LocalStorage)
// ============================================================================
(function(window) {
  'use strict';

  const STORAGE_KEY = 'ncm_workspace_docs_v1';

  // 工作区模式：不预置示范歌词
  const SAMPLE_DOCS = [];

  // 1. 核心工作区本地存储模块
  const WorkspaceStorage = {
    getAll() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        // 自动过滤历史残留的示范歌词
        return arr.filter(d => d.id !== 'sample_trans' && d.id !== 'sample_orig');
      } catch (e) {
        console.warn('读取工作区存储异常：', e);
        return [];
      }
    },

    saveAll(list) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list || []));
        window.dispatchEvent(new CustomEvent('ncm:workspace-change', { detail: { files: list } }));
      } catch (e) {
        console.error('写入工作区存储异常：', e);
      }
    },

    get(idOrName) {
      if (!idOrName) return null;
      const list = this.getAll();
      return list.find(d => d.id === idOrName || d.name === idOrName) || null;
    },

    findByName(name) {
      if (!name) return null;
      const clean = name.trim().toLowerCase();
      const list = this.getAll();
      return list.find(d => d.name.trim().toLowerCase() === clean) || null;
    },

    save(name, content, meta = {}) {
      if (!name) return null;
      const list = this.getAll();
      const trimmedName = name.trim();
      const existingIdx = list.findIndex(d => d.name === trimmedName);
      const isLrc = trimmedName.toLowerCase().endsWith('.lrc');
      const doc = {
        id: existingIdx !== -1 ? list[existingIdx].id : 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: trimmedName,
        type: isLrc ? 'lrc' : 'txt',
        content: content || '',
        size: new Blob([content || '']).size,
        mtime: Date.now(),
        ...meta
      };

      if (existingIdx !== -1) {
        list[existingIdx] = doc;
      } else {
        list.unshift(doc);
      }
      this.saveAll(list);
      return doc;
    },

    remove(id) {
      const list = this.getAll();
      const filtered = list.filter(d => d.id !== id && d.name !== id);
      this.saveAll(filtered);
    },

    clear() {
      this.saveAll([]);
    },

    loadSample() {
      return 0;
    },

    async importFiles(fileList) {
      if (!fileList || !fileList.length) return 0;
      const files = Array.from(fileList);
      let count = 0;
      for (const file of files) {
        const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
        if (ext !== '.lrc' && ext !== '.txt') continue;
        try {
          const text = await this.readFileAsText(file);
          this.save(file.name, text);
          count++;
        } catch (e) {
          console.warn('读取本地文件失败：', file.name, e);
        }
      }
      return count;
    },

    readFileAsText(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result || '');
        reader.onerror = reject;
        reader.readAsText(file, 'utf-8');
      });
    },

    exportFile(idOrDoc) {
      const doc = typeof idOrDoc === 'object' ? idOrDoc : this.get(idOrDoc);
      if (!doc || !doc.content) return;
      const blob = new Blob([doc.content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  // 挂载全局对象
  window.WorkspaceStorage = WorkspaceStorage;
  window.ManuscriptStorage = WorkspaceStorage;

  // 2. 侧边栏稿件管理大窗口 (Manuscripts Modal)
  let modalEl = null;
  let backdropEl = null;
  let currentDir = localStorage.getItem('ncm_ms_dir') || 'workspace';
  let availableDirs = [];
  let fileList = [];
  let currentFile = null;
  let originalContent = '';
  let isEditing = false;
  let browseCurrentPath = '';

  const esc = str => (str || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);

  const formatBytes = b => {
    if (!b || b <= 0) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const Manuscripts = {
    init() {
      if (modalEl) return;

      // 1. 创建背景蒙层
      backdropEl = document.createElement('div');
      backdropEl.className = 'ms-backdrop';
      backdropEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(backdropEl);

      // 2. 创建主悬浮大窗口
      modalEl = document.createElement('div');
      modalEl.className = 'ms-modal';
      modalEl.setAttribute('role', 'dialog');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.setAttribute('aria-labelledby', 'msTitle');
      modalEl.innerHTML = this.renderTemplate();
      document.body.appendChild(modalEl);

      this.bindEvents();

      // 3. 向侧边栏工具箱注册入口
      if (window.Sidebar) {
        window.Sidebar.register({
          id: 'manuscripts',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
            <polyline points="10 9 9 9 8 9"></polyline>
          </svg>`,
          label: '稿件管理',
          title: '本地译文稿件管理',
          order: 20,
          onClick: () => this.open()
        });
      }
    },

    renderTemplate() {
      return `
        <!-- 弹窗顶部栏 -->
        <div class="ms-header">
          <div class="ms-title-group">
            <span class="ms-header-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
            </span>
            <div>
              <div class="ms-title" id="msTitle">工作区文稿管理</div>
              <div class="ms-subtitle">在线编辑与多轨流转</div>
            </div>
          </div>

          <div class="ms-header-right">
            <button type="button" class="ms-close-btn" id="msCloseBtn" title="关闭 (Esc)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        <!-- 弹窗主体：左侧文件清单与目录切换 + 右侧检视/编辑区 -->
        <div class="ms-body">
          <!-- 左侧边栏：文稿来源与文件列表 -->
          <div class="ms-sidebar">
            <!-- 来源选择条 -->
            <div class="ms-dir-bar">
              <div class="ms-dir-select-wrap">
                <select id="msDirSelect" class="ms-dir-select" title="选择文稿来源"></select>
              </div>
              <input type="file" id="msFileInput" accept=".lrc,.txt" multiple style="display:none">
              <button type="button" class="mini primary" id="msImportBtn" title="从电脑导入歌词文件">导入</button>
              <button type="button" class="mini" id="msRefreshBtn" title="刷新列表">刷新</button>
            </div>

            <!-- 搜索过滤条 -->
            <div class="ms-search-bar">
              <span class="ms-search-icon">🔍</span>
              <input type="text" id="msSearchInput" placeholder="过滤文稿列表..." autocomplete="off">
              <button type="button" class="ms-search-clear hide" id="msSearchClear" title="清空搜索">✕</button>
            </div>

            <!-- 文件列表统计与容器 -->
            <div class="ms-file-stats" id="msFileStats">正在读取…</div>
            <div class="ms-file-list" id="msFileList"></div>
          </div>

          <!-- 右侧内容区：查看 / 编辑器 -->
          <div class="ms-editor-pane">
            <!-- 编辑区顶部控制栏 -->
            <div class="ms-editor-bar">
              <div class="ms-file-info-group">
                <span class="ms-active-name" id="msActiveName">未选择文稿</span>
                <span class="ms-mode-pill pill dim" id="msModePill">只读查看</span>
                <span class="ms-metrics muted" id="msMetrics"></span>
              </div>
              <div class="ms-actions-group" id="msActionsGroup"></div>
            </div>

            <!-- 文本编辑器主容器 -->
            <div class="ms-editor-wrap">
              <textarea id="msEditorText" class="ms-editor-textarea" readonly placeholder="请从左侧选择要检视或编辑的文稿..."></textarea>
              <div class="ms-empty-view" id="msEmptyView">
                <div class="ms-empty-icon">📄</div>
                <div class="ms-empty-title">未选定文稿</div>
                <div class="ms-empty-desc">请在左侧点击选择文稿，或点击「导入」添加本地 .lrc / .txt 歌词</div>
              </div>
            </div>
          </div>

          <!-- 嵌套文件夹浏览器抽屉 (从左下角滑出，供服务端模式备用) -->
          <div class="ms-browse-drawer hide" id="msBrowseDrawer">
            <div class="ms-drawer-header">
              <span class="ms-drawer-title">📁 浏览文件夹</span>
              <span class="ms-drawer-path" id="msBrowsePath"></span>
              <button type="button" class="mini primary" id="msPickCurrentBtn">选择此目录</button>
              <button type="button" class="mini" id="msBrowseCloseBtn">关闭</button>
            </div>
            <div class="ms-drawer-body" id="msBrowseBody"></div>
          </div>
        </div>
      `;
    },

    bindEvents() {
      modalEl.querySelector('#msCloseBtn').addEventListener('click', () => this.close());
      backdropEl.addEventListener('click', () => this.close());

      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalEl && modalEl.classList.contains('open')) {
          const drawer = modalEl.querySelector('#msBrowseDrawer');
          if (drawer && !drawer.classList.contains('hide')) {
            drawer.classList.add('hide');
            return;
          }
          this.close();
        }
      });

      const dirSel = modalEl.querySelector('#msDirSelect');
      dirSel.addEventListener('change', () => {
        if (this.hasUnsavedChanges()) {
          if (!window.confirm('当前文稿有尚未保存的修改，确定放弃并切换吗？')) {
            dirSel.value = currentDir;
            return;
          }
        }
        this.switchDirectory(dirSel.value);
      });

      modalEl.querySelector('#msRefreshBtn').addEventListener('click', () => {
        this.loadDirectory(currentDir);
      });

      const fileInput = modalEl.querySelector('#msFileInput');
      modalEl.querySelector('#msImportBtn').addEventListener('click', () => {
        fileInput.click();
      });
      fileInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (files && files.length) {
          const count = await WorkspaceStorage.importFiles(files);
          fileInput.value = '';
          if (window.showToast) window.showToast(`📥 成功导入 ${count} 份文稿至工作区`, 'ok');
          this.switchDirectory('workspace');
        }
      });

      modalEl.querySelector('#msBrowseCloseBtn')?.addEventListener('click', () => {
        modalEl.querySelector('#msBrowseDrawer').classList.add('hide');
      });

      const searchInput = modalEl.querySelector('#msSearchInput');
      const searchClear = modalEl.querySelector('#msSearchClear');
      searchInput.addEventListener('input', () => {
        searchClear.classList.toggle('hide', !searchInput.value);
        this.renderFileList();
      });
      searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.classList.add('hide');
        this.renderFileList();
        searchInput.focus();
      });

      const textarea = modalEl.querySelector('#msEditorText');
      textarea.addEventListener('input', () => {
        this.updateMetrics();
      });

      // 监听全局工作区变动事件
      window.addEventListener('ncm:workspace-change', () => {
        if (modalEl && modalEl.classList.contains('open') && currentDir === 'workspace') {
          this.loadDirectory('workspace');
        }
      });
    },

    hasUnsavedChanges() {
      if (!isEditing || !modalEl) return false;
      const curText = modalEl.querySelector('#msEditorText').value;
      return curText !== originalContent;
    },

    open(options = {}) {
      this.init();
      backdropEl.classList.add('open');
      modalEl.classList.add('open');

      this.loadAvailableDirs().then(() => {
        const targetDir = options.dir || currentDir || 'workspace';
        this.switchDirectory(targetDir, options.file);
      });
    },

    close() {
      if (!modalEl) return;
      if (this.hasUnsavedChanges()) {
        if (!window.confirm('当前文稿有尚未保存的修改，确定放弃并关闭吗？')) {
          return;
        }
      }
      this.exitEditMode(true);
      modalEl.querySelector('#msBrowseDrawer')?.classList.add('hide');
      backdropEl.classList.remove('open');
      modalEl.classList.remove('open');
    },

    async loadAvailableDirs() {
      const dirSel = modalEl.querySelector('#msDirSelect');
      if (!dirSel) return;
      dirSel.innerHTML = '';

      // 仅开放本地工作区存储
      const wsCount = WorkspaceStorage.getAll().length;
      const wsOpt = document.createElement('option');
      wsOpt.value = 'workspace';
      wsOpt.textContent = `浏览器工作区 (${wsCount} 篇)`;
      dirSel.appendChild(wsOpt);
      dirSel.value = 'workspace';
      currentDir = 'workspace';
    },

    async switchDirectory(dirPath, autoSelectFile = null) {
      currentDir = dirPath;
      try {
        localStorage.setItem('ncm_ms_dir', dirPath);
      } catch (_) {}

      const dirSel = modalEl.querySelector('#msDirSelect');
      if (dirSel && dirSel.value !== dirPath) {
        dirSel.value = dirPath;
      }

      await this.loadDirectory(dirPath, autoSelectFile);
    },

    async loadDirectory(dirPath, autoSelectFile = null) {
      const statsEl = modalEl.querySelector('#msFileStats');
      const listEl = modalEl.querySelector('#msFileList');
      statsEl.textContent = '读取文稿中…';
      listEl.innerHTML = '';

      if (dirPath === 'workspace') {
        const docs = WorkspaceStorage.getAll();
        fileList = docs.map(d => ({
          name: d.name,
          path: d.id,
          size: d.size,
          mtime: d.mtime,
          content: d.content,
          isWorkspace: true
        }));

        this.renderFileList();

        if (autoSelectFile) {
          const target = fileList.find(f => f.name === autoSelectFile || f.path === autoSelectFile);
          if (target) this.selectFile(target);
        } else if (currentFile && fileList.some(f => f.path === currentFile.path)) {
          const reselect = fileList.find(f => f.path === currentFile.path);
          this.selectFile(reselect);
        } else if (fileList.length > 0) {
          this.selectFile(fileList[0]);
        } else {
          this.clearActiveFile();
        }
        return;
      }

      // 服务端目录模式（降级兼容）
      try {
        const url = `/api/browse?path=${encodeURIComponent(dirPath)}`;
        const res = await (window.api ? window.api(url) : fetch(url).then(r => r.json()));
        if (!res.ok) {
          statsEl.textContent = '读取失败：' + (res.error || '');
          fileList = [];
          this.renderFileList();
          return;
        }

        fileList = (res.files || []).map(f => ({ ...f, isWorkspace: false }));
        this.renderFileList();

        if (autoSelectFile) {
          const target = fileList.find(f => f.name === autoSelectFile || f.path === autoSelectFile);
          if (target) this.selectFile(target);
        } else if (fileList.length > 0) {
          this.selectFile(fileList[0]);
        } else {
          this.clearActiveFile();
        }
      } catch (e) {
        statsEl.textContent = '读取异常：' + e.message;
      }
    },

    renderFileList() {
      const statsEl = modalEl.querySelector('#msFileStats');
      const listEl = modalEl.querySelector('#msFileList');
      const query = (modalEl.querySelector('#msSearchInput').value || '').trim().toLowerCase();

      const filtered = query
        ? fileList.filter(f => f.name.toLowerCase().includes(query))
        : fileList;

      statsEl.textContent = query
        ? `找到 ${filtered.length} / ${fileList.length} 份文稿`
        : `共 ${fileList.length} 份文稿`;

      if (!filtered.length) {
        listEl.innerHTML = `
          <div class="muted" style="text-align:center;padding:24px 12px;font-size:12.5px;">
            ${query ? '无匹配文稿' : '当前工作区暂无文稿，可导入 .lrc 或 .txt 文件'}
          </div>`;
        return;
      }

      listEl.innerHTML = filtered.map(f => {
        const isLrc = f.name.toLowerCase().endsWith('.lrc');
        const extPill = isLrc
          ? '<span class="ms-file-tag lrc">LRC</span>'
          : '<span class="ms-file-tag txt">TXT</span>';
        const activeClass = currentFile && currentFile.path === f.path ? 'active' : '';

        return `
          <div class="ms-file-item ${activeClass}" data-path="${esc(f.path)}">
            <div class="ms-file-row">
              ${extPill}
              <span class="ms-file-title" title="${esc(f.name)}">${esc(f.name)}</span>
            </div>
            <div class="ms-file-meta">
              <span>${formatBytes(f.size)}</span>
            </div>
          </div>
        `;
      }).join('');

      listEl.querySelectorAll('.ms-file-item').forEach(el => {
        el.addEventListener('click', () => {
          const path = el.dataset.path;
          const target = fileList.find(f => f.path === path);
          if (target) this.selectFile(target);
        });
      });
    },

    async selectFile(file) {
      if (this.hasUnsavedChanges()) {
        if (!window.confirm('当前文稿有未保存的修改，确定切换吗？')) {
          return;
        }
      }

      currentFile = file;
      this.exitEditMode(true);

      const items = modalEl.querySelectorAll('.ms-file-item');
      items.forEach(el => {
        el.classList.toggle('active', el.dataset.path === file.path);
      });

      const nameEl = modalEl.querySelector('#msActiveName');
      nameEl.textContent = file.name;
      nameEl.title = file.name;
      modalEl.querySelector('#msEmptyView').classList.add('hide');

      const textEl = modalEl.querySelector('#msEditorText');

      if (file.isWorkspace && file.content !== undefined) {
        originalContent = file.content;
        textEl.value = originalContent;
        this.updateMetrics();
        return;
      }

      // 服务端文件通过接口读取
      textEl.value = '正在加载文稿内容…';
      try {
        const url = `/api/read_file?path=${encodeURIComponent(file.path)}`;
        const res = await (window.api ? window.api(url) : fetch(url).then(r => r.json()));
        if (res.ok) {
          originalContent = res.text || '';
          textEl.value = originalContent;
          this.updateMetrics();
        } else {
          textEl.value = '加载失败：' + (res.error || '');
        }
      } catch (e) {
        textEl.value = '加载异常：' + e.message;
      }
    },

    clearActiveFile() {
      currentFile = null;
      this.exitEditMode(true);
      const nameEl = modalEl.querySelector('#msActiveName');
      nameEl.textContent = '未选择文稿';
      nameEl.title = '';
      modalEl.querySelector('#msMetrics').textContent = '';
      modalEl.querySelector('#msEditorText').value = '';
      modalEl.querySelector('#msEmptyView').classList.remove('hide');
    },

    updateMetrics() {
      const text = modalEl.querySelector('#msEditorText').value;
      const lines = text ? text.split('\n').length : 0;
      const chars = text ? text.length : 0;
      modalEl.querySelector('#msMetrics').textContent = `${lines} 行 · ${chars} 字符`;
    },

    startEdit() {
      if (!currentFile) return;
      isEditing = true;
      const textEl = modalEl.querySelector('#msEditorText');
      textEl.readOnly = false;
      textEl.focus();

      const pill = modalEl.querySelector('#msModePill');
      pill.textContent = '编辑中…';
      pill.className = 'ms-mode-pill pill warn';

      const actions = modalEl.querySelector('#msActionsGroup');
      actions.innerHTML = `
        <button type="button" class="mini primary" id="msSaveBtn">💾 保存修改</button>
        <button type="button" class="mini" id="msCancelBtn">取消</button>
      `;

      actions.querySelector('#msSaveBtn').addEventListener('click', () => this.saveEdit());
      actions.querySelector('#msCancelBtn').addEventListener('click', () => {
        textEl.value = originalContent;
        this.exitEditMode(true);
        this.updateMetrics();
      });
    },

    async saveEdit() {
      if (!currentFile) return;
      const saveBtn = modalEl.querySelector('#msSaveBtn');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
      }

      const content = modalEl.querySelector('#msEditorText').value;

      try {
        if (currentFile.isWorkspace) {
          WorkspaceStorage.save(currentFile.name, content);
          originalContent = content;
          currentFile.content = content;
          currentFile.size = new Blob([content]).size;
          if (window.showToast) window.showToast(`已保存《${currentFile.name}》至工作区`, 'ok');
          this.exitEditMode(false);
          this.updateMetrics();
          this.renderFileList();
          return;
        }

        // 服务端写入降级
        const res = await (window.api 
          ? window.api('/api/update_file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: currentFile.path, content: content })
            })
          : fetch('/api/update_file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: currentFile.path, content: content })
            }).then(r => r.json())
        );

        if (!res.ok) {
          if (window.showToast) window.showToast('保存失败: ' + (res.error || '未知错误'), 'err');
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '💾 保存修改';
          }
          return;
        }

        originalContent = content;
        if (window.showToast) window.showToast(`已成功保存《${currentFile.name}》`, 'ok');
        this.exitEditMode(false);
        this.updateMetrics();
        if (typeof res.size === 'number') {
          currentFile.size = res.size;
          this.renderFileList();
        }
      } catch (e) {
        if (window.showToast) window.showToast('保存出错: ' + e.message, 'err');
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = '💾 保存修改';
        }
      }
    },

    exitEditMode(skipRevert = false) {
      isEditing = false;
      const textEl = modalEl.querySelector('#msEditorText');
      textEl.readOnly = true;

      const pill = modalEl.querySelector('#msModePill');
      pill.textContent = '只读查看';
      pill.className = 'ms-mode-pill pill dim';

      if (!currentFile) {
        modalEl.querySelector('#msActionsGroup').innerHTML = '';
        return;
      }

      const actions = modalEl.querySelector('#msActionsGroup');
      actions.innerHTML = `
        <button type="button" class="mini primary" id="msEditBtn" title="解锁在线编辑">编辑</button>
        <button type="button" class="mini" id="msAlignBtn" title="带入智能对轴工作台">对轴</button>
        <button type="button" class="mini" id="msEditorBtn" title="送入双语编辑器">转到编辑工具</button>
        <button type="button" class="mini" id="msExportBtn" title="导出下载此文件到电脑">下载</button>
        <button type="button" class="mini danger-text" id="msDeleteBtn" title="从工作区删除此文稿">🗑️</button>
      `;

      actions.querySelector('#msEditBtn').addEventListener('click', () => this.startEdit());
      actions.querySelector('#msAlignBtn').addEventListener('click', () => {
        if (window.Aligner) {
          this.close();
          window.Aligner.open({ transText: textEl.value, fileName: currentFile.name });
        }
      });
      actions.querySelector('#msEditorBtn').addEventListener('click', () => {
        if (window.LyricEditor) {
          this.close();
          window.LyricEditor.open(textEl.value);
        }
      });
      actions.querySelector('#msExportBtn').addEventListener('click', () => {
        if (currentFile.isWorkspace) {
          WorkspaceStorage.exportFile(currentFile);
        } else {
          const blob = new Blob([textEl.value], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = currentFile.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      });
      actions.querySelector('#msDeleteBtn').addEventListener('click', () => {
        if (window.confirm(`确定要删除《${currentFile.name}》吗？`)) {
          if (currentFile.isWorkspace) {
            WorkspaceStorage.remove(currentFile.path);
            this.clearActiveFile();
            this.loadDirectory('workspace');
            if (window.showToast) window.showToast(`已删除《${currentFile.name}》`, 'info');
          }
        }
      });
    }
  };

  window.Manuscripts = Manuscripts;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Manuscripts.init());
  } else {
    Manuscripts.init();
  }

})(window);
