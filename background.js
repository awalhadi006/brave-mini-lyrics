// Service worker Brave Mini Lyrics.

chrome.action.onClicked.addListener((tab) => {
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { action: 'toggle_lyrics' }, () => {
        // Halaman non-YouTube tidak punya content script; abaikan error-nya.
        void chrome.runtime.lastError;
    });
});

chrome.commands.onCommand.addListener((command) => {
    if (command !== 'toggle-lyrics') return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) return;
        chrome.tabs.sendMessage(tab.id, { action: 'toggle_lyrics' }, () => {
            void chrome.runtime.lastError;
        });
    });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'romanize') return undefined;

    const senderUrl = sender.url || (sender.tab && sender.tab.url) || '';
    if (!/^https:\/\/([a-z0-9-]+\.)*youtube\.com\//i.test(senderUrl)) {
        sendResponse({ success: false, error: 'Origin tidak diizinkan.' });
        return false;
    }

    const text = typeof request.text === 'string' ? request.text : '';
    if (!text.trim()) {
        sendResponse({ success: false, error: 'Teks kosong.' });
        return false;
    }
    if (text.length > 10000) {
        sendResponse({ success: false, error: 'Teks terlalu panjang.' });
        return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const url =
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=rm&dj=1';

    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'q=' + encodeURIComponent(text),
        signal: controller.signal
    })
        .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        })
        .then((data) => {
            try {
                let romanized = '';
                if (data && Array.isArray(data.sentences)) {
                    data.sentences.forEach((sentence) => {
                        let part = sentence.src_translit || sentence.orig || '';

                        const originalNewlines =
                            typeof sentence.orig === 'string'
                                ? (sentence.orig.match(/\n/g) || []).length
                                : 0;
                        const partNewlines =
                            typeof part === 'string' ? (part.match(/\n/g) || []).length : 0;

                        // Google kadang membuang newline; kembalikan agar baris tetap sejajar.
                        if (originalNewlines > partNewlines) {
                            part += '\n'.repeat(originalNewlines - partNewlines);
                        }

                        if (
                            typeof sentence.orig === 'string' &&
                            sentence.orig.endsWith(' ') &&
                            !part.endsWith(' ') &&
                            !part.endsWith('\n')
                        ) {
                            part += ' ';
                        }

                        romanized += part;
                    });
                }

                if (romanized.trim() !== '') {
                    sendResponse({ success: true, text: romanized });
                } else {
                    sendResponse({ success: false, error: 'Tidak ada hasil transliterasi.' });
                }
            } catch (error) {
                sendResponse({ success: false, error: error.message });
            }
        })
        .catch((error) => {
            sendResponse({ success: false, error: error.message });
        })
        .finally(() => clearTimeout(timeoutId));

    return true;
});
