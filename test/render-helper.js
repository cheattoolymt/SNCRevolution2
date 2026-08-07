/*
 * SNCR2 テスト用レンダラ／劣化シミュレータ（Node 専用・DOM 非依存）
 * ------------------------------------------------------------------
 * creator.html の canvas 描画を Node の生ピクセルバッファで再現する。
 * §10 の検証（アライメントパターン有無での復元成功率比較・容量確認）で
 * decode-core に食わせる合成スキャン画像を作るために使う。
 *
 * 画像は {data:Uint8ClampedArray(RGBA), width, height}（decode-core と同形式）。
 * 実運用に近い劣化（傾き・中央たわみ＝バレル歪み・ガウスぼかし・帯状ノイズ・
 * 汚れ斑点）を合成できる。JPEG コーデックは Node 標準に無いため、JPEG 圧縮の
 * 主効果である「ブロック平滑化＋量子化ノイズ」をぼかし＋加算ノイズで近似する。
 * ================================================================== */
'use strict';

const CF = require('../js/card-format.js');

// フルサイズ（A4/300dpi）画像へ 1 ページを描画。scale で縮小して高速化。
//  opt.antialias=true で「被覆率アンチエイリアス」描画にする（既定 false）。
//   ─ なぜ必要か（実機フィードバック §10-6）─
//   これまでの描画は fillRect が整数座標のハード塗り（1px を黒/白の二値で
//   埋める）だった。この場合セル境界がピクセル格子にきっちり乗り、しかも
//   セル≒JPEG 8×8 ブロックなので、後段で実 JPEG コーデックを通しても
//   ブロック DC（ブロック平均）が保たれ、リンギング/ブロックノイズが
//   ほとんど出ない（＝机上では JPEG を通しても劣化しない）。しかし実機の
//   canvas 描画はサブピクセル境界を**被覆率でアンチエイリアス**するため、
//   セル縁は中間調になり、そこに JPEG の量子化リンギングが乗って隣接セルへ
//   にじむ。これが「実 canvas JPEG は近似ぼかしより厳しい」の物理的正体。
//   よって実 JPEG の厳しさを机上で再現するには、描画側も被覆率 AA にして
//   セル縁に中間調を作る必要がある（二値“データ”は保つが“画素”は連続値）。
function renderPage(enc, scale, opt) {
  scale = scale || 1;
  opt = opt || {};
  const antialias = !!opt.antialias;
  const W = Math.round(CF.PAGE_W * scale), H = Math.round(CF.PAGE_H * scale);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = 255; }
  const put = (x, y, v) => {
    x |= 0; y |= 0; if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = (y * W + x) * 4; data[p] = data[p + 1] = data[p + 2] = v;
  };
  // 被覆率ブレンド: 画素 (x,y) を黒(v)で cover∈[0,1] だけ塗る（白地に合成）。
  const blend = (x, y, v, cover) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = (y * W + x) * 4;
    const nv = data[p] * (1 - cover) + v * cover;
    data[p] = data[p + 1] = data[p + 2] = nv;
  };
  // ハード塗り（従来）。
  const fillRectHard = (x, y, w, h, v) => {
    const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) put(xx, yy, v);
  };
  // アンチエイリアス塗り: [x,x+w]×[y,y+h] の実数矩形を、各画素の被覆率
  //  （その画素 1×1 と矩形の重なり面積）でブレンドする。縁の画素だけ
  //  中間調になり、実 canvas 描画のサブピクセル境界を模す。
  const fillRectAA = (x, y, w, h, v) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.ceil(x + w), y1 = Math.ceil(y + h);
    for (let yy = y0; yy < y1; yy++) {
      const cy = Math.min(yy + 1, y + h) - Math.max(yy, y);
      if (cy <= 0) continue;
      for (let xx = x0; xx < x1; xx++) {
        const cx = Math.min(xx + 1, x + w) - Math.max(xx, x);
        if (cx <= 0) continue;
        blend(xx, yy, v, Math.max(0, Math.min(1, cx * cy)));
      }
    }
  };
  const fillRect = antialias ? fillRectAA : fillRectHard;
  const prof = enc.prof;
  // 四隅ファインダ（塗りつぶし正方形）。creator.html と同一レイアウト。
  const half = CF.FINDER / 2;
  const cx0 = CF.QUIET + half, cy0 = CF.QUIET + half;
  const cx1 = CF.PAGE_W - CF.QUIET - half;
  const cy1 = CF.GRID_Y + CF.GRID_H + CF.GAP + half;
  for (const f of [{x:cx0,y:cy0},{x:cx1,y:cy0},{x:cx1,y:cy1},{x:cx0,y:cy1}])
    fillRect((f.x - half) * scale, (f.y - half) * scale, CF.FINDER * scale, CF.FINDER * scale, 0);
  // データグリッド。
  for (let r = 0; r < prof.ROWS; r++)
    for (let c = 0; c < prof.COLS; c++)
      if (enc.modules[r * prof.COLS + c]) {
        const rect = CF.cellRect(prof, c, r);
        fillRect(rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale, 0);
      }
  return { data, width: W, height: H };
}

