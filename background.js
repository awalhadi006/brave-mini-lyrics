chrome.action.onClicked.addListener((tab) => {
    chrome.tabs.sendMessage(tab.id, { action: "toggle_lyrics" });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "romanize") {
        // "Cheat Code" &dj=1 memaksa Google membalas dengan struktur JSON Object yang rapi
        const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=rm&dj=1';
        
        fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `q=${encodeURIComponent(request.text)}`
        })
        .then(response => response.json())
        .then(data => {
            try {
                let romanizedStr = "";
                
                if (data && data.sentences) {
                    data.sentences.forEach(s => {
                        // Ambil teks translit latin (jika ada), kalau tidak ada ambil teks aslinya
                        let part = s.src_translit || s.orig || "";
                        
                        // LOGIKA ALGORITMA PENYELAMAT ARRAY (Mencegah Bug Paragraf Raksasa):
                        // Hitung jumlah karakter enter (\n) di teks asli vs teks hasil
                        let origNewlines = (s.orig && typeof s.orig === 'string') ? (s.orig.match(/\n/g) || []).length : 0;
                        let partNewlines = (typeof part === 'string') ? (part.match(/\n/g) || []).length : 0;
                        
                        // Jika Google membuang karakter Enter (\n), paksa tambahkan kembali di akhir
                        // Ini menjamin lirik tidak akan tergabung menjadi 1 paragraf panjang!
                        if (origNewlines > partNewlines) {
                            part += '\n'.repeat(origNewlines - partNewlines);
                        }
                        
                        // Tambahkan spasi jika Google membuang spasi pemisah antar kalimat
                        if (s.orig && s.orig.endsWith(' ') && !part.endsWith(' ') && !part.endsWith('\n')) {
                            part += ' ';
                        }

                        romanizedStr += part;
                    });
                }

                if (romanizedStr.trim() !== "") {
                    sendResponse({ success: true, text: romanizedStr });
                } else {
                    sendResponse({ success: false, error: "Teks tidak memiliki format huruf Latin." });
                }
            } catch (e) {
                sendResponse({ success: false, error: e.message });
            }
        })
        .catch(err => {
            sendResponse({ success: false, error: err.message });
        });

        return true; 
    }
});