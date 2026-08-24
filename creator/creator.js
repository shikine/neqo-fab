/* NEQO FAB — ぷくぷくネームキーホルダー クリエイター
 *
 * Blender アドオン (works/007) の生成方法をブラウザに移植したもの。
 *   ぷくぷく文字 = フォント輪郭を押し出し（extrude）＋角丸（bevel）。
 *                  総厚み t、ぷくぷく度 puff に対し r=puff*t/2、
 *                  depth=t-2r, bevelThickness=bevelSize=r。addon と同じ断面モデル。
 *   縁取り       = 名前の外シルエットを Clipper で round-offset した「器のフチ」。
 *                  外周をなぞる帯（中央は文字が入る空き）で、文字とのあいだに
 *                  “堀”（GAP）を設けて文字がフチに潰されないようにする。
 *                  round-join＝真のミンコフスキー和なので鋭角のトゲが出ない。
 *                  下に板は敷かない。フチは文字より少し低く（RIM_LIP<0）して、
 *                  中のぷくぷく文字が丸く盛り上がって見えるようにする。
 *   金具リング   = 端に置く円環。フチに一体化させる。
 *
 * すべて mm を Three の 1 単位として扱う。
 */
(function () {
  'use strict';

  var FONTS = {
    pop:  { url: 'fonts/MochiyPopOne-Regular.ttf', label: 'ポップ体' },
    rock: { url: 'fonts/RocknRollOne-Regular.ttf', label: 'レトロ丸' }
  };

  var PALETTE = [
    ['#FFFFFF', 'ホワイト'], ['#F7C1D4', 'ももいろ'], ['#F2969B', 'コーラル'],
    ['#F5B841', 'たまご'],  ['#9FD8A6', 'ミント'],   ['#8FC7E8', 'そら'],
    ['#B79CE0', 'ラベンダー'], ['#E0703F', 'NEQOオレンジ'], ['#3A3A3A', 'すみ']
  ];

  var DEFAULTS = {
    text: 'なまえ', font: 'pop', puff: 0.8,
    textColor: '#F7C1D4', borderColor: '#FFFFFF',
    border: 2.4, ring: true, ringSide: 'left'
  };

  // 固定寸法（mm）
  var SIZE = 20;          // 文字の em サイズ
  var T_TEXT = 3.0;       // 文字の厚み
  var T_BORDER = 2.4;     // （旧）未使用。フチ厚は T_TEXT + RIM_LIP
  var GAP = 0.7;          // 文字とフチの間の“堀”。0だと内壁が文字に食い込んで潰れて見える
  var RING_HOLE = 4.0, RING_WALL = 2.2;
  var RIM_LIP = -0.8;     // フチと文字の高さ差 mm（負=フチが低い→文字がぷくっと盛り上がる）
  var LETTER_SPACING = 0.06;   // em 比
  var LINE_GAP = 1.02;         // 行送り（em比）

  // ---- state ----
  var S = Object.assign({}, DEFAULTS);
  var fontCache = {};
  var THREEfont = null;
  var lastBBox = null;

  // ---- three basics ----
  var canvas = document.getElementById('view');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(38, 1, 1, 5000);
  var controls = new THREE.OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.minDistance = 40; controls.maxDistance = 600;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.autoRotate = false;

  // lighting: soft studio（白いプラを白背景で見せるので控えめ＋陰影重視）
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 0.55));
  var key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(-55, 80, 70);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 10; key.shadow.camera.far = 400;
  key.shadow.camera.left = -80; key.shadow.camera.right = 80;
  key.shadow.camera.top = 80; key.shadow.camera.bottom = -80;
  key.shadow.bias = -0.0009; key.shadow.radius = 4;
  scene.add(key);
  var fill = new THREE.DirectionalLight(0xffeede, 0.28);
  fill.position.set(60, 10, 50); scene.add(fill);
  var rim = new THREE.DirectionalLight(0xdfe8ff, 0.32);
  rim.position.set(30, 50, -70); scene.add(rim);

  var root = new THREE.Group();      // 全パーツの親。ここを回す
  scene.add(root);
  var meshGroup = new THREE.Group();
  root.add(meshGroup);

  // 背面のシャドウキャッチャー（白背景に浮かせず接地させる）
  var shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ opacity: 0.17 }));
  shadowPlane.receiveShadow = true;
  root.add(shadowPlane);

  function resize() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (lastFit) fitCamera(lastFit);
  }
  var lastFit = null;
  window.addEventListener('resize', function () { resize(); invalidate(); });
  if (window.ResizeObserver) {
    new ResizeObserver(function () { resize(); invalidate(); }).observe(canvas.parentElement || canvas);
  }

  var needRender = true;
  controls.addEventListener('change', function () { needRender = true; });
  (function loop() {
    requestAnimationFrame(loop);
    controls.update();
    if (needRender) { resize(); renderer.render(scene, camera); needRender = false; }
  })();
  function invalidate() { needRender = true; }

  // ======================================================================
  //  フォント輪郭 → 平面ポリゴン
  // ======================================================================
  // opentype のグリフを、輪郭ごとの点配列（mm, Y上向き）に変換する。
  // getPath(x,y,fontSize) は既に fontSize(=mm) スケールの座標を返す。
  function glyphContours(font, ch, penX, penY, curveSteps) {
    var glyph = font.charToGlyph(ch);
    var path = glyph.getPath(penX, penY, SIZE); // y は下向き、単位は mm
    var contours = [], cur = null, cx = 0, cy = 0, sx = 0, sy = 0;
    function P(x, y) { return [x, -y]; }         // Y 反転して上向きに
    path.commands.forEach(function (c) {
      if (c.type === 'M') { cur = [P(c.x, c.y)]; cx = c.x; cy = c.y; sx = c.x; sy = c.y; }
      else if (c.type === 'L') { cur.push(P(c.x, c.y)); cx = c.x; cy = c.y; }
      else if (c.type === 'C') {
        for (var i = 1; i <= curveSteps; i++) { var t = i / curveSteps;
          var mt = 1 - t;
          var x = mt*mt*mt*cx + 3*mt*mt*t*c.x1 + 3*mt*t*t*c.x2 + t*t*t*c.x;
          var y = mt*mt*mt*cy + 3*mt*mt*t*c.y1 + 3*mt*t*t*c.y2 + t*t*t*c.y;
          cur.push(P(x, y));
        } cx = c.x; cy = c.y;
      } else if (c.type === 'Q') {
        for (var j = 1; j <= curveSteps; j++) { var u = j / curveSteps, mu = 1 - u;
          var qx = mu*mu*cx + 2*mu*u*c.x1 + u*u*c.x;
          var qy = mu*mu*cy + 2*mu*u*c.y1 + u*u*c.y;
          cur.push(P(qx, qy));
        } cx = c.x; cy = c.y;
      } else if (c.type === 'Z') { if (cur && cur.length > 2) contours.push(cur); cur = null; }
    });
    var scale = SIZE / font.unitsPerEm;
    return { contours: contours, advance: glyph.advanceWidth * scale };
  }

  // 文字列レイアウト → 全グリフの輪郭（mm, 中央原点）
  function layoutText(font, text) {
    var scale = SIZE / font.unitsPerEm;
    var curveSteps = 10;
    var lines = text.split('\n').slice(0, 2);
    var lineH = SIZE * LINE_GAP;
    var lineContours = [];   // 各行: 輪郭配列（ベースライン基準・Y上向き）
    var lineWidths = [];
    var maxW = 0;

    lines.forEach(function (line, li) {
      var penX = 0;
      var chars = Array.from(line);
      var contours = [];
      chars.forEach(function (ch) {
        if (ch === ' ' || ch === '　') { penX += SIZE * 0.5; return; }
        var g = glyphContours(font, ch, penX, 0, curveSteps);  // penX は mm
        g.contours.forEach(function (c) { contours.push(c); });
        penX += g.advance + SIZE * LETTER_SPACING;
      });
      lineWidths[li] = Math.max(0, penX - SIZE * LETTER_SPACING);
      maxW = Math.max(maxW, lineWidths[li]);
      lineContours.push(contours);
    });

    // 各行を水平中央そろえ・行を縦に積む
    var allContours = [];
    lineContours.forEach(function (contours, li) {
      var dx = -lineWidths[li] / 2;
      var dy = (lines.length - 1) * lineH / 2 - li * lineH;
      contours.forEach(function (c) {
        allContours.push(c.map(function (p) { return [p[0] + dx, p[1] + dy]; }));
      });
    });

    // 実際の描画範囲で縦中央にそろえ直す（フォントのベースライン位置差を吸収）
    var minY = Infinity, maxY = -Infinity;
    allContours.forEach(function (c) { c.forEach(function (p) {
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }); });
    if (isFinite(minY)) {
      var cy = (minY + maxY) / 2;
      allContours.forEach(function (c) { c.forEach(function (p) { p[1] -= cy; }); });
    }
    var realH = isFinite(minY) ? (maxY - minY) : SIZE;
    return { contours: allContours, width: maxW, height: realH };
  }

  // ======================================================================
  //  輪郭ポリゴン → THREE.Shape（穴つき）
  // ======================================================================
  function signedArea(poly) {
    var a = 0; for (var i = 0, n = poly.length; i < n; i++) {
      var p = poly[i], q = poly[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1];
    } return a / 2;
  }
  function pointInPoly(pt, poly) {
    var x = pt[0], y = pt[1], inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    } return inside;
  }
  // 輪郭群を「外郭＋その穴」の shape 配列へ（包含の深さで判定）
  function contoursToShapes(contours) {
    var items = contours.map(function (c) { return { c: c, area: Math.abs(signedArea(c)) }; });
    items.sort(function (a, b) { return b.area - a.area; });   // 大きい順
    var shapes = [];
    items.forEach(function (it) {
      var rep = it.c[0];
      // この輪郭を含む既存 shape を探す（最も内側 = 最小面積の親）
      var parent = null;
      for (var k = 0; k < shapes.length; k++) {
        if (pointInPoly(rep, shapes[k].outer)) {
          if (!parent || shapes[k].area < parent.area) parent = shapes[k];
        }
      }
      // 親の穴の中に更にある場合は新しい外郭
      var inHole = false;
      if (parent) for (var h = 0; h < parent.holes.length; h++) {
        if (pointInPoly(rep, parent.holes[h])) { inHole = true; break; }
      }
      if (parent && !inHole) parent.holes.push(it.c);
      else shapes.push({ outer: it.c, holes: [], area: it.area });
    });
    return shapes.map(function (s) {
      var shp = new THREE.Shape(s.outer.map(function (p) { return new THREE.Vector2(p[0], p[1]); }));
      s.holes.forEach(function (hl) {
        shp.holes.push(new THREE.Path(hl.map(function (p) { return new THREE.Vector2(p[0], p[1]); })));
      });
      return shp;
    });
  }

  function puffGeometry(shapes, thickness, puff) {
    var r = Math.max(0.02, puff * thickness * 0.5);
    var depth = Math.max(0.01, thickness - 2 * r);
    var geo = new THREE.ExtrudeGeometry(shapes, {
      depth: depth, bevelEnabled: true, bevelThickness: r, bevelSize: r,
      bevelSegments: 4, steps: 1, curveSegments: 6
    });
    geo.translate(0, 0, -depth / 2 - r);   // 厚み中心を z=0 に
    geo.computeVertexNormals();
    return geo;
  }

  // ======================================================================
  //  Clipper で縁取りバンド
  // ======================================================================
  var SC = 1000;   // Clipper は整数座標。mm→整数の倍率
  function toClip(contours) {
    return contours.map(function (c) {
      return c.map(function (p) { return { X: Math.round(p[0] * SC), Y: Math.round(p[1] * SC) }; });
    });
  }
  function unionPaths(paths) {
    var cp = new ClipperLib.Clipper();
    cp.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
    var sol = new ClipperLib.Paths();
    cp.Execute(ClipperLib.ClipType.ctUnion, sol,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return sol;
  }
  function offsetPaths(paths, delta) {
    var co = new ClipperLib.ClipperOffset(2, 0.25 * SC);
    co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    var sol = new ClipperLib.Paths();
    co.Execute(sol, delta * SC);
    return sol;
  }
  function differencePaths(subj, clip) {
    var cp = new ClipperLib.Clipper();
    cp.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
    cp.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
    var sol = new ClipperLib.Paths();
    cp.Execute(ClipperLib.ClipType.ctDifference, sol,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return sol;
  }
  // 文字群の「外シルエット」＝内側の穴（カウンター）を塗りつぶした塗り面。
  // Union の PolyTree から外郭ノードだけ拾えば、カウンターは自然に埋まる。
  function outerSilhouette(paths) {
    var cp = new ClipperLib.Clipper();
    cp.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
    var tree = new ClipperLib.PolyTree();
    cp.Execute(ClipperLib.ClipType.ctUnion, tree,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    var outers = [];
    function poly(n) { return (typeof n.Contour === 'function') ? n.Contour() : (n.m_polygon || n.Contour); }
    function kids(n) { return (typeof n.Childs === 'function') ? n.Childs() : (n.m_Childs || []); }
    function isHole(n) { return (typeof n.IsHole === 'function') ? n.IsHole() : n.IsHole; }
    function walk(n) {
      kids(n).forEach(function (c) {
        if (!isHole(c)) { var p = poly(c); if (p && p.length > 2) outers.push(p); }
        walk(c);
      });
    }
    walk(tree);
    return outers;
  }
  // 縁取り＝名前の外周に沿って立ち上がる「器のフチ」。
  // 外シルエット（sil）を内側の縁、それを外へ width 広げた線を外側の縁とする帯。
  // 中央（＝文字が入る領域）は空きにするので、下地プレートではなく“枠/器”になる。
  // round-join オフセットなのでトゲは出ず、字間は橋渡しされて1枚に繋がる。
  function buildBorderShapes(textContours, width) {
    if (width <= 0.01) return null;
    var uni = toClip(textContours);
    var sil = outerSilhouette(uni);          // カウンターを塗った外形（Clipper 整数座標）
    if (!sil.length) return null;
    var inner = offsetPaths(sil, GAP);       // フチ内側（文字にわずかな隙間）
    var outer = offsetPaths(sil, GAP + width); // フチ外側
    if (!outer.length) return null;
    var band = differencePaths(outer, inner.length ? inner : sil);
    if (!band.length) return null;
    var contours = band.map(function (p) {
      return p.map(function (pt) { return [pt.X / SC, pt.Y / SC]; });
    });
    return contoursToShapes(contours);
  }

  // ======================================================================
  //  リング
  // ======================================================================
  function ringMesh(thickness, mat) {
    var r_in = RING_HOLE / 2, r_out = r_in + RING_WALL;
    var shape = new THREE.Shape();
    shape.absarc(0, 0, r_out, 0, Math.PI * 2, false);
    var hole = new THREE.Path(); hole.absarc(0, 0, r_in, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    var geo = new THREE.ExtrudeGeometry(shape, {
      depth: thickness * 0.8, bevelEnabled: true, bevelThickness: thickness * 0.1,
      bevelSize: thickness * 0.1, bevelSegments: 3, steps: 1, curveSegments: 24
    });
    geo.translate(0, 0, -thickness * 0.5);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, mat);
  }

  // ======================================================================
  //  組み立て
  // ======================================================================
  function material(hex) {
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex), roughness: 0.42, metalness: 0.0,
      envMapIntensity: 0.6
    });
  }

  function clearGroup(g) {
    for (var i = g.children.length - 1; i >= 0; i--) {
      var m = g.children[i]; g.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
  }

  function rebuild() {
    if (!fontCache[S.font]) return;
    var font = fontCache[S.font];
    clearGroup(meshGroup);

    var lay = layoutText(font, sanitize(S.text));
    if (!lay.contours.length) { invalidate(); return; }

    var textMat = material(S.textColor);
    var borderMat = material(S.borderColor);

    // フチ＝器の壁。文字より少し高く立ち上げ、底面をそろえて“器”に見せる。
    var borderShapes = S.border > 0.01 ? buildBorderShapes(lay.contours, S.border) : null;
    var rimThick = T_TEXT + RIM_LIP;         // 文字より RIM_LIP だけ高い
    if (borderShapes) {
      var bgeo = puffGeometry(borderShapes, rimThick, Math.min(S.puff, 0.5));
      var bmesh = new THREE.Mesh(bgeo, borderMat);
      bmesh.position.z = rimThick * 0.5;     // 底面を z=0 にそろえる
      bmesh.castShadow = true; bmesh.receiveShadow = true;
      meshGroup.add(bmesh);
    }

    // 文字。フチと同じ底面（z=0）に置き、器の中に納まって見えるように。
    var textShapes = contoursToShapes(lay.contours);
    var tgeo = puffGeometry(textShapes, T_TEXT, S.puff);
    var tmesh = new THREE.Mesh(tgeo, textMat);
    tmesh.position.z = borderShapes ? (T_TEXT * 0.5) : 0;
    tmesh.castShadow = true; tmesh.receiveShadow = true;
    meshGroup.add(tmesh);

    // リング
    var overall = computeBBox(lay, borderShapes ? S.border + GAP : 0);
    lastBBox = overall;
    if (S.ring) {
      var rmesh = ringMesh(borderShapes ? rimThick : T_TEXT, borderShapes ? borderMat : textMat);
      rmesh.castShadow = true; rmesh.receiveShadow = true;
      var side = (S.ringSide === 'left' ? -1 : 1);
      var rx = side * (lay.width / 2 + (borderShapes ? S.border : 0) + RING_HOLE / 2 + RING_WALL * 0.2);
      // フチにわずかに食い込ませて繋がって見えるように
      rx -= side * (RING_WALL + (borderShapes ? S.border * 0.4 : 0));
      rmesh.position.set(rx, 0, borderShapes ? rimThick * 0.5 : 0);
      meshGroup.add(rmesh);
      overall.w += RING_HOLE + RING_WALL;
    }

    meshGroup.position.set(0, 0, 0);

    // 背面シャドウキャッチャー（底面 z=0 のさらに裏に置く）
    shadowPlane.scale.set(Math.max(overall.w, overall.h) * 2.0, Math.max(overall.w, overall.h) * 2.0, 1);
    shadowPlane.position.set(0, 0, -1.2);

    lastFit = overall;
    fitCamera(overall);
    updateDims(overall);
    invalidate();
  }

  function computeBBox(lay, pad) {
    var w = lay.width + pad * 2, h = lay.height + pad * 2;
    return { w: w, h: h };
  }

  // フェイス面(+Z)を正面に、少し見下ろす 3/4 アングル。画面に収まる距離を計算。
  var VIEW_DIR = new THREE.Vector3(0.05, 0.26, 1.0).normalize();
  function fitCamera(bb) {
    var aspect = camera.aspect || 1.6;
    var vFov = camera.fov * Math.PI / 180;
    var margin = 1.18;
    var halfH = bb.h * 0.5 * margin;
    var halfW = bb.w * 0.5 * margin;
    var distH = halfH / Math.tan(vFov / 2);
    var distW = (halfW / aspect) / Math.tan(vFov / 2);
    var dist = Math.max(distH, distW) + Math.max(bb.w, bb.h) * 0.15 + 20;

    controls.target.set(0, 0, 0);
    // 初回だけ向きを決める。以後はユーザーの回転量を保って距離だけ合わせる。
    var dir;
    if (!fitCamera._init) { dir = VIEW_DIR.clone(); fitCamera._init = true; }
    else { dir = camera.position.clone().sub(controls.target); if (dir.lengthSq() < 1e-6) dir = VIEW_DIR.clone(); dir.normalize(); }
    camera.position.copy(dir.multiplyScalar(dist));
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    controls.minDistance = dist * 0.45;
    controls.maxDistance = dist * 2.4;
    controls.update();
  }

  function updateDims(bb) {
    var el = document.getElementById('dims');
    var th = (S.border > 0.01 ? Math.max(T_TEXT, T_TEXT + RIM_LIP) : T_TEXT);
    el.innerHTML =
      '横 <b>' + Math.round(bb.w) + '</b> mm　' +
      '縦 <b>' + Math.round(bb.h) + '</b> mm　' +
      '厚み <b>' + th.toFixed(1) + '</b> mm';
  }

  function sanitize(t) {
    if (!t) return DEFAULTS.text;
    return t.replace(/\r/g, '').slice(0, 40);
  }

  // ======================================================================
  //  UI
  // ======================================================================
  function buildSwatches(hostId, key) {
    var host = document.getElementById(hostId);
    host.innerHTML = '';
    PALETTE.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'swatch'; b.style.background = c[0]; b.title = c[1];
      b.setAttribute('aria-pressed', S[key] === c[0] ? 'true' : 'false');
      b.addEventListener('click', function () {
        S[key] = c[0];
        host.querySelectorAll('.swatch').forEach(function (s) { s.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        rebuild();
      });
      host.appendChild(b);
    });
  }

  function bindSeg(segId, prop, attr) {
    var seg = document.getElementById(segId);
    seg.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        seg.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
        btn.setAttribute('aria-pressed', 'true');
        S[prop] = btn.dataset[attr];
        if (prop === 'font') ensureFont(S.font, rebuild);
        else rebuild();
      });
    });
  }

  function updateTextCount() {
    var t = document.getElementById('text').value;
    document.getElementById('textCount').textContent = Array.from(t.replace(/\n/g, '')).length + '文字';
  }

  function initUI() {
    var textEl = document.getElementById('text');
    textEl.addEventListener('input', function () {
      S.text = textEl.value; updateTextCount();
      var warn = document.getElementById('textWarn');
      var n = Array.from(textEl.value.replace(/\n/g, '')).length;
      if (n > 8) { warn.textContent = '文字数が多いと細部がつぶれやすくなります（8文字くらいまでが目安）。'; warn.classList.add('show'); }
      else warn.classList.remove('show');
      rebuild();
    });
    updateTextCount();

    bindSeg('fontSeg', 'font', 'font');
    bindSeg('ringSeg', 'ringSide', 'side');

    var puff = document.getElementById('puff');
    puff.addEventListener('input', function () {
      S.puff = parseFloat(puff.value);
      document.getElementById('puffVal').textContent = S.puff.toFixed(2);
      rebuild();
    });

    var border = document.getElementById('border');
    border.addEventListener('input', function () {
      S.border = parseFloat(border.value);
      document.getElementById('borderVal').textContent = S.border.toFixed(1) + ' mm';
      rebuild();
    });

    document.getElementById('ring').addEventListener('change', function () {
      S.ring = this.checked; rebuild();
    });

    buildSwatches('swText', 'textColor');
    buildSwatches('swBorder', 'borderColor');

    document.getElementById('resetBtn').addEventListener('click', function () {
      S = Object.assign({}, DEFAULTS);
      document.getElementById('text').value = S.text;
      document.getElementById('puff').value = S.puff;
      document.getElementById('puffVal').textContent = S.puff.toFixed(2);
      document.getElementById('border').value = S.border;
      document.getElementById('borderVal').textContent = S.border.toFixed(1) + ' mm';
      document.getElementById('ring').checked = S.ring;
      syncSeg('fontSeg', 'font', S.font); syncSeg('ringSeg', 'side', S.ringSide);
      buildSwatches('swText', 'textColor'); buildSwatches('swBorder', 'borderColor');
      updateTextCount();
      ensureFont(S.font, rebuild);
    });

    document.getElementById('pngBtn').addEventListener('click', savePNG);
    document.getElementById('orderBtn').addEventListener('click', openOrder);
    initOrder();
  }

  function syncSeg(segId, attr, val) {
    document.getElementById(segId).querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset[attr] === val ? 'true' : 'false');
    });
  }

  function savePNG() {
    invalidate(); renderer.render(scene, camera);
    var url = renderer.domElement.toDataURL('image/png');
    var a = document.createElement('a');
    a.href = url; a.download = 'neqo-keychain-' + sanitize(S.text).replace(/\n/g, '_') + '.png';
    a.click();
  }

  // ---- order dialog ----
  var ENDPOINT = 'https://script.google.com/macros/s/AKfycbyHicngCVMmfbtBU1VuuL-Ma7-UckHde8SKVsIocotw_DMFi2eWJaM8SooKTp-mTrR1/exec';
  var dlg = document.getElementById('orderDlg');

  function previewDataURL(maxW, type, q) {
    invalidate(); renderer.render(scene, camera);
    var full = renderer.domElement;
    var scale = Math.min(1, (maxW || 480) / full.width);
    var c = document.createElement('canvas');
    c.width = Math.round(full.width * scale); c.height = Math.round(full.height * scale);
    var ctx = c.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(full, 0, 0, c.width, c.height);
    return c.toDataURL(type || 'image/png', q);
  }

  function compactSpec() {
    return {
      v: 1, text: S.text, font: S.font, puff: +S.puff.toFixed(2),
      textColor: S.textColor, borderColor: S.borderColor,
      border: +S.border.toFixed(1), ring: S.ring, ringSide: S.ringSide,
      t_text: T_TEXT, t_rim: T_TEXT + RIM_LIP
    };
  }

  function specText() {
    var bb = lastBBox || { w: 0, h: 0 };
    var th = (S.border > 0.01 ? Math.max(T_TEXT, T_TEXT + RIM_LIP) : T_TEXT);
    return [
      '■ ぷくぷくキーホルダー 注文',
      '文字: ' + JSON.stringify(S.text),
      '書体: ' + FONTS[S.font].label,
      'ぷくぷく度: ' + S.puff.toFixed(2),
      '文字色: ' + colorName(S.textColor) + ' (' + S.textColor + ')',
      'フチ: ' + (S.border > 0.01 ? (S.border.toFixed(1) + 'mm ' + colorName(S.borderColor) + ' (' + S.borderColor + ')') : 'なし'),
      '金具リング: ' + (S.ring ? (S.ringSide === 'left' ? '左' : '右') : 'なし'),
      '概寸: 約 ' + Math.round(bb.w) + ' × ' + Math.round(bb.h) + ' × ' + th.toFixed(1) + ' mm'
    ].join('\n');
  }
  function colorName(hex) {
    for (var i = 0; i < PALETTE.length; i++) if (PALETTE[i][0].toLowerCase() === hex.toLowerCase()) return PALETTE[i][1];
    return hex;
  }

  function openOrder() {
    document.getElementById('ordImg').src = previewDataURL(360);
    var bb = lastBBox || { w: 0, h: 0 };
    var th = (S.border > 0.01 ? Math.max(T_TEXT, T_TEXT + RIM_LIP) : T_TEXT);
    document.getElementById('ordMeta').innerHTML =
      '<b>' + escapeHtml(S.text.replace(/\n/g, ' ')) + '</b>' +
      '<span>' + FONTS[S.font].label + '／ぷくぷく ' + S.puff.toFixed(2) + '</span>' +
      '<span>文字：' + colorName(S.textColor) + '　フチ：' + (S.border > 0.01 ? colorName(S.borderColor) : 'なし') + '</span>' +
      '<span>約 ' + Math.round(bb.w) + '×' + Math.round(bb.h) + '×' + th.toFixed(1) + ' mm</span>';
    document.getElementById('sent').className = 'sent';
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function initOrder() {
    document.getElementById('cancelBtn').addEventListener('click', function () { dlg.close(); });
    document.getElementById('orderForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitOrder();
    });
  }

  function say(kind, html) {
    var s = document.getElementById('sent');
    s.className = 'sent show ' + kind; s.innerHTML = html;
  }

  function submitOrder() {
    var name = document.getElementById('oName').value.trim();
    var mail = document.getElementById('oMail').value.trim();
    if (!name || !mail || mail.indexOf('@') < 0) {
      say('err', 'お名前と、正しいメールアドレスをご入力ください。'); return;
    }
    var qty = document.getElementById('oQty').value;
    var note = document.getElementById('oNote').value.trim();
    var message = specText() + '\n個数: ' + qty + (note ? ('\nご要望: ' + note) : '') +
      '\n\nSPEC=' + JSON.stringify(compactSpec()) +
      '\n（このメールは neqo-fab クリエイターから自動送信されています）';

    // プレビューは小さめ JPEG（Sheets のセル上限5万文字に収める）
    var payload = new URLSearchParams({
      hp: document.getElementById('oHidden').value,
      type: 'ぷくぷくキーホルダー注文',
      name: name, mail: mail, message: message,
      preview: previewDataURL(360, 'image/jpeg', 0.62)
    });

    var btn = document.getElementById('sendBtn');
    var label = btn.textContent; btn.disabled = true; btn.textContent = '送信中…';
    fetch(ENDPOINT, { method: 'POST', body: payload })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('rejected');
        say('ok', '<b>送信しました。</b><br>内容を確認して、2〜3日以内にお見積り（送料込み）をご返信します。');
        document.getElementById('orderForm').reset();
      })
      .catch(function () {
        say('err', '送信に失敗しました。時間をおいて再度お試しいただくか、トップページのお問い合わせからご連絡ください。');
      })
      .then(function () { btn.disabled = false; btn.textContent = label; });
  }

  function escapeHtml(s) { return s.replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  // ======================================================================
  //  フォント読み込み
  // ======================================================================
  function ensureFont(which, cb) {
    if (fontCache[which]) { cb && cb(); return; }
    opentype.load(FONTS[which].url, function (err, font) {
      if (err) { console.error('font load failed', which, err);
        document.getElementById('load').textContent = 'フォントの読み込みに失敗しました'; return; }
      fontCache[which] = font;
      cb && cb();
    });
  }

  function boot() {
    resize();
    initUI();
    ensureFont(DEFAULTS.font, function () {
      document.getElementById('load').classList.add('done');
      requestAnimationFrame(function () { resize(); rebuild();
        requestAnimationFrame(function () { resize(); }); });
    });
  }
  boot();
})();
