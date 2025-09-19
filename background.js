/*
  Background script for Firefox extension: orchestrates start signal and captures
  the visible tab on request from the content script, then downloads the final PDF.
*/

// Use the WebExtensions Promise API (browser.*) for better readability
/* global browser */

// Trigger capture when the browser action is clicked
browser.browserAction.onClicked.addListener(async (tab) => {
  try {
    if (!tab || !tab.id) return;
    await browser.tabs.sendMessage(tab.id, { type: 'start-capture' });
  } catch (error) {
    // Content script might not be injected yet on some pages. Try to inject programmatically.
    try {
      console.log('error happened while sending message start-capture', error);
      if (tab && tab.id) {
        await browser.tabs.executeScript(tab.id, { file: 'content.js' });
        await browser.tabs.sendMessage(tab.id, { type: 'start-capture' });
      }
    } catch (e) {
      console.error('Failed to start capture:', e);
    }
  }
});

// Handle messages from the content script
browser.runtime.onMessage.addListener(async (message, sender) => {
  console.log('message received in background script', message && message.type);
  if (!message || !message.type) return;

  if (message.type === 'capture-viewport') {
    const tab = sender && sender.tab ? sender.tab : undefined;
    const windowId = tab ? tab.windowId : undefined;
    const tabInfo = {
      tabId: tab && tab.id,
      windowId,
      url: tab && tab.url,
      active: tab && tab.active,
      discarded: tab && tab.discarded,
      status: tab && tab.status,
      width: tab && tab.width,
      height: tab && tab.height
    };

    console.log('capture-viewport request received', tabInfo);

    try {
      if (!browser.tabs || !browser.tabs.captureVisibleTab) {
        console.error('captureVisibleTab API not available', tabInfo);
        return null;
      }

      if (!windowId) {
        console.warn('capture-viewport: missing windowId from sender', tabInfo);
      }

      // Some URLs cannot be captured (about:, addons.mozilla.org, extension pages)
      if (tab && isCaptureProhibitedUrl(tab.url)) {
        console.warn('capture-viewport: capture is prohibited on this URL', tab.url);
        return null;
      }

      // Check if tab is still loading
      if (tab && tab.status === 'loading') {
        console.warn('capture-viewport: tab is still loading, this may cause empty captures', tabInfo);
      }

      // Try to get the active tab to ensure we're capturing the right one
      let activeTab;
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        activeTab = tabs[0];
        console.log('Active tab info:', {
          id: activeTab && activeTab.id,
          url: activeTab && activeTab.url,
          status: activeTab && activeTab.status,
          discarded: activeTab && activeTab.discarded
        });
      } catch (e) {
        console.warn('Could not query active tab:', e);
      }

      // Check permissions before attempting capture
      try {
        const hasPermission = await browser.permissions.contains({
          permissions: ['activeTab', 'tabs']
        });
        console.log('Extension permissions check:', { hasPermission });
        if (!hasPermission) {
          console.error('Missing required permissions for capture');
          return null;
        }
      } catch (permError) {
        console.warn('Could not check permissions:', permError);
      }

      console.log('Attempting captureVisibleTab with windowId:', windowId);
      
      // Firefox sometimes needs a small delay before capture
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });

      console.log('captureVisibleTab result:', {
        type: typeof dataUrl,
        length: dataUrl ? dataUrl.length : 0,
        preview: typeof dataUrl === 'string' ? dataUrl.slice(0, 64) : dataUrl,
        startsWithDataImage: typeof dataUrl === 'string' ? dataUrl.startsWith('data:image/') : false
      });

      if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        console.error('captureVisibleTab returned empty/invalid dataUrl', {
          ...tabInfo,
          dataUrlType: typeof dataUrl,
          dataUrlLength: dataUrl ? dataUrl.length : 0,
          dataUrlPreview: typeof dataUrl === 'string' ? dataUrl.slice(0, 64) : dataUrl
        });
        return null;
      }

      console.log('Capture successful, dataUrl length:', dataUrl.length);
      logImageToConsole(dataUrl);
      return dataUrl;
    } catch (error) {
      console.error('Failed to capture viewport:', {
        error: error.message || error,
        stack: error.stack,
        name: error.name,
        ...tabInfo
      });
      return null;
    }
  }

  if (message.type === 'save-pdf') {
    const { filename, pdfBuffer } = message;
    const bytes = new Uint8Array(pdfBuffer);
    
    // Determine MIME type based on filename
    const mimeType = filename && filename.endsWith('.png') ? 'image/png' : 'application/pdf';
    console.log('Saving file:', { filename, mimeType, size: bytes.length });
    
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    try {
      const downloadId = await browser.downloads.download({
        url,
        filename: filename || 'webpage.pdf',
        saveAs: true
      });
      // Revoke the object URL a bit later to ensure the download has started
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      console.log('Download started:', { downloadId, filename });
      return { ok: true, downloadId };
    } catch (e) {
      console.error('Download failed:', e);
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  // Handle paragraph to PDF conversion
  if (message.type === 'convertParagraphsToPdf') {
    try {
      const { paragraphs, url } = message;
      console.log('Converting paragraphs to PDF:', { count: paragraphs.length, url });
      
      const pdfContent = await generatePdfFromParagraphs(paragraphs, url);
      const filename = generateFilename(url, 'paragraphs');
      
      // Determine file type based on content
      const mimeType = filename.endsWith('.pdf') ? 'application/pdf' : 'text/plain';
      const blob = new Blob([pdfContent], { type: mimeType });
      const downloadUrl = URL.createObjectURL(blob);
      
      const downloadId = await browser.downloads.download({
        url: downloadUrl,
        filename: filename,
        saveAs: true
      });
      
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 10_000);
      console.log('Paragraph PDF download started:', { downloadId, filename });
      
      return { success: true, downloadId, filename };
    } catch (error) {
      console.error('Failed to convert paragraphs to PDF:', error);
      return { success: false, error: error.message };
    }
  }
});

