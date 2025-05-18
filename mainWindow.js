const { ipcRenderer } = require('electron');
const pdfjsLib = require('pdfjs-dist');
const ePub = require('epubjs');
const { themes, applyTheme } = require('./theme.js');
const { broadcastThemeChange } = require('./themeSync.js');
const fs = require('fs');
const path = require('path');

// Make theme functions available to window for button clicks
window.applyTheme = function(themeName) {
    applyTheme(themeName);
    broadcastThemeChange(themeName);
};

// View switching function
window.switchView = function(viewMode) {
    // Save view preference
    localStorage.setItem('viewMode', viewMode);
    
    // Update buttons
    document.querySelectorAll('.view-button').forEach(button => {
        button.classList.toggle('active', button.classList.contains(viewMode));
    });
    
    // Update list class
    const list = document.getElementById('pdf-list');
    list.className = `pdf-list ${viewMode}-view`;
};

// PDF.js initialization
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

// DOM Elements
const bookList = document.getElementById('pdf-list');
const emptyState = document.getElementById('empty-state');
const addButton = document.getElementById('add-pdf');

// Initialize theme and UI when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Apply saved theme
    const savedTheme = localStorage.getItem('theme') || 'light';
    applyTheme(savedTheme);
    
    // Apply saved view mode
    const savedViewMode = localStorage.getItem('viewMode') || 'grid';
    switchView(savedViewMode);
    
    // Mark the current theme button as active
    document.querySelectorAll('.theme-button').forEach(button => {
        button.classList.toggle('active', button.classList.contains(savedTheme));
    });

    // Set up event listeners
    addButton.addEventListener('click', async () => {
        await ipcRenderer.invoke('add-book');
    });

    // Directory import button handler
    const importDirButton = document.getElementById('import-directory');
    importDirButton.addEventListener('click', async () => {
        await ipcRenderer.invoke('import-directory');
    });

    // Initial book list load
    ipcRenderer.invoke('get-book-list');
});

// Listen for book list updates
ipcRenderer.on('update-book-list', (event, books) => {
    updateBookList(books);
});

// Listen for directory import completion
ipcRenderer.on('directory-import-complete', (event, count) => {
    if (count > 0) {
        alert(`Successfully imported ${count} new book${count === 1 ? '' : 's'}`);
    } else {
        alert('No new books found in the selected directory');
    }
});

// Handle book deletion
async function deleteBook(path, element) {
    try {
        await ipcRenderer.invoke('delete-book', path);
        element.remove();
        
        // Check if there are any books left
        if (bookList.children.length === 0) {
            emptyState.style.display = 'block';
        }
    } catch (error) {
        console.error('Error deleting book:', error);
        alert('Failed to delete the book');
    }
}

async function extractPdfMetadata(filePath) {
    try {
        const data = await ipcRenderer.invoke('get-book-buffer', filePath);
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const metadata = await pdf.getMetadata();
        
        return {
            info: metadata.info,
            metadata: metadata.metadata,
            pageCount: pdf.numPages,
            pdf: pdf
        };
    } catch (error) {
        console.error('Error extracting PDF metadata:', error);
        return null;
    }
}

async function extractEpubMetadata(filePath) {
    try {
        const data = await ipcRenderer.invoke('get-book-buffer', filePath);
        const blob = new Blob([data], { type: 'application/epub+zip' });
        const url = URL.createObjectURL(blob);
        const book = ePub(url);
        await book.ready;

        const metadata = book.package.metadata;
        const cover = await book.coverUrl();

        // Extract metadata safely with proper handling of arrays and objects
        const extractField = (field) => {
            if (!metadata[field]) return null;
            
            const value = Array.isArray(metadata[field]) ? metadata[field][0] : metadata[field];
            return typeof value === 'object' ? value['#text'] : value;
        };

        // Get spine items to count pages
        const spine = book.spine;
        const pageCount = spine ? spine.items.length : null;

        const result = {
            info: {
                Title: extractField('title') || 'Unknown Title',
                Creator: extractField('creator') || 'Unknown Author',
                Publisher: extractField('publisher'),
                Language: extractField('language'),
                Rights: extractField('rights'),
                Description: extractField('description'),
                Subject: extractField('subject'),
                Modified: extractField('date'),
            },
            coverUrl: cover,
            book: book,
            pageCount: pageCount
        };
        
        return result;
    } catch (error) {
        console.error('Error extracting EPUB metadata:', error);
        return null;
    }
}

