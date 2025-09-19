// Popup Script for Web Page Tools Extension

class PopupController {
    constructor() {
        this.extractedParagraphs = [];
        this.init();
    }

    init() {
        // Bind event listeners
        document.getElementById('captureBtn').addEventListener('click', () => {
            this.captureFullPage();
        });

        document.getElementById('extractBtn').addEventListener('click', () => {
            this.extractParagraphs();
        });

        document.getElementById('selectAllBtn').addEventListener('click', () => {
            this.selectAllParagraphs(true);
        });

        document.getElementById('deselectAllBtn').addEventListener('click', () => {
            this.selectAllParagraphs(false);
        });

        document.getElementById('convertToPdfBtn').addEventListener('click', () => {
            this.convertSelectedToPdf();
        });
    }

    captureFullPage() {
        this.showStatus('Capturing full page...', 'info');
        
        // Send message to background script for existing functionality
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'captureFullPage' }, (response) => {
                if (response && response.success) {
                    this.showStatus('Page captured successfully!', 'success');
                } else {
                    this.showStatus('Failed to capture page', 'error');
                }
            });
        });
    }

    extractParagraphs() {
        this.showStatus('Extracting paragraphs...', 'info');
        
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'extractParagraphs' }, (response) => {
                if (response && response.success) {
                    this.extractedParagraphs = response.paragraphs;
                    this.displayParagraphs();
                    this.showStatus(`Extracted ${this.extractedParagraphs.length} paragraphs`, 'success');
                } else {
                    this.showStatus('Failed to extract paragraphs', 'error');
                }
            });
        });
    }

    displayParagraphs() {
        const paragraphsList = document.getElementById('paragraphsList');
        const paragraphsContainer = document.getElementById('paragraphsContainer');
        const paragraphCount = document.getElementById('paragraphCount');
        
        paragraphCount.textContent = this.extractedParagraphs.length;
        
        if (this.extractedParagraphs.length === 0) {
            paragraphsList.style.display = 'none';
            return;
        }

        // Clear existing content
        paragraphsContainer.innerHTML = '';
        
        // Create paragraph items
        this.extractedParagraphs.forEach((paragraph, index) => {
            const paragraphItem = document.createElement('div');
            paragraphItem.className = 'paragraph-item';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `paragraph-${index}`;
            checkbox.checked = paragraph.selected;
            checkbox.addEventListener('change', (e) => {
                this.extractedParagraphs[index].selected = e.target.checked;
            });
            
            const label = document.createElement('label');
            label.htmlFor = `paragraph-${index}`;
            
            const preview = document.createElement('div');
            preview.className = 'paragraph-preview';
            preview.textContent = paragraph.text.length > 150 
                ? paragraph.text.substring(0, 150) + '...' 
                : paragraph.text;
            
            label.appendChild(preview);
            
            paragraphItem.appendChild(checkbox);
            paragraphItem.appendChild(label);
            paragraphsContainer.appendChild(paragraphItem);
        });
        
        paragraphsList.style.display = 'block';
    }

    selectAllParagraphs(select) {
        this.extractedParagraphs.forEach((paragraph, index) => {
            paragraph.selected = select;
            const checkbox = document.getElementById(`paragraph-${index}`);
            if (checkbox) {
                checkbox.checked = select;
            }
        });
    }

    convertSelectedToPdf() {
        const selectedParagraphs = this.extractedParagraphs.filter(p => p.selected);
        
        if (selectedParagraphs.length === 0) {
            this.showStatus('Please select at least one paragraph', 'error');
            return;
        }

        this.showStatus(`Converting ${selectedParagraphs.length} paragraphs to PDF...`, 'info');
        
        // Get current tab URL first
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const currentUrl = tabs[0].url;
            
            // Send selected paragraphs to background script for PDF conversion
            chrome.runtime.sendMessage({
                type: 'convertParagraphsToPdf',
                paragraphs: selectedParagraphs,
                url: currentUrl
            }, (response) => {
                if (response && response.success) {
                    this.showStatus('PDF generated successfully!', 'success');
                } else {
                    this.showStatus('Failed to generate PDF', 'error');
                }
            });
        });
    }

    showStatus(message, type) {
        const status = document.getElementById('status');
        const statusText = document.getElementById('statusText');
        
        statusText.textContent = message;
        status.className = `status ${type}`;
        status.style.display = 'block';
        
        // Auto-hide success messages after 3 seconds
        if (type === 'success') {
            setTimeout(() => {
                status.style.display = 'none';
            }, 3000);
        }
    }
}

// Initialize popup controller when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new PopupController();
});
