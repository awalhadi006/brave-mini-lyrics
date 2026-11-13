#!/usr/bin/env node
'use strict';

/**
 * Smoke test E2E untuk jendela lirik.
 *
 * Menjalankan browser Chromium terpisah (profil sementara) dengan audio dimatikan,
 * membuka YouTube, membuka jendela PiP lewat action ekstensi, lalu memeriksa
 * judul, artis, dan jumlah baris lirik.
 *
 * Pemakaian:
 *   node scripts/e2e.js [url]
 *
 * Variabel lingkungan:
 *   BML_BROWSER    path ke Brave/Chromium (opsional)
 *   BML_EXTENSION  folder ekstensi (default: root repo)
 *   BML_PORT       port remote debugging (default: 9370)
 *   BML_HEADFUL=1  tampilkan jendela browser
 *   BML_EXPECT_TITLE  teks yang harus ada di judul lirik
 *
 * Catatan: instance ini memakai --mute-audio dan profil sendiri, jadi Brave
 * yang sedang dipakai tidak ikut ter-mute atau terganggu.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXTENSION_DIR = path.resolve(process.env.BML_EXTENSION || path.join(__dirname, '..'));
const PORT = Number(process.env.BML_PORT) || 9370;
const HEADFUL = process.env.BML_HEADFUL === '1';
const EXPECT_TITLE = process.env.BML_EXPECT_TITLE || '';
const TARGET_URL = process.argv[2] || 'https://www.youtube.com/watch?v=Dk4qOa4ivIM';
const PROFILE_DIR = path.join(os.tmpdir(), 'bml-e2e-' + process.pid);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function browserCandidates() {
    if (process.env.BML_BROWSER) return [process.env.BML_BROWSER];

    if (process.platform === 'win32') {
        const pf = process.env.ProgramFiles || 'C:\\Program Files';
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const local = process.env.LOCALAPPDATA || '';
        return [
            path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        ];
    }

    if (process.platform === 'darwin') {
        return [
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ];
    }

    return ['brave-browser', 'brave', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
}

function findBrowser() {
    for (const candidate of browserCandidates()) {
        if (candidate.includes(path.sep) || /^[A-Za-z]:/.test(candidate)) {
            if (fs.existsSync(candidate)) return candidate;
            continue;
        }
        const found = spawnSync('which', [candidate], { encoding: 'utf8' });
        if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
    }
    return null;
}

function connect(url) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const pending = new Map();
        let nextId = 0;

        socket.addEventListener('open', () => {
            resolve({
                send(method, params = {}) {
                    return new Promise((res) => {
                        const id = ++nextId;
                        pending.set(id, res);
                        socket.send(JSON.stringify({ id, method, params }));
                    });
                },
                close() {
                    try {
                        socket.close();
                    } catch (error) {
                        // abaikan
                    }
                }
            });
        });

        socket.addEventListener('message', (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (error) {
                return;
            }
            if (message.id && pending.has(message.id)) {
                const done = pending.get(message.id);
                pending.delete(message.id);
                done(message.result || message.error);
            }
        });

        socket.addEventListener('error', () => reject(new Error('Gagal terhubung ke DevTools: ' + url)));
    });
}

async function listPages() {
    const response = await fetch('http://127.0.0.1:' + PORT + '/json');
    return await response.json();
}

async function waitForDevTools(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const response = await fetch('http://127.0.0.1:' + PORT + '/json/version');
            if (response.ok) return await response.json();
        } catch (error) {
            // browser belum siap
        }
        await sleep(300);
    }
    throw new Error('DevTools tidak siap di port ' + PORT);
}

async function findExtensionId(browser, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const targets = await browser.send('Target.getTargets', {});
        const infos = (targets && targets.targetInfos) || [];
        const worker = infos.find(
            (target) => /^chrome-extension:\/\//.test(target.url || '') && /background\.js$/.test(target.url || '')
        );
        if (worker) return new URL(worker.url).host;

        const pages = await listPages();
        const anyExtension = pages.find((page) => /^chrome-extension:\/\//.test(page.url || ''));
        if (anyExtension) return new URL(anyExtension.url).host;

        await sleep(300);
    }
    throw new Error('Service worker ekstensi tidak ditemukan');
}

async function findYouTubeTab(browser, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const targets = await browser.send('Target.getTargets', { filter: [{ type: 'tab' }] });
        const infos = (targets && targets.targetInfos) || [];
        const tab = infos.find((target) => /youtube\.com/.test(target.url || ''));
        if (tab) return tab;
        await sleep(300);
    }
    throw new Error('Tab YouTube tidak ditemukan');
}

async function waitForPipPage(knownIds, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const pages = await listPages();
        const pip = pages.find(
            (page) => page.type === 'page' && page.url === 'about:blank' && !knownIds.has(page.id)
        );
        if (pip) return pip;
        await sleep(400);
    }
    throw new Error('Jendela PiP tidak muncul');
}

async function waitForTabReady(browser, tab, timeoutMs) {
    const pages = await listPages();
    const page = pages.find((item) => item.type === 'page' && /youtube\.com/.test(item.url || ''));
    if (!page || !page.webSocketDebuggerUrl) {
        throw new Error('Tab YouTube tidak bisa dihubungkan');
    }

    const conn = await connect(page.webSocketDebuggerUrl);
    const tabEval = evaluate(conn);
    const started = Date.now();
    try {
        while (Date.now() - started < timeoutMs) {
            const state = JSON.parse(
                await tabEval(`JSON.stringify({
                    ready: document.readyState,
                    video: !!document.querySelector('#movie_player video')
                })`)
            );
            // 'interactive' sudah cukup: video & player sudah ada, dan tahap
            // berikutnya punya timeout sendiri. Sebagian jaringan lambat tidak
            // pernah mencapai 'complete' dalam 30 detik.
            if (state.ready !== 'loading' && state.video) return conn;
            await sleep(400);
        }
        throw new Error('Video YouTube tidak siap');
    } catch (error) {
        conn.close();
        throw error;
    }
}

function evaluate(conn) {
    return async (expression) => {
        const result = await conn.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true
        });
        if (result && result.exceptionDetails) {
            const detail = result.exceptionDetails.exception || {};
            throw new Error(detail.description || result.exceptionDetails.text || 'Evaluasi gagal');
        }
        return result && result.result ? result.result.value : undefined;
    };
}

async function waitForLyrics(pipEval, timeoutMs) {
    const started = Date.now();
    let state = null;
    while (Date.now() - started < timeoutMs) {
        state = JSON.parse(
            await pipEval(`JSON.stringify({
                title: (document.querySelector('.title') || {}).textContent || '',
                artist: (document.querySelector('.artist') || {}).textContent || '',
                lines: document.querySelectorAll('.lyrics-line').length,
                badge: (document.querySelector('.badge') || {}).textContent || '',
                theme: document.body.dataset.theme || '',
                status: (document.querySelector('#loading-status') || {}).textContent || ''
            })`)
        );
        if (state.lines > 0) return state;
        await sleep(500);
    }
    return state;
}

function cleanup(child) {
    try {
        if (child && !child.killed) {
            if (process.platform === 'win32') {
                spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            } else {
                child.kill('SIGKILL');
            }
        }
    } catch (error) {
        // abaikan
    }
    try {
        fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) {
        // abaikan
    }
}

(async () => {
    if (typeof WebSocket === 'undefined') {
        console.error('Butuh Node.js 22+ (global WebSocket).');
        process.exit(1);
    }

    const browserPath = findBrowser();
    if (!browserPath) {
        console.error('Browser Chromium tidak ditemukan. Set BML_BROWSER ke path Brave/Chromium.');
        process.exit(1);
    }
    if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
        console.error('manifest.json tidak ditemukan di ' + EXTENSION_DIR);
        process.exit(1);
    }

    fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });

    const args = [
        HEADFUL ? '--window-size=480,720' : '--headless=new',
        '--mute-audio',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-breakpad',
        '--disable-dev-shm-usage',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
        '--autoplay-policy=no-user-gesture-required',
        '--remote-debugging-port=' + PORT,
        '--user-data-dir=' + PROFILE_DIR,
        '--load-extension=' + EXTENSION_DIR,
        '--disable-extensions-except=' + EXTENSION_DIR,
        TARGET_URL
    ];

    console.log('Browser : ' + browserPath);
    console.log('URL     : ' + TARGET_URL);
    console.log('Profil  : ' + PROFILE_DIR + ' (audio dimatikan)');

    const child = spawn(browserPath, args, { stdio: 'ignore' });
    let browser = null;
    let pipConn = null;
    let tabConn = null;

    const onExit = () => cleanup(child);
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);

    try {
        const version = await waitForDevTools(20000);
        browser = await connect(version.webSocketDebuggerUrl);

        const extensionId = await findExtensionId(browser, 20000);
        console.log('Ekstensi: ' + extensionId);

        const tab = await findYouTubeTab(browser, 30000);
        await browser.send('Target.activateTarget', { targetId: tab.targetId });
        tabConn = await waitForTabReady(browser, tab, 30000);
        await sleep(1500);

        const knownIds = new Set((await listPages()).map((page) => page.id));
        await browser.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });

        const pipPage = await waitForPipPage(knownIds, 20000);
        pipConn = await connect(pipPage.webSocketDebuggerUrl);
        const pipEval = evaluate(pipConn);

        const state = await waitForLyrics(pipEval, 30000);
        if (!state) {
            console.error('Gagal membaca state jendela lirik.');
            process.exitCode = 1;
            return;
        }

        console.log('Judul   : ' + state.title);
        console.log('Artis   : ' + state.artist);
        console.log('Lirik   : ' + state.lines + ' baris');
        console.log('Badge   : ' + state.badge);
        console.log('Tema    : ' + state.theme);

        let failed = false;
        if (state.lines === 0) {
            failed = true;
            console.error('GAGAL: lirik tidak ditemukan. Status: ' + state.status);
        }
        if (!state.title) {
            failed = true;
            console.error('GAGAL: judul lirik kosong.');
        }
        if (EXPECT_TITLE && state.title.toLowerCase().indexOf(EXPECT_TITLE.toLowerCase()) === -1) {
            failed = true;
            console.error('GAGAL: judul tidak mengandung "' + EXPECT_TITLE + '".');
        }

        if (failed) {
            process.exitCode = 1;
            return;
        }

        console.log('E2E OK');
    } catch (error) {
        console.error('E2E GAGAL: ' + (error && error.message ? error.message : error));
        process.exitCode = 1;
    } finally {
        try {
            if (pipConn) pipConn.close();
        } catch (error) {
            // abaikan
        }
        try {
            if (tabConn) tabConn.close();
        } catch (error) {
            // abaikan
        }
        try {
            if (browser) browser.close();
        } catch (error) {
            // abaikan
        }
        cleanup(child);
    }
})();