async function extractCover(pdf, canvas) {
    try {
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.0 });
        
        const containerWidth = 300;
        const scale = containerWidth / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;

        const renderContext = {
            canvasContext: canvas.getContext('2d'),
            viewport: scaledViewport
        };

        await page.render(renderContext).promise;
    } catch (error) {
        console.error('Error extracting cover:', error);
        canvas.style.display = 'none';
    }
}

function formatPdfMetadata(metadata) {
    if (!metadata) return {};

    const info = metadata.info || {};
    const result = {
        'Title': info.Title || 'N/A',
        'Author': info.Author || 'N/A',
        'Subject': info.Subject || 'N/A',
        'Creator': info.Creator || 'N/A',
        'Creation Date': info.CreationDate ? formatPdfDate(info.CreationDate) : 'N/A',
        'Pages': metadata.pageCount || 'N/A'
    };

    return result;
}

function formatEpubMetadata(metadata) {
    if (!metadata) return {};

    const info = metadata.info || {};
    return {
        'Title': info.Title || 'N/A',
        'Author': info.Creator || 'N/A',
        'Publisher': info.Publisher || 'N/A',
        'Language': info.Language || 'N/A',
        'Subject': info.Subject || 'N/A',
        'Rights': info.Rights || 'N/A',
        'Modified': info.Modified || 'N/A'
    };
}

function formatPdfDate(dateString) {
    try {
        if (dateString.startsWith('D:')) {
            dateString = dateString.slice(2);
            const year = dateString.slice(0, 4);
            const month = dateString.slice(4, 6);
            const day = dateString.slice(6, 8);
            return `${year}-${month}-${day}`;
        }
        return dateString;
    } catch (error) {
        return dateString;
    }
}