function logImageToConsole(dataUrl) {
  console.log('Captured image data URL length:', dataUrl.length);
  
  // Create a clickable link to view the image
  console.log('🖼️ CLICK TO VIEW CAPTURED IMAGE:', dataUrl);
  console.log('📋 Copy this data URL to address bar to view:', dataUrl.substring(0, 200) + '...');
  
  // Also create a downloadable blob URL that's easier to work with
  try {
    // Convert data URL to blob
    const [header, data] = dataUrl.split(',');
    const mimeMatch = header.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    
    const byteCharacters = atob(data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mime });
    const blobUrl = URL.createObjectURL(blob);
    
    console.log('🔗 BLOB URL (easier to handle):', blobUrl);
    console.log('💡 Right-click the blob URL above → "Open in new tab" to view the image');
    
    // Clean up the blob URL after 30 seconds to prevent memory leaks
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      console.log('🗑️ Cleaned up blob URL for captured image');
    }, 30000);
    
  } catch (e) {
    console.warn('Could not create blob URL:', e);
  }
  
  // Verify the data URL works by creating an image element
  try {
    const testImg = new Image();
    testImg.onload = () => {
      console.log('✅ Image capture successful:', {
        width: testImg.naturalWidth,
        height: testImg.naturalHeight,
        size: `${(dataUrl.length / 1024).toFixed(1)} KB`
      });
    };
    testImg.onerror = (e) => {
      console.error('❌ Image data URL is corrupted:', e);
    };
    testImg.src = dataUrl;
  } catch (e) {
    console.error('Failed to validate image data URL:', e);
  }
}

function isCaptureProhibitedUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const prohibitedSchemes = [
      'about:',
      'chrome:',
      'resource:',
      'moz-extension:',
      'chrome-extension:',
      'view-source:',
      'data:'
    ];
    for (const scheme of prohibitedSchemes) {
      if (url.startsWith(scheme)) return true;
    }
    const u = new URL(url);
    if (u.hostname === 'addons.mozilla.org') return true;
    return false;
  } catch (_) {
    return false;
  }
}

// Generate PDF from extracted paragraphs using basic PDF structure
async function generatePdfFromParagraphs(paragraphs, sourceUrl) {
  console.log('Generating PDF from paragraphs:', paragraphs.length);
  
  // Create a simple HTML document for PDF conversion
  const htmlContent = createHtmlFromParagraphs(paragraphs, sourceUrl);
  
  // Convert HTML to PDF using the print API (available in Firefox)
  try {
    // Create a data URL with the HTML content
    const htmlDataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`;
    
    // For Firefox extensions, we'll create a simple PDF structure
    // Note: This is a basic implementation. For production, consider using libraries like jsPDF
    return await createBasicPdf(paragraphs, sourceUrl);
  } catch (error) {
    console.error('Failed to generate PDF:', error);
    throw error;
  }
}

function createHtmlFromParagraphs(paragraphs, sourceUrl) {
  const title = getPageTitle(sourceUrl);
  const date = new Date().toLocaleDateString();
  
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>${title}</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
            .header { border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 30px; }
            .title { font-size: 24px; font-weight: bold; margin-bottom: 10px; }
            .source { color: #666; font-size: 14px; }
            .paragraph { margin-bottom: 20px; text-align: justify; }
            .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #ccc; font-size: 12px; color: #666; }
        </style>
    </head>
    <body>
        <div class="header">
            <div class="title">${title}</div>
            <div class="source">Source: ${sourceUrl}</div>
            <div class="source">Extracted on: ${date}</div>
        </div>
  `;
  
  paragraphs.forEach((paragraph, index) => {
    html += `<div class="paragraph">${paragraph.text}</div>\n`;
  });
  
  html += `
        <div class="footer">
            Extracted ${paragraphs.length} paragraphs from ${sourceUrl}
        </div>
    </body>
    </html>
  `;
  
  return html;
}

// Create a basic PDF structure (simplified version)
async function createBasicPdf(paragraphs, sourceUrl) {
  // This is a simplified PDF creation. In a real implementation, 
  // you would use a proper PDF library like jsPDF or PDFKit
  
  const title = getPageTitle(sourceUrl);
  const date = new Date().toLocaleDateString();
  
  // Create text content for the PDF
  let textContent = `${title}\n\n`;
  textContent += `Source: ${sourceUrl}\n`;
  textContent += `Extracted on: ${date}\n\n`;
  textContent += '=' .repeat(50) + '\n\n';
  
  paragraphs.forEach((paragraph, index) => {
    textContent += `${paragraph.text}\n\n`;
  });
  
  textContent += '\n' + '-'.repeat(50) + '\n';
  textContent += `Extracted ${paragraphs.length} paragraphs from ${sourceUrl}`;
  
  // Convert text to a simple PDF-like format (text file for now)
  // In a real implementation, this would generate actual PDF bytes
  const encoder = new TextEncoder();
  return encoder.encode(textContent);
}

function getPageTitle(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '') + ' - Blog Content';
  } catch (e) {
    return 'Blog Content';
  }
}

function generateFilename(url, type) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace('www.', '').replace(/\./g, '_');
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    return `${hostname}_${type}_${timestamp}.txt`;
  } catch (e) {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    return `blog_${type}_${timestamp}.txt`;
  }
}



