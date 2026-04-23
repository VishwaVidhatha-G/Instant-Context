chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getPageContent") {
    // Extract only readable text to avoid sending HTML tags to AI
    const pageText = document.body.innerText.substring(0, 5000); // Limit to 5000 chars for simplicity
    sendResponse({ content: pageText });
  }
});
