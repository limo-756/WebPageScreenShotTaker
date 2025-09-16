/*
  Content script: Scrolls the page, requests viewport captures from background,
  stitches them into one tall image, converts to a single-page PDF, and asks
  background to download it.
*/

/* global browser */

(function () {
  // Debounce to avoid multiple concurrent runs
  let isRunning = false;

  browser.runtime.onMessage.addListener(async (message) => {
    if (!message || message.type !== 'start-capture') return;
    if (isRunning) return;
    isRunning = true;

    try {
      const meta = getDocumentMetrics();
      const slices = await captureFullPage(meta);
      const stitched = await stitchImages(slices, meta.devicePixelRatio, meta.width, meta.totalHeight);
      const pdfBytes = await renderPdfFromImage(stitched.image, stitched.pixelWidth, stitched.pixelHeight);
      await browser.runtime.sendMessage({ type: 'save-pdf', filename: buildPdfFilename(), pdfBuffer: pdfBytes });
    } catch (err) {
      console.error('Capture failed:', err);
    } finally {
      isRunning = false;
    }
  });

  function getDocumentMetrics() {
    const body = document.body;
    const html = document.documentElement;
    const scrollHeight = Math.max(
      body.scrollHeight, html.scrollHeight,
      body.offsetHeight, html.offsetHeight,
      body.clientHeight, html.clientHeight
    );
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const dpr = window.devicePixelRatio || 1;
    return {
      totalHeight: scrollHeight,
      viewportHeight,
      width: viewportWidth,
      devicePixelRatio: dpr
    };
  }

  async function captureFullPage(meta) {
    const { totalHeight, viewportHeight } = meta;
    const slices = [];

    // Preserve initial scroll position
    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;

    // Use a fixed step equal to viewportHeight, but handle the last partial slice
    let currentY = 0;
    const maxScrollY = totalHeight - viewportHeight;

    // Add small delay to allow layout/scroll to settle per step
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));

    while (currentY <= maxScrollY + 1) {
      window.scrollTo(0, currentY);
      await wait(150);
      // Ask background to capture the visible area
      const dataUrl = await browser.runtime.sendMessage({ type: 'capture-viewport' });
      console.log('captured viewport', dataUrl);
      slices.push({ y: currentY, dataUrl });
      currentY += viewportHeight;
    }

    // Restore original scroll position
    window.scrollTo(originalScrollX, originalScrollY);

    return slices;
  }

  async function stitchImages(slices, dpr, cssWidth, cssTotalHeight) {
    // Decode images to determine pixel dimensions
    const images = await Promise.all(
      slices.map((s) => createImage(s.dataUrl))
    );

    // Assume all slices have identical pixel width/height except maybe last
    const pixelWidth = images[0].naturalWidth;
    const pixelViewportHeight = images[0].naturalHeight;

    // Map CSS y offset to pixel y offset using DPR
    const toPixels = (css) => Math.round(css * dpr);

    // Compute total output height in pixels
    // Last image may be partial; compute using cssTotalHeight
    const totalPixelHeight = toPixels(cssTotalHeight);

    const canvas = document.createElement('canvas');
    canvas.width = pixelWidth;
    canvas.height = totalPixelHeight;
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      console.log('img', img);
      const cssY = slices[i].y;
      const destY = toPixels(cssY);

      // Determine the source region to draw for the last slice if it overflows
      let srcX = 0;
      let srcY = 0;
      let srcW = pixelWidth;
      let srcH = pixelViewportHeight;

      const remaining = totalPixelHeight - destY;
      if (remaining < pixelViewportHeight) {
        srcH = Math.max(0, remaining);
      }

      if (srcH > 0) {
        ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, destY, srcW, srcH);
      }
    }

    return { image: canvas, pixelWidth, pixelHeight: totalPixelHeight };
  }

  function createImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = dataUrl;
    });
  }

  async function renderPdfFromImage(canvas, pixelWidth, pixelHeight) {
    // Re-encode the stitched canvas as JPEG so it can be embedded via /DCTDecode
    const jpegData = await canvasToJpegUint8Array(canvas, 0.92);

    const pdf = new MinimalPdf();
    const imageObjectId = pdf.addJpegImage(jpegData, pixelWidth, pixelHeight);
    pdf.addPageWithImage(imageObjectId, pixelWidth, pixelHeight);
    return pdf.serialize();
  }

  function buildPdfFilename() {
    const title = (document.title || 'webpage').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '');
    return `${title}.pdf`;
  }

  function canvasToPngUint8Array(canvas) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(new Uint8Array(reader.result));
        };
        reader.readAsArrayBuffer(blob);
      }, 'image/png');
    });
  }

  function canvasToJpegUint8Array(canvas, quality) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(new Uint8Array(reader.result));
        };
        reader.readAsArrayBuffer(blob);
      }, 'image/jpeg', quality);
    });
  }

  // A very small PDF writer that supports embedding a PNG as a full page.
  // Note: This is intentionally minimal and not a full-featured PDF library.
  class MinimalPdf {
    constructor() {
      this.objects = [];
      this.pages = [];
      this.nextId = 1;
      this.catalogId = this.nextObjectId();
      this.pagesId = this.nextObjectId();
    }

    nextObjectId() {
      return this.nextId++;
    }

    addObject(str) {
      const id = this.nextObjectId();
      this.objects.push({ id, str });
      return id;
    }

    addJpegImage(jpegBytes, width, height) {
      const ascii85 = ascii85Encode(jpegBytes);
      const dict = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCII85Decode /DCTDecode] /Length ${ascii85.length} >>`;
      const objId = this.addObject(`${dict}\nstream\n${ascii85}\nendstream`);
      return objId;
    }

    addPageWithImage(imageObjectId, width, height) {
      const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im1 Do\nQ\n`;
      const contentsId = this.addObject(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      const resourcesId = this.addObject(`<< /XObject << /Im1 ${imageObjectId} 0 R >> /ProcSet [/PDF /ImageB /ImageC /ImageI] >>`);
      const pageId = this.addObject(`<< /Type /Page /Parent ${this.pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentsId} 0 R /Resources ${resourcesId} 0 R >>`);
      this.pages.push(pageId);
    }

    serialize() {
      const kids = this.pages.map((id) => `${id} 0 R`).join(' ');
      const pagesObj = `<< /Type /Pages /Kids [ ${kids} ] /Count ${this.pages.length} >>`;
      this.objects.unshift({ id: this.pagesId, str: pagesObj });
      const catalogObj = `<< /Type /Catalog /Pages ${this.pagesId} 0 R >>`;
      this.objects.unshift({ id: this.catalogId, str: catalogObj });

      let offset = 0;
      const chunks = [];
      const write = (s) => { const enc = encodePdfString(s); chunks.push(enc); offset += enc.length; };
      const positions = [];

      write('%PDF-1.4\n');
      for (const obj of this.objects) {
        positions.push(offset);
        write(`${obj.id} 0 obj\n${obj.str}\nendobj\n`);
      }
      const xrefStart = offset;
      write(`xref\n0 ${this.objects.length + 1}\n`);
      write(`0000000000 65535 f \n`);
      for (const pos of positions) {
        write(`${pos.toString().padStart(10, '0')} 00000 n \n`);
      }
      write(`trailer\n<< /Size ${this.objects.length + 1} /Root ${this.catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

      let total = 0;
      for (const u of chunks) total += u.length;
      const out = new Uint8Array(total);
      let p = 0;
      for (const u of chunks) { out.set(u, p); p += u.length; }
      return out.buffer;
    }
  }

  function encodePdfString(str) {
    // Encode to UTF-8 bytes
    const encoder = new TextEncoder();
    return encoder.encode(str);
  }

  // ASCII85 encoder for stream data (safe for PDF text streams)
  function ascii85Encode(bytes) {
    let output = '';
    let tuple = 0;
    let count = 0;
    for (let i = 0; i < bytes.length; i++) {
      tuple = (tuple << 8) | bytes[i];
      count++;
      if (count === 4) {
        if (tuple === 0) {
          output += 'z';
        } else {
          let enc = '';
          for (let j = 0; j < 5; j++) {
            enc = String.fromCharCode((tuple % 85) + 33) + enc;
            tuple = Math.floor(tuple / 85);
          }
          output += enc;
        }
        tuple = 0;
        count = 0;
      }
    }
    if (count > 0) {
      // pad remaining bytes with zeros
      for (let i = count; i < 4; i++) tuple <<= 8;
      let enc = '';
      for (let j = 0; j < count + 1; j++) {
        enc = String.fromCharCode((tuple % 85) + 33) + enc;
        tuple = Math.floor(tuple / 85);
      }
      output += enc;
    }
    return output + '~>'; // EOF marker
  }
})();


