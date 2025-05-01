// 文件: public/extensions/third-party/day5/worker.js

const DB_NAME = 'SillyTavernDay1Stats';
const STORE_NAME = 'dailyStats';
const DB_VERSION = 1; // 保持版本号不变，除非你需要更改数据库结构
let db;

const GLOBAL_STATS_ID = '_GLOBAL_STATS_';

// --- IndexedDB 辅助函数 ---
function openDB() {
    return new Promise((resolve, reject) => {
        if (db) { resolve(db); return; }
        console.log('[Day1 Worker] Opening IndexedDB...'); // 添加日志
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => { console.error('[Day1 Worker] DB open error:', event.target.error); reject('IndexedDB error: ' + event.target.error); };
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('[Day1 Worker] DB connection opened successfully.'); // 添加日志
            db.onerror = (event) => console.error("[Day1 Worker] Database error:", event.target.error);
            db.onclose = () => { console.log('[Day1 Worker] DB connection closed.'); db = null; }; // 添加日志
            db.onversionchange = () => { console.log('[Day1 Worker] DB version change detected, closing connection.'); if (db) db.close(); db = null; }; // 添加日志
            resolve(db);
        };
        // *** 修改 onupgradeneeded ***
        request.onupgradeneeded = (event) => {
            console.log("[Day1 Worker] DB upgrade needed.");
            const dbInstance = event.target.result;
            const transaction = event.target.transaction; // 获取事务对象

            if (!dbInstance.objectStoreNames.contains(STORE_NAME)) {
                try {
                    dbInstance.createObjectStore(STORE_NAME, { keyPath: 'entityId' });
                    console.log(`[Day1 Worker] Object store "${STORE_NAME}" created.`);
                } catch (e) {
                    console.error(`[Day1 Worker] Error creating object store "${STORE_NAME}"`, e);
                    if (transaction) { // 检查事务是否存在
                         console.error('[Day1 Worker] Aborting transaction due to object store creation error.');
                         transaction.abort(); // 中止事务
                    }
                    reject(`Error creating object store: ${e}`); // 拒绝 Promise
                    return; // 提前退出处理程序
                }
            } else {
                 console.log(`[Day1 Worker] Object store "${STORE_NAME}" already exists.`);
            }
             console.log("[Day1 Worker] DB upgrade finished.");
             // 注意：通常在 onupgradeneeded 中不需要 resolve/reject，事务会自动处理
             // 但如果创建失败，我们上面已经 reject 了
        };
    });
}

function readData(entityId) {
    return new Promise(async (resolve, reject) => {
        try {
            const currentDb = await openDB();
            // *** 添加日志：确认数据库和存储存在 ***
            // console.log('[Day1 Worker] readData: DB connection acquired. Store names:', currentDb.objectStoreNames);
            if (!currentDb.objectStoreNames.contains(STORE_NAME)) {
                 console.error(`[Day1 Worker] readData: Object store "${STORE_NAME}" not found before starting transaction.`);
                 reject(`Object store "${STORE_NAME}" not found.`);
                 return;
            }
            const transaction = currentDb.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(entityId);
            request.onerror = (event) => {
                console.error('[Day1 Worker] readData Error:', event.target.error); // 添加日志
                reject('Error reading data: ' + event.target.error);
            };
            request.onsuccess = (event) => resolve(event.target.result);
        } catch (error) {
            console.error("[Day1 Worker] Error during readData:", error); // 修改日志区分 setup 和 执行
            reject(error);
        }
    });
}

function writeData(data) {
    return new Promise(async (resolve, reject) => {
        try {
            const currentDb = await openDB();
             // *** 添加日志：确认数据库和存储存在 ***
            // console.log('[Day1 Worker] writeData: DB connection acquired. Store names:', currentDb.objectStoreNames);
             if (!currentDb.objectStoreNames.contains(STORE_NAME)) {
                 console.error(`[Day1 Worker] writeData: Object store "${STORE_NAME}" not found before starting transaction.`);
                 reject(`Object store "${STORE_NAME}" not found.`);
                 return;
             }
            const transaction = currentDb.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            // console.log('[Day1 Worker] writeData: Attempting to write data for entityId:', data.entityId, 'Data snapshot:', JSON.stringify(data));

            const request = store.put(data);

            request.onerror = (event) => {
                console.error('[Day1 Worker] writeData: Error writing data for entityId:', data.entityId, 'Error:', event.target.error);
                reject('Error writing data: ' + event.target.error);
            };
            request.onsuccess = (event) => {
                // console.log('[Day1 Worker] writeData: Successfully wrote data for entityId:', data.entityId, 'Result:', event.target.result);
                resolve(event.target.result);
            };

            transaction.oncomplete = () => {
                // console.log('[Day1 Worker] writeData: Transaction completed for entityId:', data.entityId);
            };
            transaction.onerror = (event) => {
                console.error('[Day1 Worker] writeData: Transaction error for entityId:', data.entityId, 'Error:', event.target.error);
                 // 注意：这里通常不需要 reject，因为 request.onerror 会处理
            };

        } catch (error) {
            console.error("[Day1 Worker] Error during writeData:", error); // 修改日志区分 setup 和 执行
            reject(error);
        }
    });
}

