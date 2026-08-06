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
function renderPage(enc, scale) {
  scale = scale || 1;
  const W = Math.round(CF.PAGE_W * scale), H = Math.round(CF.PAGE_H * scale);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = 255; }
  const put = (x, y, v) => {
    x |= 0; y |= 0; if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = (y * W + x) * 4; data[p] = data[p + 1] = data[p + 2] = v;
  };
  const fillRect = (x, y, w, h, v) => {
    const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) put(xx, yy, v);
  };
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

module.exports = { renderPage, sampleGray, warpCenterBulge, rotate, blur, addNoise };
