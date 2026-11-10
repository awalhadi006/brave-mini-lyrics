// Memastikan script hanya berjalan di jendela utama YouTube, bukan di iframe tersembunyi
if (window === window.top) {
    
    // PERBAIKAN BUG KUROMOJI: 
    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function() {
        let args = Array.prototype.slice.call(arguments);
        if (typeof args[1] === 'string') {
            if (args[1].startsWith('chrome-extension:/') && !args[1].startsWith('chrome-extension://')) {
                args[1] = args[1].replace('chrome-extension:/', 'chrome-extension://');
            }
        }
        return originalXHROpen.apply(this, args);
    };

    let pipWindow = null;
    let parsedLyrics = [];
    let videoElement = null;
    let currentHighlightIndex = -1;
    let isSyncedLyrics = false;
    let lyricsTimeOffset = 0;

    console.log("Brave Mini Lyrics: Content script loaded successfully di window utama!");

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "toggle_lyrics") {
            toggleLyricsPiP();
        }
    });

    document.addEventListener('yt-navigate-finish', () => {
        if (pipWindow) {
            setTimeout(() => {
                loadLyricsToPiP(null); 
            }, 1000);
        }
    });

    // ==========================================
    // SISTEM PENYIMPANAN LOKAL (DENGAN AUTO-CLEANUP)
    // ==========================================
    function getVideoId() {
        const watchFlexy = document.querySelector('ytd-watch-flexy');
        if (watchFlexy && watchFlexy.hasAttribute('video-id')) {
            return watchFlexy.getAttribute('video-id');
        }
        
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('v')) return urlParams.get('v');
        
        if (window.location.pathname.startsWith('/shorts/')) {
            return window.location.pathname.split('/')[2];
        }

        return null;
    }

    function getLyricsSettings() {
        const vid = getVideoId();
        if (!vid) return { offset: 0, manualData: null };
        const saved = localStorage.getItem('bml_data_' + vid);
        
        if (saved) {
            try {
                let data = JSON.parse(saved);
                data.lastUpdated = Date.now();
                localStorage.setItem('bml_data_' + vid, JSON.stringify(data));
                return data;
            } catch(e) {}
        }
        return { offset: 0, manualData: null };
    }

    function saveLyricsSettings(offset, manualData = undefined) {
        const vid = getVideoId();
        if (!vid) return;
        
        let saved = localStorage.getItem('bml_data_' + vid);
        let settings = saved ? JSON.parse(saved) : { offset: 0, manualData: null };
        
        if (offset !== null && !isNaN(offset)) {
            settings.offset = parseFloat(offset.toFixed(2));
        }
        
        if (manualData !== undefined) {
            settings.manualData = manualData;
        }
        
        settings.lastUpdated = Date.now();
        localStorage.setItem('bml_data_' + vid, JSON.stringify(settings));
        
        manageStorageLimit();
    }

    function manageStorageLimit() {
        const MAX_SONGS = 200; 
        let savedKeys = [];
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('bml_data_')) {
                savedKeys.push(key);
            }
        }

        if (savedKeys.length > MAX_SONGS) {
            let allData = [];
            for(let key of savedKeys) {
                try {
                    let data = JSON.parse(localStorage.getItem(key));
                    allData.push({ key: key, time: data.lastUpdated || 0 });
                } catch(e) {}
            }

            allData.sort((a, b) => a.time - b.time);
            const itemsToDelete = allData.slice(0, Math.floor(MAX_SONGS * 0.2));
            itemsToDelete.forEach(item => {
                localStorage.removeItem(item.key);
            });
            console.log(`Brave Mini Lyrics: Membersihkan ${itemsToDelete.length} data lirik usang.`);
        }
    }
    // ==========================================

    function parseLrc(lrcString) {
        const lines = lrcString.split('\n');
        const result = [];
        const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

        lines.forEach(line => {
            const match = timeRegex.exec(line);
            if (match) {
                const minutes = parseInt(match[1]);
                const seconds = parseInt(match[2]);
                const milliseconds = parseInt(match[3]);
                const totalTime = minutes * 60 + seconds + (milliseconds / 100);
                const text = line.replace(timeRegex, '').trim();
                result.push({ time: totalTime, text: text || '♪' }); 
            }
        });
        return result;
    }

    function getVideoMetadata() {
        let title = "";
        let artist = "";

        try {
            const ytdApp = document.querySelector('ytd-app');
            const ytdAppData = (ytdApp.__data || 0).data || ytdApp.data || null;
            
            if (ytdAppData) {
                let videoDetails = null;
                if (ytdAppData.player && ytdAppData.player.args && ytdAppData.player.args.raw_player_response) {
                    videoDetails = ytdAppData.player.args.raw_player_response.videoDetails;
                } else if (ytdAppData.playerResponse) {
                    videoDetails = ytdAppData.playerResponse.videoDetails;
                }
                
                if (videoDetails) {
                    title = videoDetails.title || "";
                    artist = videoDetails.author || "";
                }
            }
        } catch (e) {
            console.warn("Brave Mini Lyrics: Gagal membaca ytd-app data", e);
        }

        if (!title) {
            const titleElement = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1');
            const channelElement = document.querySelector('.ytd-channel-name a.yt-simple-endpoint, #owner-name a');
            title = titleElement ? titleElement.textContent.trim() : document.title.replace(" - YouTube", "");
            artist = channelElement ? channelElement.textContent.trim() : "";
        }

        let rawChannelName = artist;
        if (rawChannelName && title.toLowerCase().includes(rawChannelName.toLowerCase())) {
            const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapeRegExp(rawChannelName), 'gi');
            title = title.replace(regex, '');
        }

        title = title.replace(/\[.*?\]|\(.*?\)|【.*?】/g, " "); 
        title = title.replace(/(Official )?(Lyrics? Video|Music Video|Promotion Video|Video|Audio|Live|Cover|Performance)/gi, '');
        
        if (title.includes(" - ")) {
            const parts = title.split(" - ");
            artist = parts[0].trim();
            title = parts.slice(1).join(" - ").trim();
        }

        title = title.replace(/feat\.|ft\./gi, '').trim();
        artist = artist.replace(/-\s*topic/gi, '');
        artist = artist.replace(/VEVO/gi, '');
        artist = artist.trim();

        return { title, artist };
    }

    function updateLyricsHighlight() {
        if (!pipWindow || !videoElement || parsedLyrics.length === 0 || !isSyncedLyrics) return;

        const adjustedTime = videoElement.currentTime - lyricsTimeOffset;
        let activeIndex = -1;

        for (let i = 0; i < parsedLyrics.length; i++) {
            if (adjustedTime >= parsedLyrics[i].time) {
                activeIndex = i;
            } else {
                break;
            }
        }

        if (activeIndex !== -1 && activeIndex !== currentHighlightIndex) {
            currentHighlightIndex = activeIndex;
            const container = pipWindow.document.getElementById('lyrics-container');
            if (container) {
                const lines = container.querySelectorAll('.lyrics-line');
                lines.forEach((line, index) => {
                    if (index === activeIndex) {
                        line.classList.add('active');
                        
                        if (!pipWindow.document.body.classList.contains('compact-mode')) {
                            line.scrollIntoView({
                                behavior: 'smooth',
                                block: 'center'
                            });
                        }
                    } else {
                        line.classList.remove('active');
                    }
                });
            }
        }
    }

    async function loadLyricsToPiP(manualQuery = null, directTrackData = null) {
        if (!pipWindow) return;

        const body = pipWindow.document.body;
        const header = pipWindow.document.querySelector('.header');
        const container = pipWindow.document.getElementById('lyrics-container');
        
        let { title, artist } = getVideoMetadata();
        let fallbackSearchText = manualQuery || (artist + ' ' + title).trim();
        
        const savedSettings = getLyricsSettings();
        if (manualQuery === null && directTrackData === null && savedSettings.manualData) {
            directTrackData = savedSettings.manualData;
        }
        lyricsTimeOffset = savedSettings.offset || 0;

        body.classList.remove('search-active');
        body.classList.remove('showing-results');
        body.classList.add('is-loading');

        if(header && container) {
            if (manualQuery) {
                header.innerHTML = `<p class="title">Mencari Manual...</p><p class="artist">${manualQuery}</p>`;
            } else if (directTrackData) {
                header.innerHTML = `<p class="title">Memuat Lirik Pilihan...</p><p class="artist">${directTrackData.trackName}</p>`;
            } else {
                header.innerHTML = `<p class="title">Mencari Lirik...</p><p class="artist">${artist} • ${title}</p>`;
            }
            container.innerHTML = '<p class="loading">Menghubungkan ke database lirik...</p>';
            container.style.padding = '45vh 10px'; 
        }

        currentHighlightIndex = -1;
        parsedLyrics = [];
        isSyncedLyrics = false;
        
        if (videoElement) {
            videoElement.removeEventListener('timeupdate', updateLyricsHighlight);
        }
        videoElement = document.querySelector('#movie_player video[src], video[src]');

        // Komponen Player Controls (UI)
        const isPaused = videoElement ? videoElement.paused : false;
        const playIcon = isPaused ? '▶' : '⏸';
        const playerControlsHTML = `
            <div class="player-controls">
                <button class="ctrl-btn" id="ctrl-prev" title="Video Sebelumnya">⏮</button>
                <button class="ctrl-btn" id="ctrl-pp" title="Play / Pause">${playIcon}</button>
                <button class="ctrl-btn" id="ctrl-next" title="Video Selanjutnya">⏭</button>
            </div>
        `;

        const searchLRCLIB = async (query) => {
            try {
                const cleanQuery = query.replace(/\s+/g, ' ').trim();
                if (!cleanQuery) return [];
                const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanQuery)}`);
                if (!response.ok) return [];
                return await response.json();
            } catch (error) {
                return [];
            }
        };

        let lyricsData = null;
        let searchResults = [];

        if (directTrackData) {
            lyricsData = {
                found: true,
                isSynced: !!directTrackData.syncedLyrics,
                trackName: directTrackData.trackName,
                artistName: directTrackData.artistName,
                lrc: directTrackData.syncedLyrics,
                text: directTrackData.plainLyrics
            };
        } else {
            if (manualQuery) {
                searchResults = await searchLRCLIB(manualQuery);
                searchResults = searchResults.filter(t => t.syncedLyrics || t.plainLyrics);
            } else {
                const trySearch = async (q) => {
                    let res = await searchLRCLIB(q);
                    return res.filter(t => t.syncedLyrics || t.plainLyrics);
                };

                searchResults = await trySearch(`${title} ${artist}`);
                
                if (searchResults.length === 0) {
                    searchResults = await trySearch(title);
                }

                if (searchResults.length === 0 && (title.includes('|') || title.includes('~'))) {
                    const parts = title.split(/\||~/).map(p => p.trim());
                    for (let i = parts.length - 1; i >= 0; i--) {
                        if (parts[i].length > 2) { 
                            searchResults = await trySearch(parts[i]);
                            if (searchResults.length > 0) break;
                        }
                    }
                }

                if (searchResults.length > 0) {
                    const best = searchResults.find(t => t.syncedLyrics) || searchResults[0];
                    if (best) {
                        lyricsData = {
                            found: true,
                            isSynced: !!best.syncedLyrics,
                            trackName: best.trackName,
                            artistName: best.artistName,
                            lrc: best.syncedLyrics,
                            text: best.plainLyrics
                        };
                    }
                }
            }
        }

        const setupSearchEvents = () => {
            const btnToggle = pipWindow.document.getElementById('btn-search-toggle');
            const btnCancel = pipWindow.document.getElementById('btn-search-cancel');
            const searchBox = pipWindow.document.getElementById('search-box');
            const headerInfo = pipWindow.document.getElementById('header-info');
            const searchForm = pipWindow.document.getElementById('search-form');
            const searchInput = pipWindow.document.getElementById('search-input');

            if (btnToggle) {
                btnToggle.addEventListener('click', () => {
                    headerInfo.style.display = 'none';
                    searchBox.style.display = 'block';
                    searchInput.focus();
                    searchInput.select();
                    body.classList.add('search-active');
                });
            }
            if (btnCancel) {
                btnCancel.addEventListener('click', () => {
                    searchBox.style.display = 'none';
                    headerInfo.style.display = 'block';
                    body.classList.remove('search-active');
                    searchInput.value = fallbackSearchText;
                });
            }
            if (searchForm) {
                searchForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    const query = searchInput.value.trim();
                    if (query) {
                        loadLyricsToPiP(query); 
                    }
                });
            }
        };

        const setupPlayerControls = () => {
            const btnPrev = pipWindow.document.getElementById('ctrl-prev');
            const btnPp = pipWindow.document.getElementById('ctrl-pp');
            const btnNext = pipWindow.document.getElementById('ctrl-next');

            if (btnPrev) {
                btnPrev.addEventListener('click', () => {
                    // Coba cari tombol Previous Playlist
                    const prevBtn = document.querySelector('.ytp-prev-button');
                    if (prevBtn && window.getComputedStyle(prevBtn).display !== 'none' && prevBtn.getAttribute('aria-disabled') !== 'true') {
                        prevBtn.click();
                    } else {
                        // Jika tidak di playlist, mundur ke history halaman sebelumnya
                        window.history.back();
                    }
                });
            }
            if (btnNext) {
                btnNext.addEventListener('click', () => {
                    // Cari tombol Next bawaan YouTube
                    const nextBtn = document.querySelector('.ytp-next-button');
                    if (nextBtn) {
                        nextBtn.click();
                    }
                });
            }
            if (btnPp) {
                btnPp.addEventListener('click', () => {
                    if (videoElement) {
                        if (videoElement.paused) videoElement.play();
                        else videoElement.pause();
                    }
                });
            }

            const updatePlayPauseIcon = () => {
                if (btnPp && videoElement) {
                    btnPp.textContent = videoElement.paused ? '▶' : '⏸';
                }
            };

            if (videoElement) {
                videoElement.addEventListener('play', updatePlayPauseIcon);
                videoElement.addEventListener('pause', updatePlayPauseIcon);
            }
        };

        const setupWindowControls = () => {
            const btnMaximize = pipWindow.document.getElementById('btn-maximize');
            if (btnMaximize) {
                btnMaximize.addEventListener('click', () => {
                    if (!pipWindow.isMaximized) {
                        // Simpan ukuran aslinya
                        pipWindow.originalWidth = pipWindow.outerWidth;
                        pipWindow.originalHeight = pipWindow.outerHeight;
                        
                        try {
                            // Pindahkan ke pojok kiri atas dan rentangkan ke seluruh resolusi layar
                            pipWindow.moveTo(0, 0);
                            pipWindow.resizeTo(window.screen.availWidth, window.screen.availHeight);
                        } catch (e) {
                            console.warn("Brave Mini Lyrics: Gagal me-resize window (terhalang limitasi browser).", e);
                        }
                        
                        pipWindow.isMaximized = true;
                        btnMaximize.textContent = "🗗"; // Icon perkecil
                        btnMaximize.title = "Kembalikan Ukuran";
                    } else {
                        try {
                            // Kembalikan ke ukuran standar atau ukuran aslinya
                            const w = pipWindow.originalWidth || 350;
                            const h = pipWindow.originalHeight || 500;
                            pipWindow.resizeTo(w, h);
                            // Coba letakkan agak ke tengah/kanan
                            pipWindow.moveTo(window.screen.availWidth - w - 50, 50);
                        } catch (e) {
                            console.warn("Brave Mini Lyrics: Gagal me-resize window.", e);
                        }
                        
                        pipWindow.isMaximized = false;
                        btnMaximize.textContent = "⛶"; // Icon perbesar
                        btnMaximize.title = "Layar Penuh";
                    }
                });
            }
        };

        if (lyricsData && lyricsData.found) {
            isSyncedLyrics = lyricsData.isSynced;
            const syncBadge = isSyncedLyrics ? 
                '<span class="badge badge-green">✔ Sinkron</span>' : 
                '<span class="badge badge-yellow">⚠ Statis</span>';
            
            const offsetDisplayStr = (lyricsTimeOffset > 0 ? '+' : '') + lyricsTimeOffset.toFixed(1) + 's';

            header.innerHTML = `
                <div id="header-info">
                    <p class="title">${lyricsData.trackName}</p>
                    <p class="artist">${lyricsData.artistName} ${syncBadge}</p>
                    ${playerControlsHTML}
                    <div class="sync-controls">
                        ${isSyncedLyrics ? `
                        <button class="sync-btn" id="sync-minus" title="Maju (Lirik Lebih Cepat)">-0.1s</button>
                        <span class="sync-display" id="sync-val">${offsetDisplayStr}</span>
                        <button class="sync-btn" id="sync-plus" title="Tunda (Lirik Lebih Lambat)">+0.1s</button>
                        <button class="sync-btn mode-btn karaoke-toggle" id="mode-toggle" title="Mode Karaoke/Ringkas">🎤</button>
                        ` : ''}
                        <button class="sync-btn latin-toggle" id="btn-latin" style="margin-left: 5px;" title="Ubah lirik Jepang/Korea ke huruf Latin">🔤</button>
                        <button class="sync-btn" id="btn-search-toggle" style="margin-left: 5px;" title="Cari Lirik Manual">🔍</button>
                        <button class="sync-btn" id="btn-maximize" style="margin-left: 5px;" title="Layar Penuh">⛶</button>
                    </div>
                    ${isSyncedLyrics ? `
                    <div style="font-size: 0.65rem; color: #94a3b8; margin-top: 5px;">
                        Klik Kiri: Lompat lagu | Kanan: Kalibrasi instan
                    </div>
                    ` : ''}
                </div>
                <div id="search-box" style="display: none; margin-top: 8px;">
                    <form id="search-form" style="display: flex; gap: 5px; justify-content: center; align-items: center;">
                        <input type="text" id="search-input" class="search-input" placeholder="Nama Artis - Judul Lagu" value="${fallbackSearchText}">
                        <button type="submit" class="search-btn-submit">Cari</button>
                        <button type="button" class="search-btn-cancel" id="btn-search-cancel">Batal</button>
                    </form>
                </div>
            `;
            
            container.innerHTML = ''; 
            body.classList.remove('is-loading'); 
            setupSearchEvents();
            setupPlayerControls();
            setupWindowControls(); // Panggil fungsi kontrol window di sini
            
            // -------------------------------------------------------------
            // STATE MANAGEMENT & KUROSHIRO LOKAL
            // -------------------------------------------------------------
            let isLatinMode = false;
            let originalLyricsArray = [];
            let latinLyricsArray = [];
            let isFullyTranslated = false;
            let kuroshiroInstance = null; 

            const btnLatin = pipWindow.document.getElementById('btn-latin');
            if (btnLatin) {
                btnLatin.addEventListener('click', async () => {
                    const linesElements = Array.from(container.querySelectorAll('.lyrics-line'));
                    
                    if (originalLyricsArray.length === 0) {
                        originalLyricsArray = linesElements.map(p => p.textContent);
                    }

                    // TOGGLE OFF
                    if (isLatinMode) {
                        isLatinMode = false;
                        btnLatin.classList.remove('active-latin'); 
                        btnLatin.textContent = "🔤"; 

                        linesElements.forEach((p, index) => {
                            const originalText = originalLyricsArray[index] || '♪';
                            p.textContent = originalText;
                            if (isSyncedLyrics && parsedLyrics[index]) {
                                parsedLyrics[index].text = originalText;
                            }
                        });
                        return; 
                    }

                    // TOGGLE ON DARI CACHE
                    if (isFullyTranslated && latinLyricsArray.length > 0) {
                        isLatinMode = true;
                        btnLatin.classList.add('active-latin'); 
                        btnLatin.textContent = "✔"; 

                        linesElements.forEach((p, index) => {
                            const latinText = latinLyricsArray[index] || '♪';
                            p.textContent = latinText;
                            if (isSyncedLyrics && parsedLyrics[index]) {
                                parsedLyrics[index].text = latinText;
                            }
                        });
                        return; 
                    }

                    btnLatin.disabled = true;

                    try {
                        if (!kuroshiroInstance) {
                            btnLatin.textContent = "⏳ Kamus...";
                            kuroshiroInstance = new Kuroshiro.default();
                            const dictPath = chrome.runtime.getURL("dict/");
                            await kuroshiroInstance.init(new KuromojiAnalyzer({ dictPath: dictPath }));
                        }

                        btnLatin.textContent = "⏳...";

                        let indicesToTranslate = [];
                        originalLyricsArray.forEach((text, i) => {
                            let trimmed = text.trim();
                            if (trimmed !== '' && trimmed !== '♪') {
                                indicesToTranslate.push(i);
                            }
                        });

                        const convertToRomaji = async (text) => {
                            try {
                                let result = await kuroshiroInstance.convert(text, {
                                    to: "romaji",
                                    mode: "spaced",
                                    romajiSystem: "hepburn"
                                });
                                
                                result = result.replace(/\n/g, ' ').trim()
                                    .replace(/ō/g, 'ou').replace(/Ō/g, 'Ou')
                                    .replace(/ū/g, 'uu').replace(/Ū/g, 'Uu')
                                    .replace(/ā/g, 'aa').replace(/Ā/g, 'Aa')
                                    .replace(/ī/g, 'ii').replace(/Ī/g, 'Ii')
                                    .replace(/ē/g, 'ee').replace(/Ē/g, 'Ee')
                                    .replace(/tch/g, 'cch'); 
                                    
                                return result;
                            } catch (error) {
                                return text;
                            }
                        };

                        const results = await Promise.all(indicesToTranslate.map(i => convertToRomaji(originalLyricsArray[i])));
                        
                        latinLyricsArray = [...originalLyricsArray];
                        
                        results.forEach((translatedText, idx) => {
                            let origIndex = indicesToTranslate[idx];
                            latinLyricsArray[origIndex] = translatedText;
                        });

                        isFullyTranslated = true;
                        isLatinMode = true;
                        btnLatin.classList.add('active-latin');
                        btnLatin.textContent = "✔";
                        btnLatin.disabled = false;
                        
                        linesElements.forEach((p, index) => {
                            const latinText = latinLyricsArray[index] || '♪';
                            p.textContent = latinText;
                            if (isSyncedLyrics && parsedLyrics[index]) {
                                parsedLyrics[index].text = latinText;
                            }
                        });

                    } catch (error) {
                        console.error("Gagal menjalankan Kuroshiro Lokal:", error);
                        btnLatin.textContent = "❌";
                        isFullyTranslated = false;
                        latinLyricsArray = [];
                        
                        setTimeout(() => { 
                            btnLatin.textContent = "🔤"; 
                            btnLatin.disabled = false;
                        }, 2000);
                    }
                });
            }

            if (isSyncedLyrics) {
                const btnMinus = pipWindow.document.getElementById('sync-minus');
                const btnPlus = pipWindow.document.getElementById('sync-plus');
                const syncVal = pipWindow.document.getElementById('sync-val');
                const btnMode = pipWindow.document.getElementById('mode-toggle');
                
                btnMode.addEventListener('click', () => {
                    body.classList.toggle('compact-mode');
                    currentHighlightIndex = -1;
                    updateLyricsHighlight(); 
                    setTimeout(() => {
                        currentHighlightIndex = -1; 
                        updateLyricsHighlight(); 
                    }, 350); 
                });

                const updateSyncDisplay = () => {
                    syncVal.textContent = (lyricsTimeOffset > 0 ? '+' : '') + lyricsTimeOffset.toFixed(1) + 's';
                    updateLyricsHighlight(); 
                };

                btnMinus.addEventListener('click', () => { 
                    lyricsTimeOffset -= 0.1; 
                    updateSyncDisplay(); 
                    saveLyricsSettings(lyricsTimeOffset);
                });
                btnPlus.addEventListener('click', () => { 
                    lyricsTimeOffset += 0.1; 
                    updateSyncDisplay(); 
                    saveLyricsSettings(lyricsTimeOffset);
                });

                parsedLyrics = parseLrc(lyricsData.lrc);
                parsedLyrics.forEach((line, index) => {
                    const p = pipWindow.document.createElement('p');
                    p.className = 'lyrics-line';
                    p.id = `line-${index}`;
                    p.textContent = line.text;
                    
                    p.addEventListener('click', () => {
                        if (videoElement) {
                            videoElement.currentTime = line.time + lyricsTimeOffset;
                        }
                    });

                    p.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        if (videoElement) {
                            lyricsTimeOffset = videoElement.currentTime - line.time;
                            updateSyncDisplay();
                            saveLyricsSettings(lyricsTimeOffset);
                        }
                    });

                    container.appendChild(p);
                });

                if(videoElement) {
                    videoElement.addEventListener('timeupdate', updateLyricsHighlight);
                    updateLyricsHighlight(); 
                }
            } else {
                const lines = lyricsData.text.split('\n');
                lines.forEach((line) => {
                    const p = pipWindow.document.createElement('p');
                    p.className = 'lyrics-line static-line';
                    p.textContent = line || ' ';
                    container.appendChild(p);
                });
            }

        } else if (searchResults.length > 0 && manualQuery) {
            body.classList.remove('is-loading');
            body.classList.add('showing-results'); 

            header.innerHTML = `
                <div id="header-info">
                    <p class="title">Hasil Pencarian</p>
                    <p class="artist">${searchResults.length} versi lirik ditemukan</p>
                    ${playerControlsHTML}
                    <div class="sync-controls">
                        <button class="sync-btn" id="btn-search-toggle" style="margin-left: 0;" title="Cari Lirik Manual">🔍 Ulangi Pencarian</button>
                        <button class="sync-btn" id="btn-maximize" style="margin-left: 5px;" title="Layar Penuh">⛶</button>
                    </div>
                </div>
                <div id="search-box" style="display: none; margin-top: 8px;">
                    <form id="search-form" style="display: flex; gap: 5px; justify-content: center; align-items: center;">
                        <input type="text" id="search-input" class="search-input" placeholder="Nama Artis - Judul Lagu" value="${fallbackSearchText}">
                        <button type="submit" class="search-btn-submit">Cari</button>
                        <button type="button" class="search-btn-cancel" id="btn-search-cancel">Batal</button>
                    </form>
                </div>
            `;
            
            container.innerHTML = '';
            container.style.padding = '125px 10px 20px 10px'; 
            setupSearchEvents();
            setupPlayerControls();
            setupWindowControls(); // Panggil fungsi kontrol window di sini

            const listWrapper = pipWindow.document.createElement('div');
            listWrapper.className = 'search-results-list';

            searchResults.forEach(track => {
                const div = pipWindow.document.createElement('div');
                div.className = 'search-result-item';
                
                const isSync = !!track.syncedLyrics;
                const badge = isSync ? '<span class="badge badge-green">Sinkron</span>' : '<span class="badge badge-yellow">Statis</span>';
                const duration = track.duration ? ` • ${Math.floor(track.duration / 60)}:${(track.duration % 60).toString().padStart(2, '0')}` : '';

                div.innerHTML = `
                    <div class="sr-info">
                        <div class="sr-title">${track.trackName}</div>
                        <div class="sr-artist">${track.artistName} ${duration}</div>
                    </div>
                    <div class="sr-badge">${badge}</div>
                `;

                div.addEventListener('click', () => {
                    saveLyricsSettings(0, track);
                    loadLyricsToPiP(null, track);
                });

                listWrapper.appendChild(div);
            });

            container.appendChild(listWrapper);

        } else {
            header.innerHTML = `
                <div id="header-info">
                    <p class="title">Lirik tidak ditemukan :(</p>
                    <p class="artist" style="color: #ef4444;">${fallbackSearchText}</p>
                    ${playerControlsHTML}
                    <div class="sync-controls">
                        <button class="sync-btn mode-btn" id="btn-search-toggle" style="margin-left:0;" title="Cari Manual">🔍 Cari Manual Lirik</button>
                        <button class="sync-btn" id="btn-maximize" style="margin-left: 5px;" title="Layar Penuh">⛶</button>
                    </div>
                </div>
                <div id="search-box" style="display: none; margin-top: 8px;">
                    <form id="search-form" style="display: flex; gap: 5px; justify-content: center; align-items: center;">
                        <input type="text" id="search-input" class="search-input" placeholder="Nama Artis - Judul Lagu" value="${fallbackSearchText}">
                        <button type="submit" class="search-btn-submit">Cari</button>
                        <button type="button" class="search-btn-cancel" id="btn-search-cancel">Batal</button>
                    </form>
                </div>
            `;
            container.innerHTML = '<p class="loading" style="color: #ef4444;">Maaf, lirik tidak tersedia di database. <br><br>Coba gunakan tombol <b>Cari Manual</b> di atas dan ketik spesifik (Contoh: "Dewa 19 Kangen")</p>';
            body.classList.add('is-loading'); 
            setupSearchEvents();
            setupPlayerControls();
            setupWindowControls(); // Panggil fungsi kontrol window di sini
        }
    }

    async function toggleLyricsPiP() {
        if (pipWindow) {
            pipWindow.close();
            return;
        }

        if (!('documentPictureInPicture' in window)) {
            alert("Browser Anda belum mendukung Document Picture-in-Picture.");
            return;
        }

        videoElement = document.querySelector('#movie_player video[src], video[src]');
        if (!videoElement) {
            alert("Tidak ada video yang sedang diputar!");
            return;
        }
        
        try {
            pipWindow = await window.documentPictureInPicture.requestWindow({
                width: 350,
                height: 500
            });

            const style = pipWindow.document.createElement('style');
            style.textContent = `
                body {
                    margin: 0; background-color: #0f172a; color: #f8fafc;
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    height: 100vh; overflow: hidden; position: relative;
                    transition: background-color 0.3s;
                }
                
                .header {
                    position: absolute; top: 0; left: 0; right: 0;
                    text-align: center; box-sizing: border-box;
                    padding: 15px 15px 35px 15px; 
                    background: linear-gradient(to bottom, rgba(15,23,42,0.95) 65%, rgba(15,23,42,0));
                    opacity: 0; transition: opacity 0.4s ease; z-index: 10;
                    pointer-events: none; 
                }
                
                body.is-loading .header, body:hover .header, body.search-active .header, body.showing-results .header {
                    opacity: 1; pointer-events: auto; 
                }

                .title { font-size: 1.1rem; font-weight: bold; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
                .artist { font-size: 0.85rem; color: #94a3b8; margin: 8px 0 0 0; display: flex; align-items: center; justify-content: center; gap: 8px;}
                .badge { font-size: 0.7rem; padding: 2px 6px; border-radius: 12px; font-weight: bold;}
                .badge-green { background: #064e3b; color: #34d399; }
                .badge-yellow { background: #78350f; color: #fbbf24; }
                
                /* Player Controls UI */
                .player-controls {
                    display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 8px; margin-bottom: 4px;
                }
                .ctrl-btn {
                    background: rgba(255, 255, 255, 0.1); color: #f8fafc; border: none;
                    width: 26px; height: 26px; border-radius: 50%; cursor: pointer; font-size: 0.75rem;
                    transition: all 0.2s; display: flex; align-items: center; justify-content: center;
                }
                .ctrl-btn:hover { background: rgba(255, 255, 255, 0.25); transform: scale(1.1); }
                .ctrl-btn:active { transform: scale(0.9); }

                .sync-controls {
                    display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 5px;
                }
                .sync-btn {
                    background: #334155; color: #f8fafc; border: 1px solid #475569; 
                    padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 0.75rem;
                    transition: all 0.2s; font-weight: bold; display: flex; align-items: center;
                }
                .sync-btn.mode-btn { margin-left: 5px; }
                .sync-btn:hover { background: #475569; border-color: #64748b; }
                .sync-btn:active { transform: scale(0.95); }
                .sync-display { font-size: 0.85rem; font-family: monospace; color: #cbd5e1; width: 45px; text-align: center; font-weight: bold;}

                /* State Tombol Aktif (Berwarna Biru) */
                body.compact-mode .sync-btn.karaoke-toggle { background: #2563eb; border-color: #3b82f6; }
                body.compact-mode .sync-btn.karaoke-toggle:hover { background: #3b82f6; }
                
                .sync-btn.active-latin { background: #2563eb; border-color: #3b82f6; }
                .sync-btn.active-latin:hover { background: #3b82f6; }

                /* ================= CSS FORM PENCARIAN ================= */
                .search-input {
                    background: rgba(30, 41, 59, 0.9); border: 1px solid #475569; color: white;
                    padding: 6px 8px; border-radius: 6px; font-size: 0.85rem; width: 60%;
                    outline: none; transition: border-color 0.2s; font-family: inherit;
                }
                .search-input:focus { border-color: #3b82f6; }
                .search-btn-submit {
                    background: #10b981; color: white; border: none; padding: 6px 12px;
                    border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: bold;
                }
                .search-btn-submit:hover { background: #059669; }
                .search-btn-cancel {
                    background: #64748b; color: white; border: none; padding: 6px 12px;
                    border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: bold;
                }
                .search-btn-cancel:hover { background: #475569; }

                /* ================= CSS DAFTAR HASIL PENCARIAN ================= */
                .search-results-list {
                    display: flex; flex-direction: column; gap: 8px;
                }
                .search-result-item {
                    background: rgba(30, 41, 59, 0.85); border: 1px solid #334155;
                    border-radius: 8px; padding: 12px; display: flex; 
                    justify-content: space-between; align-items: center; cursor: pointer;
                    text-align: left; transition: all 0.2s;
                }
                .search-result-item:hover {
                    background: rgba(59, 130, 246, 0.2); border-color: #3b82f6; transform: scale(1.02);
                }
                .sr-info { flex: 1; overflow: hidden; }
                .sr-title { font-weight: bold; font-size: 1rem; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .sr-artist { font-size: 0.8rem; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: margin-top: 4px;}
                .sr-badge { margin-left: 10px; flex-shrink: 0; }

                /* ================= CSS CONTAINER LIRIK UTAMA ================= */
                #lyrics-container {
                    height: 100vh; overflow-y: auto; text-align: center; scroll-behavior: smooth;
                    box-sizing: border-box; padding: 45vh 10px; 
                }
                
                .lyrics-line {
                    color: #64748b; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    margin: 18px 0; font-size: 1.15rem; line-height: 1.5; transform-origin: center;
                    cursor: pointer;
                }
                .lyrics-line:hover { color: #cbd5e1; }
                .static-line { color: #cbd5e1; cursor: default; }
                .lyrics-line.active {
                    color: #10b981; font-size: 1.4rem; font-weight: bold; 
                    text-shadow: 0 0 15px rgba(16, 185, 129, 0.4);
                    transform: scale(1.05);
                }
                .loading { color: #f59e0b; text-align: center; margin-top: 50px; font-style: italic;}
                
                ::-webkit-scrollbar { width: 4px; }
                ::-webkit-scrollbar-track { background: transparent; }
                ::-webkit-scrollbar-thumb { background: #475569; border-radius: 10px; }

                /* MODE FOKUS (KARAOKE BAR) */
                body.compact-mode {
                    background-color: rgba(0, 0, 0, 0.90); 
                }
                
                body.compact-mode #lyrics-container {
                    position: relative; 
                    padding: 0 !important; 
                    overflow: hidden; 
                    display: block; 
                }
                
                body.compact-mode .lyrics-line {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    width: 90%; 
                    margin: 0;
                    transform: translate(-50%, -50%) scale(0.9);
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.4s ease, transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                }
                
                body.compact-mode .lyrics-line.active {
                    opacity: 1;
                    transform: translate(-50%, -50%) scale(1.05);
                    pointer-events: auto;
                }
                
                body.compact-mode:hover .header {
                    opacity: 0.9;
                }
            `;
            pipWindow.document.head.appendChild(style);

            const header = pipWindow.document.createElement('div');
            header.className = 'header';
            pipWindow.document.body.appendChild(header);

            const container = pipWindow.document.createElement('div');
            container.id = 'lyrics-container';
            pipWindow.document.body.appendChild(container);

            pipWindow.addEventListener("pagehide", () => {
                if (videoElement) {
                    videoElement.removeEventListener('timeupdate', updateLyricsHighlight);
                }
                pipWindow = null;
                parsedLyrics = [];
            });

            loadLyricsToPiP(null);

        } catch (error) {
            console.error('Brave Mini Lyrics: Gagal membuka PiP Window:', error);
        }
    }
}