// 双一次サンプリングで元画像から (fx,fy) の輝度を読む。
function sampleGray(img, fx, fy) {
  const { data, width, height } = img;
  if (fx < 0) fx = 0; if (fy < 0) fy = 0;
  if (fx > width - 1) fx = width - 1; if (fy > height - 1) fy = height - 1;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
  const tx = fx - x0, ty = fy - y0;
  const g = (x, y) => { const p = (y * width + x) * 4; return data[p] * 0.299 + data[p+1]*0.587 + data[p+2]*0.114; };
  const a = g(x0, y0) * (1 - tx) + g(x1, y0) * tx;
  const b = g(x0, y1) * (1 - tx) + g(x1, y1) * tx;
  return a * (1 - ty) + b * ty;
}

// ---- 劣化: 中央たわみ（バレル/ピンクッション歪み）------------------
//  中心からの距離に比例して画素を外/内へずらす。QR のアライメント
//  パターンが補正を狙う「紙のたわみ・レンズ歪み」に相当。
function warpCenterBulge(img, k) {
  const { width: W, height: H } = img;
  const out = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  const cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / R, dy = (y - cy) / R;
      const rr = dx * dx + dy * dy;
      const f = 1 + k * rr;           // 半径方向のスケール
      const sx = cx + (x - cx) * f;
      const sy = cy + (y - cy) * f;
      const v = sampleGray(out ? img : img, sx, sy);
      const p = (y * W + x) * 4;
      out.data[p] = out.data[p+1] = out.data[p+2] = v; out.data[p+3] = 255;
    }
  }
  return out;
}

// ---- 劣化: 傾き（微小回転）----------------------------------------
function rotate(img, deg) {
  const { width: W, height: H } = img;
  const out = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  const rad = deg * Math.PI / 180, cs = Math.cos(rad), sn = Math.sin(rad);
  const cx = W / 2, cy = H / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy;
    const sx = cx + dx * cs + dy * sn;
    const sy = cy - dx * sn + dy * cs;
    const v = sampleGray(img, sx, sy);
    const p = (y * W + x) * 4; out.data[p]=out.data[p+1]=out.data[p+2]=v; out.data[p+3]=255;
  }
  return out;
}

// ---- 劣化: ガウスぼかし（JPEG 平滑化近似・分離型）------------------
function blur(img, radius) {
  const { width: W, height: H } = img;
  const tmp = new Float32Array(W * H), out = { data: new Uint8ClampedArray(W*H*4), width:W, height:H };
  const g = (x,y)=>{const p=(y*W+x)*4;return img.data[p]*0.299+img.data[p+1]*0.587+img.data[p+2]*0.114;};
  const r = Math.max(1, radius|0);
  // 横
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){let s=0,c=0;for(let d=-r;d<=r;d++){const xx=x+d;if(xx<0||xx>=W)continue;s+=g(xx,y);c++;}tmp[y*W+x]=s/c;}
  // 縦
  for (let x=0;x<W;x++) for (let y=0;y<H;y++){let s=0,c=0;for(let d=-r;d<=r;d++){const yy=y+d;if(yy<0||yy>=H)continue;s+=tmp[yy*W+x];c++;}const v=s/c;const p=(y*W+x)*4;out.data[p]=out.data[p+1]=out.data[p+2]=v;out.data[p+3]=255;}
  return out;
}

