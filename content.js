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
      console.log('Document metrics:', meta);
      
      const slices = await captureFullPage(meta);
      console.log('Captured slices:', slices.length, 'total slices');
      
      if (slices.length === 0) {
        console.error('No slices captured, aborting');
        return;
      }
      
      const stitched = await stitchImages(slices, meta.devicePixelRatio, meta.width, meta.totalHeight);
      console.log('Stitched image:', {
        pixelWidth: stitched.pixelWidth,
        pixelHeight: stitched.pixelHeight,
        canvasWidth: stitched.image.width,
        canvasHeight: stitched.image.height
      });
      
      // First, let's save the stitched image as PNG to verify stitching works
      console.log('Testing stitched canvas...');
      const testDataUrl = stitched.image.toDataURL('image/png');
      console.log('Stitched image size:', (testDataUrl.length / 1024).toFixed(1), 'KB');
      
      // Create a more manageable blob URL for the stitched image
      stitched.image.toBlob((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        console.log('🖼️ STITCHED IMAGE BLOB URL (right-click → open in new tab):', blobUrl);
        console.log('💡 This should show the complete webpage as one tall image');
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      }, 'image/png');
      
      // TEMPORARY: Save as PNG first to test if stitching works
      console.log('🧪 TESTING: Saving stitched image as PNG first...');
      stitched.image.toBlob(async (blob) => {
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const pngFilename = buildPdfFilename().replace('.pdf', '_stitched.png');
        await browser.runtime.sendMessage({ 
          type: 'save-pdf', 
          filename: pngFilename, 
          pdfBuffer: uint8Array.buffer 
        });
        console.log('✅ PNG saved:', pngFilename);
      }, 'image/png');

      const pdfBytes = await renderPdfFromImage(stitched.image, stitched.pixelWidth, stitched.pixelHeight);
      console.log('PDF generated:', pdfBytes.byteLength, 'bytes');
      
      await browser.runtime.sendMessage({ type: 'save-pdf', filename: buildPdfFilename(), pdfBuffer: pdfBytes });
      console.log('PDF save message sent');
    } catch (err) {
      console.error('Capture failed:', err);
      console.error('Error stack:', err.stack);
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
      if (!dataUrl) {
        console.warn('capture-viewport returned empty result; aborting capture loop');
        break;
      }
      console.log('captured viewport', dataUrl ? dataUrl.substring(0, 48) + '...' : dataUrl);
      slices.push({ y: currentY, dataUrl });
      currentY += viewportHeight;
    }

    // Restore original scroll position
    window.scrollTo(originalScrollX, originalScrollY);

    return slices;
  }

  async function stitchImages(slices, dpr, cssWidth, cssTotalHeight) {
    console.log('Stitching images:', {
      sliceCount: slices.length,
      dpr,
      cssWidth,
      cssTotalHeight
    });

    // Decode images to determine pixel dimensions
    const images = await Promise.all(
      slices.map((s, index) => {
        console.log(`Loading image ${index}:`, s.dataUrl ? s.dataUrl.substring(0, 50) + '...' : 'null');
        return createImage(s.dataUrl);
      })
    );

    console.log('Images loaded:', images.map(img => ({
      width: img.naturalWidth,
      height: img.naturalHeight,
      complete: img.complete
    })));

    // Assume all slices have identical pixel width/height except maybe last
    const pixelWidth = images[0].naturalWidth;
    const pixelViewportHeight = images[0].naturalHeight;

    console.log('Base dimensions:', { pixelWidth, pixelViewportHeight });

    // Map CSS y offset to pixel y offset using DPR
    const toPixels = (css) => Math.round(css * dpr);

    // Compute total output height in pixels
    // Last image may be partial; compute using cssTotalHeight
    const totalPixelHeight = toPixels(cssTotalHeight);

    console.log('Canvas dimensions:', { pixelWidth, totalPixelHeight });

    const canvas = document.createElement('canvas');
    canvas.width = pixelWidth;
    canvas.height = totalPixelHeight;
    const ctx = canvas.getContext('2d');

    // Fill with white background first
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, pixelWidth, totalPixelHeight);

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const cssY = slices[i].y;
      const destY = toPixels(cssY);

      console.log(`Drawing image ${i}:`, {
        cssY,
        destY,
        imgWidth: img.naturalWidth,
        imgHeight: img.naturalHeight
      });

      // Determine the source region to draw for the last slice if it overflows
      let srcX = 0;
      let srcY = 0;
      let srcW = pixelWidth;
      let srcH = pixelViewportHeight;

      const remaining = totalPixelHeight - destY;
      if (remaining < pixelViewportHeight) {
        srcH = Math.max(0, remaining);
        console.log(`Last slice clipped: remaining=${remaining}, srcH=${srcH}`);
      }

      if (srcH > 0) {
        try {
          ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, destY, srcW, srcH);
          console.log(`Successfully drew image ${i}`);
        } catch (e) {
          console.error(`Failed to draw image ${i}:`, e);
        }
      }
    }

    // Test if canvas has content by checking a few pixels
    const imageData = ctx.getImageData(0, 0, Math.min(100, pixelWidth), Math.min(100, totalPixelHeight));
    const hasContent = imageData.data.some((value, index) => {
      // Check RGB values (skip alpha channel)
      return index % 4 !== 3 && value !== 255; // Not white
    });
    
    console.log('Canvas content check:', { hasContent, canvasSize: imageData.data.length });

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
    console.log('Starting PDF generation:', { pixelWidth, pixelHeight });
    
    try {
      return await createPdfFromCanvas(canvas, pixelWidth, pixelHeight, 0.92);
    } catch (e) {
      console.error('High-quality PDF generation failed:', e);
      console.log('🔄 Trying with lower quality...');
      
      try {
        return await createPdfFromCanvas(canvas, pixelWidth, pixelHeight, 0.5);
      } catch (e2) {
        console.error('Medium-quality PDF generation failed:', e2);
        console.log('🔄 Trying with very small test image...');
        
        // Create a tiny test canvas to see if the PDF structure works at all
        const testCanvas = document.createElement('canvas');
        testCanvas.width = 200;
        testCanvas.height = 200;
        const ctx = testCanvas.getContext('2d');
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, 200, 200);
        ctx.fillStyle = 'white';
        ctx.font = '20px Arial';
        ctx.fillText('TEST', 75, 110);
        
        return await createPdfFromCanvas(testCanvas, 200, 200, 0.8);
      }
    }
  }

  async function createPdfFromCanvas(canvas, pixelWidth, pixelHeight, quality) {
    // Scale down huge images to reasonable PDF dimensions
    const maxPdfDimension = 14400; // 200 inches at 72 DPI
    let pdfWidth = pixelWidth;
    let pdfHeight = pixelHeight;
    
    if (pixelWidth > maxPdfDimension || pixelHeight > maxPdfDimension) {
      const scale = Math.min(maxPdfDimension / pixelWidth, maxPdfDimension / pixelHeight);
      pdfWidth = Math.round(pixelWidth * scale);
      pdfHeight = Math.round(pixelHeight * scale);
      console.log('Scaling PDF dimensions:', {
        original: { pixelWidth, pixelHeight },
        scaled: { pdfWidth, pdfHeight },
        scale
      });
    }
    
    // Re-encode the canvas as JPEG
    console.log('Converting canvas to JPEG with quality:', quality);
    const jpegData = await canvasToJpegUint8Array(canvas, quality);
    console.log('JPEG conversion complete:', {
      jpegSize: jpegData.byteLength,
      jpegSizeKB: (jpegData.byteLength / 1024).toFixed(1)
    });

    // Test the JPEG data by creating a data URL
    const jpegBlob = new Blob([jpegData], { type: 'image/jpeg' });
    const jpegDataUrl = URL.createObjectURL(jpegBlob);
    console.log('🖼️ JPEG VERSION (click to view):', jpegDataUrl);
    setTimeout(() => URL.revokeObjectURL(jpegDataUrl), 30000);

    console.log('Creating PDF...');
    const pdf = new MinimalPdf();
    const imageObjectId = pdf.addJpegImage(jpegData, pixelWidth, pixelHeight);
    console.log('Image object added to PDF, ID:', imageObjectId);
    
    pdf.addPageWithImage(imageObjectId, pdfWidth, pdfHeight);
    console.log('Page added to PDF with dimensions:', { pdfWidth, pdfHeight });
    
    const pdfBuffer = pdf.serialize();
    console.log('PDF serialized:', {
      bufferSize: pdfBuffer.byteLength,
      bufferSizeKB: (pdfBuffer.byteLength / 1024).toFixed(1)
    });
    
    return pdfBuffer;
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
      console.log('Adding JPEG to PDF:', { width, height, jpegBytesLength: jpegBytes.length });
      
      // The issue might be with binary encoding in JavaScript strings
      // Let's always use ASCII85 but with better error handling
      try {
        const ascii85 = ascii85Encode(jpegBytes);
        console.log('ASCII85 encoding complete, length:', ascii85.length);
        
        // Verify ASCII85 data is valid (should only contain printable ASCII + ~>)
        const invalidChars = ascii85.match(/[^\x21-\x7E~>]/g);
        if (invalidChars) {
          console.error('Invalid characters in ASCII85:', invalidChars.slice(0, 10));
        }
        
        const dict = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCII85Decode /DCTDecode] /Length ${ascii85.length} >>`;
        const objId = this.addObject(`${dict}\nstream\n${ascii85}\nendstream`);
        console.log('JPEG image object created with ASCII85, ID:', objId);
        return objId;
      } catch (e) {
        console.error('ASCII85 encoding failed:', e);
        // Fallback: try with a much smaller quality
        console.log('Retrying with lower quality JPEG...');
        throw e;
      }
    }

    addPageWithImage(imageObjectId, width, height) {
      console.log('Adding page to PDF:', { imageObjectId, width, height });
      
      // PDF content stream: position image to fill the entire page
      // q = save graphics state
      // width 0 0 height 0 0 cm = transformation matrix (scale and position)
      // /Im1 Do = draw image object Im1
      // Q = restore graphics state
      const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im1 Do\nQ\n`;
      console.log('Page content stream:', content);
      
      const contentsId = this.addObject(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      const resourcesId = this.addObject(`<< /XObject << /Im1 ${imageObjectId} 0 R >> /ProcSet [/PDF /ImageB /ImageC /ImageI] >>`);
      
      // MediaBox defines the page size: [llx lly urx ury] (lower-left x, lower-left y, upper-right x, upper-right y)
      const pageId = this.addObject(`<< /Type /Page /Parent ${this.pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentsId} 0 R /Resources ${resourcesId} 0 R >>`);
      this.pages.push(pageId);
      console.log('Page added with ID:', pageId, 'MediaBox: [0 0', width, height, '], Total pages:', this.pages.length);
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


