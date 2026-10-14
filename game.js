// ====== 合成大西瓜 Suika Game（Matter.js 版本 · 第 3 步） ======
// 当前目标：自绘渲染（移除 Matter.Render），仅物理用 Engine.update，验证水果掉落。

(() => {
  'use strict';

  console.log('fruits:', SuikaFruits.getAll());

  const { Engine, Bodies, Body, Composite, Events } = Matter;

  const canvas = document.getElementById('game-canvas');
  let ctx = canvas.getContext('2d');

  // 精灵缓存：预缩放后的水果位图（key: `${level}_${targetPx}`）
  const spriteCache = new Map();

  // 按 devicePixelRatio 初始化高分辨率后备缓冲，逻辑坐标固定 400x600
  function setupCanvasResolution() {
    console.log('[setupCanvasResolution] 调用, dpr =', window.devicePixelRatio);
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const logicalW = 400;
    const logicalH = 600;

    canvas.width  = Math.round(logicalW * dpr);
    canvas.height = Math.round(logicalH * dpr);

    canvas._dpr = dpr;
    canvas._logicalW = logicalW;
    canvas._logicalH = logicalH;

    ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) {
      ctx.imageSmoothingQuality = 'high';
    }

    if (typeof clearSpriteCache === 'function') clearSpriteCache();
    const rect = canvas.getBoundingClientRect();
    console.log('[setupCanvasResolution] 完成, canvas.width =', canvas.width,
      '| 显示尺寸 client =', canvas.clientWidth + 'x' + canvas.clientHeight,
      '| rect =', Math.round(rect.width) + 'x' + Math.round(rect.height));
  }

  setupCanvasResolution();

  // 屏幕缩放 / 横竖屏切换时重新设置分辨率并重设变换
  window.addEventListener('resize', () => {
    setupCanvasResolution();
  });

  // 分数与待处理合成队列
  let score = 0;
  let pendingMerges = [];
  let isGameOver = false;

  // 下一个水果（1~3 级随机）与瞄准位置
  let nextLevel = randomDropLevel();
  let previewX = canvas._logicalW / 2;        // 当前预览的水平位置（逻辑坐标）
  let pointerActive = false;   // 是否处于“按下”状态

  function randomDropLevel() { return 1 + Math.floor(Math.random() * 3); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // 物理引擎与边界在 initGame() 中初始化
  let engine = null;
  const thickness = 40; // 墙厚

  // ====== 水果 ======
  // 用 SuikaFruits 的定义创建一个圆形刚体
  function createFruit(x, y, level) {
    const def = SuikaFruits.get(level);
    if (!def) {
      console.warn('[Suika] 未找到 level=', level, '的水果定义');
      return null;
    }
    const body = Bodies.circle(x, y, def.radius, {
      label: 'fruit',
      restitution: 0.2,
      friction: 0.4,
      frictionAir: 0.01,
      density: 0.001
    });
    body.fruitLevel = level;   // 自定义属性：等级
    body.isMerged = false;     // 自定义属性：是否已合成
    body.bornAt = engine.timing.timestamp; // 出生时刻（用于死亡线判定）
    Composite.add(engine.world, body);
    return body;
  }

  // 投放：在指定 x 生成指定等级的水果（按当前半径夹紧到墙内）
  function dropFruit(x, level) {
    const cx = clampPreviewX(x, level);
    const fruit = createFruit(cx, 60, level);
    if (fruit) Body.setVelocity(fruit, { x: 0, y: 0 });
    return fruit;
  }

  // 坐标转换：客户端坐标 -> canvas 内部坐标
  function getCanvasPos(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas._logicalW / rect.width;
    const scaleY = canvas._logicalH / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top)  * scaleY
    };
  }

  // 左右墙厚度（与物理边界一致），预览按当前水果半径收缩范围
  const WALL_THICKNESS = 40;
  function clampPreviewX(x, level) {
    const def = SuikaFruits.get(level);
    const r = def ? def.radius : 20;
    const min = WALL_THICKNESS + r;
    const max = canvas._logicalW - WALL_THICKNESS - r;
    return Math.max(min, Math.min(max, x));
  }

  function updatePreviewFromEvent(e) {
    const pos = getCanvasPos(e.clientX, e.clientY);
    previewX = clampPreviewX(pos.x, nextLevel);
  }

  function onPointerDown(e) {
    if (!e.isPrimary) return;
    e.preventDefault();
    pointerActive = true;
    updatePreviewFromEvent(e);
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
  }

  function onPointerMove(e) {
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse') {
      updatePreviewFromEvent(e); // 鼠标：无需按下就跟随
    } else {
      if (!pointerActive) return;
      e.preventDefault();
      updatePreviewFromEvent(e); // 触摸：只有按下时才跟随
    }
  }

  function onPointerUp(e) {
    if (!e.isPrimary) return;
    if (!pointerActive) return;
    e.preventDefault();
    pointerActive = false;
    dropFruit(previewX, nextLevel);
    nextLevel = randomDropLevel();
    previewX = canvas._logicalW / 2;
  }

  function onPointerCancel(e) {
    if (!e.isPrimary) return;
    pointerActive = false;
    previewX = canvas._logicalW / 2;
  }

  // 分数显示
  function updateScore() {
    const el = document.getElementById('score');
    if (el) el.textContent = '分数：' + score;
  }

  // 在下一帧统一处理合成：移除两个旧水果，在中点生成高一级水果
  function processMerges() {
    if (pendingMerges.length === 0) return;
    for (const m of pendingMerges) {
      const midX = (m.a.position.x + m.b.position.x) / 2;
      const midY = (m.a.position.y + m.b.position.y) / 2;
      Composite.remove(engine.world, m.a);
      Composite.remove(engine.world, m.b);
      const newBody = createFruit(midX, midY, m.level + 1);
      if (newBody) {
        Body.setVelocity(newBody, { x: 0, y: -3 }); // 向上小速度
        score += SuikaFruits.get(m.level + 1).score;
      }
    }
    pendingMerges = [];
    updateScore();
  }

  // ====== 渲染 ======
  function drawWall(c, body) {
    const v = body.vertices;
    c.save();
    c.beginPath();
    c.moveTo(v[0].x, v[0].y);
    for (let i = 1; i < v.length; i++) c.lineTo(v[i].x, v[i].y);
    c.closePath();
    c.fillStyle = '#333';
    c.fill();
    c.restore();
  }

  // 按等级 + 具体图片预生成精灵（裁掉透明留白后 contain 缩放）
  // key 带 img.src：本地图标自动生成各自缓存，换图/不同来源自动失效
  function getFruitSpriteFromImage(level, img) {
    if (!img || !img.complete || img.naturalWidth === 0) return null;

    const def = SuikaFruits.get(level);
    if (!def) return null;

    const dpr = canvas._dpr || 1;
    const r = def.radius;

    // 目标物理像素直径
    const targetPx = Math.max(2, Math.round(r * 2 * dpr));
    const key = `${level}_${targetPx}_${img.src}`;

    if (spriteCache.has(key)) return spriteCache.get(key);

    const off = document.createElement('canvas');
    off.width = targetPx;
    off.height = targetPx;
    const octx = off.getContext('2d');
    octx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in octx) {
      octx.imageSmoothingQuality = 'high';
    }

    // 自动裁掉透明留白，再 contain 缩放
    const crop = getOpaqueBounds(img);
    const sw = crop.w;
    const sh = crop.h;

    const scale = Math.min(targetPx / sw, targetPx / sh);
    const dw = sw * scale;
    const dh = sh * scale;

    octx.drawImage(
      img,
      crop.x, crop.y, sw, sh,
      (targetPx - dw) / 2, (targetPx - dh) / 2, dw, dh
    );

    spriteCache.set(key, off);
    return off;
  }

  // 无精灵时的兜底：在半径 r 的圆内居中 contain 绘制图片
  function drawContainImage(c, img, r) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const size = r * 2;
    const scale = Math.min(size / iw, size / ih);
    const w = iw * scale;
    const h = ih * scale;
    c.drawImage(img, -w / 2, -h / 2, w, h);
  }

  function clearSpriteCache() {
    spriteCache.clear();
  }

  // 计算图片不透明区域的包围盒（裁掉透明留白），WeakMap 缓存避免重复扫描
  const _boundsCache = new WeakMap();

  function getOpaqueBounds(img) {
    if (_boundsCache.has(img)) return _boundsCache.get(img);

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const full = { x: 0, y: 0, w, h };

    try {
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const octx = off.getContext('2d');
      octx.drawImage(img, 0, 0);
      const data = octx.getImageData(0, 0, w, h).data;

      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = data[(y * w + x) * 4 + 3];
          if (a > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX < 0) {
        _boundsCache.set(img, full);
        return full;
      }

      // 加一点内边距，避免贴边
      const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.02);
      const result = {
        x: Math.max(0, minX - pad),
        y: Math.max(0, minY - pad),
        w: Math.min(w - Math.max(0, minX - pad), (maxX - minX) + pad * 2),
        h: Math.min(h - Math.max(0, minY - pad), (maxY - minY) + pad * 2)
      };
      _boundsCache.set(img, result);
      return result;
    } catch (e) {
      // 跨域图片会抛错，回退到完整尺寸
      _boundsCache.set(img, full);
      return full;
    }
  }

  // 默认绘制：圆底 + emoji（清晰字体 + 轻微阴影）
  function drawDefaultFruit(c, def, radius) {
    c.shadowColor = 'rgba(0,0,0,0.15)';
    c.shadowBlur = 4;
    c.shadowOffsetY = 2;
    c.beginPath();
    c.arc(0, 0, radius, 0, Math.PI * 2);
    c.fillStyle = def.color;
    c.fill();
    c.shadowColor = 'transparent'; // 复位，避免阴影累积到后面绘制

    if (def.emoji) {
      const dpr = canvas._dpr || 1;
      const fontSize = Math.round(radius * 1.15 * dpr) / dpr;
      c.font = `${fontSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(def.emoji, 0, radius * 0.05);
    }
  }

  // 公共绘制：本地图标 > 默认圆 + emoji（def.draw 可自定义）
  // alpha 默认 1；angle 为旋转弧度（世界水果用）
  function drawFruitShape(c, level, cx, cy, radius, alpha, angle) {
    const def = SuikaFruits.get(level);
    if (!def) return;
    const localImg = SuikaFruits.getDefImage(level);

    c.save();
    c.globalAlpha = (alpha == null ? 1 : alpha);
    c.translate(cx, cy);
    if (angle) c.rotate(angle);

    if (localImg) {
      const sprite = getFruitSpriteFromImage(level, localImg);
      if (sprite) {
        // 目标尺寸用逻辑坐标（外层已 setTransform(dpr)，自动映射为物理像素 1:1）
        c.drawImage(sprite, -radius, -radius, radius * 2, radius * 2);
      } else {
        drawContainImage(c, localImg, radius);
      }
    } else if (typeof def.draw === 'function') {
      def.draw(c, { x: 0, y: 0, radius, angle, t: performance.now() });
    } else {
      drawDefaultFruit(c, def, radius);
    }

    // 描边（区分边界）
    c.beginPath();
    c.arc(0, 0, radius, 0, Math.PI * 2);
    c.lineWidth = 2;
    c.strokeStyle = 'rgba(0,0,0,0.25)';
    c.stroke();
    c.restore();
  }

  function drawFruit(c, body) {
    const def = SuikaFruits.get(body.fruitLevel);
    if (!def) return;
    drawFruitShape(c, body.fruitLevel, body.position.x, body.position.y, def.radius, 1, body.angle);
  }

  function renderFrame() {
    if (!renderFrame._logged) {
      console.log('[renderFrame] 第一帧, W =', canvas._logicalW, 'H =', canvas._logicalH);
      renderFrame._logged = true;
    }
    const dpr = canvas._dpr || 1;
    const W = canvas._logicalW || 400;
    const H = canvas._logicalH || 600;

    // 先还原成物理像素清屏，再进入逻辑坐标
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

    // 浅色背景
    ctx.fillStyle = '#fff7e6';
    ctx.fillRect(0, 0, W, H);

    if (!renderFrame._pxLogged) {
      renderFrame._pxLogged = true;
      try {
        const p = ctx.getImageData(5, 5, 1, 1).data;
        console.log('[renderFrame] 采样(5,5)像素 =', p[0], p[1], p[2], p[3], '(期望 255 247 230 255)');
      } catch (e) {
        console.error('[renderFrame] getImageData 失败(可能被跨域图片污染):', e);
      }
    }

    // 死亡线（仅渲染，不进入物理世界）
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = 'rgba(220, 40, 40, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 100);
    ctx.lineTo(W, 100);
    ctx.stroke();
    ctx.restore();

    // 先画墙，再画水果（保证水果在墙体之上）
    for (const body of engine.world.bodies) {
      if (body.label === 'wall') drawWall(ctx, body);
    }
    for (const body of engine.world.bodies) {
      if (body.label === 'fruit') drawFruit(ctx, body);
    }

    // 瞄准预览（半透明，优先精灵）与落点辅助虚线
    const ndef = SuikaFruits.get(nextLevel);
    if (ndef) {
      drawFruitShape(ctx, nextLevel, previewX, 60, ndef.radius, 0.4);

      ctx.save();
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(previewX, 60 + ndef.radius);
      ctx.lineTo(previewX, H);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 死亡线判定：水果越过线(顶部)、几乎静止、且已存在超过 1 秒
  function checkGameOver() {
    for (const body of engine.world.bodies) {
      if (body.label !== 'fruit') continue;
      const def = SuikaFruits.get(body.fruitLevel);
      if (!def) continue;
      if (body.position.y - def.radius < 100 &&
          body.speed < 0.5 &&
          (engine.timing.timestamp - body.bornAt) > 1000) {
        endGame();
        return;
      }
    }
  }

  function endGame() {
    if (isGameOver) return;
    isGameOver = true;
    const finalScoreEl = document.getElementById('final-score');
    if (finalScoreEl) finalScoreEl.textContent = score;
    const overlay = document.getElementById('game-over-overlay');
    if (overlay) overlay.classList.remove('hidden');
  }

  function restartGame() {
    // 1. 清空所有水果刚体
    for (const body of engine.world.bodies.slice()) {
      if (body.label === 'fruit') Composite.remove(engine.world, body);
    }
    // 2. 重置分数
    score = 0;
    pendingMerges = [];
    isGameOver = false;
    updateScore();
    // 3. 重置下一个水果
    nextLevel = randomDropLevel();
    previewX = canvas._logicalW / 2;
    // 4. 关闭遮罩
    const overlay = document.getElementById('game-over-overlay');
    if (overlay) overlay.classList.add('hidden');
    // 5. 主循环在 isGameOver 时仍持续渲染，解除标志后即恢复物理
  }

  function bindRestartButton() {
    const btn = document.getElementById('btn-restart');
    if (btn) btn.addEventListener('click', restartGame);
    const gbtn = document.getElementById('btn-restart-global');
    if (gbtn) gbtn.addEventListener('click', restartGame);
  }

  // ====== 初始化物理世界、边界与事件 ======
  function initGame() {
    console.log('[initGame] 1. 创建 engine');
    // 1) 创建引擎，重力向下
    engine = Engine.create();
    engine.gravity.x = 0;
    engine.gravity.y = 1;

    console.log('[initGame] 2. 创建墙壁');
    // 2) 三面静态墙，构成 U 形（深灰 #333）
    const wallStyle = { isStatic: true, label: 'wall' };
    const ground  = Bodies.rectangle(canvas._logicalW / 2, canvas._logicalH - thickness / 2, canvas._logicalW, thickness, wallStyle);
    const leftWall  = Bodies.rectangle(thickness / 2, canvas._logicalH / 2, thickness, canvas._logicalH, wallStyle);
    const rightWall = Bodies.rectangle(canvas._logicalW - thickness / 2, canvas._logicalH / 2, thickness, canvas._logicalH, wallStyle);
    Composite.add(engine.world, [ground, leftWall, rightWall]);
    console.log('[initGame] 3. 绑定事件');

    // 3) 状态重置
    score = 0;
    pendingMerges = [];
    isGameOver = false;
    nextLevel = randomDropLevel();
    previewX = canvas._logicalW / 2;
    pointerActive = false;
    updateScore();

    // 4) 指针/触摸事件（移动端 + 桌面统一）
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);

    // 兜底：某些旧浏览器不支持 pointer events
    if (!window.PointerEvent) {
      canvas.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        if (!t) return;
        e.preventDefault();
        pointerActive = true;
        updatePreviewFromEvent({ clientX: t.clientX, clientY: t.clientY, isPrimary: true, preventDefault(){} });
      }, { passive: false });

      canvas.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        if (!t || !pointerActive) return;
        e.preventDefault();
        updatePreviewFromEvent({ clientX: t.clientX, clientY: t.clientY, isPrimary: true, preventDefault(){} });
      }, { passive: false });

      canvas.addEventListener('touchend', (e) => {
        if (!pointerActive) return;
        e.preventDefault();
        onPointerUp({ isPrimary: true, preventDefault(){} });
      }, { passive: false });
    }

    // 5) 碰撞回调：只标记待合成，真正的移除/生成放到下一帧处理
    Events.on(engine, 'collisionStart', (e) => {
      for (const pair of e.pairs) {
        const a = pair.bodyA, b = pair.bodyB;
        if (a.label !== 'fruit' || b.label !== 'fruit') continue;
        if (a.isMerged || b.isMerged) continue;
        if (a.fruitLevel !== b.fruitLevel) continue;
        const level = a.fruitLevel;
        if (level === SuikaFruits.getMaxLevel()) continue; // 最高级（西瓜）不再合成
        a.isMerged = true;
        b.isMerged = true;
        pendingMerges.push({ a, b, level });
      }
    });
    console.log('[initGame] 4. 完成');
  }

  // ====== 主循环 ======
  function loop() {
    if (!loop._logged) {
      console.log('[loop] 第一帧');
      loop._logged = true;
    }
    if (isGameOver) {
      // 结束后仍渲染，但不更新物理（冻结画面）
      renderFrame();
      requestAnimationFrame(loop);
      return;
    }
    processMerges();
    Engine.update(engine, 1000 / 60);
    checkGameOver();
    renderFrame();
    requestAnimationFrame(loop);
  }

  // ====== 启动 ======
  async function boot() {
    console.log('[boot] 开始');

    try {
      console.log('[boot] 等待图片加载...');
      await SuikaFruits.waitAllImages();
      console.log('[boot] 图片加载完成');
    } catch (e) {
      console.error('[boot] waitAllImages 失败:', e);
    }

    try {
      console.log('[boot] 开始 initGame');
      initGame();
      bindRestartButton();
      console.log('[boot] initGame 完成');
    } catch (e) {
      console.error('[boot] initGame 失败:', e);
      return;
    }

    try {
      console.log('[boot] 启动 loop');
      loop();
      console.log('[boot] loop 已启动');
    } catch (e) {
      console.error('[boot] loop 失败:', e);
    }
  }
  boot();
})();