// ---- 劣化: ドットゲイン（全面均一膨張）----------------------------
//  実機のインク/トナー滲みや濃いめ印刷・スキャナのガンマで、盤面全域の黒が
//  「一律に」太り・沈む現象。「局所の汚れ」(addNoise の spots) と違い、全面が
//  同じだけ劣化するのが特徴。固定しきい 128 の二値化はこれに破綻しやすい
//  （盤面全体の輝度分布が平行移動し、白セルまで固定しきいを割る）ため、
//  適応しきい化（大域 Otsu + 局所適応）の耐性検証に用いる。
//
//  モデルは実機の 3 効果を合成する:
//   (1) growPx … モルフォロジー膨張（min フィルタ）。黒セルが半径 growPx だけ
//       周囲へにじみ出す（インク/トナーの物理的な太り）。
//   (2) blackFloor / whiteCeil … 出力ダイナミックレンジの圧縮。実機では黒は
//       完全な 0 にならず（blackFloor まで浮く）、紙白も 255 に届かない
//       （whiteCeil まで沈む）。この「コントラスト縮小」が固定しきいを最も
//       破綻させる主因。[0,255] を [blackFloor, whiteCeil] に線形写像する。
//   (3) bias … 全面へ一律に足す明るさオフセット（負で全体を暗く）。スキャナ
//       ガンマや濃いめ設定に相当。
//  gain(後方互換) を渡した場合は暗部を gain 倍する旧挙動も併用する。
function dotGain(img, opt) {
  opt = opt || {};
  const growPx = Math.max(0, Math.round(opt.growPx != null ? opt.growPx : 1));
  const gain = opt.gain != null ? opt.gain : 1.0;        // >1 で暗部を強調（旧互換）
  const blackFloor = opt.blackFloor != null ? opt.blackFloor : 0;    // 黒の浮き
  const whiteCeil  = opt.whiteCeil  != null ? opt.whiteCeil  : 255;   // 白の沈み
  const bias = opt.bias != null ? opt.bias : 0;          // 全面明るさオフセット
  const { width: W, height: H } = img;
  const src = img.data;
  const out = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  const span = Math.max(1, whiteCeil - blackFloor);
  // 分離型 min フィルタ（暗い方＝黒が半径 growPx だけ膨張）。
  const tmp = new Float32Array(W * H);
  const lum = (x, y) => { const p = (y * W + x) * 4; return src[p]; }; // 描画はグレースケール
  // 横方向 min
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let m = 255;
    for (let d = -growPx; d <= growPx; d++) { const xx = x + d; if (xx < 0 || xx >= W) continue; const v = lum(xx, y); if (v < m) m = v; }
    tmp[y * W + x] = m;
  }
  // 縦方向 min → gain → レンジ圧縮 → bias → 書き出し
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    let m = 255;
    for (let d = -growPx; d <= growPx; d++) { const yy = y + d; if (yy < 0 || yy >= H) continue; const v = tmp[yy * W + x]; if (v < m) m = v; }
    // gain>1: 暗部を一律に暗く沈める（旧挙動）。
    let v = 255 - (255 - m) * gain;
    // ダイナミックレンジ圧縮: [0,255] → [blackFloor, whiteCeil]。
    v = blackFloor + (v / 255) * span;
    // 全面バイアス。
    v += bias;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    const p = (y * W + x) * 4;
    out.data[p] = out.data[p + 1] = out.data[p + 2] = v; out.data[p + 3] = 255;
  }
  return out;
}

