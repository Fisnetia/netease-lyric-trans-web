// ============================================================================
// web/glsl-engine.js - 高性能背景动效引擎 (3D WebGL / 2D Canvas)
// 模式 1：3D 模式 (WebGL 光线步进、次表面散射、双流体粘弹性物理)
// 模式 2：2D 性能模式 (Canvas 2D 极光粒子)
// ============================================================================

(function initMusicCanvasBgEngine() {
  'use strict';

  // 1. 无障碍模式检测（减弱动态效果设置）：若开启，提供安全的空对象 Stub 接口
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    console.info('[GlslBgEngine] prefers-reduced-motion active, background engine bypassed.');
    if (window.Splash) window.Splash.dismiss();
    window.GlslBgEngine = {
      canvas: null,
      canvas2D: null,
      burst: () => {},
      isSupported: false,
      stop: () => {},
      start: () => {},
      destroy: () => {}
    };
    return;
  }

  try {
    let w = window.innerWidth, h = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    // -------------------------------------------------------------------------
    // Canvas 创建与挂载 (3D WebGL Canvas 与 2D Canvas 双层架构)
    // -------------------------------------------------------------------------
    const canvas = document.createElement('canvas');
    canvas.id = 'ncmBgCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '-1',
      opacity: '0',
      transition: 'opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1)'
    });

    const canvas2D = document.createElement('canvas');
    canvas2D.id = 'ncmBgCanvas2D';
    canvas2D.setAttribute('aria-hidden', 'true');
    Object.assign(canvas2D.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '-1'
    });

    if (document.body) {
      document.body.prepend(canvas2D);
      document.body.prepend(canvas);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.body.prepend(canvas2D);
        document.body.prepend(canvas);
      });
    }

    const ctx2D = canvas2D.getContext('2d', { alpha: true });
    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false,
        powerPreference: 'low-power',
        failIfMajorPerformanceCaveat: true,
        premultipliedAlpha: false
      });
    } catch (_) {
      gl = null;
    }

    let isContextLost = false;
    let is3DInitialized = false;
    let is3DCompiling = false;

    // -------------------------------------------------------------------------
    // 帧缓冲 (FBO) 与画布尺寸管理
    // -------------------------------------------------------------------------
    let fbo = null, fboTex = null;

    function initFBO(width, height) {
      if (!gl || isContextLost) return;
      if (fbo) gl.deleteFramebuffer(fbo);
      if (fboTex) gl.deleteTexture(fboTex);

      fbo = gl.createFramebuffer();
      fboTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    function handleResize() {
      w = window.innerWidth;
      h = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas2D.width = Math.floor(w * dpr);
      canvas2D.height = Math.floor(h * dpr);
      if (ctx2D) {
        ctx2D.setTransform(1, 0, 0, 1, 0, 0);
        ctx2D.scale(dpr, dpr);
      }

      if (gl && !isContextLost && !window.__LOW_POWER_MODE__) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        gl.viewport(0, 0, canvas.width, canvas.height);
        initFBO(canvas.width, canvas.height);
      }

      // 窗口面积伸缩时自适应调整音符数量
      if (notes.length > 0) {
        const targetNoteCount = Math.min(24, Math.max(14, Math.floor((w * h) / 76000)));
        while (notes.length < targetNoteCount) {
          notes.push(createJellyNote(notes.length));
        }
        if (notes.length > targetNoteCount) {
          notes.length = targetNoteCount;
        }
      }
    }

    function resize() {
      handleResize();
    }

    let resizeTimer = null;
    function onWindowResize() {
      if (resizeTimer) cancelAnimationFrame(resizeTimer);
      resizeTimer = requestAnimationFrame(handleResize);
    }
    window.addEventListener('resize', onWindowResize);

    // -------------------------------------------------------------------------
    // 着色器编译与安全降级
    // -------------------------------------------------------------------------
    function createProgram(vsSrc, fsSrc) {
      if (!gl || isContextLost) return null;
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vsSrc);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        console.warn('[GlslBgEngine] VS compile error:', gl.getShaderInfoLog(vs));
        gl.deleteShader(vs);
        return null;
      }

      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsSrc);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.warn('[GlslBgEngine] FS compile error:', gl.getShaderInfoLog(fs));
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return null;
      }

      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.warn('[GlslBgEngine] Program link error:', gl.getProgramInfoLog(prog));
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return null;
      }
      return prog;
    }

    function fallbackTo2D() {
      console.warn('[GlslBgEngine] WebGL failed or unsupported, safely falling back to 2D.');
      stop3D();
      is3DInitialized = false;
      is3DCompiling = false;
      canvas.style.display = 'none';
      canvas2D.style.display = 'block';
      start2D();
      if (window.Splash) window.Splash.dismiss();
    }

    // -------------------------------------------------------------------------
    // Pass 1：背景层（三颗差速过冲光球 + 底部高斯平滑声波 + 声学等高线）
    // -------------------------------------------------------------------------
    const bgVs = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const bgFs = `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif

      varying vec2 v_uv;
      uniform vec2 u_res;
      uniform float u_dpr;
      uniform float u_time;
      uniform float u_isDark;
      uniform float u_energy;
      uniform float u_waveMouseX;
      uniform float u_waveInf;

      uniform vec4 u_blobs[3];
      uniform vec3 u_blobColors[3];

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      float smoothNoise(vec2 uv) {
        vec2 i = floor(uv);
        vec2 f = fract(uv);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = hash12(i);
        float b = hash12(i + vec2(1.0, 0.0));
        float c = hash12(i + vec2(0.0, 1.0));
        float d = hash12(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      void main() {
        vec2 pix = v_uv * u_res;
        vec3 premulCol = vec3(0.0);
        float totalAlpha = 0.0;

        vec3 blobTint = u_isDark > 0.5 ? vec3(0.45, 0.52, 0.68) : vec3(0.48, 0.52, 0.62);

        // 1. 三颗极光光球
        for (int i = 0; i < 3; i++) {
          vec2 bPos = u_blobs[i].xy;
          float bRadius = u_blobs[i].z;
          float bAlpha = u_blobs[i].w;
          vec3 bCol = u_blobColors[i];

          float dist = length(pix - bPos);
          float t = clamp(dist / max(bRadius, 1.0), 0.0, 1.0);

          float falloff = pow(1.0 - t, 2.8) * 0.72 + pow(1.0 - t, 1.2) * 0.28;
          float a = falloff * bAlpha;

          vec3 c = mix(bCol, blobTint, t * 0.42);
          premulCol += c * a;
          totalAlpha = totalAlpha + a * (1.0 - totalAlpha);
        }

        // 2. 声学等高线微纹理
        float waveNoise = smoothNoise(pix * 0.0038 + vec2(u_time * 0.045, -u_time * 0.025));
        float topoField = length((v_uv - 0.5) * vec2(1.0, u_res.y / u_res.x)) * 7.5 + waveNoise * 1.8;
        float topoLine = sin(topoField * 6.28318 - u_time * 0.25);
        float topoEdge = smoothstep(0.78, 0.98, topoLine) * 0.65 + smoothstep(0.92, 0.99, topoLine) * 0.35;

        float blobBoost = smoothstep(0.05, 0.45, totalAlpha);
        float topoBaseA = (u_isDark > 0.5 ? 0.055 : 0.065) + blobBoost * 0.085;
        float topoFinalA = topoEdge * topoBaseA * (0.4 + u_energy * 0.6);

        vec3 topoCol = u_isDark > 0.5 ? vec3(0.70, 0.82, 1.0) : vec3(0.35, 0.45, 0.65);
        premulCol += topoCol * topoFinalA;
        totalAlpha = totalAlpha + topoFinalA * (1.0 - totalAlpha);

        // 3. 底部动态声学波纹
        float nx = v_uv.x;
        float waveTime = u_time * 1.35;
        float mouseXNorm = u_waveMouseX / u_res.x;

        float mouseProx = 1.0 - clamp(abs(nx - mouseXNorm) * 2.2, 0.0, 1.0);
        float localInf = mouseProx * u_waveInf;

        for (int k = 0; k < 2; k++) {
          float fk = float(k);
          float freq = 5.2 + fk * 2.1;
          float spd = waveTime * (0.85 + fk * 0.45);
          float ph = fk * 1.85;

          float baseWave = sin(nx * freq + spd + ph) * 0.024
                         + sin(nx * (freq * 1.8) - spd * 0.7) * 0.012;
          float mouseDent = -localInf * 0.048 * sin(mouseProx * 3.14159);
          float yLine = 0.065 + fk * 0.038 + baseWave + mouseDent;

          float wDist = v_uv.y - yLine;
          float lineGlow = exp(-abs(wDist) * 75.0) * 0.85;
          float fillT = clamp(-wDist * 16.0, 0.0, 1.0);
          fillT = pow(fillT, 1.6);

          float wBaseA = u_isDark > 0.5
            ? (0.045 + fk * 0.025 + localInf * 0.06)
            : (0.055 + fk * 0.030 + localInf * 0.07);

          vec3 wCol = (k == 0)
            ? (u_isDark > 0.5 ? vec3(0.96, 0.32, 0.48) : vec3(0.92, 0.22, 0.38))
            : (u_isDark > 0.5 ? vec3(0.38, 0.65, 0.98) : vec3(0.25, 0.55, 0.92));

          float la = lineGlow * wBaseA * 1.3;
          premulCol += wCol * la;
          totalAlpha = totalAlpha + la * (1.0 - totalAlpha);

          float fa = fillT * wBaseA * 0.75;
          premulCol = premulCol * (1.0 - fa) + wCol * fa;
          totalAlpha = totalAlpha + fa * (1.0 - totalAlpha);
        }

        gl_FragColor = vec4(premulCol, totalAlpha);
      }
    `;

    // -------------------------------------------------------------------------
    // Pass 2：高速单纹理采样 Blit 着色器（将 FBO 一次性直拷屏幕）
    // -------------------------------------------------------------------------
    const blitVs = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const blitFs = `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif

      varying vec2 v_uv;
      uniform sampler2D u_tex;
      void main() {
        gl_FragColor = texture2D(u_tex, v_uv);
      }
    `;

    // -------------------------------------------------------------------------
    // Pass 3：3D 果冻物理音符实体 (SDF 结合光线步进、Beer-Lambert 吸收与环境折射)
    // -------------------------------------------------------------------------
    const jellyVs = `
      attribute vec2 a_uv;
      uniform vec2 u_res;
      uniform vec2 u_center;
      uniform float u_scale;
      varying vec2 v_uv;
      varying vec2 v_screenUV;

      void main() {
        v_uv = a_uv;
        vec2 px = u_center + vec2(a_uv.x, -a_uv.y) * u_scale;
        v_screenUV = vec2(px.x / u_res.x, 1.0 - px.y / u_res.y);
        vec2 clip = vec2((px.x / u_res.x) * 2.0 - 1.0, 1.0 - (px.y / u_res.y) * 2.0);
        gl_Position = vec4(clip, 0.0, 1.0);
      }
    `;

    const jellyFs = `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif

      varying vec2 v_uv;
      varying vec2 v_screenUV;

      uniform sampler2D u_bgTex;
      uniform float u_time;
      uniform float u_isDark;
      uniform float u_type;
      uniform float u_alpha;
      uniform vec3 u_baseColor;
      uniform float u_glowEnergy;

      uniform vec2 u_p0;
      uniform vec2 u_p1;
      uniform vec2 u_p2;
      uniform vec2 u_p3;
      uniform vec2 u_headStretch;
      uniform float u_thinning;
      uniform float u_wobble;

      float smin(float a, float b, float k) {
        float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
        return mix(b, a, h) - k * h * (1.0 - h);
      }

      float sdCapsule3D(vec3 p, vec3 a, vec3 b, float r) {
        vec3 pa = p - a, ba = b - a;
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        return length(pa - ba * h) - r;
      }

      float sdDynamicNoteHead(vec3 p, vec3 c, vec3 r) {
        vec3 q = p - c;
        float stretchMag = length(u_headStretch);
        if (stretchMag > 0.001) {
          vec2 dir = u_headStretch / stretchMag;
          float parallel = dot(q.xy, dir);
          vec2 perp = q.xy - dir * parallel;
          float sFactor = 1.0 + stretchMag;
          float invSqrt = 1.0 / sqrt(sFactor);
          q.xy = dir * (parallel / sFactor) + perp / invSqrt;
          q.z /= invSqrt;
        }
        q.xy = vec2(q.x * 0.93 - q.y * 0.36, q.x * 0.36 + q.y * 0.93);
        float k0 = length(q / r);
        float k1 = length(q / (r * r));
        return k0 * (k0 - 1.0) / max(k1, 1e-4);
      }

      float sdCurvedStem3D(vec3 p, vec3 pStart, vec3 pMid, vec3 pEnd, float r) {
        const int SEG = 5;
        float minD = 1e5;
        vec3 prev = pStart;
        for (int i = 1; i <= SEG; i++) {
          float t = float(i) / float(SEG);
          float invT = 1.0 - t;
          vec3 curr = invT * invT * pStart + 2.0 * invT * t * pMid + t * t * pEnd;
          minD = min(minD, sdCapsule3D(p, prev, curr, r));
          prev = curr;
        }
        return minD;
      }

      float map3D(vec3 p) {
        float tubeR = 0.092 * u_thinning;

        if (u_type < 0.5) {
          vec3 headPos = vec3(u_p0, 0.02);
          vec3 stemBase = vec3(u_p0 + vec2(0.19, 0.05), 0.02);
          vec3 stemMid  = vec3(u_p1, 0.0);
          vec3 stemTop  = vec3(u_p2, -0.02);
          vec3 flagTip  = vec3(u_p3, 0.04);
          vec3 flagMid  = vec3(mix(u_p2, u_p3, 0.55) + vec2(0.10, 0.06), 0.02);

          float head = sdDynamicNoteHead(p, headPos, vec3(0.30, 0.22, 0.22));
          float stem = sdCurvedStem3D(p, stemBase, stemMid, stemTop, tubeR);
          float flag = sdCurvedStem3D(p, stemTop, flagMid, flagTip, tubeR * 0.90);
          return smin(head, smin(stem, flag, 0.075), 0.095);

        } else if (u_type < 1.5) {
          vec3 h1Pos = vec3(u_p0, 0.02);
          vec3 h2Pos = vec3(u_p1, -0.02);
          vec3 s1Base = vec3(u_p0 + vec2(0.17, 0.04), 0.02);
          vec3 s2Base = vec3(u_p1 + vec2(0.17, 0.04), -0.02);
          vec3 top1 = vec3(u_p2, 0.0);
          vec3 top2 = vec3(u_p3, 0.0);

          float h1 = sdDynamicNoteHead(p, h1Pos, vec3(0.25, 0.19, 0.20));
          float h2 = sdDynamicNoteHead(p, h2Pos, vec3(0.25, 0.19, 0.20));
          float s1 = sdCapsule3D(p, s1Base, top1, tubeR * 0.92);
          float s2 = sdCapsule3D(p, s2Base, top2, tubeR * 0.92);
          float beam = sdCapsule3D(p, top1, top2, tubeR * 1.12);
          return smin(smin(smin(h1, s1, 0.085), smin(h2, s2, 0.085), 0.05), beam, 0.085);

        } else {
          vec3 headPos = vec3(u_p0, 0.02);
          vec3 stemBase = vec3(u_p0 + vec2(0.19, 0.05), 0.02);
          vec3 stemMid  = vec3(u_p1, 0.0);
          vec3 stemTop  = vec3(u_p2, -0.02);
          vec3 f1Tip    = vec3(u_p3, 0.04);
          vec3 f2Tip    = vec3(u_p1 + (u_p3 - u_p2) * 0.95, 0.04);

          float head = sdDynamicNoteHead(p, headPos, vec3(0.29, 0.21, 0.22));
          float stem = sdCurvedStem3D(p, stemBase, stemMid, stemTop, tubeR);
          float f1 = sdCapsule3D(p, stemTop, f1Tip, tubeR * 0.88);
          float f2 = sdCapsule3D(p, stemMid, f2Tip, tubeR * 0.88);
          return smin(head, smin(stem, smin(f1, f2, 0.06), 0.08), 0.095);
        }
      }

      vec3 calcNormal3D(vec3 p) {
        const float h = 0.004;
        const vec2 k = vec2(1.0, -1.0);
        return normalize(
          k.xyy * map3D(p + k.xyy * h) +
          k.yyx * map3D(p + k.yyx * h) +
          k.yxy * map3D(p + k.yxy * h) +
          k.xxx * map3D(p + k.xxx * h)
        );
      }

      vec3 sampleStudioEnv(vec3 R) {
        vec3 keyBoxDir = normalize(vec3(-0.48, 0.68, 0.55));
        float keyBox = smoothstep(0.55, 0.98, dot(R, keyBoxDir)) * 0.18;
        vec3 rimLightDir = normalize(vec3(0.75, 0.20, 0.62));
        float rimStrip = smoothstep(0.75, 0.98, dot(R, rimLightDir)) * 0.12;
        float sky = clamp(R.y * 0.5 + 0.5, 0.0, 1.0) * 0.08;
        return vec3(keyBox + rimStrip + sky);
      }

      void main() {
        vec3 ro = vec3(v_uv, 2.2);
        vec3 rd = normalize(vec3(v_uv * -0.10, -1.0));

        float t = 1.1;
        bool hit = false;

        for (int i = 0; i < 24; i++) {
          vec3 p = ro + rd * t;
          float d = map3D(p);
          if (d < 0.0035) {
            hit = true;
            break;
          }
          t += d * 0.92;
          if (t > 3.2) break;
        }

        // 果冻底部投影
        if (!hit) {
          vec3 shadowTestP = vec3(v_uv - vec2(0.06, -0.08), 0.0);
          float sd = map3D(shadowTestP);
          float shadowAlpha = smoothstep(0.12, -0.06, sd) * (u_isDark > 0.5 ? 0.30 : 0.21) * u_alpha;
          if (shadowAlpha < 0.003) discard;
          vec3 shadowCol = u_isDark > 0.5 ? (u_baseColor * 0.7) : (u_baseColor * 0.48 + vec3(0.15));
          gl_FragColor = vec4(shadowCol * shadowAlpha, shadowAlpha);
          return;
        }

        vec3 pos = ro + rd * t;
        vec3 N = calcNormal3D(pos);
        vec3 V = -rd;

        float ior = 1.38;
        vec3 rdIn = refract(rd, N, 1.0 / ior);

        float dIn1 = max(0.0, -map3D(pos + rdIn * 0.10));
        float dIn2 = max(0.0, -map3D(pos + rdIn * 0.22));
        float opticalDepth = clamp((dIn1 + dIn2) * 4.8, 0.08, 1.0);

        vec3 exitPos = pos + rdIn * (0.14 + opticalDepth * 0.22);
        vec3 exitN = calcNormal3D(exitPos);
        vec2 refrVec = (N.xy * 0.70 - exitN.xy * 0.35) * (0.038 + opticalDepth * 0.048);

        vec2 uvR = clamp(v_screenUV - refrVec * 0.90, 0.002, 0.998);
        vec2 uvG = clamp(v_screenUV - refrVec * 1.00, 0.002, 0.998);
        vec2 uvB = clamp(v_screenUV - refrVec * 1.10, 0.002, 0.998);

        vec4 bgSampleR = texture2D(u_bgTex, uvR);
        vec4 bgSampleG = texture2D(u_bgTex, uvG);
        vec4 bgSampleB = texture2D(u_bgTex, uvB);
        vec3 refractedScene = vec3(bgSampleR.r, bgSampleG.g, bgSampleB.b);

        vec3 pageBase = u_isDark > 0.5 ? vec3(0.08, 0.11, 0.18) : vec3(0.96, 0.97, 0.99);
        vec3 backLight = pageBase * (1.0 - bgSampleG.a) + refractedScene;

        vec3 absorbCoeff = (vec3(1.0) - u_baseColor) * 0.85 + vec3(0.05);
        vec3 beerTransmittance = exp(-absorbCoeff * (0.3 + opticalDepth * 0.7));
        vec3 gummyVolumeCol = backLight * beerTransmittance;
        gummyVolumeCol = mix(gummyVolumeCol, u_baseColor, 0.25 + opticalDepth * 0.15);

        // 透镜边缘折光暗环
        float cosTheta = clamp(dot(N, V), 0.0, 1.0);
        float grazingRim = pow(1.0 - cosTheta, 2.1);
        if (u_isDark < 0.5) {
          vec3 darkRimCol = u_baseColor * 0.52 + vec3(0.12, 0.14, 0.18);
          gummyVolumeCol = mix(gummyVolumeCol, darkRimCol, grazingRim * 0.68);
        }

        // 次表面透光
        vec3 L = normalize(vec3(-0.52, 0.65, 0.55));
        float backScatter = max(0.0, dot(rdIn, -L)) * max(0.0, dot(N.xy, vec2(0.52, -0.65)));
        float caustic = pow(backScatter, 1.6) * smoothstep(0.1, 0.6, opticalDepth) * 0.35;
        vec3 sssGlow = mix(u_baseColor, vec3(1.0), 0.75) * caustic;

        // 柔光箱高光与菲涅尔反射
        vec3 R = reflect(rd, N);
        vec3 studioRefl = sampleStudioEnv(R);
        float fresnel = 0.02 + 0.32 * pow(1.0 - cosTheta, 3.0);

        vec3 finalCol = gummyVolumeCol + sssGlow + studioRefl * 0.52 + vec3(fresnel * (u_isDark > 0.5 ? 0.20 : 0.08));
        // 碰撞发光增强
        finalCol += u_baseColor * (u_glowEnergy * 0.45);
        finalCol = clamp(finalCol, 0.0, 1.0);

        float edgeAA = smoothstep(0.02, 0.08, cosTheta);
        float baseOp = u_isDark > 0.5 ? 0.39 : 0.47;
        float jellyAlpha = clamp(baseOp + opticalDepth * 0.12 + grazingRim * 0.28, 0.0, 0.77) * edgeAA * u_alpha;

        gl_FragColor = vec4(finalCol * jellyAlpha, jellyAlpha);
      }
    `;

    // =========================================================================
    // WebGL 资源编译、初始化与上下文恢复管理
    // =========================================================================
    let bgProg = null, blitProg = null, jellyProg = null;
    let bgBuf = null, jellyBuf = null;
    let bgLoc = {}, blitLoc = {}, jLoc = {};

    function initGLResources() {
      if (!gl || isContextLost) return false;

      // 1. 缓冲区与 FBO 创建（收紧面片半径 R = 1.35，大幅削减空白区域光线步进开销）
      initFBO(canvas.width || Math.floor(w * dpr), canvas.height || Math.floor(h * dpr));

      if (bgBuf) gl.deleteBuffer(bgBuf);
      bgBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

      const R = 1.35;
      if (jellyBuf) gl.deleteBuffer(jellyBuf);
      jellyBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, jellyBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-R, -R, R, -R, -R, R, -R, R, R, -R, R, R]), gl.STATIC_DRAW);

      // 2. 着色器程序链接
      if (bgProg) gl.deleteProgram(bgProg);
      bgProg = createProgram(bgVs, bgFs);
      if (!bgProg) return false;
      bgLoc = {
        a_pos: gl.getAttribLocation(bgProg, 'a_pos'),
        u_res: gl.getUniformLocation(bgProg, 'u_res'),
        u_dpr: gl.getUniformLocation(bgProg, 'u_dpr'),
        u_time: gl.getUniformLocation(bgProg, 'u_time'),
        u_isDark: gl.getUniformLocation(bgProg, 'u_isDark'),
        u_energy: gl.getUniformLocation(bgProg, 'u_energy'),
        u_waveMouseX: gl.getUniformLocation(bgProg, 'u_waveMouseX'),
        u_waveInf: gl.getUniformLocation(bgProg, 'u_waveInf'),
        u_blobs: gl.getUniformLocation(bgProg, 'u_blobs'),
        u_blobColors: gl.getUniformLocation(bgProg, 'u_blobColors')
      };

      if (blitProg) gl.deleteProgram(blitProg);
      blitProg = createProgram(blitVs, blitFs);
      if (!blitProg) return false;
      blitLoc = {
        a_pos: gl.getAttribLocation(blitProg, 'a_pos'),
        u_tex: gl.getUniformLocation(blitProg, 'u_tex')
      };

      if (jellyProg) gl.deleteProgram(jellyProg);
      jellyProg = createProgram(jellyVs, jellyFs);
      if (!jellyProg) return false;
      jLoc = {
        a_uv: gl.getAttribLocation(jellyProg, 'a_uv'),
        u_res: gl.getUniformLocation(jellyProg, 'u_res'),
        u_center: gl.getUniformLocation(jellyProg, 'u_center'),
        u_scale: gl.getUniformLocation(jellyProg, 'u_scale'),
        u_type: gl.getUniformLocation(jellyProg, 'u_type'),
        u_alpha: gl.getUniformLocation(jellyProg, 'u_alpha'),
        u_baseColor: gl.getUniformLocation(jellyProg, 'u_baseColor'),
        u_p0: gl.getUniformLocation(jellyProg, 'u_p0'),
        u_p1: gl.getUniformLocation(jellyProg, 'u_p1'),
        u_p2: gl.getUniformLocation(jellyProg, 'u_p2'),
        u_p3: gl.getUniformLocation(jellyProg, 'u_p3'),
        u_headStretch: gl.getUniformLocation(jellyProg, 'u_headStretch'),
        u_thinning: gl.getUniformLocation(jellyProg, 'u_thinning'),
        u_wobble: gl.getUniformLocation(jellyProg, 'u_wobble'),
        u_glowEnergy: gl.getUniformLocation(jellyProg, 'u_glowEnergy'),
        u_bgTex: gl.getUniformLocation(jellyProg, 'u_bgTex'),
        u_time: gl.getUniformLocation(jellyProg, 'u_time'),
        u_isDark: gl.getUniformLocation(jellyProg, 'u_isDark')
      };

      return true;
    }

    // 分步冷启动，防止占用主线程长任务
    function step1_initFBOAndBuffers() {
      if (!gl || isContextLost) return;
      if (window.Splash) window.Splash.setProgress(25);
      resize();

      if (bgBuf) gl.deleteBuffer(bgBuf);
      bgBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

      const R = 1.35;
      if (jellyBuf) gl.deleteBuffer(jellyBuf);
      jellyBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, jellyBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-R, -R, R, -R, -R, R, -R, R, R, -R, R, R]), gl.STATIC_DRAW);

      setTimeout(step2_compileBgProg, 25);
    }

    function step2_compileBgProg() {
      if (window.Splash) window.Splash.setProgress(55);
      bgProg = createProgram(bgVs, bgFs);
      blitProg = createProgram(blitVs, blitFs);
      if (!bgProg || !blitProg) {
        fallbackTo2D();
        return;
      }
      bgLoc = {
        a_pos: gl.getAttribLocation(bgProg, 'a_pos'),
        u_res: gl.getUniformLocation(bgProg, 'u_res'),
        u_dpr: gl.getUniformLocation(bgProg, 'u_dpr'),
        u_time: gl.getUniformLocation(bgProg, 'u_time'),
        u_isDark: gl.getUniformLocation(bgProg, 'u_isDark'),
        u_energy: gl.getUniformLocation(bgProg, 'u_energy'),
        u_waveMouseX: gl.getUniformLocation(bgProg, 'u_waveMouseX'),
        u_waveInf: gl.getUniformLocation(bgProg, 'u_waveInf'),
        u_blobs: gl.getUniformLocation(bgProg, 'u_blobs'),
        u_blobColors: gl.getUniformLocation(bgProg, 'u_blobColors')
      };
      blitLoc = {
        a_pos: gl.getAttribLocation(blitProg, 'a_pos'),
        u_tex: gl.getUniformLocation(blitProg, 'u_tex')
      };
      setTimeout(step3_compileJellyProg, 35);
    }

    function step3_compileJellyProg() {
      if (window.Splash) window.Splash.setProgress(80);
      jellyProg = createProgram(jellyVs, jellyFs);
      if (!jellyProg) {
        fallbackTo2D();
        return;
      }
      jLoc = {
        a_uv: gl.getAttribLocation(jellyProg, 'a_uv'),
        u_res: gl.getUniformLocation(jellyProg, 'u_res'),
        u_center: gl.getUniformLocation(jellyProg, 'u_center'),
        u_scale: gl.getUniformLocation(jellyProg, 'u_scale'),
        u_type: gl.getUniformLocation(jellyProg, 'u_type'),
        u_alpha: gl.getUniformLocation(jellyProg, 'u_alpha'),
        u_baseColor: gl.getUniformLocation(jellyProg, 'u_baseColor'),
        u_p0: gl.getUniformLocation(jellyProg, 'u_p0'),
        u_p1: gl.getUniformLocation(jellyProg, 'u_p1'),
        u_p2: gl.getUniformLocation(jellyProg, 'u_p2'),
        u_p3: gl.getUniformLocation(jellyProg, 'u_p3'),
        u_headStretch: gl.getUniformLocation(jellyProg, 'u_headStretch'),
        u_thinning: gl.getUniformLocation(jellyProg, 'u_thinning'),
        u_wobble: gl.getUniformLocation(jellyProg, 'u_wobble'),
        u_glowEnergy: gl.getUniformLocation(jellyProg, 'u_glowEnergy'),
        u_bgTex: gl.getUniformLocation(jellyProg, 'u_bgTex'),
        u_time: gl.getUniformLocation(jellyProg, 'u_time'),
        u_isDark: gl.getUniformLocation(jellyProg, 'u_isDark')
      };
      setTimeout(step4_initPhysicsAndLaunch, 30);
    }

    // -------------------------------------------------------------------------
    // 物理参数、调色盘与音符结构
    // -------------------------------------------------------------------------
    let time = 0;
    let mouseX = w * 0.5, mouseY = h * 0.35;
    let mouseVx = 0, mouseVy = 0, mouseSpeed = 0;
    let targetMouseInfluence = 0, mouseInfluence = 0;
    let energy = 1.0, targetEnergy = 1.0;
    let smoothWaveX = mouseX;

    const blobs = [
      {
        x: mouseX, y: mouseY, vx: 0, vy: 0,
        k: 0.12, cruiseDamp: 0.75, arriveDamp: 0.78, cruiseV: 46, arrivalR: 120,
        r: 200, orbitR: 22, phase: 0,
        colLight: [0.95, 0.05, 0.22], colDark: [1.00, 0.22, 0.38]
      },
      {
        x: mouseX, y: mouseY, vx: 0, vy: 0,
        k: 0.036, cruiseDamp: 0.85, arriveDamp: 0.90, cruiseV: 19, arrivalR: 165,
        r: 220, orbitR: 32, phase: 2.09,
        colLight: [0.62, 0.22, 0.96], colDark: [0.75, 0.38, 1.00]
      },
      {
        x: mouseX, y: mouseY, vx: 0, vy: 0,
        k: 0.020, cruiseDamp: 0.88, arriveDamp: 0.925, cruiseV: 12.5, arrivalR: 210,
        r: 210, orbitR: 40, phase: 4.18,
        colLight: [0.06, 0.68, 0.96], colDark: [0.20, 0.78, 1.00]
      }
    ];

    const CANDY_PALETTE = [
      { light: [0.92, 0.72, 0.76], dark: [0.82, 0.56, 0.62] },
      { light: [0.80, 0.74, 0.90], dark: [0.68, 0.60, 0.82] },
      { light: [0.70, 0.85, 0.92], dark: [0.56, 0.74, 0.84] }
    ];

    const REST_POSES = [
      [ [-0.14, -0.38], [0.08, 0.04],  [0.08, 0.48],  [0.42, 0.04] ], // ♪
      [ [-0.34, -0.38], [0.22, -0.28], [-0.15, 0.36], [0.41, 0.46] ], // ♫
      [ [-0.14, -0.40], [0.07, 0.06],  [0.07, 0.50],  [0.42, 0.16] ]  // ♬
    ];

    const SPRING_CHAINS = [
      [ [0, 1, 0.032, 0.88, 0.02], [1, 2, 0.026, 0.89, 0.02], [2, 3, 0.020, 0.90, 0.01] ],
      [ [0, 1, 0.030, 0.88, 0.04], [0, 2, 0.025, 0.89, 0.02], [1, 3, 0.025, 0.89, 0.02], [2, 3, 0.035, 0.88, 0.03] ],
      [ [0, 1, 0.032, 0.88, 0.02], [1, 2, 0.026, 0.89, 0.02], [2, 3, 0.020, 0.90, 0.01] ]
    ];

    const noteCount = Math.min(24, Math.max(16, Math.floor((w * h) / 76000)));
    let notes = [];

    // 预分配复用数组，消除每帧垃圾回收 (GC) 抖动
    const blobVec4 = new Float32Array(12);
    const blobColVec3 = new Float32Array(9);
    const cachedRestOffsets = [ { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 } ];

    function lerpColor(c1, c2, t) {
      return [
        c1[0] + (c2[0] - c1[0]) * t,
        c1[1] + (c2[1] - c1[1]) * t,
        c1[2] + (c2[2] - c1[2]) * t
      ];
    }

    function createJellyNote(idx) {
      const type = idx % 3;
      const baseSize = 25 + Math.random() * 5;
      const cx = Math.random() * w;
      const cy = Math.random() * h;
      const baseAngle = (Math.random() - 0.5) * 0.4;

      const cosA = Math.cos(baseAngle), sinA = Math.sin(baseAngle);
      const rawPoses = REST_POSES[type];
      const nodes = [0, 1, 2, 3].map(k => {
        const raw = rawPoses[k];
        const rx = (raw[0] * cosA - raw[1] * sinA) * baseSize;
        const ry = -(raw[0] * sinA + raw[1] * cosA) * baseSize;
        return {
          x: cx + rx,
          y: cy + ry,
          vx: (Math.random() - 0.5) * 0.25,
          vy: (Math.random() - 0.5) * 0.25
        };
      });

      return {
        type,
        size: baseSize,
        x: cx,
        y: cy,
        baseAngle,
        angle: baseAngle,
        colorIdx: idx % 3,
        baseVx: (Math.random() - 0.5) * 0.15,
        baseVy: -0.10 - Math.random() * 0.15,
        nodes,
        wobble: 0,
        glowEnergy: 0,
        wobblePhase: Math.random() * Math.PI * 2
      };
    }

    function shiftNote(n, dx, dy) {
      n.x += dx;
      n.y += dy;
      n.nodes.forEach(nd => {
        nd.x += dx;
        nd.y += dy;
      });
    }

    function triggerBurst3D(originX = 60, originY = 40) {
      targetEnergy = 1.95;
      targetMouseInfluence = 1;
      blobs.forEach((b, i) => {
        const ang = (i * Math.PI * 2) / 3 + 0.3;
        b.vx += Math.cos(ang) * 35;
        b.vy += Math.sin(ang) * 35;
      });

      notes.forEach(n => {
        const dx = n.x - originX, dy = n.y - originY;
        const dist = Math.hypot(dx, dy) || 1;
        if (dist < 450) {
          const force = (1 - dist / 450) * 11;
          n.nodes.forEach(nd => {
            nd.vx += (dx / dist) * force;
            nd.vy += (dy / dist) * force;
          });
          n.wobble = 1.0;
          n.glowEnergy = 1.0;
        }
      });
    }

    // 包装看板娘交互事件，兼容原生函数调用
    function wrapPokeAvatar() {
      const origPoke = window.pokeAvatar;
      if (typeof origPoke === 'function' && !origPoke.__bg_wrapped__) {
        window.pokeAvatar = function (...args) {
          let res;
          try {
            res = origPoke.apply(this, args);
          } catch (e) {
            console.error('[GlslBgEngine] origPoke error:', e);
          }
          const avatarRect = document.getElementById('brandAvatar')?.getBoundingClientRect();
          const x = avatarRect ? (avatarRect.left + avatarRect.width / 2) : 60;
          const y = avatarRect ? (avatarRect.top + avatarRect.height / 2) : 40;
          if (window.__LOW_POWER_MODE__) {
            triggerBurst2D(x, y);
          } else {
            triggerBurst3D(x, y);
          }
          return res;
        };
        window.pokeAvatar.__bg_wrapped__ = true;
      }
    }

    // -------------------------------------------------------------------------
    // 主题探测与平滑缓动
    // -------------------------------------------------------------------------
    let currentThemeDark = 1.0;
    let targetThemeDark = 1.0;

    function getThemeDarkTarget() {
      const cur = document.documentElement.getAttribute('data-theme');
      if (cur === 'light') return 0;
      if (cur === 'dark') return 1;
      return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 0 : 1;
    }

    function syncTheme() {
      targetThemeDark = getThemeDarkTarget();
    }

    syncTheme();
    currentThemeDark = targetThemeDark;
    const themeObserver = new MutationObserver(() => syncTheme());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // -------------------------------------------------------------------------
    // 背景层绘制闭包函数（提升定义，避免每帧重复创建函数对象）
    // -------------------------------------------------------------------------
    function drawBackdrop() {
      gl.disable(gl.BLEND);
      gl.useProgram(bgProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
      gl.enableVertexAttribArray(bgLoc.a_pos);
      gl.vertexAttribPointer(bgLoc.a_pos, 2, gl.FLOAT, false, 0, 0);

      gl.uniform2f(bgLoc.u_res, w, h);
      gl.uniform1f(bgLoc.u_dpr, dpr);
      gl.uniform1f(bgLoc.u_time, time);
      gl.uniform1f(bgLoc.u_isDark, currentThemeDark);
      gl.uniform1f(bgLoc.u_energy, energy);
      gl.uniform1f(bgLoc.u_waveMouseX, smoothWaveX);
      gl.uniform1f(bgLoc.u_waveInf, mouseInfluence);
      gl.uniform4fv(bgLoc.u_blobs, blobVec4);
      gl.uniform3fv(bgLoc.u_blobColors, blobColVec3);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // -------------------------------------------------------------------------
    // 3D 主渲染循环（基于 Delta-Time 解耦高刷屏刷新率依赖）
    // -------------------------------------------------------------------------
    let renderRaf3D = null;
    let lastFrameTime3D = performance.now();

    function render3D(now) {
      if (window.__LOW_POWER_MODE__ || isContextLost || document.hidden) {
        renderRaf3D = null;
        return;
      }

      // 计算帧时间差并归一化至 60Hz 步进比例 (dtScale)
      const dt = lastFrameTime3D ? Math.min(32, now - lastFrameTime3D) : 16.67;
      lastFrameTime3D = now;
      const dtScale = dt / 16.67;

      currentThemeDark += (targetThemeDark - currentThemeDark) * (1 - Math.pow(1 - 0.14, dtScale));

      mouseVx *= Math.pow(0.82, dtScale);
      mouseVy *= Math.pow(0.82, dtScale);
      mouseSpeed *= Math.pow(0.85, dtScale);

      smoothWaveX += (mouseX - smoothWaveX) * (1 - Math.pow(1 - 0.05, dtScale));
      mouseInfluence += (targetMouseInfluence - mouseInfluence) * (1 - Math.pow(1 - 0.04, dtScale));
      energy += (targetEnergy - energy) * (1 - Math.pow(1 - 0.06, dtScale));
      targetEnergy += (1 - targetEnergy) * (1 - Math.pow(1 - 0.03, dtScale));
      time += 0.015 * energy * dtScale;

      // 1. 更新三色光球物理并填充预分配缓冲区
      for (let idx = 0; idx < blobs.length; idx++) {
        const b = blobs[idx];
        const orbitAngle = time * 1.15 + b.phase;
        const tx = mouseX + Math.cos(orbitAngle) * b.orbitR;
        const ty = mouseY + Math.sin(orbitAngle) * b.orbitR;
        const dx = tx - b.x, dy = ty - b.y;
        const dist = Math.hypot(dx, dy) || 0.001;

        if (dist > b.arrivalR) {
          b.vx = (b.vx + (dx / dist) * b.arrivalR * b.k * dtScale) * Math.pow(b.cruiseDamp, dtScale);
          b.vy = (b.vy + (dy / dist) * b.arrivalR * b.k * dtScale) * Math.pow(b.cruiseDamp, dtScale);
          const spd = Math.hypot(b.vx, b.vy);
          if (spd > b.cruiseV) {
            b.vx = (b.vx / spd) * b.cruiseV;
            b.vy = (b.vy / spd) * b.cruiseV;
          }
        } else {
          b.vx = (b.vx + dx * b.k * dtScale) * Math.pow(b.arriveDamp, dtScale);
          b.vy = (b.vy + dy * b.k * dtScale) * Math.pow(b.arriveDamp, dtScale);
        }

        b.x += b.vx * dtScale;
        b.y += b.vy * dtScale;

        const peakAlpha = currentThemeDark > 0.5 ? (idx === 0 ? 0.28 : 0.23) : (idx === 0 ? 0.20 : 0.16);
        const dynamicAlpha = peakAlpha * Math.min(1.4, Math.max(0.7, energy * 0.95));

        blobVec4[idx * 4 + 0] = b.x;
        blobVec4[idx * 4 + 1] = b.y;
        blobVec4[idx * 4 + 2] = b.r;
        blobVec4[idx * 4 + 3] = dynamicAlpha;

        const c = lerpColor(b.colLight, b.colDark, currentThemeDark);
        blobColVec3[idx * 3 + 0] = c[0];
        blobColVec3[idx * 3 + 1] = c[1];
        blobColVec3[idx * 3 + 2] = c[2];
      }

      // 2. 更新音符质点与弹簧骨骼
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        const nodes = n.nodes;
        const head = nodes[0];
        const springs = SPRING_CHAINS[n.type];

        // 鼠标避让与引力扰动
        const dx = mouseX - head.x, dy = mouseY - head.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        const repulseR = 135 + Math.min(60, mouseSpeed * 1.5);
        const proximity = Math.max(0, 1 - dist / repulseR);
        if (proximity > 0) {
          const nx = -(dx / dist), ny = -(dy / dist);
          const pushForce = proximity * proximity * Math.min(1.15, mouseSpeed * 0.032) * dtScale;
          head.vx += nx * pushForce + (mouseVx * 0.016 * proximity * dtScale);
          head.vy += ny * pushForce + (mouseVy * 0.016 * proximity * dtScale);
          nodes[1].vx += (nx * pushForce + mouseVx * 0.016 * proximity * dtScale) * 0.45;
          nodes[1].vy += (ny * pushForce + mouseVy * 0.016 * proximity * dtScale) * 0.45;
          n.glowEnergy = Math.min(1.0, n.glowEnergy + proximity * Math.min(0.35, mouseSpeed * 0.015));
        }

        n.angle = n.baseAngle + Math.sin(time * 0.7 + n.wobblePhase) * 0.10;

        // 计算当前音符的 4 个局部静止偏移（无多余对象分配）
        const cosA = Math.cos(n.angle), sinA = Math.sin(n.angle);
        const rawPoses = REST_POSES[n.type];
        for (let k = 0; k < 4; k++) {
          const raw = rawPoses[k];
          cachedRestOffsets[k].x = (raw[0] * cosA - raw[1] * sinA) * n.size;
          cachedRestOffsets[k].y = -(raw[0] * sinA + raw[1] * cosA) * n.size;
        }

        for (let sIdx = 0; sIdx < springs.length; sIdx++) {
          const s = springs[sIdx];
          const iA = s[0], iB = s[1];
          const kSpring = s[2] * dtScale, damp = Math.pow(s[3], dtScale), backPull = s[4] * dtScale;
          const pA = nodes[iA], pB = nodes[iB];

          const offA = cachedRestOffsets[iA];
          const offB = cachedRestOffsets[iB];
          const restDx = offB.x - offA.x, restDy = offB.y - offA.y;
          const restLen = Math.hypot(restDx, restDy) || 1;

          const targetBx = pA.x + restDx, targetBy = pA.y + restDy;
          const fx = (targetBx - pB.x) * kSpring;
          const fy = (targetBy - pB.y) * kSpring;

          pB.vx = (pB.vx + fx) * damp;
          pB.vy = (pB.vy + fy) * damp;
          pA.vx -= fx * 0.35 * backPull;
          pA.vy -= fy * 0.35 * backPull;

          // 刚性骨骼硬约束
          const curDx = pB.x - pA.x, curDy = pB.y - pA.y;
          const curLen = Math.hypot(curDx, curDy) || 0.001;
          const maxLen = restLen * 1.55;
          if (curLen > maxLen) {
            const excess = (curLen - maxLen) * 0.25;
            pB.x -= (curDx / curLen) * excess;
            pB.y -= (curDy / curLen) * excess;
          }
        }

        const driftVx = n.baseVx + Math.sin(time * 0.6 + n.wobblePhase) * 0.12;
        const driftVy = n.baseVy + Math.cos(time * 0.5 + n.wobblePhase) * 0.10;

        for (let ndIdx = 0; ndIdx < nodes.length; ndIdx++) {
          const nd = nodes[ndIdx];
          nd.vx += driftVx * 0.05 * dtScale;
          nd.vy += driftVy * 0.05 * dtScale;
          nd.vx *= Math.pow(0.972, dtScale);
          nd.vy *= Math.pow(0.972, dtScale);
          nd.x += nd.vx * dtScale;
          nd.y += nd.vy * dtScale;
        }

        n.x = (nodes[0].x + nodes[1].x + nodes[2].x + nodes[3].x) * 0.25;
        n.y = (nodes[0].y + nodes[1].y + nodes[2].y + nodes[3].y) * 0.25;

        // 平滑衰减 wobble 与发光能量
        n.wobble *= Math.pow(0.88, dtScale);
        n.glowEnergy *= Math.pow(0.982, dtScale);

        // 视口环绕
        const pad = n.size * 2.5;
        if (n.y < -pad) { shiftNote(n, 0, h + pad * 2); n.nodes.forEach(nd => { nd.vy *= 0.5; }); }
        if (n.y > h + pad) { shiftNote(n, 0, -(h + pad * 2)); n.nodes.forEach(nd => { nd.vy *= 0.5; }); }
        if (n.x < -pad) shiftNote(n, w + pad * 2, 0);
        if (n.x > w + pad) shiftNote(n, -(w + pad * 2), 0);
      }

      // 3. 音符间软接触碰撞
      for (let i = 0; i < notes.length; i++) {
        for (let j = i + 1; j < notes.length; j++) {
          const a = notes[i], b = notes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const minDist = (a.size + b.size) * 0.78;
          if (Math.abs(dx) > minDist || Math.abs(dy) > minDist) continue;

          const dist = Math.hypot(dx, dy) || 0.001;
          if (dist < minDist) {
            const overlap = (minDist - dist) * 0.52;
            const nx = dx / dist, ny = dy / dist;

            shiftNote(a, -nx * overlap * 0.65, -ny * overlap * 0.65);
            shiftNote(b, nx * overlap * 0.65, ny * overlap * 0.65);

            const rvx = b.nodes[0].vx - a.nodes[0].vx;
            const rvy = b.nodes[0].vy - a.nodes[0].vy;
            const velAlongNormal = rvx * nx + rvy * ny;
            if (velAlongNormal < 0) {
              const impulse = -velAlongNormal * 0.38;
              a.nodes[0].vx -= nx * impulse;
              a.nodes[0].vy -= ny * impulse;
              b.nodes[0].vx += nx * impulse;
              b.nodes[0].vy += ny * impulse;

              const hit = Math.min(1.0, Math.abs(velAlongNormal) * 0.28);
              a.wobble = Math.min(1, a.wobble + hit);
              b.wobble = Math.min(1, b.wobble + hit);

              const sharedGlow = Math.max(a.glowEnergy, b.glowEnergy, Math.min(0.9, Math.abs(velAlongNormal) * 0.22));
              a.glowEnergy = Math.max(a.glowEnergy, sharedGlow * 0.92);
              b.glowEnergy = Math.max(b.glowEnergy, sharedGlow * 0.92);
            }
          }
        }
      }

      // Pass 1: 将完整计算的背景渲染进 FBO（用于音符折射取样）
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawBackdrop();

      // Pass 2: 将 FBO 快速 Blit 到屏幕（避免每帧执行两次昂贵的背景着色器计算）
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.useProgram(blitProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
      gl.enableVertexAttribArray(blitLoc.a_pos);
      gl.vertexAttribPointer(blitLoc.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.uniform1i(blitLoc.u_tex, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Pass 3: 渲染 3D 光线步进音符实体（在屏幕上混合绘制，fboTex 提供背景折射）
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(jellyProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, jellyBuf);
      gl.enableVertexAttribArray(jLoc.a_uv);
      gl.vertexAttribPointer(jLoc.a_uv, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.uniform1i(jLoc.u_bgTex, 0);
      gl.uniform2f(jLoc.u_res, w, h);
      gl.uniform1f(jLoc.u_time, time);
      gl.uniform1f(jLoc.u_isDark, currentThemeDark);

      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        // 紧凑四边形粗裁剪（R = 1.35）
        const pad = n.size * 1.5;
        if (n.x < -pad || n.x > w + pad || n.y < -pad || n.y > h + pad) continue;

        const pal = CANDY_PALETTE[n.colorIdx];
        const baseCol = lerpColor(pal.light, pal.dark, currentThemeDark);

        const invS = 1 / n.size;
        const nd = n.nodes;
        const p0x = (nd[0].x - n.x) * invS, p0y = -(nd[0].y - n.y) * invS;
        const p1x = (nd[1].x - n.x) * invS, p1y = -(nd[1].y - n.y) * invS;
        const p2x = (nd[2].x - n.x) * invS, p2y = -(nd[2].y - n.y) * invS;
        const p3x = (nd[3].x - n.x) * invS, p3y = -(nd[3].y - n.y) * invS;

        const curStemLen = Math.hypot(p2x - p0x, p2y - p0y);
        const restStemLen = 0.88;
        const stretchRatio = Math.max(0.75, Math.min(1.65, curStemLen / restStemLen));
        const thinning = 1.0 / Math.sqrt(stretchRatio);

        const stretchVecX = (nd[0].vx * 0.045) + (p1x - p0x - 0.20) * 0.35;
        const stretchVecY = (-nd[0].vy * 0.045) + (p1y - p0y - 0.42) * 0.35;
        const stretchMag = Math.hypot(stretchVecX, stretchVecY);
        const clampMag = Math.min(0.42, stretchMag);
        const hsX = stretchMag > 0.001 ? (stretchVecX / stretchMag) * clampMag : 0;
        const hsY = stretchMag > 0.001 ? (stretchVecY / stretchMag) * clampMag : 0;

        gl.uniform2f(jLoc.u_center, n.x, n.y);
        gl.uniform1f(jLoc.u_scale, n.size);
        gl.uniform1f(jLoc.u_type, n.type);
        gl.uniform1f(jLoc.u_alpha, 1.0);
        gl.uniform3f(jLoc.u_baseColor, baseCol[0], baseCol[1], baseCol[2]);

        gl.uniform2f(jLoc.u_p0, p0x, p0y);
        gl.uniform2f(jLoc.u_p1, p1x, p1y);
        gl.uniform2f(jLoc.u_p2, p2x, p2y);
        gl.uniform2f(jLoc.u_p3, p3x, p3y);
        gl.uniform2f(jLoc.u_headStretch, hsX, hsY);
        gl.uniform1f(jLoc.u_thinning, thinning);
        gl.uniform1f(jLoc.u_wobble, n.wobble);
        gl.uniform1f(jLoc.u_glowEnergy, n.glowEnergy);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      renderRaf3D = requestAnimationFrame(render3D);
    }

    // =========================================================================
    // 2D 性能模式实现 (Canvas 2D)
    // =========================================================================
    const blobs2D = [
      { x: w * 0.25, y: h * 0.35, vx: 0, vy: 0, r: 280, phase: 0.0, speed: 0.0008, colorDark: 'rgba(230, 0, 38, 0.12)', colorLight: 'rgba(255, 58, 58, 0.07)' },
      { x: w * 0.75, y: h * 0.65, vx: 0, vy: 0, r: 320, phase: 2.1, speed: 0.0006, colorDark: 'rgba(59, 130, 246, 0.10)', colorLight: 'rgba(37, 99, 235, 0.06)' },
      { x: w * 0.50, y: h * 0.80, vx: 0, vy: 0, r: 240, phase: 4.2, speed: 0.0007, colorDark: 'rgba(245, 158, 11, 0.08)', colorLight: 'rgba(245, 158, 11, 0.05)' }
    ];

    const NOTE_CHARS_2D = ['♪', '♫', '♬'];
    const NOTE_COLOR_PREFIXES_DARK = ['rgba(255, 71, 87, ', 'rgba(96, 165, 250, ', 'rgba(251, 191, 36, '];
    const NOTE_COLOR_PREFIXES_LIGHT = ['rgba(230, 0, 38, ', 'rgba(37, 99, 235, ', 'rgba(217, 119, 6, '];

    const noteCount2D = Math.min(18, Math.max(10, Math.floor((w * h) / 95000)));

    function createNote2D(idx) {
      return {
        char: NOTE_CHARS_2D[idx % NOTE_CHARS_2D.length],
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35,
        vy: -0.25 - Math.random() * 0.45,
        size: 16 + Math.random() * 14,
        alpha: 0.15 + Math.random() * 0.28,
        baseAlpha: 0.15 + Math.random() * 0.28,
        angle: (Math.random() - 0.5) * 0.4,
        vAngle: (Math.random() - 0.5) * 0.008,
        wobblePhase: Math.random() * Math.PI * 2,
        colorIdx: idx % 3
      };
    }

    const notes2D = Array.from({ length: noteCount2D }, (_, i) => createNote2D(i));
    const burstParticles2D = [];

    function triggerBurst2D(originX, originY) {
      const cx = originX != null ? originX : w * 0.15;
      const cy = originY != null ? originY : 60;
      const count = 18;

      for (let i = 0; i < count; i++) {
        const ang = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
        const spd = 2.5 + Math.random() * 4.5;
        burstParticles2D.push({
          char: NOTE_CHARS_2D[Math.floor(Math.random() * NOTE_CHARS_2D.length)],
          x: cx,
          y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 1.5,
          size: 16 + Math.random() * 12,
          rot: Math.random() * Math.PI * 2,
          vRot: (Math.random() - 0.5) * 0.12,
          alpha: 1.0,
          color: ['#ff4757', '#3b82f6', '#f59e0b', '#10b981'][Math.floor(Math.random() * 4)],
          life: 1.0
        });
      }
    }

    let renderRaf2D = null;
    let lastFrameTime2D = performance.now();
    let mouse2DX = w * 0.5, mouse2DY = h * 0.4;

    function render2D(now) {
      if (!window.__LOW_POWER_MODE__ || document.hidden || !ctx2D) {
        renderRaf2D = null;
        return;
      }

      const dt = lastFrameTime2D ? Math.min(32, now - lastFrameTime2D) : 16.67;
      lastFrameTime2D = now;
      const dtScale = dt / 16.67;
      const timeSec = now * 0.001;

      mouse2DX += (mouseX - mouse2DX) * (1 - Math.pow(1 - 0.08, dtScale));
      mouse2DY += (mouseY - mouse2DY) * (1 - Math.pow(1 - 0.08, dtScale));

      ctx2D.clearRect(0, 0, w, h);
      const isDark = (targetThemeDark > 0.5);

      // 1. 柔和极光流光球
      for (let i = 0; i < blobs2D.length; i++) {
        const b = blobs2D[i];
        const angle = timeSec * b.speed * 1000 + b.phase;
        const targetX = (w * 0.5) + Math.cos(angle) * (w * 0.35);
        const targetY = (h * 0.5) + Math.sin(angle * 1.3) * (h * 0.35);

        b.x += (targetX - b.x) * 0.02 * dtScale;
        b.y += (targetY - b.y) * 0.02 * dtScale;

        const radGrad = ctx2D.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        const col = isDark ? b.colorDark : b.colorLight;
        radGrad.addColorStop(0, col);
        radGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx2D.fillStyle = radGrad;
        ctx2D.beginPath();
        ctx2D.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx2D.fill();
      }

      // 2. 悬浮音符物理浮动与鼠标微避让
      ctx2D.textAlign = 'center';
      ctx2D.textBaseline = 'middle';
      const repulseRadius = 110 + Math.min(50, mouseSpeed * 1.0);

      for (let i = 0; i < notes2D.length; i++) {
        const n = notes2D[i];
        const dx = n.x - mouse2DX;
        const dy = n.y - mouse2DY;
        const dist = Math.hypot(dx, dy) || 1;

        if (dist < repulseRadius) {
          const force = (1 - dist / repulseRadius) * 1.6 * dtScale;
          n.vx += (dx / dist) * force;
          n.vy += (dy / dist) * force;
          n.alpha = Math.min(0.85, n.baseAlpha + force * 0.4);
        } else {
          n.alpha += (n.baseAlpha - n.alpha) * 0.04 * dtScale;
        }

        n.vx *= Math.pow(0.96, dtScale);
        n.vy = n.vy * Math.pow(0.98, dtScale) - 0.005 * dtScale;
        n.x += (n.vx + Math.sin(timeSec + n.wobblePhase) * 0.25) * dtScale;
        n.y += n.vy * dtScale;
        n.angle += n.vAngle * dtScale;

        const pad = 40;
        if (n.y < -pad) { n.y = h + pad; n.x = Math.random() * w; }
        if (n.y > h + pad) n.y = -pad;
        if (n.x < -pad) n.x = w + pad;
        if (n.x > w + pad) n.x = -pad;

        ctx2D.save();
        ctx2D.translate(n.x, n.y);
        ctx2D.rotate(n.angle);
        ctx2D.font = `${Math.floor(n.size)}px -apple-system, sans-serif`;

        const prefix = isDark ? NOTE_COLOR_PREFIXES_DARK[n.colorIdx] : NOTE_COLOR_PREFIXES_LIGHT[n.colorIdx];
        ctx2D.fillStyle = prefix + n.alpha.toFixed(2) + ')';
        ctx2D.fillText(n.char, 0, 0);
        ctx2D.restore();
      }

      // 3. 看板娘戳戳粒子迸发
      for (let i = burstParticles2D.length - 1; i >= 0; i--) {
        const p = burstParticles2D[i];
        p.vy += 0.12 * dtScale;
        p.vx *= Math.pow(0.98, dtScale);
        p.vy *= Math.pow(0.98, dtScale);
        p.x += p.vx * dtScale;
        p.y += p.vy * dtScale;
        p.rot += p.vRot * dtScale;
        p.life -= 0.018 * dtScale;
        p.alpha = Math.max(0, p.life);

        if (p.life <= 0) {
          burstParticles2D.splice(i, 1);
          continue;
        }

        ctx2D.save();
        ctx2D.translate(p.x, p.y);
        ctx2D.rotate(p.rot);
        ctx2D.font = `${Math.floor(p.size)}px -apple-system, sans-serif`;
        ctx2D.globalAlpha = p.alpha;
        ctx2D.fillStyle = p.color;
        ctx2D.fillText(p.char, 0, 0);
        ctx2D.restore();
      }

      renderRaf2D = requestAnimationFrame(render2D);
    }

    function start2D() {
      if (!ctx2D || document.hidden) return;
      if (!renderRaf2D) {
        lastFrameTime2D = performance.now();
        renderRaf2D = requestAnimationFrame(render2D);
      }
    }

    function stop2D() {
      if (renderRaf2D) {
        cancelAnimationFrame(renderRaf2D);
        renderRaf2D = null;
      }
    }

    function start3D() {
      if (isContextLost || !is3DInitialized || window.__LOW_POWER_MODE__ || document.hidden || !gl) return;
      if (!renderRaf3D) {
        lastFrameTime3D = performance.now();
        renderRaf3D = requestAnimationFrame(render3D);
      }
    }

    function stop3D() {
      if (renderRaf3D) {
        cancelAnimationFrame(renderRaf3D);
        renderRaf3D = null;
      }
    }

    // =========================================================================
    // 3D 物理与管线启动控制
    // =========================================================================
    function step4_initPhysicsAndLaunch() {
      if (window.Splash) window.Splash.setProgress(95);

      notes = Array.from({ length: noteCount }, (_, i) => createJellyNote(i));

      is3DInitialized = true;
      is3DCompiling = false;

      // 第一帧安全渲染
      if (!window.__LOW_POWER_MODE__) {
        canvas.style.opacity = '1';
        start3D();
      }

      // 遮罩平滑淡出完成
      if (window.Splash) {
        window.Splash.dismiss();
      }
    }

    function init3DPipeline() {
      if (is3DInitialized || is3DCompiling || !gl || isContextLost) return;
      // 若处于低功耗模式，绝不做多余的 WebGL 着色器编译和 FBO 创建
      if (window.__LOW_POWER_MODE__) return;

      is3DCompiling = true;
      requestAnimationFrame(() => {
        setTimeout(step1_initFBOAndBuffers, 40);
      });
    }

    // 全局鼠标/触摸指针动力学跟踪（钳制超大位移突刺）
    let idleTimer = null;
    function onPointerMove(e) {
      const nx = e.clientX, ny = e.clientY;
      const rawVx = nx - mouseX;
      const rawVy = ny - mouseY;
      mouseVx = Math.max(-65, Math.min(65, rawVx));
      mouseVy = Math.max(-65, Math.min(65, rawVy));
      mouseSpeed = Math.hypot(mouseVx, mouseVy);
      mouseX = nx;
      mouseY = ny;

      targetMouseInfluence = 1;
      targetEnergy = Math.min(1.4, targetEnergy + 0.015);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { targetMouseInfluence = 0; }, 1200);
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    // 注册看板娘彩蛋（增加防双重触发保护）
    function onPokeAvatarEvent(e) {
      if (window.pokeAvatar && window.pokeAvatar.__bg_wrapped__) return;
      const x = (e.detail && typeof e.detail.x === 'number') ? e.detail.x : 60;
      const y = (e.detail && typeof e.detail.y === 'number') ? e.detail.y : 40;
      if (window.__LOW_POWER_MODE__) {
        triggerBurst2D(x, y);
      } else {
        triggerBurst3D(x, y);
      }
    }
    window.addEventListener('ncm:poke-avatar', onPokeAvatarEvent);

    wrapPokeAvatar();
    window.addEventListener('DOMContentLoaded', wrapPokeAvatar);

    // 容灾机制：真·上下文重建
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      isContextLost = true;
      stop3D();
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
      isContextLost = false;
      const restoredOk = initGLResources();
      if (!restoredOk) {
        fallbackTo2D();
        return;
      }
      resize();
      if (!window.__LOW_POWER_MODE__ && !document.hidden) {
        start3D();
      }
    });

    function onVisibilityChange() {
      if (document.hidden) {
        stop3D();
        stop2D();
      } else {
        if (window.__LOW_POWER_MODE__) {
          start2D();
        } else {
          start3D();
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    function onLowPowerChange(e) {
      const isLowPower = !!(e.detail && e.detail.lowPower);
      if (isLowPower) {
        stop3D();
        canvas.style.display = 'none';
        canvas2D.style.display = 'block';
        start2D();
      } else {
        stop2D();
        canvas2D.style.display = 'none';
        canvas.style.display = 'block';
        if (!is3DInitialized) {
          init3DPipeline();
        } else {
          start3D();
        }
      }
    }
    window.addEventListener('ncm:low-power-change', onLowPowerChange);

    // 根据初始模式启动相应引擎
    if (window.__LOW_POWER_MODE__ || !gl) {
      canvas.style.display = 'none';
      canvas2D.style.display = 'block';
      start2D();
      if (window.Splash) window.Splash.dismiss();
    } else {
      canvas.style.display = 'block';
      canvas2D.style.display = 'none';
      init3DPipeline();
    }

    // 暴露干净的全局控制接口与完整的销毁清理能力
    window.GlslBgEngine = {
      canvas,
      canvas2D,
      burst: (x, y) => {
        if (window.__LOW_POWER_MODE__) {
          triggerBurst2D(x, y);
        } else {
          triggerBurst3D(x, y);
        }
      },
      isSupported: !window.__LOW_POWER_MODE__ && !!gl,
      stop: () => {
        stop3D();
        stop2D();
      },
      start: () => {
        if (window.__LOW_POWER_MODE__) {
          start2D();
        } else {
          start3D();
        }
      },
      destroy: () => {
        stop3D();
        stop2D();
        if (themeObserver) themeObserver.disconnect();
        window.removeEventListener('resize', onWindowResize);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('ncm:poke-avatar', onPokeAvatarEvent);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('ncm:low-power-change', onLowPowerChange);
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        if (canvas2D && canvas2D.parentNode) canvas2D.parentNode.removeChild(canvas2D);
        if (gl && !isContextLost) {
          const ext = gl.getExtension('WEBGL_lose_context');
          if (ext) ext.loseContext();
        }
        window.GlslBgEngine = null;
      }
    };

  } catch (fatalError) {
    console.error('[GlslBgEngine] Uncaught engine error, gracefully halted:', fatalError);
    if (window.Splash) window.Splash.dismiss();
  }
})();
