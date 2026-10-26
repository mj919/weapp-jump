/*
 * 人物照片替换
 * - 选择本地图片后做尺寸压缩、可选纯色背景去除、裁剪/贴纸化
 * - 生成一块面向相机的纹理交给 h5-adapter.js 挂到小人身上
 * - 图片以 PNG 形式保存在 localStorage，刷新后仍然生效
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'weapp-jump:avatar-v2';
  var DISABLED_KEY = 'weapp-jump:avatar-disabled-v2';
  var DEFAULT_AVATAR = 'res/avatar-user.png?v=3';
  var MAX_SIDE = 600;

  var toggleBtn = document.getElementById('avatar-toggle');
  var panel = document.getElementById('avatar-panel');
  var fileInput = document.getElementById('avatar-file');
  var cutoutInput = document.getElementById('avatar-cutout');
  var resetBtn = document.getElementById('avatar-reset');
  var msgEl = document.getElementById('avatar-msg');

  var lastFile = null;

  function setMsg(text, isError) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = isError ? 'err' : 'ok';
  }

  function avatarApi() {
    return window.WeappJumpAvatar || null;
  }

  // ---------------------------------------------------------------- 图像处理
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  // 返回 alpha 包围盒；没有任何透明/内容时返回 null
  function contentBBox(canvas) {
    var w = canvas.width;
    var h = canvas.height;
    var data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      var row = y * w * 4;
      for (var x = 0; x < w; x++) {
        if (data[row + x * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function hasAlpha(canvas) {
    var d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (var i = 3; i < d.length; i += 4) {
      if (d[i] < 250) return true;
    }
    return false;
  }

  function cropCanvas(src, box) {
    var out = makeCanvas(box.w, box.h);
    out.getContext('2d').drawImage(src, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    return out;
  }

  // 从四周向内泛洪，去掉和边缘平均色接近的连通区域（纯色背景）
  // 返回被移除像素占比
  function removeSolidBackground(canvas) {
    var w = canvas.width;
    var h = canvas.height;
    var ctx = canvas.getContext('2d');
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;

    var br = 0, bg = 0, bb = 0, n = 0;
    function sample(x, y) {
      var i = (y * w + x) * 4;
      br += d[i]; bg += d[i + 1]; bb += d[i + 2]; n++;
    }
    for (var x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
    for (var y = 0; y < h; y++) { sample(0, y); sample(w - 1, y); }
    br /= n; bg /= n; bb /= n;

    var tol = 42;
    var visited = new Uint8Array(w * h);
    var stack = [];

    function tryOpen(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      var p = y * w + x;
      if (visited[p]) return;
      var i = p * 4;
      if (d[i + 3] === 0) { visited[p] = 1; stack.push(p); return; }
      if (Math.abs(d[i] - br) <= tol &&
          Math.abs(d[i + 1] - bg) <= tol &&
          Math.abs(d[i + 2] - bb) <= tol) {
        visited[p] = 1;
        stack.push(p);
      }
    }

    for (var bx = 0; bx < w; bx++) { tryOpen(bx, 0); tryOpen(bx, h - 1); }
    for (var by = 0; by < h; by++) { tryOpen(0, by); tryOpen(w - 1, by); }

    var removed = 0;
    while (stack.length) {
      var p = stack.pop();
      var i = p * 4;
      if (d[i + 3] !== 0) { d[i + 3] = 0; removed++; }
      var px = p % w;
      var py = (p / w) | 0;
      tryOpen(px + 1, py);
      tryOpen(px - 1, py);
      tryOpen(px, py + 1);
      tryOpen(px, py - 1);
    }

    ctx.putImageData(img, 0, 0);
    return removed / (w * h);
  }

  function roundedPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 没有透明通道时做成圆角照片贴纸，避免生硬的矩形
  function makeSticker(src) {
    var pad = 10;
    var w = src.width;
    var h = src.height;
    var r = Math.max(10, Math.min(w, h) * 0.12);
    var out = makeCanvas(w + pad * 2, h + pad * 2);
    var ctx = out.getContext('2d');

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#ffffff';
    roundedPath(ctx, pad, pad, w, h, r);
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundedPath(ctx, pad, pad, w, h, r);
    ctx.clip();
    ctx.drawImage(src, pad, pad);
    ctx.restore();

    ctx.strokeStyle = 'rgba(0,0,0,.16)';
    ctx.lineWidth = 2;
    roundedPath(ctx, pad + 1, pad + 1, w - 2, h - 2, Math.max(6, r - 1));
    ctx.stroke();

    return out;
  }

  function buildAvatarCanvas(img, useCutout) {
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    if (!iw || !ih) throw new Error('图片尺寸异常');

    var scale = Math.min(1, MAX_SIDE / Math.max(iw, ih));
    var w = Math.max(1, Math.round(iw * scale));
    var h = Math.max(1, Math.round(ih * scale));

    var base = makeCanvas(w, h);
    var ctx = base.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    var transparent = hasAlpha(base);
    var removedRatio = 0;
    if (useCutout) {
      removedRatio = removeSolidBackground(base);
    }

    var shouldCrop = transparent || removedRatio > 0.015;
    if (shouldCrop) {
      var box = contentBBox(base);
      if (box && box.w > 4 && box.h > 4) {
        return cropCanvas(base, box);
      }
    }
    return makeSticker(base);
  }

  function applyCanvas(canvas, persist) {
    var api = avatarApi();
    if (api) api.setCanvas(canvas);

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, canvas.toDataURL('image/png'));
        localStorage.removeItem(DISABLED_KEY);
      } catch (e) {
        setMsg('照片已应用，但图片较大，刷新后需要重新上传', true);
      }
    }
  }

  function processFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setMsg('请选择图片文件', true);
      return;
    }
    lastFile = file;
    setMsg('正在处理照片…');

    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      try {
        applyCanvas(buildAvatarCanvas(img, !!(cutoutInput && cutoutInput.checked)), true);
        setMsg('已更换形象');
      } catch (e) {
        console.error(e);
        setMsg('处理失败，请换一张图片试试', true);
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      setMsg('图片读取失败，请换一张图片', true);
    };
    img.src = url;
  }

  // ------------------------------------------------------------------ 持久化
  function loadDefaultAvatar() {
    var disabled = false;
    try { disabled = localStorage.getItem(DISABLED_KEY) === '1'; } catch (e) {}
    if (disabled) return;

    var img = new Image();
    img.onload = function () {
      try {
        var canvas = makeCanvas(img.width, img.height);
        canvas.getContext('2d').drawImage(img, 0, 0);
        applyCanvas(canvas, false);
      } catch (e) {
        console.error(e);
      }
    };
    img.src = DEFAULT_AVATAR;
  }

  function loadSaved() {
    var data = null;
    try { data = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (!data) {
      loadDefaultAvatar();
      return;
    }

    var img = new Image();
    img.onload = function () {
      try {
        var canvas = makeCanvas(img.width, img.height);
        canvas.getContext('2d').drawImage(img, 0, 0);
        applyCanvas(canvas, false);
      } catch (e) {
        console.error(e);
      }
    };
    img.src = data;
  }

  // -------------------------------------------------------------------- UI
  if (toggleBtn && panel) {
    toggleBtn.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      processFile(file);
    });
  }

  if (cutoutInput) {
    cutoutInput.addEventListener('change', function () {
      if (lastFile) processFile(lastFile);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.setItem(DISABLED_KEY, '1');
      } catch (e) {}
      lastFile = null;
      var api = avatarApi();
      if (api) api.clear();
      setMsg('已恢复原形象');
    });
  }

  loadSaved();
})();