// ---- 劣化: ドットゲイン（二値化先行 → 4 近傍膨張モデル）------------
//  【実機フィードバック §10-9】上の dotGain() は「min フィルタ＋レンジ圧縮」
//  でにじみを近似する“連続値”モデルで、実測では成長量 growPx=3.0（ver14/
//  セル比 0.35）まで復元できていた。しかし実機のインク/トナーの染み込みは
//  「まず紙面が黒/白に二値化され、その黒が物理的に周囲へ太る（膨張する）」
//  離散プロセスに近い。この“二値化先行→膨張”を min フィルタ連続値モデルは
//  再現できず（連続値は縁が中間調で寛容）、机上で実機の厳しさを過小評価する。
//
//  本関数はその実プロセスを忠実に再現する:
//   (1) まず固定しきい thr（既定 128）で盤面を二値化（黒=1）。
//   (2) その黒マスクを growPx 回だけ 4 近傍膨張（黒が上下左右へ 1px ずつ太る）。
//       ＝インク/トナーの物理的なにじみ出し。連続値ではなく画素単位の離散膨張。
//   (3) 出力ダイナミックレンジ圧縮 [blackFloor, whiteCeil]（黒は浮き・白は沈む）
//       ＋全面バイアス bias（スキャナガンマ）。実機のコントラスト縮小を再現。
//  growPx はここでは「膨張回数（=にじみ半径 px）」。セル比＝growPx / セル px。
//  ver14 は 1 セル≒8.6px なので growPx3=セル比 0.35（min フィルタモデルの
//  復元上限と同じ物理量）で比較できる。この二値化先行モデルでは同じセル比
//  3.0 でも黒が白セルを侵食して破綻しやすく、実機の失敗を机上で捕捉できる。
function dotGainBinary(img, opt) {
  opt = opt || {};
  const rounds = Math.max(0, Math.round(opt.growPx != null ? opt.growPx : 1));
  const thr = opt.thr != null ? opt.thr : 128;
  const blackFloor = opt.blackFloor != null ? opt.blackFloor : 0;
  const whiteCeil  = opt.whiteCeil  != null ? opt.whiteCeil  : 255;
  const bias = opt.bias != null ? opt.bias : 0;
  const W = img.width, H = img.height, src = img.data;
  // (1) 先に二値化（黒=1）。描画はグレースケールなので R チャネルで判定。
  let bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = src[i * 4] < thr ? 1 : 0;
  // (2) growPx 回の 4 近傍膨張（黒を上下左右へ 1px 太らせる）。
  for (let it = 0; it < rounds; it++) {
    const nb = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (bin[i]) { nb[i] = 1; continue; }
        if ((x > 0 && bin[i - 1]) || (x < W - 1 && bin[i + 1]) ||
            (y > 0 && bin[i - W]) || (y < H - 1 && bin[i + W])) nb[i] = 1;
      }
    }
    bin = nb;
  }
  // (3) レンジ圧縮 + バイアスで書き出し（黒→blackFloor, 白→whiteCeil）。
  const out = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  for (let i = 0; i < W * H; i++) {
    let v = (bin[i] ? blackFloor : whiteCeil) + bias;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    const p = i * 4; out.data[p] = out.data[p + 1] = out.data[p + 2] = v; out.data[p + 3] = 255;
  }
  return out;
}

