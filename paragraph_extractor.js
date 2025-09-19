// Paragraph Extractor Content Script
// Extracts paragraphs from blog sites and sends them to background script

class ParagraphExtractor {
    constructor() {
        this.extractedParagraphs = [];
        this.init();
    }

    init() {
        // Listen for messages from popup
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'extractParagraphs') {
                this.extractParagraphs();
                sendResponse({ success: true, paragraphs: this.extractedParagraphs });
            }
        });
    }

    extractParagraphs() {
        this.extractedParagraphs = [];
        
        // Common blog selectors - prioritize article content
        const selectors = [
            'article p',
            '.post-content p',
            '.entry-content p',
            '.content p',
            '.post p',
            '.article-content p',
            '.blog-content p',
            'main p',
            '.container p',
            'p'
        ];

        let paragraphs = [];
        
        // Try selectors in order of specificity
        for (const selector of selectors) {
            paragraphs = document.querySelectorAll(selector);
            if (paragraphs.length > 0) {
                break;
            }
        }

        // Filter and process paragraphs
        paragraphs.forEach((p, index) => {
            const text = p.textContent.trim();
            
            // Skip short paragraphs, navigation, and footer content
            if (text.length > 50 && 
                !this.isNavigationText(text) && 
                !this.isFooterText(text) &&
                !this.isAdText(text)) {
                
                this.extractedParagraphs.push({
                    id: index,
                    text: text,
                    html: p.outerHTML,
                    selected: true
                });
            }
        });

        console.log(`Extracted ${this.extractedParagraphs.length} paragraphs from the page`);
    }

    isNavigationText(text) {
        const navKeywords = [
            'home', 'about', 'contact', 'menu', 'search', 'login', 'register',
            'next', 'previous', 'back', 'continue', 'skip', 'more'
        ];
        
        const lowerText = text.toLowerCase();
        return navKeywords.some(keyword => 
            lowerText === keyword || 
            (text.length < 100 && lowerText.includes(keyword))
        );
    }

    isFooterText(text) {
        const footerKeywords = [
            'copyright', '©', 'all rights reserved', 'privacy policy', 
            'terms of service', 'cookies', 'subscribe', 'newsletter'
        ];
        
        const lowerText = text.toLowerCase();
        return footerKeywords.some(keyword => lowerText.includes(keyword));
    }

    isAdText(text) {
        const adKeywords = [
            'advertisement', 'sponsored', 'ads by', 'promoted', 'affiliate',
            'buy now', 'click here', 'learn more', 'sign up now'
        ];
        
        const lowerText = text.toLowerCase();
        return adKeywords.some(keyword => lowerText.includes(keyword));
    }

    getExtractedParagraphs() {
        return this.extractedParagraphs;
    }
}

// Initialize the paragraph extractor
const paragraphExtractor = new ParagraphExtractor();
