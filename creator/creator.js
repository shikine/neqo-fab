/* NEQO FAB — ぷくぷくネームキーホルダー クリエイター
 *
 * Blender アドオン (works/007) の生成方法をブラウザに移植したもの。
 *   ぷくぷく文字 = フォント輪郭を押し出し（extrude）＋角丸（bevel）。
 *                  総厚み t、ぷくぷく度 puff に対し r=puff*t/2、
 *                  depth=t-2r, bevelThickness=bevelSize=r。addon と同じ断面モデル。
 *   縁取り       = 名前の外シルエットを Clipper で round-offset した「お皿状のフチ」。
 *                  底(floor)＋外周に立つ壁(rim)で、文字は底の上に乗る。
 *                  文字と壁のあいだに“堀”(GAP)を設けて潰れを防ぐ。
 *                  round-join＝真のミンコフスキー和なので鋭角のトゲが出ない。
 *                  底があるので全体が1体化し、2部品に分けても組み合わせて完成する。
 *   金具リング   = フチ端に丸パッドを一体化し、穴を開ける（外縁だけで処理）。
 *   注文時       = フチ部品／文字部品の STL と完成予想 PNG を書き出して送信する。
 *
 * すべて mm を Three の 1 単位として扱う。
 */
(function () {
  'use strict';

  // 書体（スタイル）ごとに、日本語系(_jp)とハングル系(_ko)のフォントを持つ。
  // 文字ごとに字形を持つフォントへ自動フォールバックする（日英韓の混在OK）。
  var FONTS = {
    pop:  { label: 'ポップ体', jp: 'fonts/MochiyPopOne-Regular.ttf', ko: 'fonts/Jua-Regular.ttf' },
    rock: { label: 'レトロ丸', jp: 'fonts/RocknRollOne-Regular.ttf', ko: 'fonts/BlackHanSans-Regular.ttf' }
  };
  function fontUrl(key) {   // key 例: 'pop_jp'
    var m = key.split('_'); return FONTS[m[0]][m[1]];
  }
  function isHangul(ch) {
    var c = ch.charCodeAt(0);
    return (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x1100 && c <= 0x11FF) ||
           (c >= 0x3130 && c <= 0x318F) || (c >= 0xA960 && c <= 0xA97F);
  }

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

  // 当面はPLA専用。材料原価や販売条件を変えるときは、この数値だけ調整する。
  var MATERIAL = { key: 'pla', label: 'PLA', density: 1.24, yenPerKg: 3000 };
  var PRICE = {
    baseYen: 700,          // 造形準備・機械使用・仕上げの基本料金
    yenPerGram: 50,        // 材料使用量に連動する加工料金
    minimumYen: 900,       // 1個あたり最低価格
    roundYen: 100          // 表示価格の丸め単位（切り上げ）
  };
  // Stripe国内カード手数料3.6%を差し引いても郵便料金を確保できるよう、10円単位で切り上げる。
  var STRIPE_FEE_RATE = 0.036;
  function stripeFeeIncludedYen(postageYen) {
    return Math.ceil((postageYen / (1 - STRIPE_FEE_RATE)) / 10) * 10;
  }
  var SHIPPING = {
    smart: { label: 'スマートレター', postageYen: 210, yen: stripeFeeIncludedYen(210) },
    light: { label: 'レターパックライト', postageYen: 430, yen: stripeFeeIncludedYen(430) },
    pickup: { label: '直接受け取り', postageYen: 0, yen: 0 }
  };
  // 2026年8月31日 23:59（日本時間）まで、商品代は0円で送料のみ。
  var AUGUST_CAMPAIGN_END_MS = Date.parse('2026-09-01T00:00:00+09:00');
  function augustCampaignActive() { return Date.now() < AUGUST_CAMPAIGN_END_MS; }
  function orderUnitPrice(estimate) { return augustCampaignActive() ? 0 : estimate.priceYen; }
  var MATERIAL_MARGIN = 1.08; // スライサー差・端材を見込む8%
  var JOB_OVERHEAD_G = 0.35;  // 別出力1回あたりのスカート／開始線など

  // 固定寸法（mm）
  var SIZE = 20;          // 文字の em サイズ
  var T_TEXT = 3.0;       // 文字の厚み
  var T_BORDER = 2.4;     // （旧）未使用。フチ厚は T_TEXT + RIM_LIP
  var GAP = 0.7;          // 文字とフチの間の“堀”。0だと内壁が文字に食い込んで潰れて見える
  var RING_HOLE = 4.0, RING_WALL = 2.2;
  var FLOOR = 1.2;        // お皿の底の厚み mm（フチ部品の底面）。文字はこの上に乗る
  var WALL = 1.4;         // 底から立ち上がる壁の高さ mm（お皿のフチ）
  var LETTER_SPACING = 0.06;   // em 比
  var LINE_GAP = 1.02;         // 行送り（em比）

  // ---- state ----
  var S = Object.assign({}, DEFAULTS);
  var fontCache = {};
  var THREEfont = null;
  var lastBBox = null;
  var lastEstimate = null;

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
  var borderMesh = null, textMesh = null;   // 出力用に保持

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

  function hasGlyph(font, ch) { return font && font.charToGlyph(ch).index !== 0; }
  // 文字 ch に使うフォントを選ぶ。ハングルは _ko を優先、無ければ _jp、
  // それも無ければ他スタイルへ。読み込み済みのものだけから選ぶ。
  function pickFont(style, ch) {
    var pref = isHangul(ch) ? (style + '_ko') : (style + '_jp');
    var order = [pref, style + '_jp', style + '_ko',
                 'pop_jp', 'rock_jp', 'pop_ko', 'rock_ko'];
    for (var i = 0; i < order.length; i++) {
      var f = fontCache[order[i]];
      if (hasGlyph(f, ch)) return f;
    }
    for (var k in fontCache) if (fontCache[k]) return fontCache[k];
    return null;
  }
  // text の描画に必要なフォントキー集合（プリロード用）。基準として style_jp は常に含める。
  function neededFontKeys(style, text) {
    var set = {};
    set[style + '_jp'] = true;
    Array.from(text).forEach(function (ch) {
      if (ch === ' ' || ch === '　' || ch === '\n') return;
      set[isHangul(ch) ? (style + '_ko') : (style + '_jp')] = true;
    });
    return Object.keys(set);
  }

  // 文字列レイアウト → 全グリフの輪郭（mm, 中央原点）
  function layoutText(style, text) {
    var curveSteps = 6;
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
        var font = pickFont(style, ch);
        if (!font) return;
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
      bevelSegments: 3, steps: 1, curveSegments: 4
    });
    // ExtrudeGeometry は z=-r 〜 depth+r に広がる（中心 depth/2）。
    // -depth/2 で中心を z=0 にそろえる（総厚み = depth+2r）。
    geo.translate(0, 0, -depth / 2);
    geo.computeVertexNormals();
    return geo;
  }
  // 平板（お皿の底）。天面はフラット（面取り無し）＝壁との境界に段が出ないようにする。
  function plateGeometry(shapes, thickness) {
    var geo = new THREE.ExtrudeGeometry(shapes, {
      depth: thickness, bevelEnabled: false, steps: 1, curveSegments: 4
    });
    geo.translate(0, 0, -thickness / 2);
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
  function circlePath(cx, cy, r, seg) {
    var p = [];
    for (var i = 0; i < seg; i++) {
      var a = 2 * Math.PI * i / seg;
      p.push({ X: Math.round((cx + r * Math.cos(a)) * SC), Y: Math.round((cy + r * Math.sin(a)) * SC) });
    }
    return p;
  }

  // 縁取り＝名前の外周に沿って立ち上がる「器のフチ」。
  // 外シルエット（sil）を内側の縁、それを外へ width 広げた線を外側の縁とする帯。
  // 中央（＝文字が入る領域）は空きにするので、下地プレートではなく“枠/器”になる。
  // ring 指定時は、フチの端に丸いパッドを一体化し、そこに金具穴を開ける
  // （＝リングを別部品にせず「外縁だけで処理」する）。
  // round-join オフセットなのでトゲは出ず、字間は橋渡しされて1枚に繋がる。
  function pathsToShapes(paths) {
    return contoursToShapes(paths.map(function (p) {
      return p.map(function (pt) { return [pt.X / SC, pt.Y / SC]; });
    }));
  }

  // お皿状フチ。floor=底（外形いっぱいの塗り面）、rim=底の外周に立つ壁（帯）。
  // どちらにも金具パッド＋穴を一体化する（＝金具は外縁だけで処理）。
  function buildBorderShapes(textContours, width, ring) {
    if (width <= 0.01) return null;
    var uni = toClip(textContours);
    var sil = outerSilhouette(uni);            // カウンターを塗った外形
    if (!sil.length) return null;
    var inner = offsetPaths(sil, GAP);         // 壁の内側（＝底の内寄り）
    var outer = offsetPaths(sil, GAP + width); // 皿の外形
    if (!outer.length) return null;
    var band = differencePaths(outer, inner.length ? inner : sil);
    if (!band.length) return null;

    var floor = outer;                          // 底は外形いっぱいの塗り面
    if (ring) {
      var lug = circlePath(ring.cx, ring.cy, ring.rOut, 48);
      var hole = circlePath(ring.cx, ring.cy, ring.rIn, 40);
      floor = differencePaths(unionPaths(floor.concat([lug])), [hole]);
      band = differencePaths(unionPaths(band.concat([lug])), [hole]);
    }
    return { floor: pathsToShapes(floor), rim: pathsToShapes(band) };
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
    var text = sanitize(S.text);
    // この文字列に必要なフォントが未読なら読み込んでから作り直す
    var keys = neededFontKeys(S.font, text);
    var missing = keys.filter(function (k) { return !fontCache[k]; });
    if (missing.length) { ensureFonts(missing, function () { rebuild(); }); return; }

    clearGroup(meshGroup);
    borderMesh = null; textMesh = null;

    var lay = layoutText(S.font, text);
    if (!lay.contours.length) { invalidate(); return; }

    var textMat = material(S.textColor);
    var borderMat = material(S.borderColor);

    // 金具穴はフチの端に一体化する（別部品にしない）
    var ringOpt = null;
    if (S.ring && S.border > 0.01) {
      var side = (S.ringSide === 'left' ? -1 : 1);
      var rOut = RING_HOLE / 2 + RING_WALL;
      var outerEdge = lay.width / 2 + GAP + S.border;   // フチ外端の x
      var cx = side * (outerEdge + RING_HOLE / 2);       // パッド中心（RING_WALL 分フチに食い込む）
      ringOpt = { cx: cx, cy: 0, rOut: rOut, rIn: RING_HOLE / 2 };
    }

    // フチ＝お皿。底(floor)＋外周の壁(rim)。底面は z=0。
    var borderShapes = S.border > 0.01 ? buildBorderShapes(lay.contours, S.border, ringOpt) : null;
    var floorTop = borderShapes ? FLOOR : 0;   // 文字が乗る面
    if (borderShapes) {
      var fgeo = plateGeometry(borderShapes.floor, FLOOR);  // 底：平板・天面フラット
      var fmesh = new THREE.Mesh(fgeo, borderMat);
      fmesh.position.z = FLOOR * 0.5;
      fmesh.castShadow = true; fmesh.receiveShadow = true;
      meshGroup.add(fmesh);

      // 壁は底の一番下(z=0)から全高で立てる＝底面と一体化し、境界(z=FLOOR)は
      // 垂直な内壁のまま（面取りが出ない）。上端だけぷくっと丸める。
      var rimTop = FLOOR + WALL;
      var wgeo = puffGeometry(borderShapes.rim, rimTop, Math.min(S.puff, 0.5));
      var wmesh = new THREE.Mesh(wgeo, borderMat);
      wmesh.position.z = rimTop * 0.5;
      wmesh.castShadow = true; wmesh.receiveShadow = true;
      meshGroup.add(wmesh);

      borderMesh = [fmesh, wmesh];
    }

    // 文字。お皿の底の上（z=floorTop）に乗せる。
    var textShapes = contoursToShapes(lay.contours);
    var tgeo = puffGeometry(textShapes, T_TEXT, S.puff);
    var tmesh = new THREE.Mesh(tgeo, textMat);
    tmesh.position.z = floorTop + T_TEXT * 0.5;
    tmesh.castShadow = true; tmesh.receiveShadow = true;
    meshGroup.add(tmesh);
    textMesh = tmesh;

    // 金具穴はフチに含めたので、寸法だけ張り出し分を見込む
    var overall = computeBBox(lay, borderShapes ? S.border + GAP : 0);
    lastBBox = overall;
    if (ringOpt) overall.w += RING_HOLE + RING_WALL * 2;

    meshGroup.position.set(0, 0, 0);

    // 背面シャドウキャッチャー（底面 z=0 のさらに裏に置く）
    shadowPlane.scale.set(Math.max(overall.w, overall.h) * 2.0, Math.max(overall.w, overall.h) * 2.0, 1);
    shadowPlane.position.set(0, 0, -1.2);

    lastFit = overall;
    fitCamera(overall);
    updateDims(overall);
    updateEstimate();
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
    var th = (S.border > 0.01 ? (FLOOR + T_TEXT) : T_TEXT);
    el.innerHTML =
      '横 <b>' + Math.round(bb.w) + '</b> mm　' +
      '縦 <b>' + Math.round(bb.h) + '</b> mm　' +
      '厚み <b>' + th.toFixed(1) + '</b> mm';
  }

  // 閉じた三角形メッシュの符号付き四面体体積から体積(mm³)を求める。
  function meshVolumeMm3(meshOrArr) {
    if (!meshOrArr) return 0;
    var list = Array.isArray(meshOrArr) ? meshOrArr : [meshOrArr];
    var total = 0;
    list.forEach(function (mesh) {
      if (!mesh || !mesh.geometry) return;
      mesh.updateWorldMatrix(true, false);
      var g = mesh.geometry, pos = g.attributes.position, idx = g.index, m = mesh.matrixWorld;
      var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cross = new THREE.Vector3();
      var sum = 0, count = idx ? idx.count : pos.count;
      function v(i, out) { return out.fromBufferAttribute(pos, i).applyMatrix4(m); }
      for (var i = 0; i < count; i += 3) {
        var i0 = idx ? idx.getX(i) : i;
        var i1 = idx ? idx.getX(i + 1) : i + 1;
        var i2 = idx ? idx.getX(i + 2) : i + 2;
        v(i0, a); v(i1, b); v(i2, c);
        sum += a.dot(cross.crossVectors(b, c)) / 6;
      }
      total += Math.abs(sum);
    });
    return total;
  }

  function yen(n) { return '¥' + Math.round(n).toLocaleString('ja-JP'); }

  function calculateEstimate() {
    var mat = MATERIAL;
    var textNetG = meshVolumeMm3(textMesh) / 1000 * mat.density;
    // フチは底と壁のSTLが重なっている。スライサーで一体化される重複分を二重計上しない。
    var borderMm3 = 0;
    if (borderMesh && borderMesh.length) {
      var floorMm3 = meshVolumeMm3(borderMesh[0]);
      var rimMm3 = meshVolumeMm3(borderMesh[1]);
      borderMm3 = floorMm3 + rimMm3 * (WALL / (FLOOR + WALL));
    }
    var borderNetG = borderMm3 / 1000 * mat.density;
    // 色別の2部品を別出力するため、存在する部品ごとに開始線などの予備量を加える。
    var textG = textNetG > 0 ? textNetG * MATERIAL_MARGIN + JOB_OVERHEAD_G : 0;
    var borderG = borderNetG > 0 ? borderNetG * MATERIAL_MARGIN + JOB_OVERHEAD_G : 0;
    var grams = textG + borderG;
    var materialYen = grams * mat.yenPerKg / 1000;
    var rawPrice = Math.max(PRICE.minimumYen, PRICE.baseYen + grams * PRICE.yenPerGram);
    var priceYen = Math.ceil(rawPrice / PRICE.roundYen) * PRICE.roundYen;
    return {
      material: mat.key, materialLabel: mat.label,
      textG: textG, borderG: borderG, grams: grams,
      materialYen: materialYen, priceYen: priceYen
    };
  }

  function updateEstimate() {
    lastEstimate = calculateEstimate();
    var e = lastEstimate;
    var weight = document.getElementById('materialWeight');
    var price = document.getElementById('estimatedPrice');
    var priceLabel = document.getElementById('estimatedPriceLabel');
    var note = document.getElementById('estimateBreakdown');
    if (weight) weight.textContent = '約 ' + e.grams.toFixed(1) + ' g';
    if (priceLabel) priceLabel.textContent = augustCampaignActive() ? '8月キャンペーン／1個' : '参考価格／1個';
    if (price) price.innerHTML = augustCampaignActive()
      ? '<span class="campaign-old">通常 ' + yen(e.priceYen) + '</span><br>¥0'
      : yen(e.priceYen);
    if (note) note.textContent = augustCampaignActive()
      ? '8月31日23:59まで商品代0円。お支払いは送料のみです。材料使用量は製作管理用に計算しています。'
      : '文字 ' + e.textG.toFixed(1) + 'g ＋ フチ ' + e.borderG.toFixed(1) + 'g' +
        '（別出力の予備分込み）／材料原価 約' + Math.ceil(e.materialYen) + '円。送料別の参考価格です。';
    updateOrderPrice();
  }

  function updateCampaignUI() {
    var active = augustCampaignActive();
    var banner = document.getElementById('campaignBanner');
    var sub = document.getElementById('orderDialogSub');
    if (banner) banner.hidden = !active;
    if (sub) sub.textContent = active
      ? '8月限定キャンペーンのため商品代は0円です。Stripeの決済画面で送料のみをお支払いください。'
      : '内容を送信後、Stripeの決済画面で商品代と送料を確認します。決済が完了するまで注文は確定しません。';
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
        rebuild();   // 必要なフォントは rebuild 内で読み込む
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
      rebuild();
    });

    document.getElementById('pngBtn').addEventListener('click', savePNG);
    document.getElementById('orderBtn').addEventListener('click', openOrder);
    initOrder();
  }

  function initMobileInputVisibility() {
    var controls = document.querySelector('.controls');
    var viewport = window.visualViewport;
    var timers = [];

    function activeControl() {
      var el = document.activeElement;
      if (!el || !controls.contains(el)) return null;
      return el.matches('input[type="text"],textarea,select') ? el : null;
    }

    function revealActiveControl() {
      if (!window.matchMedia('(max-width:640px)').matches) return;
      var el = activeControl();
      var stage = document.querySelector('.stage');
      var viewTop = viewport ? viewport.offsetTop : 0;
      var viewHeight = viewport ? viewport.height : window.innerHeight;
      document.body.classList.toggle('mobile-input-tight', !!el && viewHeight < 420);
      if (!el || !stage) return;

      var stageBottom = stage.getBoundingClientRect().bottom;
      var safeTop = Math.max(viewTop + 10, stageBottom + 10);
      var safeBottom = viewTop + viewHeight - 12;
      var rect = el.getBoundingClientRect();
      if (safeBottom <= safeTop || (rect.top >= safeTop && rect.bottom <= safeBottom)) return;

      var room = Math.max(0, safeBottom - safeTop - rect.height);
      var targetTop = safeTop + Math.min(28, room / 2);
      window.scrollBy(0, rect.top - targetTop);
    }

    function scheduleReveal() {
      timers.forEach(function (id) { window.clearTimeout(id); });
      timers = [60, 240, 520].map(function (delay) {
        return window.setTimeout(revealActiveControl, delay);
      });
    }

    controls.addEventListener('focusin', scheduleReveal);
    controls.addEventListener('focusout', scheduleReveal);
    if (viewport) {
      viewport.addEventListener('resize', scheduleReveal);
      viewport.addEventListener('scroll', scheduleReveal);
    }
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

  // ---- STL 書き出し（部品ごと・ワールド座標） ----
  function meshTriangles(mesh) {
    mesh.updateWorldMatrix(true, false);
    var g = mesh.geometry, pos = g.attributes.position, idx = g.index, m = mesh.matrixWorld;
    var tris = [];
    var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    function v(i, out) { return out.fromBufferAttribute(pos, i).applyMatrix4(m); }
    var count = idx ? idx.count : pos.count;
    for (var i = 0; i < count; i += 3) {
      var i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      tris.push([v(i0, a).clone(), v(i1, b).clone(), v(i2, c).clone()]);
    }
    return tris;
  }
  function trisToStl(tris) {
    var n = tris.length, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf), off = 84;
    dv.setUint32(80, n, true);
    var ab = new THREE.Vector3(), ac = new THREE.Vector3(), nr = new THREE.Vector3();
    for (var t = 0; t < n; t++) {
      var p = tris[t];
      ab.subVectors(p[1], p[0]); ac.subVectors(p[2], p[0]); nr.crossVectors(ab, ac);
      if (nr.lengthSq() > 0) nr.normalize();
      dv.setFloat32(off, nr.x, true); dv.setFloat32(off + 4, nr.y, true); dv.setFloat32(off + 8, nr.z, true); off += 12;
      for (var k = 0; k < 3; k++) { dv.setFloat32(off, p[k].x, true); dv.setFloat32(off + 4, p[k].y, true); dv.setFloat32(off + 8, p[k].z, true); off += 12; }
      off += 2;
    }
    return new Uint8Array(buf);
  }
  function u8ToBase64(u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function meshStlBase64(meshOrArr) {
    if (!meshOrArr) return '';
    var list = Array.isArray(meshOrArr) ? meshOrArr : [meshOrArr];
    var tris = [];
    list.forEach(function (m) { if (m) tris = tris.concat(meshTriangles(m)); });
    if (!tris.length) return '';
    return u8ToBase64(trisToStl(tris));
  }

  function compactSpec() {
    var e = lastEstimate || calculateEstimate();
    return {
      v: 2, text: S.text, font: S.font, puff: +S.puff.toFixed(2),
      textColor: S.textColor, borderColor: S.borderColor,
      border: +S.border.toFixed(1), ring: S.ring, ringSide: S.ringSide,
      material: MATERIAL.key, grams: +e.grams.toFixed(1), priceYen: e.priceYen,
      campaignPriceYen: orderUnitPrice(e),
      t_text: T_TEXT, t_floor: FLOOR, t_wall: WALL
    };
  }

  function specText() {
    var bb = lastBBox || { w: 0, h: 0 };
    var e = lastEstimate || calculateEstimate();
    var th = (S.border > 0.01 ? (FLOOR + T_TEXT) : T_TEXT);
    return [
      '■ ぷくぷくキーホルダー 注文',
      '文字: ' + JSON.stringify(S.text),
      '書体: ' + FONTS[S.font].label,
      'ぷくぷく度: ' + S.puff.toFixed(2),
      '文字色: ' + colorName(S.textColor) + ' (' + S.textColor + ')',
      'フチ: ' + (S.border > 0.01 ? (S.border.toFixed(1) + 'mm ' + colorName(S.borderColor) + ' (' + S.borderColor + ')') : 'なし'),
      '金具リング: ' + (S.ring ? (S.ringSide === 'left' ? '左' : '右') : 'なし'),
      '概寸: 約 ' + Math.round(bb.w) + ' × ' + Math.round(bb.h) + ' × ' + th.toFixed(1) + ' mm',
      '材料: ' + e.materialLabel + '／約 ' + e.grams.toFixed(1) + ' g（文字 ' + e.textG.toFixed(1) + 'g・フチ ' + e.borderG.toFixed(1) + 'g）',
      (augustCampaignActive()
        ? '8月キャンペーン価格: ¥0／1個（送料のみ）'
        : '参考価格: ' + yen(e.priceYen) + '／1個（送料別）')
    ].join('\n');
  }
  function colorName(hex) {
    for (var i = 0; i < PALETTE.length; i++) if (PALETTE[i][0].toLowerCase() === hex.toLowerCase()) return PALETTE[i][1];
    return hex;
  }

  function openOrder() {
    document.getElementById('ordImg').src = previewDataURL(360);
    var bb = lastBBox || { w: 0, h: 0 };
    var th = (S.border > 0.01 ? (FLOOR + T_TEXT) : T_TEXT);
    var e = lastEstimate || calculateEstimate();
    document.getElementById('ordMeta').innerHTML =
      '<b>' + escapeHtml(S.text.replace(/\n/g, ' ')) + '</b>' +
      '<span>' + FONTS[S.font].label + '／ぷくぷく ' + S.puff.toFixed(2) + '</span>' +
      '<span>文字：' + colorName(S.textColor) + '　フチ：' + (S.border > 0.01 ? colorName(S.borderColor) : 'なし') + '</span>' +
      '<span>約 ' + Math.round(bb.w) + '×' + Math.round(bb.h) + '×' + th.toFixed(1) + ' mm</span>' +
      '<span>' + e.materialLabel + ' 約' + e.grams.toFixed(1) + 'g／' +
        (augustCampaignActive() ? '8月キャンペーン 商品代¥0' : '参考価格 ' + yen(e.priceYen)) + '</span>';
    updateShippingChoices();
    document.getElementById('sent').className = 'sent';
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function initOrder() {
    document.getElementById('cancelBtn').addEventListener('click', function () { dlg.close(); });
    document.getElementById('oQty').addEventListener('change', updateShippingChoices);
    document.getElementById('oShipping').addEventListener('change', updateShippingChoices);
    document.getElementById('orderForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitOrder();
    });
  }

  function smartLetterEligible() {
    var qty = parseInt(document.getElementById('oQty').value, 10);
    if (qty !== 1 || !lastBBox) return false;
    // 封筒は250×170mm。緩衝材と封入余白を各辺に見込む。
    var w = lastBBox.w, h = lastBBox.h;
    return (w <= 235 && h <= 155) || (w <= 155 && h <= 235);
  }

  function updateShippingChoices() {
    var select = document.getElementById('oShipping');
    var smart = select.querySelector('option[value="smart"]');
    var eligible = smartLetterEligible();
    smart.disabled = !eligible;
    if (!eligible && select.value === 'smart') select.value = 'light';
    var pickup = select.value === 'pickup';
    document.getElementById('oShippingNote').textContent = pickup
      ? '送料・オンライン決済はありません。受付後、受け取り日時と場所をメールで調整します。'
      : (eligible
        ? '全国一律・Stripe手数料込み。スマートレターは追跡なし、レターパックライトは追跡ありです。'
        : 'この内容は梱包サイズのため、手数料込み450円のレターパックライトで発送します。');
    var sub = document.getElementById('orderDialogSub');
    if (sub) sub.textContent = pickup
      ? '直接受け取りは送料0円・オンライン決済なしです。送信後、受け取り日時と場所をメールで調整します。'
      : (augustCampaignActive()
        ? '8月限定キャンペーンのため商品代は0円です。Stripeの決済画面で送料のみをお支払いください。'
        : '内容を送信後、Stripeの決済画面で商品代と送料を確認します。決済が完了するまで注文は確定しません。');
    var send = document.getElementById('sendBtn');
    if (send && !send.disabled) send.textContent = pickup ? '直接受け取りで申し込む' : 'Stripe決済へ進む';
    updateOrderPrice();
  }

  function updateOrderPrice() {
    var el = document.getElementById('oPrice');
    if (!el || !lastEstimate) return;
    var qty = parseInt(document.getElementById('oQty').value, 10);
    var method = SHIPPING[document.getElementById('oShipping').value];
    if (!isFinite(qty)) {
      el.textContent = '6個以上は数量を確認してお見積りします。';
    } else {
      var goods = orderUnitPrice(lastEstimate) * qty;
      if (method === SHIPPING.pickup) {
        el.textContent = (augustCampaignActive() ? '8月キャンペーン 商品代 ' : '商品 ') + yen(goods) +
          ' ＋ 直接受け取り ' + yen(0) + ' ＝ 合計 ' + yen(goods) + '（オンライン決済なし）';
      } else {
        el.textContent = (augustCampaignActive() ? '8月キャンペーン 商品代 ' : '商品 ') + yen(goods) +
          ' ＋ ' + method.label + ' ' + yen(method.yen) + ' ＝ 合計 ' + yen(goods + method.yen) + '（手数料込み）';
      }
    }
  }

  function say(kind, html) {
    var s = document.getElementById('sent');
    s.className = 'sent show ' + kind; s.innerHTML = html;
  }

  function submitOrder() {
    var name = document.getElementById('oName').value.trim();
    var mail = document.getElementById('oMail').value.trim();
    var shippingKey = document.getElementById('oShipping').value;
    var shipping = SHIPPING[shippingKey];
    if (!name || !mail || mail.indexOf('@') < 0 || !shipping) {
      say('err', 'お名前と、正しいメールアドレスをご入力ください。'); return;
    }
    var qty = document.getElementById('oQty').value;
    var qtyNum = parseInt(qty, 10);
    var note = document.getElementById('oNote').value.trim();
    var campaignUnit = lastEstimate ? orderUnitPrice(lastEstimate) : 0;
    var priceTotal = isFinite(qtyNum) && lastEstimate
      ? ('\n商品代: ' + yen(campaignUnit * qtyNum) + '\n' + shipping.label + ': ' + yen(shipping.yen) + '\n合計: ' + yen(campaignUnit * qtyNum + shipping.yen))
      : '';
    var message = specText() + '\n個数: ' + qty + priceTotal + (note ? ('\nご要望: ' + note) : '') +
      '\n配送方法: ' + shipping.label +
      '\n\nSPEC=' + JSON.stringify(compactSpec()) +
      '\n（このメールは neqo-fab クリエイターから自動送信されています）';

    var directPickup = shippingKey === 'pickup';
    var btn = document.getElementById('sendBtn');
    var label = btn.textContent; btn.disabled = true; btn.textContent = '出力中…';
    var pickupSubmitted = false;

    // 部品STL（フチ／文字）と完成予想PNGを生成
    rebuild();                          // 念のため最新化
    var slug = sanitize(S.text).replace(/\s+/g, '').slice(0, 20) || 'name';
    var borderStl = meshStlBase64(borderMesh);   // お皿（底＋壁＋金具）
    var floorStl = meshStlBase64(borderMesh && borderMesh[0]); // サーバー側の価格再計算用
    var rimStl = meshStlBase64(borderMesh && borderMesh[1]);   // サーバー側の価格再計算用
    var lettersStl = meshStlBase64(textMesh);    // 文字
    var previewPng = previewDataURL(640, 'image/png');

    var payload = new URLSearchParams({
      hp: document.getElementById('oHidden').value,
      type: 'ぷくぷくキーホルダー注文',
      name: name, mail: mail, message: message,
      slug: slug, qty: qty, shippingMethod: shippingKey, checkout: directPickup ? '0' : '1',
      previewPng: previewPng,    // 管理者＆注文者へ添付する完成予想図
      borderStl: borderStl,      // 管理者へ添付：フチ（お皿）部品
      floorStl: floorStl,        // サーバー検算用：底
      rimStl: rimStl,            // サーバー検算用：壁
      lettersStl: lettersStl     // 管理者へ添付：文字部品
    });

    btn.textContent = '決済画面を準備中…';
    fetch(ENDPOINT, { method: 'POST', body: payload })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.reason) || 'rejected');
        if (directPickup) {
          if (!res.directPickup) throw new Error('pickup_not_accepted');
          pickupSubmitted = true;
          say('ok', '<b>直接受け取りのお申し込みを受け付けました。</b><br>受け取り日時と場所をメールでご連絡します。');
          return;
        }
        if (!res.checkoutUrl) throw new Error('checkout_unavailable');
        say('ok', '<b>Stripeの決済画面へ移動します。</b><br>金額と送料を確認してお支払いください。');
        window.location.assign(res.checkoutUrl);
      })
      .catch(function (err) {
        console.error('checkout failed', err);
        say('err', '決済画面を準備できませんでした。注文記録は届いている場合があります。重ねて送信せず、NEQO FABへお問い合わせください。');
      })
      .then(function () {
        btn.disabled = pickupSubmitted;
        btn.textContent = pickupSubmitted ? '申込完了' : label;
      });
  }

  function paymentNotice(kind, html) {
    var el = document.getElementById('paymentNotice');
    if (!el) return;
    el.className = 'payment-notice show' + (kind === 'err' ? ' err' : (kind === 'info' ? ' info' : ''));
    el.innerHTML = html + '<button type="button" class="payment-notice-close" aria-label="お知らせを閉じる">×</button>';
    el.querySelector('.payment-notice-close').addEventListener('click', function () {
      el.className = 'payment-notice';
      el.innerHTML = '';
    });
  }

  function clearPaymentReturnParams() {
    var url = new URL(window.location.href);
    url.searchParams.delete('payment');
    url.searchParams.delete('session_id');
    history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
  }

  function initPaymentReturn() {
    var q = new URLSearchParams(window.location.search);
    var state = q.get('payment');
    if (state === 'cancelled') {
      clearPaymentReturnParams();
      paymentNotice('info', '<b>決済は完了していません。</b> 料金は発生していません。引き続き内容を編集できます。');
      window.setTimeout(function () {
        var el = document.getElementById('paymentNotice');
        if (el && el.classList.contains('info')) {
          el.className = 'payment-notice';
          el.innerHTML = '';
        }
      }, 8000);
      return;
    }
    if (state !== 'success') return;
    var sessionId = q.get('session_id') || '';
    clearPaymentReturnParams();
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      paymentNotice('err', '決済結果を確認できませんでした。Stripeの領収メールをご確認ください。');
      return;
    }
    paymentNotice('ok', '<b>お支払いを確認しています…</b>');
    fetch(ENDPOINT + '?action=paymentStatus&session_id=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok || !res.paid) throw new Error('not_paid');
        paymentNotice('ok', '<b>お支払いが完了しました。</b> ご注文ありがとうございます。製作開始のご連絡をお待ちください。');
      })
      .catch(function () {
        paymentNotice('err', '<b>決済状況を自動確認できませんでした。</b> Stripeの領収メールをご確認ください。二重に決済しないでください。');
      });
  }

  function escapeHtml(s) { return s.replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  // ======================================================================
  //  フォント読み込み（キー例: 'pop_jp' / 'rock_ko'）
  // ======================================================================
  function ensureFonts(keys, cb) {
    var pending = 0, done = false;
    function finish() { if (!done && pending === 0) { done = true; cb && cb(); } }
    keys.forEach(function (k) {
      if (fontCache[k]) return;
      pending++;
      opentype.load(fontUrl(k), function (err, font) {
        pending--;
        if (err) { console.error('font load failed', k, err); }
        else { fontCache[k] = font; }
        finish();
      });
    });
    finish();  // すべて読込済みなら即時
  }

  function boot() {
    resize();
    initUI();
    initMobileInputVisibility();
    updateCampaignUI();
    initPaymentReturn();
    ensureFonts(neededFontKeys(DEFAULTS.font, DEFAULTS.text), function () {
      document.getElementById('load').classList.add('done');
      requestAnimationFrame(function () { resize(); rebuild();
        requestAnimationFrame(function () { resize(); }); });
    });
  }
  boot();
})();