// ---- 劣化: 帯状ノイズ + 汚れ斑点 + 量子化ノイズ -------------------
//  seed 固定の決定的 PRNG でテスト再現性を確保。
function addNoise(img, opt, seed) {
  opt = opt || {};
  let s = (seed || 12345) >>> 0;
  const rnd = () => { s ^= s<<13; s>>>=0; s ^= s>>>17; s ^= s<<5; s>>>=0; return s/0x100000000; };
  const { width: W, height: H } = img;
  const out = { data: Uint8ClampedArray.from(img.data), width: W, height: H };
  const bandAmp = opt.bandAmp || 0;    // 帯状ノイズの振幅
  const qNoise = opt.qNoise || 0;      // 一様量子化ノイズ
  const spots = opt.spots || 0;        // 汚れ斑点の数
  for (let y=0;y<H;y++){
    const band = bandAmp ? Math.sin(y*0.08)*bandAmp : 0;
    for (let x=0;x<W;x++){
      const p=(y*W+x)*4; let v=out.data[p];
      v += band + (qNoise ? (rnd()*2-1)*qNoise : 0);
      v = v<0?0:v>255?255:v;
      out.data[p]=out.data[p+1]=out.data[p+2]=v;
    }
  }
  for (let i=0;i<spots;i++){
    const sx=(rnd()*W)|0, sy=(rnd()*H)|0, rad=2+((rnd()*6)|0), dark=rnd()<0.5?0:255;
    for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++){
      if(dx*dx+dy*dy>rad*rad)continue; const xx=sx+dx,yy=sy+dy; if(xx<0||yy<0||xx>=W||yy>=H)continue;
      const p=(yy*W+xx)*4; out.data[p]=out.data[p+1]=out.data[p+2]=dark;
    }
  }
  return out;
}

// ==================================================================
//  幾何劣化の「順写像」点マッパ（内部アライメント検出テスト用）
// ------------------------------------------------------------------
//  warpCenterBulge / rotate は out(x,y)=source(finv(x,y)) の形（＝出力画素へ
//  ソースを引き戻す inverse map）で定義されている。内部アライメント検出の
//  精度を「劣化後の“真の”パターン中心」に対して測るには、逆に「ソース上の
//  既知セル中心が、劣化後の出力画像の *どこ* に現れるか」＝順写像 forward が
//  必要になる。ここではその forward を厳密に与える（blur/dotGain/addNoise は
//  特徴位置を動かさないので恒等）。
//
//  【重要】これらは decode-core を一切使わない“地上の真値(ground truth)”で
//  ある。テストがこの真値に対して検出誤差を測ることで、四隅ホモグラフィとは
//  独立に「内部アライメント検出そのものの局所化精度」を検証できる。
// ==================================================================

// warpCenterBulge の順写像: ソース点 (sx,sy) → 出力点 (x,y)。
//  inverse は sourceRay = c + (out-c)*(1+k*|out-c|^2/R^2)。半径方向へ単調なので
//  出力半径 ρ を二分法で解く（|source-c| = ρ*(1+k*ρ^2/R^2)）。
function bulgePointForward(W, H, k, sx, sy) {
  const cx = W / 2, cy = H / 2, R = Math.hypot(cx, cy);
  const vx = sx - cx, vy = sy - cy;
  const srcR = Math.hypot(vx, vy);
  if (srcR < 1e-9) return { x: cx, y: cy };
  // 解く: srcR = rho * (1 + k*rho^2/R^2)  （rho = 出力半径, 単調増加）。
  let lo = 0, hi = srcR;                 // f>=1 なので出力半径 <= ソース半径
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    const val = mid * (1 + k * mid * mid / (R * R));
    if (val < srcR) lo = mid; else hi = mid;
  }
  const rho = (lo + hi) / 2;
  const scale = rho / srcR;
  return { x: cx + vx * scale, y: cy + vy * scale };
}

// rotate の順写像: ソース点 → 出力点。rotate の inverse は
//  source = c + Rot(+deg)*(out-c) なので、forward は out = c + Rot(-deg)*(src-c)。
function rotatePointForward(W, H, deg, sx, sy) {
  const rad = deg * Math.PI / 180, cs = Math.cos(rad), sn = Math.sin(rad);
  const cx = W / 2, cy = H / 2;
  const dx = sx - cx, dy = sy - cy;
  // inverse: sx = cx + dx'*cs + dy'*sn ; sy = cy - dx'*sn + dy'*cs  （dx'=out-c）
  //  → out を解く（回転の逆行列 = 転置）。
  const ox = dx * cs - dy * sn;
  const oy = dx * sn + dy * cs;
  return { x: cx + ox, y: cy + oy };
}

module.exports = {
  renderPage, sampleGray, warpCenterBulge, rotate, blur, dotGain, dotGainBinary, addNoise,
  bulgePointForward, rotatePointForward,
};