async function updateBookList(books) {
    // Clear the current list
    bookList.innerHTML = '';
    
    // Show/hide empty state
    emptyState.style.display = books.length === 0 ? 'block' : 'none';
    
    for (const book of books) {
        const li = document.createElement('li');
        li.className = 'pdf-item';
        
        // Create cover container
        const coverDiv = document.createElement('div');
        coverDiv.className = 'pdf-cover';
        
        // Add book type badge
        const typeBadge = document.createElement('div');
        typeBadge.className = 'book-type-badge';
        typeBadge.textContent = book.type.toUpperCase();
        coverDiv.appendChild(typeBadge);
        
        // Create info container
        const infoDiv = document.createElement('div');
        infoDiv.className = 'pdf-info';
        
        // Create delete button
        const deleteButton = document.createElement('button');
        deleteButton.className = 'delete-button';
        deleteButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>';
        deleteButton.title = 'Удалить книгу';
        
        // Add delete button event listener
        deleteButton.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteBook(book.path, li);
        });
        
        // Get file stats
        const stats = fs.statSync(book.path);
        const creationDate = new Date(stats.birthtime);
        
        // Extract metadata based on file type
        let metadata;
        if (book.type === 'pdf') {
            metadata = await extractPdfMetadata(book.path);
            if (metadata && metadata.pdf) {
                const canvas = document.createElement('canvas');
                await extractCover(metadata.pdf, canvas);
                coverDiv.appendChild(canvas);
            }
        } else if (book.type === 'epub') {
            metadata = await extractEpubMetadata(book.path);
            if (metadata && metadata.coverUrl) {
                const img = document.createElement('img');
                img.src = metadata.coverUrl;
                img.alt = metadata?.info?.Title || "Book cover";
                coverDiv.appendChild(img);
            } else {
                // Create placeholder cover if no cover is available
                const placeholderDiv = document.createElement('div');
                placeholderDiv.className = 'placeholder-cover';
                placeholderDiv.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21,5C19.89,4.65 18.67,4.5 17.5,4.5C15.55,4.5 13.45,4.9 12,6C10.55,4.9 8.45,4.5 6.5,4.5C4.55,4.5 2.45,4.9 1,6V20.65C1,20.9 1.25,21.15 1.5,21.15C1.6,21.15 1.65,21.1 1.75,21.1C3.1,20.45 5.05,20 6.5,20C8.45,20 10.55,20.4 12,21.5C13.35,20.65 15.8,20 17.5,20C19.15,20 20.85,20.3 22.25,21.05C22.35,21.1 22.4,21.1 22.5,21.1C22.75,21.1 23,20.85 23,20.6V6C22.4,5.55 21.75,5.25 21,5M21,18.5C19.9,18.15 18.7,18 17.5,18C15.8,18 13.35,18.65 12,19.5V8C13.35,7.15 15.8,6.5 17.5,6.5C18.7,6.5 19.9,6.65 21,7V18.5Z"/></svg>';
                placeholderDiv.title = "No cover available";
                coverDiv.appendChild(placeholderDiv);
            }
        }
        
        // Create and populate title element
        const titleElement = document.createElement('h3');
        titleElement.className = 'pdf-title';
        titleElement.textContent = metadata?.info?.Title || path.basename(book.path);
        
        // Create and populate author element
        const authorElement = document.createElement('p');
        authorElement.className = 'pdf-author';
        authorElement.textContent = metadata?.info?.Author || metadata?.info?.Creator || 'Неизвестный автор';
        
        // Create metadata container
        const metadataDiv = document.createElement('div');
        metadataDiv.className = 'pdf-metadata';
        
        // Create language pill if available for EPUB
        if (book.type === 'epub' && metadata?.info?.Language) {
            const langSpan = document.createElement('span');
            langSpan.className = 'metadata-pill language-pill';
            langSpan.textContent = metadata.info.Language.toUpperCase();
            authorElement.appendChild(langSpan);
        }
        
        // Add page count for both PDF and EPUB
        const pagesSpan = document.createElement('span');
        if (metadata?.pageCount) {
            pagesSpan.textContent = `${metadata.pageCount} ${book.type === 'pdf' ? 'стр.' : 'гл.'}`;
        }
        
        // Add creation date
        const dateSpan = document.createElement('span');
        dateSpan.textContent = creationDate.toLocaleDateString('ru-RU');
        
        // Add publisher for EPUB if available
        if (book.type === 'epub' && metadata?.info?.Publisher) {
            const publisherDiv = document.createElement('div');
            publisherDiv.className = 'publisher-info';
            publisherDiv.textContent = metadata.info.Publisher;
            infoDiv.insertBefore(publisherDiv, metadataDiv);
        }
        
        // Assemble the elements
        metadataDiv.appendChild(pagesSpan);
        metadataDiv.appendChild(dateSpan);
        
        infoDiv.appendChild(titleElement);
        infoDiv.appendChild(authorElement);
        infoDiv.appendChild(metadataDiv);
        
        li.appendChild(coverDiv);
        li.appendChild(infoDiv);
        li.appendChild(deleteButton);
        
        // Add click handler to open the book
        li.addEventListener('click', () => {
            ipcRenderer.invoke('open-book-window', book.path);
        });
        
        bookList.appendChild(li);
    }
}

function updateMetadataDisplay(container, metadata) {
    const metadataHtml = Object.entries(metadata)
        .map(([key, value]) => `
            <div class="metadata-item">
                <span class="metadata-label">${key}:</span>
                <span class="metadata-value">${value}</span>
            </div>
        `).join('');
    
    container.querySelector('.pdf-metadata').innerHTML = metadataHtml;
} 