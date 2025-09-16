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
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || !message.type) return;

  if (message.type === 'capture-viewport') {
    // Capture the currently visible tab area as a PNG data URL
    const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
    return browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  }

  if (message.type === 'save-pdf') {
    const { filename, pdfBuffer } = message;
    const bytes = new Uint8Array(pdfBuffer);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    return browser.downloads.download({
      url,
      filename: filename || 'webpage.pdf',
      saveAs: true
    }).then((downloadId) => {
      // Revoke the object URL a bit later to ensure the download has started
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return { ok: true, downloadId };
    });
  }
});


