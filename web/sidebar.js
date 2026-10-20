// ============================================================================
// web/sidebar.js - 可扩展极简毛玻璃侧边栏 (常态图标，Hover 展开 1/6 屏 · 渐变偏好设置)
// ============================================================================
(function(window) {
  'use strict';

  const registry = [];
  const settingsRegistry = [];
  let sidebarEl = null;
  let activeId = null;

  const Sidebar = {
    /**
     * 注册侧边栏功能项目
     * @param {Object} item - { id, icon, label, title, badge, onClick, order }
     */
    register(item) {
      if (!item || !item.id) return;
      const idx = registry.findIndex(x => x.id === item.id);
      if (idx >= 0) {
        registry[idx] = { ...registry[idx], ...item };
      } else {
        registry.push(item);
      }
      registry.sort((a, b) => (a.order || 50) - (b.order || 50));
      if (sidebarEl) this.render();
    },

    /**
     * 注册设置项开关 (高扩展性)
     * @param {Object} setting - { id, title, desc, icon, default, onChange }
     */
    registerSetting(setting) {
      if (!setting || !setting.id) return;
      const idx = settingsRegistry.findIndex(x => x.id === setting.id);
      if (idx >= 0) {
        settingsRegistry[idx] = { ...settingsRegistry[idx], ...setting };
      } else {
        settingsRegistry.push(setting);
      }
      if (sidebarEl) this.renderSettings();
    },

    get(id) {
      return registry.find(x => x.id === id);
    },

    setActive(id) {
      activeId = id;
      if (!sidebarEl) return;
      sidebarEl.querySelectorAll('.sidebar-nav .sidebar-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.id === id);
      });
    },

    openSettings() {
      if (!sidebarEl) return;
      sidebarEl.classList.add('settings-mode');
      this.renderSettings();
    },

    closeSettings() {
      if (!sidebarEl) return;
      sidebarEl.classList.remove('settings-mode');
    },

    toggleSettings() {
      if (!sidebarEl) return;
      if (sidebarEl.classList.contains('settings-mode')) {
        this.closeSettings();
      } else {
        this.openSettings();
      }
    },

    /**
     * 性能模式 (Canvas 2D / 降级动效) 状态控制器
     * @param {boolean} enabled 
     */
    setLowPowerMode(enabled) {
      window.__LOW_POWER_MODE__ = !!enabled;
      try {
        localStorage.setItem('ncm_low_power_mode', String(enabled));
      } catch (_) {}

      if (enabled) {
        document.documentElement.classList.add('low-power-mode');
        document.body?.classList.add('low-power-mode');
        if (typeof window.banner === 'function') {
          window.banner('已开启 2D 性能模式', 'ok', 2800);
        }
      } else {
        document.documentElement.classList.remove('low-power-mode');
        document.body?.classList.remove('low-power-mode');
        if (typeof window.banner === 'function') {
          window.banner('✨ 已恢复 3D 光影物理模式', 'info', 2000);
        }
      }

      window.dispatchEvent(new CustomEvent('ncm:low-power-change', {
        detail: { lowPower: !!enabled }
      }));
    },

    isLowPowerMode() {
      return !!window.__LOW_POWER_MODE__;
    },

    render() {
      if (!sidebarEl) return;
      const nav = sidebarEl.querySelector('.sidebar-nav');
      if (!nav) return;

      nav.innerHTML = registry.map(item => {
        const isActive = activeId === item.id;
        const badgeHtml = item.badge ? `<span class="sidebar-badge">${item.badge}</span>` : '';
        return `
          <button type="button" 
                  class="sidebar-item ${isActive ? 'active' : ''}" 
                  data-id="${item.id}" 
                  title="${item.title || item.label || ''}">
            <span class="sidebar-icon">${item.icon}</span>
            <span class="sidebar-label-wrap">
              <span class="sidebar-label">${item.label}</span>
              ${badgeHtml}
            </span>
          </button>
        `;
      }).join('');

      // 绑定功能项点击事件
      nav.querySelectorAll('.sidebar-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const id = btn.dataset.id;
          const found = this.get(id);
          if (found && typeof found.onClick === 'function') {
            found.onClick(found);
          }
        });
      });
    },

    renderSettings() {
      if (!sidebarEl) return;
      const listEl = sidebarEl.querySelector('.sidebar-settings-list');
      if (!listEl) return;

      listEl.innerHTML = settingsRegistry.map(s => {
        const checked = typeof s.default === 'function' ? s.default() : !!s.default;
        return `
          <div class="sidebar-setting-card" data-setting-id="${s.id}">
            <div class="setting-text-group">
              <div class="setting-title-row">
                <span class="setting-title">${s.title}</span>
              </div>
              ${s.desc ? `<div class="setting-desc">${s.desc}</div>` : ''}
            </div>
            <label class="ios-switch" title="${s.title}">
              <input type="checkbox" id="setting_${s.id}" ${checked ? 'checked' : ''}>
              <span class="ios-switch-slider"></span>
            </label>
          </div>
        `;
      }).join('');

      // 绑定开关变动
      listEl.querySelectorAll('.sidebar-setting-card').forEach(card => {
        const id = card.dataset.settingId;
        const input = card.querySelector('input[type="checkbox"]');
        const setting = settingsRegistry.find(x => x.id === id);
        if (input && setting) {
          input.addEventListener('change', (e) => {
            if (typeof setting.onChange === 'function') {
              setting.onChange(e.target.checked);
            }
          });
        }
      });
    },

    init() {
      if (sidebarEl) return;

      // 同步初始性能模式设置
      const isInitialLowPower = localStorage.getItem('ncm_low_power_mode') === 'true';
      if (isInitialLowPower) {
        window.__LOW_POWER_MODE__ = true;
        document.documentElement.classList.add('low-power-mode');
        document.body?.classList.add('low-power-mode');
      }

      // 注册性能模式设置开关
      this.registerSetting({
        id: 'lowPower',
        icon: '',
        title: '性能模式',
        desc: '关闭光线步进，切换为轻量 2D 动效',
        default: () => localStorage.getItem('ncm_low_power_mode') === 'true',
        onChange: (val) => {
          this.setLowPowerMode(val);
        }
      });

      // 动态挂载侧边栏容器（确保在 header 之后渲染）
      sidebarEl = document.createElement('aside');
      sidebarEl.id = 'appSidebar';
      sidebarEl.className = 'app-sidebar';
      sidebarEl.setAttribute('aria-label', '功能侧边栏');

      sidebarEl.innerHTML = `
        <div class="sidebar-inner">

          <!-- 视图 1：主功能面板 (工具箱 + 底部设置入口) -->
          <div class="sidebar-view sidebar-view-main">
            <div class="sidebar-header-hint">
              <span class="sidebar-hint-text">工具箱</span>
            </div>
            <nav class="sidebar-nav"></nav>
            <div class="sidebar-bottom">
              <div class="sidebar-divider"></div>
              <button type="button" 
                      class="sidebar-item sidebar-settings-btn" 
                      id="sidebarSettingsBtn" 
                      title="偏好设置">
                <span class="sidebar-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                  </svg>
                </span>
                <span class="sidebar-label-wrap">
                  <span class="sidebar-label">设置</span>
                </span>
              </button>
            </div>
          </div>

          <!-- 视图 2：设置面板 (带渐变平滑切入与 iOS 胶囊开关) -->
          <div class="sidebar-view sidebar-view-settings">
            <div class="sidebar-settings-header">
              <button type="button" class="sidebar-back-btn" id="sidebarBackBtn" title="返回工具箱">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
                <span class="sidebar-settings-title">偏好设置</span>
              </button>
            </div>
            <div class="sidebar-settings-list"></div>
            <div class="sidebar-settings-footer">
              <span class="sidebar-ver-tag">By: FinaFina</span>
            </div>
          </div>

        </div>
      `;

      // 插入到 body 内 header 的后面
      const header = document.querySelector('header');
      if (header && header.nextSibling) {
        document.body.insertBefore(sidebarEl, header.nextSibling);
      } else {
        document.body.prepend(sidebarEl);
      }

      this.render();
      this.renderSettings();

      // 绑定设置入口与返回按钮事件
      const settingsBtn = sidebarEl.querySelector('#sidebarSettingsBtn');
      if (settingsBtn) {
        settingsBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.openSettings();
        });
      }

      const backBtn = sidebarEl.querySelector('#sidebarBackBtn');
      if (backBtn) {
        backBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.closeSettings();
        });
      }

      // 点击侧边栏外部时，自动退出设置模式
      document.addEventListener('pointerdown', (e) => {
        if (sidebarEl && sidebarEl.classList.contains('settings-mode')) {
          if (!sidebarEl.contains(e.target)) {
            this.closeSettings();
          }
        }
      });

      // ESC 键退出设置模式
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sidebarEl && sidebarEl.classList.contains('settings-mode')) {
          this.closeSettings();
        }
      });

      // 测量并同步 header 高度到 CSS 变量（主页下 header 收起高度归零，其它页面展开平滑过渡）
      let cachedHeaderHeight = 62;
      const measureHeader = () => {
        if (header && (!document.body || !document.body.classList.contains('is-home'))) {
          const rect = header.getBoundingClientRect();
          if (rect.height > 45) {
            cachedHeaderHeight = Math.round(rect.height);
          }
        }
      };

      const syncHeaderHeight = () => {
        const isHome = document.body && document.body.classList.contains('is-home');
        if (isHome) {
          document.documentElement.style.setProperty('--header-actual-h', '0px');
          return;
        }
        // 若 header 当前展开中且已有稳定尺寸，先采样更新
        measureHeader();
        // 关键修复：当从主页切到其它 Tab 时，header 正在以 0.38s CSS 过渡展开，
        // 同步更新 CSS 变量为展开高度，
        // 从而使 .app-sidebar 基于其自身的 CSS transition (top 0.38s, height 0.38s)
        // 与 header 保持过渡同步，避免侧边栏迟滞或被遮挡
        document.documentElement.style.setProperty('--header-actual-h', `${cachedHeaderHeight}px`);
      };

      Sidebar.syncHeaderHeight = syncHeaderHeight;
      syncHeaderHeight();

      // 当 header 展开/收起过渡完成后，做一次最终精准校准
      if (header) {
        header.addEventListener('transitionend', (e) => {
          if (e.propertyName === 'max-height' || e.propertyName === 'transform') {
            if (!document.body.classList.contains('is-home')) {
              measureHeader();
              document.documentElement.style.setProperty('--header-actual-h', `${cachedHeaderHeight}px`);
            }
          }
        });
      }

      window.addEventListener('resize', () => {
        const isHome = document.body && document.body.classList.contains('is-home');
        if (!isHome) {
          measureHeader();
          document.documentElement.style.setProperty('--header-actual-h', `${cachedHeaderHeight}px`);
        } else {
          document.documentElement.style.setProperty('--header-actual-h', '0px');
        }
      }, { passive: true });
    }
  };

  // 暴露全局命名空间
  window.Sidebar = Sidebar;

  // DOM 就绪后自启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Sidebar.init());
  } else {
    Sidebar.init();
  }

})(window);
