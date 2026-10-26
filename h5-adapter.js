/*
 * 微信小游戏「跳一跳」H5 适配层
 *
 * game.js 是打包后的微信小游戏代码，内部自带一份 weapp-adapter，
 * 依赖 wx.* API、GameGlobal、window/document 等宿主环境。
 * 这里用浏览器能力补齐这些接口，再以 new Function 的方式注入自定义
 * 的 window/document/canvas 后运行原始 game.js（不修改原文件）。
 */
(function () {
  'use strict';

  // 游戏内部按 414 x 736 的竖屏逻辑尺寸做布局
  var LOGIC_W = 414;
  var LOGIC_H = 736;

  var stage = document.getElementById('stage');
  var frame = document.getElementById('frame');
  var statusEl = document.getElementById('status');

  var realCanvas = document.getElementById('game-canvas');
  var ctx2dProbe = null;

  // ---------------------------------------------------------------- 布局适配
  function fitFrame() {
    var s = Math.min(window.innerWidth / LOGIC_W, window.innerHeight / LOGIC_H);
    s = Math.max(s, 0.1);
    frame.style.transform = 'scale(' + s + ')';
    return s;
  }
  var viewScale = fitFrame();
  window.addEventListener('resize', fitFrame);
  window.addEventListener('orientationchange', fitFrame);

  // ------------------------------------------------------------ 渲染分辨率
  // 桌面端视图被放大时适当提高渲染分辨率，上限 2.5 倍，避免 GPU 压力过大
  var renderDpr = Math.min(2.5, Math.max(1, (window.devicePixelRatio || 1) * Math.max(viewScale, 1)));

  // ------------------------------------------------------- 主 canvas 门面对象
  // 不能把真实 canvas 直接交给 weapp-adapter：它会改写画布的原型链，
  // 用门面对象承接这些赋值，真实 canvas 保持原生行为。
  var base2 = {};
  var base1 = Object.create(base2);
  var facade = Object.create(base1);

  var styleTarget = { width: LOGIC_W + 'px', height: LOGIC_H + 'px' };
  var styleProxy = new Proxy(styleTarget, {
    set: function (t, p, v) {
      t[p] = v;
      if (p === 'width' || p === 'height') {
        realCanvas.style[p] = v;
      }
      return true;
    },
    get: function (t, p) {
      return t[p];
    }
  });

  Object.defineProperties(facade, {
    width: {
      configurable: true,
      get: function () { return realCanvas.width; },
      set: function (v) { realCanvas.width = v; }
    },
    height: {
      configurable: true,
      get: function () { return realCanvas.height; },
      set: function (v) { realCanvas.height = v; }
    }
  });

  facade.type = 'canvas';
  facade.tagName = 'CANVAS';
  facade.id = 'game-canvas';
  facade.style = styleProxy;
  facade.clientWidth = LOGIC_W;
  facade.clientHeight = LOGIC_H;
  facade.offsetWidth = LOGIC_W;
  facade.offsetHeight = LOGIC_H;
  facade.getContext = function () {
    return realCanvas.getContext.apply(realCanvas, arguments);
  };
  facade.toDataURL = function () {
    return realCanvas.toDataURL.apply(realCanvas, arguments);
  };
  facade.getBoundingClientRect = function () {
    return { top: 0, left: 0, width: LOGIC_W, height: LOGIC_H };
  };

  realCanvas.style.width = LOGIC_W + 'px';
  realCanvas.style.height = LOGIC_H + 'px';
  realCanvas.style.display = 'block';
  realCanvas.style.touchAction = 'none';

  // 提前探测 WebGL，便于给出明确错误（用临时画布，避免锁定主画布的上下文属性）
  try {
    var probeCanvas = document.createElement('canvas');
    ctx2dProbe = probeCanvas.getContext('webgl') || probeCanvas.getContext('experimental-webgl');
  } catch (e) {
    ctx2dProbe = null;
  }
  if (!ctx2dProbe) {
    setStatus('当前浏览器不支持 WebGL，无法运行');
    return;
  }

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = isError ? '#ff8a80' : '#cfcfcf';
    if (!text) {
      statusEl.style.display = 'none';
    }
  }

  // ------------------------------------------------------------- 触摸事件
  var wxTouchHandlers = {
    touchstart: null,
    touchmove: null,
    touchend: null,
    touchcancel: null
  };
  var activeTouches = Object.create(null);
  var mouseId = 'mouse';
  var lastTouchTs = 0;

  function toLogicPoint(clientX, clientY, id) {
    var r = realCanvas.getBoundingClientRect();
    var sx = r.width ? LOGIC_W / r.width : 1;
    var sy = r.height ? LOGIC_H / r.height : 1;
    var x = (clientX - r.left) * sx;
    var y = (clientY - r.top) * sy;
    return {
      identifier: id,
      clientX: x,
      clientY: y,
      pageX: x,
      pageY: y,
      screenX: clientX,
      screenY: clientY,
      force: 1
    };
  }

  function emitTouch(type) {
    var handler = wxTouchHandlers[type];
    if (!handler) return;

    var all = [];
    for (var k in activeTouches) all.push(activeTouches[k]);

    var changed = emitTouch._changed || [];
    handler({
      touches: all,
      targetTouches: all.slice(),
      changedTouches: changed.slice(),
      timeStamp: (window.performance && performance.now ? performance.now() : Date.now())
    });
  }

  function addTouch(id, x, y) {
    activeTouches[id] = toLogicPoint(x, y, id);
    emitTouch._changed = [activeTouches[id]];
  }

  function moveTouch(id, x, y) {
    activeTouches[id] = toLogicPoint(x, y, id);
    emitTouch._changed = [activeTouches[id]];
  }

  function removeTouch(id) {
    var t = activeTouches[id];
    delete activeTouches[id];
    emitTouch._changed = t ? [t] : [];
  }

  // 原生 touchstart 里的多个触点
  function handleTouchEvent(type, ev) {
    lastTouchTs = (window.performance && performance.now) ? performance.now() : Date.now();
    var list = ev.changedTouches || [];
    var changed = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var id = 't' + t.identifier;
      if (type === 'touchstart' || type === 'touchmove') {
        activeTouches[id] = toLogicPoint(t.clientX, t.clientY, id);
        changed.push(activeTouches[id]);
      } else {
        if (activeTouches[id]) changed.push(activeTouches[id]);
        delete activeTouches[id];
      }
    }
    emitTouch._changed = changed;
    if (type === 'touchstart' || type === 'touchmove' || type === 'touchend' || type === 'touchcancel') {
      emitTouch(type);
    }
    if (ev.cancelable) ev.preventDefault();
  }

  var supportsTouch = 'ontouchstart' in window;
  if (supportsTouch) {
    var opts = { passive: false };
    realCanvas.addEventListener('touchstart', function (e) { handleTouchEvent('touchstart', e); }, opts);
    realCanvas.addEventListener('touchmove', function (e) { handleTouchEvent('touchmove', e); }, opts);
    realCanvas.addEventListener('touchend', function (e) { handleTouchEvent('touchend', e); }, opts);
    realCanvas.addEventListener('touchcancel', function (e) { handleTouchEvent('touchcancel', e); }, opts);
  }

  // 桌面端用鼠标模拟单指触摸；触摸设备忽略兼容性鼠标事件
  function isCompatMouse() {
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    return now - lastTouchTs < 1000;
  }

  realCanvas.addEventListener('mousedown', function (ev) {
    if (ev.button !== 0 || isCompatMouse()) return;
    addTouch(mouseId, ev.clientX, ev.clientY);
    emitTouch('touchstart');
    ev.preventDefault();
  });
  window.addEventListener('mousemove', function (ev) {
    if (!(mouseId in activeTouches)) return;
    moveTouch(mouseId, ev.clientX, ev.clientY);
    emitTouch('touchmove');
  });
  window.addEventListener('mouseup', function (ev) {
    if (!(mouseId in activeTouches)) return;
    removeTouch(mouseId);
    emitTouch('touchend');
  });
  window.addEventListener('blur', function () {
    if (mouseId in activeTouches) {
      removeTouch(mouseId);
      emitTouch('touchend');
    }
  });

  // --------------------------------------------------------------- 存储
  var STORE_PREFIX = 'weapp-jump:';

  function readStore(key) {
    var raw = localStorage.getItem(STORE_PREFIX + key);
    if (raw === null) return '';
    try {
      return JSON.parse(raw);
    } catch (e) {
      return raw;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
    } catch (e) {
      /* 空间不足或隐私模式，忽略 */
    }
  }

  // --------------------------------------------------------------- 音频
  function createInnerAudioContext() {
    var el = new Audio();
    el.preload = 'auto';

    var api = {
      get src() { return el.getAttribute('src') || ''; },
      set src(v) { if (v != null) el.src = v; },
      get loop() { return el.loop; },
      set loop(v) { el.loop = !!v; },
      get volume() { return el.volume; },
      set volume(v) { el.volume = Math.max(0, Math.min(1, Number(v))); },
      get currentTime() { return el.currentTime || 0; },
      set currentTime(v) { try { el.currentTime = v; } catch (e) {} },
      get duration() { return el.duration || 0; },
      get paused() { return el.paused; },
      get startTime() { return 0; },
      play: function () {
        var p = el.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      },
      pause: function () { el.pause(); },
      stop: function () {
        el.pause();
        try { el.currentTime = 0; } catch (e) {}
        api.onStop && api.onStop();
      },
      seek: function (t) {
        try { el.currentTime = t; } catch (e) {}
      },
      destroy: function () {
        el.pause();
        el.removeAttribute('src');
        try { el.load(); } catch (e) {}
      }
    };

    function binder(domType, wxName) {
      var handlers = [];
      el.addEventListener(domType, function (e) {
        for (var i = 0; i < handlers.length; i++) handlers[i](e);
      });
      api['on' + wxName] = function (fn) { handlers.push(fn); return api; };
      api['off' + wxName] = function (fn) {
        var i = handlers.indexOf(fn);
        if (i >= 0) handlers.splice(i, 1);
      };
    }

    binder('canplay', 'Canplay');
    binder('play', 'Play');
    binder('pause', 'Pause');
    binder('ended', 'Ended');
    binder('error', 'Error');
    binder('waiting', 'Waiting');
    binder('seeking', 'Seeking');
    binder('seeked', 'Seeked');
    binder('timeupdate', 'TimeUpdate');

    api.onStop = null;
    return api;
  }

  // --------------------------------------------------------------- wx 对象
  var launchOptions = {
    scene: 1001,
    query: {},
    referrerInfo: {},
    shareTicket: undefined,
    isSticky: false
  };

  var socketTemplate = function () {
    var handlers = { open: [], close: [], error: [], message: [] };
    var socket = {
      send: function () {},
      close: function () {},
      onOpen: function (fn) { handlers.open.push(fn); },
      onClose: function (fn) { handlers.close.push(fn); },
      onError: function (fn) { handlers.error.push(fn); },
      onMessage: function (fn) { handlers.message.push(fn); }
    };
    return socket;
  };

  var wx = {
    getSystemInfoSync: function () {
      return {
        brand: 'H5',
        model: 'Browser',
        pixelRatio: renderDpr,
        screenWidth: LOGIC_W,
        screenHeight: LOGIC_H,
        windowWidth: LOGIC_W,
        windowHeight: LOGIC_H,
        statusBarHeight: 0,
        language: 'zh_CN',
        version: '8.0.0',
        system: 'Android 12',
        platform: 'android',
        SDKVersion: '2.30.0',
        benchmarkLevel: 50,
        safeArea: { left: 0, top: 0, right: LOGIC_W, bottom: LOGIC_H, width: LOGIC_W, height: LOGIC_H },
        devicePixelRatio: renderDpr
      };
    },

    getLaunchOptionsSync: function () {
      return launchOptions;
    },

    createCanvas: function () {
      // 第一次调用是游戏主画布，之后都是离屏画布
      if (!wx._mainCanvasGiven) {
        wx._mainCanvasGiven = true;
        return facade;
      }
      return document.createElement('canvas');
    },

    createImage: function () {
      return new Image();
    },

    loadFont: function (path) {
      var family = 'WeappJumpNum';
      try {
        if (document.fonts && typeof FontFace !== 'undefined') {
          var face = new FontFace(family, 'url("' + path + '")');
          face.load().then(function (loaded) { document.fonts.add(loaded); }).catch(function () {});
        }
      } catch (e) {}
      return family;
    },

    createInnerAudioContext: createInnerAudioContext,

    getNetworkType: function (o) {
      setTimeout(function () {
        o && o.success && o.success({ networkType: 'wifi', errMsg: 'getNetworkType:ok' });
        o && o.complete && o.complete({ errMsg: 'getNetworkType:ok' });
      }, 0);
    },

    login: function (o) {
      setTimeout(function () {
        o && o.success && o.success({ code: 'h5-local', errMsg: 'login:ok' });
        o && o.complete && o.complete({ errMsg: 'login:ok' });
      }, 0);
    },

    // 原版依赖微信服务端，H5 环境下直接失败，让游戏走离线逻辑
    request: function (o) {
      setTimeout(function () {
        var res = { errMsg: 'request:fail not available in H5', data: {} };
        o && o.fail && o.fail(res);
        o && o.complete && o.complete(res);
      }, 0);
    },

    connectSocket: function (o) {
      var socket = socketTemplate();
      wx._socket = socket;
      setTimeout(function () {
        var err = { errMsg: 'connectSocket:fail not available in H5' };
        o && o.fail && o.fail(err);
        socket.onError && socket.onError(err);
      }, 0);
      return socket;
    },
    sendSocketMessage: function () {},
    closeSocket: function () {},
    onSocketOpen: function () {},
    onSocketError: function () {},
    onSocketMessage: function () {},
    onSocketClose: function () {},

    getStorageSync: readStore,
    setStorageSync: function (key, data) { writeStore(key, data); },
    removeStorageSync: function (key) { localStorage.removeItem(STORE_PREFIX + key); },
    clearStorageSync: function () {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(STORE_PREFIX) === 0) keys.push(k);
      }
      for (var j = 0; j < keys.length; j++) localStorage.removeItem(keys[j]);
    },
    getStorageInfoSync: function () {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(STORE_PREFIX) === 0) keys.push(k.slice(STORE_PREFIX.length));
      }
      return { keys: keys, currentSize: 0, limitSize: 10240 };
    },
    setStorage: function (o) {
      var ok = true;
      try { writeStore(o.key, o.data); } catch (e) { ok = false; }
      setTimeout(function () {
        if (ok) { o.success && o.success({}); o.complete && o.complete({}); }
        else { o.fail && o.fail({ errMsg: 'setStorage:fail' }); o.complete && o.complete({}); }
      }, 0);
    },
    removeStorage: function (o) {
      wx.removeStorageSync(o.key);
      setTimeout(function () {
        o.success && o.success({});
        o.complete && o.complete({});
      }, 0);
    },

    showLoading: function (o) {
      if (o && o.title && statusEl && statusEl.style.display !== 'none') setStatus(o.title);
    },
    hideLoading: function () {},
    showModal: function (o) {
      console.log('[wx.showModal]', o && o.title, o && o.content);
      setTimeout(function () {
        // 可取消的弹窗一律走取消分支：原版“分数上传失败”弹窗的确认按钮是“重试”，
        // H5 离线环境下重试会无限循环，取消则会正常进入结算页。
        var cancelable = !o || o.showCancel !== false;
        var res = cancelable
          ? { confirm: false, cancel: true, errMsg: 'showModal:ok' }
          : { confirm: true, cancel: false, errMsg: 'showModal:ok' };
        o && o.success && o.success(res);
        o && o.complete && o.complete(res);
      }, 0);
    },
    showToast: function (o) {
      console.log('[wx.showToast]', o && o.title);
    },

    shareAppMessage: function () {},
    updateShareMenu: function (o) {
      setTimeout(function () { o && o.success && o.success({}); }, 0);
    },
    getShareInfo: function (o) {
      setTimeout(function () { o && o.fail && o.fail({ errMsg: 'getShareInfo:fail not available in H5' }); }, 0);
    },

    setKeepScreenOn: function () {},
    triggerGC: function () {
      if (typeof window.gc === 'function') window.gc();
    },
    exitMiniProgram: function () {
      try { window.close(); } catch (e) {}
    },

    onShow: function (fn) {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) fn && fn({});
      });
    },
    onHide: function (fn) {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) fn && fn({});
      });
    },
    onError: function (fn) {
      window.addEventListener('error', function (e) {
        fn && fn({ message: e.message, stack: e.error && e.error.stack });
      });
      window.addEventListener('unhandledrejection', function (e) {
        var r = e.reason;
        fn && fn({ message: r && r.message ? r.message : String(r), stack: r && r.stack });
      });
    },
    onAudioInterruptionBegin: function () {},
    onTouchStart: function (fn) { wxTouchHandlers.touchstart = fn; },
    onTouchMove: function (fn) { wxTouchHandlers.touchmove = fn; },
    onTouchEnd: function (fn) { wxTouchHandlers.touchend = fn; },
    onTouchCancel: function (fn) { wxTouchHandlers.touchcancel = fn; }
  };

  // ------------------------------------------------------------ 伪 window
  var win = {
    innerWidth: LOGIC_W,
    innerHeight: LOGIC_H,
    outerWidth: LOGIC_W,
    outerHeight: LOGIC_H,
    devicePixelRatio: renderDpr,
    screen: { availWidth: LOGIC_W, availHeight: LOGIC_H, width: LOGIC_W, height: LOGIC_H },
    document: document,
    console: console,
    navigator: navigator,
    location: location,
    performance: window.performance,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    atob: window.atob.bind(window),
    btoa: window.btoa.bind(window),
    decodeURIComponent: window.decodeURIComponent,
    encodeURIComponent: window.encodeURIComponent,
    AudioContext: window.AudioContext || window.webkitAudioContext,
    webkitAudioContext: window.webkitAudioContext,
    WebGL2RenderingContext: window.WebGL2RenderingContext,
    WebGLRenderingContext: window.WebGLRenderingContext,
    Image: window.Image,
    Audio: window.Audio,
    XMLHttpRequest: window.XMLHttpRequest,
    WebSocket: window.WebSocket,
    localStorage: window.localStorage,
    URL: window.URL,
    Blob: window.Blob,
    fetch: window.fetch ? window.fetch.bind(window) : undefined,
    HTMLImageElement: window.HTMLImageElement,
    HTMLCanvasElement: window.HTMLCanvasElement,
    HTMLElement: window.HTMLElement,
    Float32Array: window.Float32Array,
    Uint8Array: window.Uint8Array,
    Uint16Array: window.Uint16Array,
    Int32Array: window.Int32Array,
    ArrayBuffer: window.ArrayBuffer,
    Math: Math,
    Date: Date,
    JSON: JSON
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.parent = win;

  // -------------------------------------------------- 自定义人物照片（avatar）
  // 原理：把照片做成一块朝向相机的半透明面片，挂到小人的变换节点上，
  // 继承原有的跳跃位移、落地压扁、摔倒翻转等动画；同时隐藏原来的瓶身。
  var avatar = {
    enabled: false,
    canvas: null,
    scene: null,
    camera: null,
    parts: null,
    mesh: null,
    photoW: 0,
    photoH: 0,
    wrapped: false
  };

  // 原瓶身几何尺寸（见 game.js 中 Bottle 构造函数）：
  // 瓶子内层 y=1.35，身体圆柱半高约 1.266
  var BOTTLE_FEET_Y = 1.266;
  var BOTTLE_INNER_Y = 1.35;
  var AVATAR_MAX_W = 5.2;
  var AVATAR_MAX_H = 7.0;

  function findBottleParts(scene) {
    var root = scene.getObjectByName('bottle');
    if (!root) return null;

    var head = null;
    var planeSample = null;

    root.traverse(function (o) {
      if (!o.isMesh) return;
      var geo = o.geometry;
      var type = geo && (geo.type || '');
      if (!head && type.indexOf('Sphere') >= 0) head = o;
      if (!planeSample && geo && geo.parameters &&
          geo.parameters.width === 1 && geo.parameters.height === 1 &&
          o.material && o.material.map) {
        planeSample = o;
      }
    });

    if (!head || !head.material || !head.material.map) return null;

    var human = head.parent;
    var body = null;
    if (human) {
      for (var i = 0; i < human.children.length; i++) {
        if (human.children[i] !== head) { body = human.children[i]; break; }
      }
    }
    if (!body) return null;

    var sampleGeo = planeSample ? planeSample.geometry : null;
    var baseW = 1;
    var baseH = 1;
    if (sampleGeo && sampleGeo.parameters) {
      baseW = sampleGeo.parameters.width || 1;
      baseH = sampleGeo.parameters.height || 1;
    } else {
      var ground = scene.getObjectByName('ground');
      if (ground && ground.geometry) {
        sampleGeo = ground.geometry;
        baseW = (sampleGeo.parameters && sampleGeo.parameters.width) || 1;
        baseH = (sampleGeo.parameters && sampleGeo.parameters.height) || 1;
      }
    }
    if (!sampleGeo) return null;

    return {
      root: root,
      head: head,
      body: body,
      sampleGeo: sampleGeo,
      baseW: baseW,
      baseH: baseH,
      MeshCtor: head.constructor,
      MatCtor: head.material.constructor,
      TexCtor: head.material.map.constructor
    };
  }

  function ensureAvatarMesh() {
    var parts = avatar.parts;
    if (!parts) return null;
    if (avatar.mesh) return avatar.mesh;

    var geo = parts.sampleGeo.clone ? parts.sampleGeo.clone() : parts.sampleGeo;
    var mat = new parts.MatCtor();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = 2; // THREE.DoubleSide
    mat.alphaTest = 0.01;

    var mesh = new parts.MeshCtor(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    // 面片朝向相机（等距视角），挂到 obj 上可继承位移和摔倒旋转
    if (avatar.camera && avatar.camera.quaternion) {
      mesh.quaternion.copy(avatar.camera.quaternion);
    }
    parts.root.add(mesh);
    avatar.mesh = mesh;
    return mesh;
  }

  function updateAvatarTransform() {
    var mesh = avatar.mesh;
    var parts = avatar.parts;
    if (!mesh || !mesh.visible || !parts) return;

    var sy = parts.body.scale.y || 1;
    var sx = parts.body.scale.x || 1;
    var w = avatar.photoW * sx;
    var h = avatar.photoH * sy;

    mesh.scale.set(w / parts.baseW, h / parts.baseH, 1);
    // 以原瓶身脚底为锚点，随压扁动画一起缩放
    var feetY = BOTTLE_INNER_Y - BOTTLE_FEET_Y * sy;
    mesh.position.set(0, feetY + h / 2, 0);
  }

  function applyAvatar() {
    if (!avatar.parts) return;

    if (!avatar.enabled || !avatar.canvas) {
      if (avatar.mesh) avatar.mesh.visible = false;
      avatar.parts.head.visible = true;
      avatar.parts.body.visible = true;
      return;
    }

    var mesh = ensureAvatarMesh();
    if (!mesh) return;

    var tex = new avatar.parts.TexCtor(avatar.canvas);
    tex.needsUpdate = true;
    tex.generateMipmaps = false;
    tex.minFilter = 1006; // THREE.LinearFilter
    tex.magFilter = 1006;
    tex.wrapS = 1001;     // THREE.ClampToEdgeWrapping
    tex.wrapT = 1001;

    if (mesh.material.map && mesh.material.map.dispose) mesh.material.map.dispose();
    mesh.material.map = tex;
    mesh.material.needsUpdate = true;

    var aspect = avatar.canvas.width / avatar.canvas.height;
    var ph = AVATAR_MAX_H;
    var pw = ph * aspect;
    if (pw > AVATAR_MAX_W) {
      pw = AVATAR_MAX_W;
      ph = pw / aspect;
    }
    avatar.photoW = pw;
    avatar.photoH = ph;

    mesh.visible = true;
    avatar.parts.head.visible = false;
    avatar.parts.body.visible = false;
    updateAvatarTransform();
  }

  function hookRenderer() {
    if (avatar.wrapped) return;
    var renderer = win.renderer;
    if (!renderer || typeof renderer.render !== 'function') return;

    var originalRender = renderer.render;
    renderer.render = function (scene, camera) {
      if (!avatar.scene) {
        avatar.scene = scene;
        avatar.camera = camera;
        avatar.parts = findBottleParts(scene);
        if (avatar.parts) applyAvatar();
      }
      updateAvatarTransform();
      return originalRender.apply(this, arguments);
    };
    avatar.wrapped = true;
  }

  window.WeappJumpAvatar = {
    setCanvas: function (canvas) {
      avatar.canvas = canvas || null;
      avatar.enabled = !!canvas;
      applyAvatar();
    },
    clear: function () {
      avatar.canvas = null;
      avatar.enabled = false;
      applyAvatar();
    }
  };

  // ------------------------------------------------------------ 启动游戏
  var appFactory = null;
  var appModule = { exports: {} };
  var booted = false;

  function define(name, factory) {
    appFactory = factory;
  }

  function require(name) {
    if (name === 'game.js' && appFactory && !booted) {
      booted = true;
      appFactory(require, appModule, appModule.exports);
    }
    return appModule.exports;
  }

  function boot(src) {
    setStatus('正在启动…');
    var runner = new Function(
      'window', 'document', 'GameGlobal', 'wx', 'canvas', 'define', 'require',
      src + '\n//# sourceURL=game.js'
    );
    runner(win, document, win, wx, facade, define, require);

    hookRenderer();
    var avatarHookTimer = setInterval(function () {
      hookRenderer();
      if (avatar.wrapped) clearInterval(avatarHookTimer);
    }, 200);

    // 等首帧渲染出来再收起加载提示
    setTimeout(function () { setStatus(''); }, 1200);
  }

  fetch('game.js', { cache: 'no-cache' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function (src) {
      boot(src);
    })
    .catch(function (err) {
      console.error(err);
      setStatus('加载 game.js 失败：' + err.message + '（请通过本地 HTTP 服务访问，不要直接双击 index.html）', true);
    });
})();
