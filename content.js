chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getPageContent") {
    // Extract readable text, removing excessive whitespace
    const pageText = document.body.innerText
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 10000); 
    
    sendResponse({ content: pageText });
  }
});
