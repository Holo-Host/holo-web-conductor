/**
 * Background Service Worker
 *
 * Creates offscreen document and tests WASM + sync XHR capability.
 */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

// Track offscreen document status
let creating = null;

async function hasOffscreenDocument() {
  // Check if offscreen document already exists
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });
  return contexts.length > 0;
}

async function setupOffscreenDocument() {
  // Return if already exists
  if (await hasOffscreenDocument()) {
    console.log('Offscreen document already exists');
    return;
  }

  // Avoid creating multiple documents
  if (creating) {
    await creating;
    return;
  }

  console.log('Creating offscreen document...');
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['WORKERS'], // WORKERS reason for general computation
    justification: 'Running WASM with synchronous host functions for network access'
  });

  await creating;
  creating = null;
  console.log('Offscreen document created');
}

// Handle messages from offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] Received message:', message);

  if (message.target !== 'background') {
    return;
  }

  if (message.type === 'OFFSCREEN_READY') {
    console.log('[Background] Offscreen document is ready');
    return;
  }

  if (message.type === 'TEST_RESULT') {
    console.log('[Background] Test result:', message.data);
    return;
  }

  return false;
});

// Handle extension icon click - run the test
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[Background] Running test...');

  // Ensure offscreen document exists
  await setupOffscreenDocument();

  // Send test request to offscreen document
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'RUN_TEST'
  });

  console.log('[Background] Test response:', response);
});

// Create offscreen document on startup
console.log('[Background] Service worker starting...');
setupOffscreenDocument();
