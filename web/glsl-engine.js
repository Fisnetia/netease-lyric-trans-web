// ============================================================================
// web/glsl-engine.js - 背景动效引擎 (3D WebGL / 2D Canvas)
// 模式 1：3D 模式 (WebGL 光线步进与物理动效)
// 模式 2：2D 性能模式 (Canvas 2D 渐变与粒子)
// ============================================================================

(function initMusicCanvasBgEngine() {
  'use strict';

  // 1. 无障碍模式检测（减弱动态效果设置）
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    console.info('[GlslBgEngine] prefers-reduced-motion active, background engine bypassed.');
    if (window.Splash) window.Splash.dismiss();
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
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '-1',
      opacity: '0',
      transition: 'opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1)'
    });

    const canvas2D = document.createElement('canvas');
    canvas2D.id = 'ncmBgCanvas2D';
    Object.assign(canvas2D.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
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
      gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
    } catch (_) {
      gl = null;
    }

    let isContextLost = false;

    let fbo = null, bgTex = null;
    function initFBO(width, height) {
      if (isContextLost || !gl) return;
      if (bgTex) gl.deleteTexture(bgTex);
      if (fbo) gl.deleteFramebuffer(fbo);

      bgTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bgTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);

      // 调整 3D WebGL Canvas
      if (canvas && gl && !isContextLost) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        gl.viewport(0, 0, canvas.width, canvas.height);
        initFBO(canvas.width, canvas.height);
      }

      // 调整 2D Canvas
      if (canvas2D && ctx2D) {
        canvas2D.width = Math.floor(w * dpr);
        canvas2D.height = Math.floor(h * dpr);
        ctx2D.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    resize();
    window.addEventListener('resize', resize, { passive: true });

    function createProgram(vsSrc, fsSrc) {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vsSrc);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        console.warn('[GlslBgEngine] VS compile error:', gl.getShaderInfoLog(vs));
      }

      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsSrc);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.warn('[GlslBgEngine] FS compile error:', gl.getShaderInfoLog(fs));
      }

      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.warn('[GlslBgEngine] Program link error:', gl.getProgramInfoLog(prog));
      }
      return prog;
    }

    // -------------------------------------------------------------------------
    // Pass 1：背景层（三颗差速过冲光球 + 底部高斯平滑声波 + 声学等高线）
    // -------------------------------------------------------------------------
    const bgVs = `
      attribute vec2 a_pos;
      void main() {
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;
    const bgFs = `
      precision highp float;
      uniform vec2 u_res;
      uniform float u_dpr;
      uniform float u_time;
      uniform float u_isDark;
      uniform float u_energy;
      uniform float u_waveMouseX;
      uniform float u_waveInf;
      uniform vec4 u_blobs[3];
      uniform vec3 u_blobColors[3];

      // 声学等高线标量场
      float topoField(vec2 p, float t) {
        vec2 uv = p * 0.0021;
        float v = sin(uv.x * 2.2 + t * 0.14 + sin(uv.y * 1.7 - t * 0.10))
                + cos(uv.y * 2.1 - t * 0.12 + cos(uv.x * 1.5 + t * 0.09)) * 0.85
                + sin((uv.x - uv.y) * 1.4 + t * 0.11) * 0.55;
        return v;
      }

      void main() {
        vec2 px = vec2(gl_FragCoord.x / u_dpr, u_res.y - gl_FragCoord.y / u_dpr);
        vec3 premulCol = vec3(0.0);
        float totalAlpha = 0.0;

        // 1. 渲染三颗液态追逐光球
        vec3 blobTint = u_isDark > 0.5 ? vec3(0.45, 0.52, 0.68) : vec3(0.48, 0.52, 0.62);
        float blobBoost = 0.0;

        for (int i = 0; i < 3; i++) {
          vec2 bPos = u_blobs[i].xy;
          float bRad = u_blobs[i].z;
          float bPeak = u_blobs[i].w;
          float dist = length(px - bPos);
          if (dist < bRad) {
            float t = 1.0 - dist / bRad;
            float a = t * t * (3.0 - 2.0 * t) * bPeak;
            vec3 c = u_blobColors[i];
            premulCol = premulCol + c * a * (1.0 - totalAlpha * 0.35);
            totalAlpha = totalAlpha + a * (1.0 - totalAlpha);
            blobTint = mix(blobTint, c, t * 0.75);
            blobBoost = max(blobBoost, t);
          }
        }

        // 2. 声学等高线底纹（写入 FBO 供 3D 果冻透镜折射放大）
        float tf = topoField(px, u_time);
        float tfDx = topoField(px + vec2(1.5, 0.0), u_time) - tf;
        float tfDy = topoField(px + vec2(0.0, 1.5), u_time) - tf;
        float gradLen = max(0.0018, length(vec2(tfDx, tfDy)));

        float cell = tf * 2.6;
        float distToLine = abs(fract(cell) - 0.5) / (gradLen * 2.6);
        float lineMask = smoothstep(1.35, 0.25, distToLine);

        float majorDist = abs(fract(cell * 0.25) - 0.5) / (gradLen * 0.65);
        float majorMask = smoothstep(1.6, 0.3, majorDist);
        float finalTopo = max(lineMask * 0.55, majorMask);

        float topoBaseA = (u_isDark > 0.5 ? 0.055 : 0.065) + blobBoost * 0.085;
        float topoA = finalTopo * topoBaseA;
        premulCol = premulCol * (1.0 - topoA) + blobTint * topoA;
        totalAlpha = totalAlpha + topoA * (1.0 - totalAlpha);

        // 3. 屏幕底部 3 条高斯平滑声波丝绸
        float sigma2 = 2.0 * 280.0 * 280.0;
        float dx = px.x - u_waveMouseX;
        float gaussian = exp(-(dx * dx) / sigma2) * u_waveInf;

        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          float baseY = u_res.y * 0.82 + fi * 26.0;
          float amp = (i == 0 ? 32.0 : (i == 1 ? 38.0 : 26.0));
          float freq = (i == 0 ? 0.0018 : (i == 1 ? 0.0014 : 0.0022));
          float spd = (i == 0 ? 1.0 : (i == 1 ? -0.75 : 1.25));
          float off = fi * 2.1;

          float localAmp = (amp + gaussian * 18.0) * u_energy;
          float waveY = baseY
            + sin(px.x * freq + u_time * spd + off) * localAmp
            + cos(px.x * freq * 1.6 - u_time * 0.4 + fi) * (12.0 * u_energy);

          vec3 wCol = u_blobColors[i];
          float wBaseA = u_isDark > 0.5
            ? (i == 0 ? 0.20 : (i == 1 ? 0.16 : 0.14))
            : (i == 0 ? 0.12 : (i == 1 ? 0.09 : 0.08));

          float distLine = abs(px.y - waveY);
          if (distLine < 2.4) {
            float la = smoothstep(2.4, 0.0, distLine) * wBaseA * 1.5;
            premulCol = premulCol * (1.0 - la) + wCol * la;
            totalAlpha = totalAlpha + la * (1.0 - totalAlpha);
          }
          if (px.y > waveY) {
            float fillT = clamp(1.0 - (px.y - waveY) / (u_res.y - baseY + 60.0), 0.0, 1.0);
            float fa = fillT * wBaseA * 0.75;
            premulCol = premulCol * (1.0 - fa) + wCol * fa;
            totalAlpha = totalAlpha + fa * (1.0 - totalAlpha);
          }
        }

        gl_FragColor = vec4(premulCol, totalAlpha);
      }
    `;

    // -------------------------------------------------------------------------
    // Pass 2：3D 光线步进音符着色器
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
      precision highp float;
      varying vec2 v_uv;
      varying vec2 v_screenUV;

      uniform sampler2D u_bgTex;
      uniform float u_time;
      uniform float u_isDark;
      uniform float u_type;
      uniform float u_alpha;
      uniform vec3 u_baseColor;

      // 4 个实时物理骨骼质点的局部坐标
      uniform vec2 u_p0;
      uniform vec2 u_p1;
      uniform vec2 u_p2;
      uniform vec2 u_p3;
      uniform vec2 u_headStretch; // 音符豆受拉扯时的水滴形变向量
      uniform float u_thinning;   // 泊松体积守恒：身体被拉长时圆管自动变细
      uniform float u_wobble;     // 表面微颤

      float smin(float a, float b, float k) {
        float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
        return mix(b, a, h) - k * h * (1.0 - h);
      }

      float sdCapsule3D(vec3 p, vec3 a, vec3 b, float r) {
        vec3 pa = p - a, ba = b - a;
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        return length(pa - ba * h) - r;
      }

      // 支持沿拉扯方向动态水滴拉伸的 3D 椭球音符头
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

      // 用 3 段平滑胶囊拟合 3D 弯曲软糖触手曲线
      float sdCurvedStem3D(vec3 p, vec3 A, vec3 B, vec3 C, float r) {
        vec3 m1 = mix(mix(A, B, 0.35), mix(B, C, 0.35), 0.35);
        vec3 m2 = mix(mix(A, B, 0.68), mix(B, C, 0.68), 0.68);
        float d1 = sdCapsule3D(p, A, m1, r);
        float d2 = sdCapsule3D(p, m1, m2, r);
        float d3 = sdCapsule3D(p, m2, C, r);
        return smin(d1, smin(d2, d3, 0.045), 0.045);
      }

      float map3D(vec3 p) {
        float tubeR = 0.092 * u_thinning;

        if (u_type < 0.5) {
          // 样式 0：单八分音符 (♪)
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
          // 样式 1：双连音符 (♫)
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
          // 样式 2：双旗十六分音符 (♬)
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

        // 次表面透光亮瓤
        vec3 L = normalize(vec3(-0.52, 0.65, 0.55));
        float backScatter = max(0.0, dot(rdIn, -L)) * max(0.0, dot(N.xy, vec2(0.52, -0.65)));
        float caustic = pow(backScatter, 1.6) * smoothstep(0.1, 0.6, opticalDepth) * 0.35;
        vec3 sssGlow = mix(u_baseColor, vec3(1.0), 0.75) * caustic;

        // 柔光箱高光与菲涅尔反射
        vec3 R = reflect(rd, N);
        vec3 studioRefl = sampleStudioEnv(R);
        float fresnel = 0.02 + 0.32 * pow(1.0 - cosTheta, 3.0);

        vec3 finalCol = gummyVolumeCol + sssGlow + studioRefl * 0.52 + vec3(fresnel * (u_isDark > 0.5 ? 0.20 : 0.08));
        finalCol = clamp(finalCol, 0.0, 1.0);

        float edgeAA = smoothstep(0.02, 0.08, cosTheta);
        float baseOp = u_isDark > 0.5 ? 0.39 : 0.47;
        float jellyAlpha = clamp(baseOp + opticalDepth * 0.12 + grazingRim * 0.28, 0.0, 0.77) * edgeAA * u_alpha;

        gl_FragColor = vec4(finalCol * jellyAlpha, jellyAlpha);
      }
    `;

    // =========================================================================
    // 异步分步初始化流程
    // =========================================================================
    let bgProg, jellyProg;
    let bgBuf, jellyBuf;
    let bgLoc = {}, jLoc = {};

    function step1_initFBOAndBuffers() {
      if (!gl || isContextLost) return;
      if (window.Splash) window.Splash.setProgress(25);

      resize();

      bgBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

      const R = 2.65;
      jellyBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, jellyBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-R, -R, R, -R, -R, R, -R, R, R, -R, R, R]), gl.STATIC_DRAW);

      setTimeout(step2_compileBgProg, 25);
    }

    function step2_compileBgProg() {
      if (window.Splash) window.Splash.setProgress(55);

      bgProg = createProgram(bgVs, bgFs);
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

      setTimeout(step3_compileJellyProg, 25);
    }

    function step3_compileJellyProg() {
      if (window.Splash) window.Splash.setProgress(80);

      jellyProg = createProgram(jellyVs, jellyFs);
      jLoc = {
        a_uv: gl.getAttribLocation(jellyProg, 'a_uv'),
        u_bgTex: gl.getUniformLocation(jellyProg, 'u_bgTex'),
        u_res: gl.getUniformLocation(jellyProg, 'u_res'),
        u_center: gl.getUniformLocation(jellyProg, 'u_center'),
        u_scale: gl.getUniformLocation(jellyProg, 'u_scale'),
        u_time: gl.getUniformLocation(jellyProg, 'u_time'),
        u_isDark: gl.getUniformLocation(jellyProg, 'u_isDark'),
        u_type: gl.getUniformLocation(jellyProg, 'u_type'),
        u_alpha: gl.getUniformLocation(jellyProg, 'u_alpha'),
        u_baseColor: gl.getUniformLocation(jellyProg, 'u_baseColor'),
        u_p0: gl.getUniformLocation(jellyProg, 'u_p0'),
        u_p1: gl.getUniformLocation(jellyProg, 'u_p1'),
        u_p2: gl.getUniformLocation(jellyProg, 'u_p2'),
        u_p3: gl.getUniformLocation(jellyProg, 'u_p3'),
        u_headStretch: gl.getUniformLocation(jellyProg, 'u_headStretch'),
        u_thinning: gl.getUniformLocation(jellyProg, 'u_thinning'),
        u_wobble: gl.getUniformLocation(jellyProg, 'u_wobble')
      };

      setTimeout(step4_initPhysicsAndLaunch, 25);
    }

    // =========================================================================
    // 物理状态与实体初始化
    // =========================================================================
    let time = 0;
    let energy = 1, targetEnergy = 1;
    let mouseX = w * 0.5, mouseY = h * 0.45;
    let mouseVx = 0, mouseVy = 0, mouseSpeed = 0;
    let smoothWaveX = w * 0.5, mouseInfluence = 0, targetMouseInfluence = 0;

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

    function getRotatedRestOffset(type, nodeIdx, angle, size) {
      const raw = REST_POSES[type][nodeIdx];
      const c = Math.cos(angle), s = Math.sin(angle);
      const rx = raw[0] * c - raw[1] * s;
      const ry = raw[0] * s + raw[1] * c;
      return { x: rx * size, y: -ry * size };
    }

    function createJellyNote(idx) {
      const type = idx % 3;
      const baseSize = 25 + Math.random() * 5;
      const cx = Math.random() * w;
      const cy = Math.random() * h;
      const baseAngle = (Math.random() - 0.5) * 0.4;

      const nodes = [0, 1, 2, 3].map(k => {
        const off = getRotatedRestOffset(type, k, baseAngle, baseSize);
        return { x: cx + off.x, y: cy + off.y, vx: 0, vy: 0 };
      });

      return {
        x: cx, y: cy,
        type,
        colorIdx: idx % 3,
        size: baseSize,
        colR: baseSize * 0.95,
        mass: baseSize * baseSize,
        baseVx: (Math.random() - 0.5) * 0.28,
        baseVy: -0.12 - Math.random() * 0.18,
        baseAngle,
        angle: baseAngle,
        vAngle: 0,
        nodes,
        wobble: 0,
        glowEnergy: 0,
        wobblePhase: Math.random() * Math.PI * 2
      };
    }

    function shiftNote(n, dx, dy) {
      n.x += dx; n.y += dy;
      for (let k = 0; k < 4; k++) {
        n.nodes[k].x += dx;
        n.nodes[k].y += dy;
      }
    }

    function triggerBurst3D(originX = 60, originY = 40) {
      targetEnergy = 2.1;
      blobs.forEach((b, i) => {
        const ang = (i * Math.PI * 2) / 3 + 0.3;
        b.vx += Math.cos(ang) * (25 + i * 10);
        b.vy += Math.sin(ang) * (25 + i * 10);
      });
      notes.forEach(n => {
        const dx = n.x - originX, dy = n.y - originY;
        const dist = Math.hypot(dx, dy) || 1;
        if (dist < 450) {
          const force = (1 - dist / 450) * 11;
          n.nodes[0].vx += (dx / dist) * force * 1.4;
          n.nodes[0].vy += (dy / dist) * force * 1.4;
          n.wobble = 1.0;
          n.glowEnergy = 1.0;
        }
      });
    }

    function wrapPokeAvatar() {
      const origPoke = window.pokeAvatar;
      if (typeof origPoke === 'function' && !origPoke.__bg_wrapped__) {
        window.pokeAvatar = function () {
          try { origPoke.apply(this, arguments); } catch (e) {}
          const avatarRect = document.getElementById('brandAvatar')?.getBoundingClientRect();
          const x = avatarRect ? (avatarRect.left + avatarRect.width / 2) : 60;
          const y = avatarRect ? (avatarRect.top + avatarRect.height / 2) : 40;
          if (window.__LOW_POWER_MODE__) {
            triggerBurst2D(x, y);
          } else {
            triggerBurst3D(x, y);
          }
        };
        window.pokeAvatar.__bg_wrapped__ = true;
      }
    }

    // =========================================================================
    // 深浅主题状态独立跟踪（解耦 ui.js，平滑过渡）
    // =========================================================================
    function getThemeDarkTarget() {
      const cur = document.documentElement.getAttribute('data-theme');
      return (cur === 'light' ? 0.0 : 1.0);
    }

    let currentThemeDark = getThemeDarkTarget();
    let targetThemeDark = currentThemeDark;

    function syncTheme() {
      targetThemeDark = getThemeDarkTarget();
    }

    try {
      const themeObserver = new MutationObserver(() => syncTheme());
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
    window.addEventListener('ncm:theme-change', syncTheme);

    let renderRaf3D = null;

    function render3D(now) {
      if (window.__LOW_POWER_MODE__ || isContextLost || document.hidden) {
        renderRaf3D = null;
        return;
      }

      currentThemeDark += (targetThemeDark - currentThemeDark) * 0.14;
      const isDark = currentThemeDark;

      mouseVx *= 0.82;
      mouseVy *= 0.82;
      mouseSpeed *= 0.85;

      smoothWaveX += (mouseX - smoothWaveX) * 0.05;
      mouseInfluence += (targetMouseInfluence - mouseInfluence) * 0.04;
      energy += (targetEnergy - energy) * 0.06;
      targetEnergy += (1 - targetEnergy) * 0.03;
      time += 0.015 * energy;

      // 1. 更新三色光球物理
      const blobVec4 = new Float32Array(12);
      const blobColVec3 = new Float32Array(9);

      blobs.forEach((b, idx) => {
        const orbitAngle = time * 1.15 + b.phase;
        const tx = mouseX + Math.cos(orbitAngle) * b.orbitR;
        const ty = mouseY + Math.sin(orbitAngle) * b.orbitR;
        const dx = tx - b.x, dy = ty - b.y;
        const dist = Math.hypot(dx, dy) || 0.001;

        if (dist > b.arrivalR) {
          b.vx = (b.vx + (dx / dist) * b.arrivalR * b.k) * b.cruiseDamp;
          b.vy = (b.vy + (dy / dist) * b.arrivalR * b.k) * b.cruiseDamp;
          const spd = Math.hypot(b.vx, b.vy);
          if (spd > b.cruiseV) {
            b.vx = (b.vx / spd) * b.cruiseV;
            b.vy = (b.vy / spd) * b.cruiseV;
          }
        } else {
          b.vx = (b.vx + dx * b.k) * b.arriveDamp;
          b.vy = (b.vy + dy * b.k) * b.arriveDamp;
        }

        b.x += b.vx; b.y += b.vy;
        const peakAlpha = isDark > 0.5 ? (idx === 0 ? 0.28 : 0.23) : (idx === 0 ? 0.20 : 0.16);
        blobVec4[idx * 4 + 0] = b.x;
        blobVec4[idx * 4 + 1] = b.y;
        blobVec4[idx * 4 + 2] = b.r;
        blobVec4[idx * 4 + 3] = peakAlpha;

        const c = isDark > 0.5 ? b.colDark : b.colLight;
        blobColVec3[idx * 3 + 0] = c[0];
        blobColVec3[idx * 3 + 1] = c[1];
        blobColVec3[idx * 3 + 2] = c[2];
      });

      // 2. 更新 3D 果冻音符 4 质点物理与弹簧链条
      const repulseR = 135 + Math.min(60, mouseSpeed * 1.5);

      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        const nodes = n.nodes;
        const head = nodes[0];
        const dx = head.x - mouseX, dy = head.y - mouseY;
        const dist = Math.hypot(dx, dy) || 0.001;

        if (dist < repulseR && mouseSpeed > 0.35) {
          const proximity = 1 - dist / repulseR;
          const pushForce = proximity * proximity * Math.min(1.15, mouseSpeed * 0.032);
          const nx = dx / dist, ny = dy / dist;
          head.vx += nx * pushForce + (mouseVx * 0.016 * proximity);
          head.vy += ny * pushForce + (mouseVy * 0.016 * proximity);

          if (n.type === 1) {
            nodes[1].vx += (nx * pushForce + mouseVx * 0.016 * proximity) * 0.45;
            nodes[1].vy += (ny * pushForce + mouseVy * 0.016 * proximity) * 0.45;
          }
          n.glowEnergy = Math.min(1.0, n.glowEnergy + proximity * Math.min(0.35, mouseSpeed * 0.015));
        }

        n.angle = n.baseAngle + Math.sin(time * 0.7 + n.wobblePhase) * 0.10;
        const chains = SPRING_CHAINS[n.type];

        for (let cIdx = 0; cIdx < chains.length; cIdx++) {
          const [iA, iB, kSpring, damp, backPull] = chains[cIdx];
          const pA = nodes[iA], pB = nodes[iB];
          const offA = getRotatedRestOffset(n.type, iA, n.angle, n.size);
          const offB = getRotatedRestOffset(n.type, iB, n.angle, n.size);
          const restDx = offB.x - offA.x;
          const restDy = offB.y - offA.y;
          const restLen = Math.hypot(restDx, restDy) || 1;

          const targetBx = pA.x + restDx;
          const targetBy = pA.y + restDy;

          const fx = (targetBx - pB.x) * kSpring;
          const fy = (targetBy - pB.y) * kSpring;
          pB.vx = (pB.vx + fx) * damp;
          pB.vy = (pB.vy + fy) * damp;
          pA.vx -= fx * backPull;
          pA.vy -= fy * backPull;

          const curDx = pB.x - pA.x;
          const curDy = pB.y - pA.y;
          const curLen = Math.hypot(curDx, curDy) || 0.001;
          const maxLen = restLen * 2.15;
          if (curLen > maxLen) {
            const excess = (curLen - maxLen) * 0.25;
            const ux = curDx / curLen, uy = curDy / curLen;
            pB.x -= ux * excess;
            pB.y -= uy * excess;
          }
        }

        const driftVx = n.baseVx + Math.sin(time * 0.6 + n.wobblePhase) * 0.12;
        const driftVy = n.baseVy + Math.cos(time * 0.5 + n.wobblePhase) * 0.10;

        let sumX = 0, sumY = 0;
        for (let k = 0; k < 4; k++) {
          const nd = nodes[k];
          if (k === 0) {
            nd.vx = nd.vx * 0.985 + driftVx * 0.015;
            nd.vy = nd.vy * 0.985 + driftVy * 0.015;
          }
          nd.x += nd.vx; nd.y += nd.vy;
          sumX += nd.x; sumY += nd.y;
        }

        n.x = sumX * 0.25; n.y = sumY * 0.25;
        n.wobble = 0;
        n.glowEnergy *= 0.982;

        const pad = 65;
        if (n.x < -pad) shiftNote(n, w + pad * 2, 0);
        else if (n.x > w + pad) shiftNote(n, -(w + pad * 2), 0);
        if (n.y < -pad) shiftNote(n, 0, h + pad * 2);
        else if (n.y > h + pad) shiftNote(n, 0, -(h + pad * 2));
      }

      // 音符之间的弹性碰撞与果冻颤动反应
      for (let i = 0; i < notes.length; i++) {
        const a = notes[i];
        for (let j = i + 1; j < notes.length; j++) {
          const b = notes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const minDist = a.colR + b.colR;
          if (Math.abs(dx) >= minDist || Math.abs(dy) >= minDist) continue;

          const dist = Math.hypot(dx, dy) || 0.001;
          if (dist < minDist) {
            const nx = dx / dist, ny = dy / dist;
            const overlap = (minDist - dist) * 0.52;
            shiftNote(a, -nx * overlap, -ny * overlap);
            shiftNote(b, nx * overlap, ny * overlap);

            const rvx = b.nodes[0].vx - a.nodes[0].vx;
            const rvy = b.nodes[0].vy - a.nodes[0].vy;
            const velAlongNormal = rvx * nx + rvy * ny;
            if (velAlongNormal < 0) {
              const impulse = -1.85 * velAlongNormal * 0.5;
              const ix = impulse * nx, iy = impulse * ny;

              a.nodes[0].vx -= ix * 1.3; a.nodes[0].vy -= iy * 1.3;
              a.nodes[1].vx -= ix * 0.5; a.nodes[1].vy -= iy * 0.5;
              b.nodes[0].vx += ix * 1.3; b.nodes[0].vy += iy * 1.3;
              b.nodes[1].vx += ix * 0.5; b.nodes[1].vy += iy * 0.5;

              const hit = Math.min(1.0, Math.abs(velAlongNormal) * 0.28);
              a.wobble = Math.min(1, a.wobble + hit);
              b.wobble = Math.min(1, b.wobble + hit);

              const sharedGlow = Math.max(a.glowEnergy, b.glowEnergy, Math.min(0.9, Math.abs(velAlongNormal) * 0.3));
              a.glowEnergy = Math.max(a.glowEnergy, sharedGlow * 0.92);
              b.glowEnergy = Math.max(b.glowEnergy, sharedGlow * 0.92);
            }
          }
        }
      }

      // 3. 多通道渲染
      function drawBackdrop() {
        gl.disable(gl.BLEND);
        gl.useProgram(bgProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
        gl.enableVertexAttribArray(bgLoc.a_pos);
        gl.vertexAttribPointer(bgLoc.a_pos, 2, gl.FLOAT, false, 0, 0);

        gl.uniform2f(bgLoc.u_res, w, h);
        gl.uniform1f(bgLoc.u_dpr, dpr);
        gl.uniform1f(bgLoc.u_time, time);
        gl.uniform1f(bgLoc.u_isDark, isDark);
        gl.uniform1f(bgLoc.u_energy, energy);
        gl.uniform1f(bgLoc.u_waveMouseX, smoothWaveX);
        gl.uniform1f(bgLoc.u_waveInf, mouseInfluence);
        gl.uniform4fv(bgLoc.u_blobs, blobVec4);
        gl.uniform3fv(bgLoc.u_blobColors, blobColVec3);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      // Pass 1: 渲染背景到底层 FBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawBackdrop();

      // Pass 2: 渲染背景到屏幕
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawBackdrop();

      // Pass 3: 渲染 3D 光线步进音符实体
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(jellyProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, jellyBuf);
      gl.enableVertexAttribArray(jLoc.a_uv);
      gl.vertexAttribPointer(jLoc.a_uv, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.uniform1i(jLoc.u_bgTex, 0);
      gl.uniform2f(jLoc.u_res, w, h);
      gl.uniform1f(jLoc.u_time, time);
      gl.uniform1f(jLoc.u_isDark, isDark);

      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];

        // 视口粗裁剪：大幅超出屏幕缓冲区的音符跳过步进计算
        const pad = n.size * 2.2;
        if (n.x < -pad || n.x > w + pad || n.y < -pad || n.y > h + pad) continue;

        // 果冻常显模式：所有 3D 果冻音符始终常驻显示，受交互激波时高光物理颤动
        const finalAlpha = 1.0;

        const pal = CANDY_PALETTE[n.colorIdx];
        const baseCol = isDark > 0.5 ? pal.dark : pal.light;

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
        gl.uniform1f(jLoc.u_alpha, finalAlpha);
        gl.uniform3f(jLoc.u_baseColor, baseCol[0], baseCol[1], baseCol[2]);

        gl.uniform2f(jLoc.u_p0, p0x, p0y);
        gl.uniform2f(jLoc.u_p1, p1x, p1y);
        gl.uniform2f(jLoc.u_p2, p2x, p2y);
        gl.uniform2f(jLoc.u_p3, p3x, p3y);
        gl.uniform2f(jLoc.u_headStretch, hsX, hsY);
        gl.uniform1f(jLoc.u_thinning, thinning);
        gl.uniform1f(jLoc.u_wobble, n.wobble);

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

      const dt = Math.min(32, now - lastFrameTime2D);
      lastFrameTime2D = now;
      const timeSec = now * 0.001;

      mouse2DX += (mouseX - mouse2DX) * 0.08;
      mouse2DY += (mouseY - mouse2DY) * 0.08;

      ctx2D.clearRect(0, 0, w, h);
      const isDark = (document.documentElement.getAttribute('data-theme') !== 'light');

      // 1. 柔和极光流光球
      for (let i = 0; i < blobs2D.length; i++) {
        const b = blobs2D[i];
        const angle = timeSec * b.speed * 1000 + b.phase;
        const targetX = (w * 0.5) + Math.cos(angle) * (w * 0.35);
        const targetY = (h * 0.5) + Math.sin(angle * 1.3) * (h * 0.35);

        b.x += (targetX - b.x) * 0.02;
        b.y += (targetY - b.y) * 0.02;

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
          const force = (1 - dist / repulseRadius) * 1.6;
          n.vx += (dx / dist) * force;
          n.vy += (dy / dist) * force;
          n.alpha = Math.min(0.85, n.baseAlpha + force * 0.4);
        } else {
          n.alpha += (n.baseAlpha - n.alpha) * 0.04;
        }

        n.vx *= 0.96;
        n.vy = n.vy * 0.98 - 0.005;
        n.x += n.vx + Math.sin(timeSec + n.wobblePhase) * 0.25;
        n.y += n.vy;
        n.angle += n.vAngle;

        const pad = 40;
        if (n.y < -pad) { n.y = h + pad; n.x = Math.random() * w; }
        if (n.y > h + pad) n.y = -pad;
        if (n.x < -pad) n.x = w + pad;
        if (n.x > w + pad) n.x = -pad;

        ctx2D.save();
        ctx2D.translate(n.x, n.y);
        ctx2D.rotate(n.angle);
        ctx2D.font = `${Math.floor(n.size)}px -apple-system, sans-serif`;

        const noteColor = isDark
          ? (n.colorIdx === 0 ? `rgba(255, 71, 87, ${n.alpha})` : (n.colorIdx === 1 ? `rgba(96, 165, 250, ${n.alpha})` : `rgba(251, 191, 36, ${n.alpha})`))
          : (n.colorIdx === 0 ? `rgba(230, 0, 38, ${n.alpha})` : (n.colorIdx === 1 ? `rgba(37, 99, 235, ${n.alpha})` : `rgba(217, 119, 6, ${n.alpha})`));

        ctx2D.fillStyle = noteColor;
        ctx2D.fillText(n.char, 0, 0);
        ctx2D.restore();
      }

      // 3. 看板娘戳戳粒子迸发
      for (let i = burstParticles2D.length - 1; i >= 0; i--) {
        const p = burstParticles2D[i];
        p.vy += 0.12;
        p.vx *= 0.98;
        p.vy *= 0.98;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vRot;
        p.life -= 0.022;

        if (p.life <= 0) {
          burstParticles2D.splice(i, 1);
          continue;
        }

        ctx2D.save();
        ctx2D.translate(p.x, p.y);
        ctx2D.rotate(p.rot);
        ctx2D.font = `bold ${Math.floor(p.size)}px -apple-system, sans-serif`;
        ctx2D.fillStyle = p.color;
        ctx2D.globalAlpha = Math.max(0, p.life);
        ctx2D.fillText(p.char, 0, 0);
        ctx2D.restore();
      }

      renderRaf2D = requestAnimationFrame(render2D);
    }

    function start2D() {
      if (!ctx2D || !window.__LOW_POWER_MODE__ || document.hidden) return;
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
    let is3DInitialized = false;
    let is3DCompiling = false;

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
      is3DCompiling = true;
      requestAnimationFrame(() => {
        setTimeout(step1_initFBOAndBuffers, 40);
      });
    }

    // 全局鼠标/触摸指针动力学跟踪
    let idleTimer = null;
    window.addEventListener('pointermove', e => {
      const nx = e.clientX, ny = e.clientY;
      mouseVx = nx - mouseX;
      mouseVy = ny - mouseY;
      mouseSpeed = Math.min(65, Math.hypot(mouseVx, mouseVy));
      mouseX = nx;
      mouseY = ny;

      targetMouseInfluence = 1;
      targetEnergy = Math.min(1.4, targetEnergy + 0.015);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { targetMouseInfluence = 0; }, 1200);
    }, { passive: true });

    // 注册戳戳看板娘彩蛋
    window.addEventListener('ncm:poke-avatar', (e) => {
      const x = (e.detail && typeof e.detail.x === 'number') ? e.detail.x : 60;
      const y = (e.detail && typeof e.detail.y === 'number') ? e.detail.y : 40;
      if (window.__LOW_POWER_MODE__) {
        triggerBurst2D(x, y);
      } else {
        triggerBurst3D(x, y);
      }
    });

    wrapPokeAvatar();
    window.addEventListener('DOMContentLoaded', wrapPokeAvatar);

    // 容灾机制
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      isContextLost = true;
      stop3D();
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
      isContextLost = false;
      resize();
      if (!window.__LOW_POWER_MODE__ && !document.hidden) {
        start3D();
      }
    });

    document.addEventListener('visibilitychange', () => {
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
    });

    window.addEventListener('ncm:low-power-change', (e) => {
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
    });

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

    // 暴露干净的全局控制接口
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
      isSupported: true,
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
      }
    };

  } catch (fatalError) {
    console.error('[GlslBgEngine] Uncaught engine error, gracefully halted:', fatalError);
    if (window.Splash) window.Splash.dismiss();
  }
})();
