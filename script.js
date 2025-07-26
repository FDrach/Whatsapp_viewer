document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const fileInput = document.getElementById('chat-file');
    const chatContainer = document.getElementById('chat-container');
    const loadingIndicator = document.getElementById('loading-indicator');

    // --- Core State ---
    let allMessages = [];
    let mediaFileEntries = new Map();
    let zipFile = null;
    let renderedBatches = new Map();

    // --- Configuration ---
    const BATCH_SIZE = 50;
    const MAX_RENDERED_BATCHES = 5;
    const RENDER_TRIGGER_MARGIN = window.innerHeight * 1.5;

    // --- Control Flags ---
    let scrollCheckScheduled = false;

    // --- Event Listeners ---
    fileInput.addEventListener('change', handleFileSelect);
    chatContainer.addEventListener('scroll', () => {
        if (!scrollCheckScheduled) {
            window.requestAnimationFrame(() => {
                checkAndLoadBatches();
                scrollCheckScheduled = false;
            });
            scrollCheckScheduled = true;
        }
    });
    window.addEventListener('beforeunload', cleanup);

    function cleanup() {
        renderedBatches.forEach(batch => batch.blobUrls.forEach(URL.revokeObjectURL));
        renderedBatches.clear();
        allMessages = [];
        mediaFileEntries.clear();
        zipFile = null;
        document.getElementById('user-selection-modal').classList.add('hidden');
        document.getElementById('file-selection-modal').classList.add('hidden');
    }

    async function handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file || !file.name.endsWith('.zip')) return;

        loadingIndicator.classList.remove('hidden');
        cleanup();
        chatContainer.innerHTML = '';

        try {
            zipFile = await JSZip.loadAsync(file);
            const chatFile = await findChatFile(zipFile, file.name);

            zipFile.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir) mediaFileEntries.set(zipEntry.name, zipEntry);
            });

            const chatText = await chatFile.async('string');
            const participants = parseAllMessages(chatText);
            
            const mainUser = await promptForUser(participants);
            
            allMessages.forEach(msg => {
                if (msg.sender && msg.sender !== 'System') {
                    msg.type = msg.sender.toLowerCase() === mainUser.toLowerCase() ? 'outgoing' : 'incoming';
                }
            });
            
            await initializeChatView();

        } catch (error) {
            console.error('File processing error:', error);
            alert(`Error: ${error.message}`);
        } finally {
            loadingIndicator.classList.add('hidden');
        }
    }
    
    // --- NEW: Simplified and Direct Prompt Functions ---
    function promptForUser(participants) {
        const modal = document.getElementById('user-selection-modal');
        const buttonContainer = document.getElementById('user-buttons-container');
        const options = Array.from(participants);
        
        return new Promise((resolve) => {
            buttonContainer.innerHTML = '';
            if (options.length <= 1) {
                resolve(options[0] || null); // Auto-select if 1 or 0 participants
                return;
            }
            // Show only the first 2 participants for a standard 1-on-1 chat selection
            options.slice(0, 2).forEach(name => {
                const button = document.createElement('button');
                button.className = 'user-button';
                button.textContent = name;
                button.onclick = () => {
                    modal.classList.add('hidden');
                    resolve(name);
                };
                buttonContainer.appendChild(button);
            });
            modal.classList.remove('hidden');
        });
    }

    function promptForFile(fileOptions) {
        const modal = document.getElementById('file-selection-modal');
        const buttonContainer = document.getElementById('file-buttons-container');

        return new Promise((resolve) => {
            buttonContainer.innerHTML = '';
            fileOptions.forEach(fileName => {
                const button = document.createElement('button');
                button.className = 'user-button';
                button.textContent = fileName;
                button.onclick = () => {
                    modal.classList.add('hidden');
                    resolve(fileName);
                };
                buttonContainer.appendChild(button);
            });
            modal.classList.remove('hidden');
        });
    }

    async function findChatFile(zip, zipFilename) {
        let chatFile = zip.file('_chat.txt');
        if (chatFile) return chatFile;

        const zipNameAsTxt = zipFilename.replace(/\.zip$/i, '.txt');
        chatFile = zip.file(zipNameAsTxt);
        if (chatFile) return chatFile;

        const textFiles = zip.filter((path, entry) => path.toLowerCase().endsWith('.txt') && !entry.dir);
        if (textFiles.length === 0) throw new Error('No .txt files found in the zip archive.');
        if (textFiles.length === 1) return textFiles[0];

        const chatNamedFiles = textFiles.filter(f => f.name.toLowerCase().includes('chat'));
        if (chatNamedFiles.length === 1) return chatNamedFiles[0];
        
        const filesToValidate = chatNamedFiles.length > 0 ? chatNamedFiles : textFiles;
        const validChatFiles = [];
        for (const f of filesToValidate) {
            if (await isValidChatFormat(f)) {
                validChatFiles.push(f);
            }
        }

        if (validChatFiles.length === 0) throw new Error('Could not find a valid WhatsApp chat file.');
        if (validChatFiles.length === 1) return validChatFiles[0];

        // Last resort: prompt the user
        const selectedFileName = await promptForFile(validChatFiles.map(f => f.name));
        return zip.file(selectedFileName);
    }

    async function isValidChatFormat(fileEntry) {
        try {
            const content = await fileEntry.async('string');
            const lines = content.split('\n').slice(0, 10);
            const messageStartRegex = /^\d{1,2}\/\d{1,2}\/\d{4},/;
            return lines.some(line => messageStartRegex.test(line));
        } catch (e) {
            return false;
        }
    }

    function parseAllMessages(text) {
        const participants = new Set();
        const lines = text.split('\n');
        const messageStartRegex = /^\d{1,2}\/\d{1,2}\/\d{4},\s*.*?-\s*/;
        let currentMessage = null;

        lines.forEach(line => {
            const cleanLine = line.replace(/[\u200E\u200F\u202A-\u202E]/g, '').trim();
            if (!cleanLine) return;

            if (messageStartRegex.test(cleanLine)) {
                if (currentMessage) allMessages.push(currentMessage);
                const [dateTimeString, messageBody] = cleanLine.split(' - ', 2);
                const time = dateTimeString.split(', ')[1] || '';
                const senderMatch = messageBody.match(/^([^:]+):\s/);

                if (senderMatch) {
                    const sender = senderMatch[1];
                    participants.add(sender);
                    const content = messageBody.substring(sender.length + 2);
                    currentMessage = { sender, content, time, type: '' };
                } else {
                    currentMessage = { sender: 'System', content: messageBody, time: '', type: 'system' };
                }
            } else if (currentMessage) {
                currentMessage.content += '\n' + cleanLine;
            }
        });
        if (currentMessage) allMessages.push(currentMessage);
        return participants;
    }

    async function initializeChatView() {
        const totalBatches = Math.ceil(allMessages.length / BATCH_SIZE);
        const initialBatchIndex = Math.max(0, totalBatches - 1);
        
        const numToPreload = Math.min(totalBatches, 3);
        for(let i = 0; i < numToPreload; i++) {
            if (initialBatchIndex - i >= 0) {
               await loadBatch(initialBatchIndex - i, 'prepend');
            }
        }
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    async function checkAndLoadBatches() {
        const firstBatchIndex = renderedBatches.size > 0 ? Math.min(...renderedBatches.keys()) : -1;
        const lastBatchIndex = renderedBatches.size > 0 ? Math.max(...renderedBatches.keys()) : -1;

        if (chatContainer.scrollTop < RENDER_TRIGGER_MARGIN && firstBatchIndex > 0) {
            await loadBatch(firstBatchIndex - 1, 'prepend');
        }

        const scrollBottom = chatContainer.scrollHeight - chatContainer.clientHeight - chatContainer.scrollTop;
        const totalBatches = Math.ceil(allMessages.length / BATCH_SIZE);
        if (scrollBottom < RENDER_TRIGGER_MARGIN && lastBatchIndex < totalBatches - 1) {
            await loadBatch(lastBatchIndex + 1, 'append');
        }
    }

    async function loadBatch(batchIndex, position) {
        if (batchIndex < 0 || renderedBatches.has(batchIndex)) return;

        const startIndex = batchIndex * BATCH_SIZE;
        const endIndex = Math.min(startIndex + BATCH_SIZE, allMessages.length);
        const messagesToRender = allMessages.slice(startIndex, endIndex);

        const batchContainer = document.createElement('div');
        batchContainer.dataset.batchIndex = batchIndex;
        const blobUrls = [];

        for (const msg of messagesToRender) {
            const { bubble, urls } = await createMessageBubble(msg);
            if (bubble) {
                batchContainer.appendChild(bubble);
                blobUrls.push(...urls);
            }
        }
        
        const oldScrollHeight = chatContainer.scrollHeight;
        if (position === 'prepend') {
            chatContainer.prepend(batchContainer);
            chatContainer.scrollTop += chatContainer.scrollHeight - oldScrollHeight;
        } else {
            chatContainer.append(batchContainer);
        }
        renderedBatches.set(batchIndex, { element: batchContainer, blobUrls });

        if (renderedBatches.size > MAX_RENDERED_BATCHES) {
            const indexToUnload = (position === 'prepend') ? Math.max(...renderedBatches.keys()) : Math.min(...renderedBatches.keys());
            unloadBatch(indexToUnload);
        }
    }

    function unloadBatch(batchIndex) {
        const batch = renderedBatches.get(batchIndex);
        if (batch) {
            batch.blobUrls.forEach(URL.revokeObjectURL);
            batch.element.remove();
            renderedBatches.delete(batchIndex);
        }
    }

    async function createMessageBubble(msg) {
        if (msg.content.includes('<Multimedia omitido>')) return { bubble: null, urls: [] };

        const bubble = document.createElement('div');
        bubble.classList.add('message-bubble', msg.type);
        const urls = [];

        if (msg.type === 'incoming') {
            const senderDiv = document.createElement('div');
            senderDiv.classList.add('sender');
            senderDiv.textContent = msg.sender;
            bubble.appendChild(senderDiv);
        }
        
        let fileName = null, caption = '';
        const matchWithTag = msg.content.match(/^(.*?)\s+\(archivo adjunto\)(?:\n([\s\S]*))?$/);
        if (matchWithTag) {
            fileName = matchWithTag[1].trim(); caption = matchWithTag[2] || '';
        } else if (mediaFileEntries.has(msg.content.trim())) {
            fileName = msg.content.trim();
        }

        if (fileName && mediaFileEntries.has(fileName)) {
            const zipEntry = mediaFileEntries.get(fileName);
            const blob = await zipEntry.async('blob');
            const url = URL.createObjectURL(blob);
            urls.push(url);

            const mediaContainer = createMediaElement(fileName, url, caption);
            bubble.appendChild(mediaContainer);
        } else {
            const textDiv = document.createElement('div');
            textDiv.classList.add('text-content');
            textDiv.innerHTML = formatText(msg.content);
            bubble.appendChild(textDiv);
        }
        
        const timeDiv = document.createElement('div');
        timeDiv.classList.add('timestamp');
        timeDiv.textContent = msg.time;
        bubble.appendChild(timeDiv);

        return { bubble, urls };
    }

    function createMediaElement(fileName, url, caption) {
        const mediaContainer = document.createElement('div');
        mediaContainer.classList.add('media-container');
        let mediaElement;
        const lowerCaseFileName = fileName.toLowerCase();
        if (lowerCaseFileName.endsWith('.jpg') || lowerCaseFileName.endsWith('.jpeg') || lowerCaseFileName.endsWith('.png') || lowerCaseFileName.endsWith('.gif') || lowerCaseFileName.endsWith('.webp')) {
            mediaElement = document.createElement('img');
        } else if (lowerCaseFileName.endsWith('.opus') || lowerCaseFileName.endsWith('.ogg') || lowerCaseFileName.endsWith('.mp3') || lowerCaseFileName.endsWith('.m4a') || lowerCaseFileName.endsWith('.aac')) {
            mediaElement = document.createElement('audio');
            mediaElement.controls = true;
        } else if (lowerCaseFileName.endsWith('.mp4') || lowerCaseFileName.endsWith('.mov') || lowerCaseFileName.endsWith('.webm')) {
            mediaElement = document.createElement('video');
            mediaElement.controls = true;
        }
        if (mediaElement) {
            mediaElement.src = url;
            mediaElement.classList.add('media-attachment');
            mediaContainer.appendChild(mediaElement);
        } else {
            mediaContainer.innerHTML = `<div class="file-attachment"><div class="file-icon"></div><span>${formatText(fileName)}</span></div>`;
        }
        if (caption) {
            const captionDiv = document.createElement('div');
            captionDiv.classList.add('caption');
            captionDiv.innerHTML = formatText(caption);
            mediaContainer.appendChild(captionDiv);
        }
        return mediaContainer;
    }

    function formatText(text) {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        let formattedText = text.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
        formattedText = formattedText.replace(urlRegex, '<a href="$&" target="_blank" rel="noopener noreferrer">$&</a>');
        return formattedText.replace(/\n/g, '<br>');
    }
});