// ... (getOrCreateDailyStat 函数保持不变) ...

// --- Web Worker 消息处理 ---
self.onmessage = async (event) => {
    if (!event.data?.command) return;
    const { command, payload } = event.data;

    // 处理 'processMessage' 命令
    if (command === 'processMessage') {
        if (!payload?.entityId || !payload.timestamp) return;
        const { entityId, entityName, isUser, tokenCount, timestamp, aiResponseDuration } = payload;
        try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            let stats = await readData(entityId);
            if (!stats) stats = { entityId, entityName: entityName || entityId, dailyData: {}, totalInteractionDurationMs: 0 };
            if (entityName && stats.entityName !== entityName) stats.entityName = entityName;
            stats.totalInteractionDurationMs = stats.totalInteractionDurationMs || 0;
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            if (isUser === true) {
                dailyStat.userMessages = (dailyStat.userMessages || 0) + 1; dailyStat.userTokens += Number(tokenCount) || 0; dailyStat.lastUserMessageTimestamp = timestamp;
            } else if (isUser === false) {
                dailyStat.aiMessages = (dailyStat.aiMessages || 0) + 1; dailyStat.aiTokens += Number(tokenCount) || 0; dailyStat.lastAiMessageTimestamp = timestamp;
                if (typeof aiResponseDuration === 'number' && aiResponseDuration >= 0) dailyStat.totalAiResponseDuration += aiResponseDuration;
            }
            await writeData(stats);
        } catch (error) { console.error(`Worker Error (processMessage ${entityId}):`, error); } // 这里捕获到的可能是 readData 或 writeData 的 reject
    }
    // 处理 'recordPromptTokens' 命令
    else if (command === 'recordPromptTokens') {
        if (!payload?.entityId || !payload.timestamp || typeof payload.promptTokenCount !== 'number') return;
        const { entityId, entityName, timestamp, promptTokenCount } = payload;
         try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            let stats = await readData(entityId);
            if (!stats) stats = { entityId, entityName: entityName || entityId, dailyData: {}, totalInteractionDurationMs: 0 };
            if (entityName && stats.entityName !== entityName) stats.entityName = entityName;
            stats.totalInteractionDurationMs = stats.totalInteractionDurationMs || 0;
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            dailyStat.cumulativeTokens += Number(promptTokenCount) || 0;
            await writeData(stats);
        } catch (error) { console.error(`Worker Error (recordPromptTokens ${entityId}):`, error); }
    }
    // 处理 'recordDailyDuration' 命令
    else if (command === 'recordDailyDuration') {
        if (typeof payload?.durationMs !== 'number' || !payload.timestamp) return;
        const { durationMs, timestamp } = payload;
        const entityId = GLOBAL_STATS_ID;
        try {
            let date = new Date(timestamp); if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            let stats = await readData(entityId);
            if (!stats) stats = { entityId, entityName: 'Global Stats', dailyData: {} };
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            dailyStat.totalVisibleDurationMs += durationMs;
            // console.log('[Day1 Worker] Writing global duration. Payload:', payload, 'New Daily Visible:', dailyStat.totalVisibleDurationMs);
            await writeData(stats);
        } catch (error) { console.error(`Worker Error (recordDailyDuration):`, error); }
    }
    // 处理 'recordEntityDuration' 命令
    else if (command === 'recordEntityDuration') {
        if (!payload?.entityId || typeof payload.durationMs !== 'number' || !payload.timestamp) {
            console.warn('Day1 Worker: Received recordEntityDuration with missing data.', payload); return;
        }
        const { entityId, entityName, durationMs, timestamp } = payload;

        try {
            let stats = await readData(entityId);
            if (!stats) {
                stats = { entityId, entityName: entityName || entityId, dailyData: {}, totalInteractionDurationMs: 0 };
            }
            stats.totalInteractionDurationMs = stats.totalInteractionDurationMs || 0;
            stats.totalInteractionDurationMs += durationMs;

            let date = new Date(timestamp);
            if (isNaN(date.getTime())) date = new Date();
            const dateString = date.toISOString().split('T')[0];
            const dailyStat = getOrCreateDailyStat(stats, dateString, entityId);
            dailyStat.dailyInteractionDurationMs += durationMs;

            // console.log('[Day1 Worker] Writing entity duration. Payload:', payload, 'New Total:', stats.totalInteractionDurationMs, 'New Daily:', dailyStat.dailyInteractionDurationMs);
            await writeData(stats);
        } catch (error) {
            console.error(`Worker Error (recordEntityDuration ${entityId}):`, error);
        }
    }
};

// --- Worker 初始化 ---
console.log('Day1 Worker: Script loaded.');
openDB().then(() => { console.log("Day1 Worker: Initial DB check successful after openDB call."); }) // 修改日志
        .catch(e => { console.error("Day1 Worker: Initial DB check failed after openDB call.", e); }); // 修改日志
