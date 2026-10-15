// 把用户选的图片 / PDF 统一变成 JPEG dataURL 列表（PDF 在浏览器里逐页渲染成图，文字版和扫描版都适用，
// 之后走同一条识别流程）。pdf.js 只在用户选了 PDF 时才按需加载。
export const MAX_MATERIAL_IMAGES = 6;

export async function imageToDataUrl(file, maxEdge = 1600, q = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('无法读取图片')); i.src = url; });
    const k = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  } finally { URL.revokeObjectURL(url); }
}

export const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

export async function pdfToDataUrls(file, maxPages, maxEdge = 1600, q = 0.82) {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error(`PDF「${file.name}」有密码保护，请先解除密码再上传`);
    throw new Error(`无法读取 PDF「${file.name}」，文件可能已损坏`);
  }
  const total = doc.numPages; const use = Math.min(total, maxPages); const out = [];
  for (let p = 1; p <= use; p++) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, maxEdge / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(c.toDataURL('image/jpeg', q));
  }
  return { images: out, total, used: use };
}

/** 返回 { images, notes }：notes 是给用户看的提示（例如 PDF 页数超出只读了前几页）。 */
export async function filesToImages(files, max = MAX_MATERIAL_IMAGES) {
  const images = []; const notes = [];
  for (const f of files) {
    const left = max - images.length;
    if (left <= 0) { notes.push(`最多读取 ${max} 张/页，「${f.name}」及之后的文件未读取`); break; }
    if (isPdf(f)) {
      const r = await pdfToDataUrls(f, left);
      images.push(...r.images);
      if (r.total > r.used) notes.push(`PDF「${f.name}」共 ${r.total} 页，只读取了前 ${r.used} 页（单次最多 ${max} 张/页）`);
    } else {
      images.push(await imageToDataUrl(f));
    }
  }
  return { images, notes };
}
