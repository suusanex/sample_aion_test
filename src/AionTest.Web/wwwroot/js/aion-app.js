const storageKey = "aion-prompt-evaluation-state-v2";
const casesUrl = "/evaluation/cases/evaluation-cases.json";
const knownAvailability = new Set(["unavailable", "downloadable", "downloading", "available"]);

class PromptApiClient {
    constructor(languageModel = globalThis.LanguageModel) {
        this.languageModel = languageModel;
    }

    async inspect() {
        if (!this.languageModel) return { exists: false, availability: "unavailable" };
        return { exists: true, availability: await this.languageModel.availability() };
    }

    async getParameters() {
        if (!this.languageModel || typeof this.languageModel.params !== "function") return null;
        return await this.languageModel.params();
    }

    async create(options, onProgress) {
        if (!this.languageModel) throw new Error("LanguageModel API is unavailable.");
        return await this.languageModel.create({
            ...options,
            monitor: monitor => monitor?.addEventListener?.("downloadprogress", event => onProgress({
                loaded: event.loaded ?? event.detail?.loaded,
                total: event.total ?? event.detail?.total,
            })),
        });
    }
}

const elements = Object.fromEntries([
    "api-status", "availability-status", "session-status", "run-status", "download-progress", "prepare-session", "status-message", "error-message",
    "system-prompt", "temperature", "top-k", "parameter-support", "streaming", "reset-session", "clear-history", "case-select", "case-details", "human-notes",
    "edge-version", "os-version", "hardware", "device-class", "model-confirmation", "conversation", "user-prompt", "send-prompt", "cancel-prompt", "record-count", "download-json", "download-markdown",
].map(id => [id, document.getElementById(id)]));

const app = {
    client: new PromptApiClient(),
    session: null,
    creatingSession: null,
    abortController: null,
    isRunning: false,
    parameterMetadata: null,
    cases: [],
    state: { turns: [], records: [], settings: {}, selectedCaseId: "", contextStartIndex: 0 },
};

const runLockedControls = [
    elements["system-prompt"], elements.temperature, elements["top-k"], elements.streaming, elements["case-select"], elements["prepare-session"], elements["reset-session"], elements["clear-history"],
    elements["human-notes"], elements["edge-version"], elements["os-version"], elements.hardware, elements["device-class"], elements["model-confirmation"], elements["user-prompt"],
];

function now() { return new Date().toISOString(); }
function errorText(error) { return error instanceof Error ? error.message : String(error); }
function createAbortError() { return new DOMException("Generation cancelled.", "AbortError"); }
function setStatus(message, error = null) {
    elements["status-message"].textContent = message;
    elements["error-message"].hidden = !error;
    elements["error-message"].textContent = error ?? "";
}
function sessionState(text) { elements["session-status"].textContent = text; }
function hasSupportedParameters() {
    const metadata = app.parameterMetadata;
    return Boolean(metadata && [metadata.defaultTemperature, metadata.maxTemperature, metadata.defaultTopK, metadata.maxTopK].every(Number.isFinite));
}
function updateInteractiveControls() {
    for (const control of runLockedControls) control.disabled = app.isRunning;
    elements.temperature.disabled = app.isRunning || !hasSupportedParameters();
    elements["top-k"].disabled = app.isRunning || !hasSupportedParameters();
    elements["prepare-session"].disabled = app.isRunning || app.creatingSession !== null;
}
function setRunning(running, text = running ? "実行中" : "待機中") {
    app.isRunning = running;
    elements["run-status"].textContent = text;
    elements["send-prompt"].disabled = running;
    elements["cancel-prompt"].disabled = !running;
    updateInteractiveControls();
}
function readSettings() {
    return {
        systemPrompt: elements["system-prompt"].value,
        temperature: elements.temperature.disabled ? null : Number(elements.temperature.value),
        topK: elements["top-k"].disabled ? null : Number(elements["top-k"].value),
        streaming: elements.streaming.checked,
        environment: {
            edgeVersion: elements["edge-version"].value,
            os: elements["os-version"].value,
            hardware: elements.hardware.value,
            deviceClass: elements["device-class"].value,
            modelConfirmation: elements["model-confirmation"].value,
        },
        humanNotes: elements["human-notes"].value,
    };
}
function applySettings(settings = {}) {
    elements["system-prompt"].value = settings.systemPrompt ?? elements["system-prompt"].value;
    elements.streaming.checked = settings.streaming ?? true;
    for (const [key, element] of Object.entries({ edgeVersion: elements["edge-version"], os: elements["os-version"], hardware: elements.hardware, deviceClass: elements["device-class"], modelConfirmation: elements["model-confirmation"] })) element.value = settings.environment?.[key] ?? "";
    elements["human-notes"].value = settings.humanNotes ?? "";
    if (settings.temperature !== null && settings.temperature !== undefined) elements.temperature.value = settings.temperature;
    if (settings.topK !== null && settings.topK !== undefined) elements["top-k"].value = settings.topK;
}
function normalizeContextBoundary() {
    if (!Number.isInteger(app.state.contextStartIndex) || app.state.contextStartIndex < 0 || app.state.contextStartIndex > app.state.turns.length) app.state.contextStartIndex = 0;
}
function persist() {
    app.state.settings = readSettings();
    app.state.selectedCaseId = elements["case-select"].value;
    try {
        sessionStorage.setItem(storageKey, JSON.stringify(app.state));
        return true;
    } catch (error) {
        console.error(error);
        setStatus("状態を保存できなかった。", errorText(error));
        return false;
    }
}
function restore() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
        if (saved && Array.isArray(saved.turns) && Array.isArray(saved.records)) app.state = { ...app.state, ...saved };
    } catch (error) {
        console.error(error);
        setStatus("保存済み状態を復元できなかった。", errorText(error));
    }
    normalizeContextBoundary();
    applySettings(app.state.settings);
}
function renderTurns() {
    elements.conversation.replaceChildren(...app.state.turns.map(turn => {
        const article = document.createElement("article");
        article.className = `turn ${turn.role} ${turn.status ?? ""}`;
        const header = document.createElement("header");
        header.textContent = `${turn.role === "user" ? "User" : "Assistant"}${turn.status ? ` (${turn.status})` : ""}`;
        if (turn.role === "assistant" && turn.content) {
            const copy = document.createElement("button");
            copy.type = "button";
            copy.className = "copy-response";
            copy.textContent = "コピー";
            copy.addEventListener("click", () => copyTurn(turn.content));
            header.append(copy);
        }
        const body = document.createElement("div");
        body.textContent = turn.content;
        article.append(header, body);
        return article;
    }));
}
async function copyTurn(content) {
    try {
        await navigator.clipboard.writeText(content);
        setStatus("応答をクリップボードへコピーした。");
    } catch (error) {
        console.error(error);
        setStatus("応答をコピーできなかった。", errorText(error));
    }
}
function completedPrompts() {
    normalizeContextBoundary();
    const settings = readSettings();
    const prompts = settings.systemPrompt ? [{ role: "system", content: settings.systemPrompt }] : [];
    for (let index = app.state.contextStartIndex; index < app.state.turns.length; index += 1) {
        const userTurn = app.state.turns[index];
        const assistantTurn = app.state.turns[index + 1];
        if (userTurn?.role === "user" && assistantTurn?.role === "assistant" && assistantTurn.status === "completed") {
            prompts.push({ role: "user", content: userTurn.content }, { role: "assistant", content: assistantTurn.content });
            index += 1;
        }
    }
    return prompts;
}
function sessionOptions(settings = readSettings()) {
    const options = { initialPrompts: completedPrompts() };
    if (hasSupportedParameters()) {
        options.temperature = settings.temperature;
        options.topK = settings.topK;
    }
    return options;
}
async function discardSession(reason) {
    const old = app.session;
    app.session = null;
    if (old?.destroy) {
        try {
            await old.destroy();
        } catch (error) {
            console.error(error);
            setStatus("既存セッションを破棄できなかった。", errorText(error));
            throw error;
        }
    }
    sessionState(reason);
}
function setDownloadProgress(progress) {
    elements["download-progress"].hidden = false;
    const loaded = Number(progress.loaded);
    const total = Number(progress.total);
    if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0 && loaded >= 0) {
        elements["download-progress"].value = Math.max(0, Math.min(1, loaded / total));
        elements["download-progress"].setAttribute("aria-label", `モデルダウンロード進捗 ${loaded}/${total}`);
        return;
    }
    elements["download-progress"].removeAttribute("value");
    elements["download-progress"].setAttribute("aria-label", "モデルダウンロード進捗は総量未取得");
    setStatus("モデルダウンロード進捗の総量を取得できないため、不定表示にしている。");
}
async function ensureSession(options = sessionOptions()) {
    if (app.session) return app.session;
    if (app.creatingSession) return await app.creatingSession;
    const createTask = (async () => {
        const inspection = await app.client.inspect();
        updateInspection(inspection);
        if (!inspection.exists) throw new Error("LanguageModel API が利用できない。");
        if (!knownAvailability.has(inspection.availability)) throw new Error(`Unsupported LanguageModel availability state: ${inspection.availability}`);
        if (inspection.availability === "unavailable") throw new Error("LanguageModel API または対象モデルを利用できない。");
        elements["download-progress"].hidden = false;
        elements["download-progress"].removeAttribute("value");
        sessionState("作成中");
        try {
            app.session = await app.client.create(options, setDownloadProgress);
            sessionState("作成済み");
            setStatus("セッションを作成した。");
            return app.session;
        } catch (error) {
            console.error(error);
            sessionState("作成失敗");
            setStatus("セッションを作成できなかった。", errorText(error));
            throw error;
        } finally {
            elements["download-progress"].hidden = true;
        }
    })();
    app.creatingSession = createTask;
    updateInteractiveControls();
    try {
        return await createTask;
    } catch (error) {
        sessionState("作成失敗");
        setStatus("セッションを作成できなかった。", errorText(error));
        throw error;
    } finally {
        app.creatingSession = null;
        updateInteractiveControls();
    }
}
function updateInspection(inspection) {
    elements["api-status"].textContent = inspection.exists ? "利用可能" : "未対応";
    elements["availability-status"].textContent = inspection.availability;
}
function configureParameters(metadata) {
    app.parameterMetadata = metadata;
    if (!hasSupportedParameters()) {
        elements["parameter-support"].textContent = "LanguageModel.params() が未対応のため、temperature と topK は設定しない。";
        updateInteractiveControls();
        return;
    }
    const setRange = (element, defaultValue, maxValue) => {
        element.value = defaultValue;
        element.max = maxValue;
        element.min = 0;
    };
    setRange(elements.temperature, metadata.defaultTemperature, metadata.maxTemperature);
    setRange(elements["top-k"], metadata.defaultTopK, metadata.maxTopK);
    elements["parameter-support"].textContent = `LanguageModel.params() の範囲: temperature 0-${metadata.maxTemperature}, topK 0-${metadata.maxTopK}`;
    updateInteractiveControls();
}
function validateParameters() {
    if (!hasSupportedParameters()) return;
    const metadata = app.parameterMetadata;
    const temperature = Number(elements.temperature.value);
    const topK = Number(elements["top-k"].value);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > metadata.maxTemperature) throw new Error(`Temperature must be between 0 and ${metadata.maxTemperature}.`);
    if (!Number.isInteger(topK) || topK < 0 || topK > metadata.maxTopK) throw new Error(`Top K must be an integer between 0 and ${metadata.maxTopK}.`);
}
function selectedCase() { return app.cases.find(item => item.id === elements["case-select"].value) ?? null; }
function expandedCasePrompt(item) { return `${item.instruction}\n\n${item.input}`; }
function makeRecord({ executionId, startedAt, completedAt, prompt, output, status, error, ttftMs, totalMs, caseItem, settings, availability }) {
    return {
        schemaVersion: "1.0",
        executionId,
        caseId: caseItem?.id ?? null,
        timestamps: { startedAt, completedAt },
        environment: { ...settings.environment, browserUserAgent: navigator.userAgent, online: navigator.onLine },
        availability,
        settings: { systemPrompt: settings.systemPrompt, temperature: settings.temperature, topK: settings.topK, streaming: settings.streaming },
        input: { resolvedPrompt: prompt, chars: prompt.length, evaluationCase: caseItem ?? null },
        output: { text: output, chars: output.length },
        timings: { timeToFirstTextMs: ttftMs, totalMs },
        status,
        error: error ?? null,
        humanNotes: settings.humanNotes,
    };
}
async function discardAfterGenerationFailure() {
    try {
        await discardSession("失敗後に破棄");
        return null;
    } catch (error) {
        console.error(error);
        return errorText(error);
    }
}
async function send() {
    if (app.isRunning) return;
    const caseItem = selectedCase();
    const prompt = elements["user-prompt"].value.trim();
    if (!prompt) {
        setStatus("User prompt を入力するか、評価ケースを選択する。", "Prompt is required.");
        return;
    }
    const executionId = crypto.randomUUID();
    const startedAt = now();
    const startTime = performance.now();
    const settings = readSettings();
    const availability = elements["availability-status"].textContent;
    let ttftMs = null;
    let assistantTurn = null;
    let output = "";
    app.abortController = new AbortController();
    setRunning(true, "準備中");
    try {
        validateParameters();
        const userTurn = { role: "user", content: prompt, status: "completed" };
        assistantTurn = { role: "assistant", content: "", status: "pending" };
        app.state.turns.push(userTurn, assistantTurn);
        renderTurns();
        persist();
        const session = await ensureSession(sessionOptions(settings));
        if (app.abortController.signal.aborted) throw createAbortError();
        elements["run-status"].textContent = "実行中";
        if (settings.streaming) {
            for await (const chunk of session.promptStreaming(prompt, { signal: app.abortController.signal })) {
                if (ttftMs === null) ttftMs = Math.round(performance.now() - startTime);
                assistantTurn.content += chunk;
                renderTurns();
            }
        } else {
            const answer = await session.prompt(prompt, { signal: app.abortController.signal });
            if (answer) ttftMs = Math.round(performance.now() - startTime);
            assistantTurn.content = answer ?? "";
            renderTurns();
        }
        assistantTurn.status = "completed";
        output = assistantTurn.content;
        app.state.records.push(makeRecord({ executionId, startedAt, completedAt: now(), prompt, output, status: "success", ttftMs, totalMs: Math.round(performance.now() - startTime), caseItem, settings, availability: elements["availability-status"].textContent }));
        setStatus("生成が完了した。");
    } catch (error) {
        console.error(error);
        const cancelled = error?.name === "AbortError" || app.abortController?.signal.aborted;
        if (assistantTurn) {
            assistantTurn.status = cancelled ? "cancelled" : "failed";
            output = assistantTurn.content;
        }
        const cleanupError = await discardAfterGenerationFailure();
        const message = cleanupError ? `${errorText(error)} Cleanup failed: ${cleanupError}` : errorText(error);
        app.state.records.push(makeRecord({ executionId, startedAt, completedAt: now(), prompt, output, status: cancelled ? "cancelled" : "failed", error: message, ttftMs, totalMs: Math.round(performance.now() - startTime), caseItem, settings, availability: elements["availability-status"].textContent || availability }));
        setStatus(cancelled ? "生成をキャンセルした。" : "生成に失敗した。", message);
        renderTurns();
    } finally {
        app.abortController = null;
        setRunning(false);
        persist();
        renderRecordCount();
    }
}
function cancel() { app.abortController?.abort(); }
function renderRecordCount() { elements["record-count"].textContent = `記録: ${app.state.records.length} 件`; }
async function resetSession() {
    app.state.contextStartIndex = app.state.turns.length;
    await discardSession("リセット済み");
    setStatus("モデル文脈だけを破棄した。会話履歴と記録は保持する。");
    persist();
}
async function clearHistory() {
    app.state.turns = [];
    app.state.contextStartIndex = 0;
    await discardSession("履歴クリア");
    renderTurns();
    setStatus("会話履歴とモデル文脈を消去した。記録は保持する。");
    persist();
}
function selectCase() {
    const item = selectedCase();
    app.state.selectedCaseId = item?.id ?? "";
    if (item) {
        elements["user-prompt"].value = expandedCasePrompt(item);
        elements["case-details"].textContent = `${item.category} / ${item.language} / ${item.size}\n期待形式: ${item.expectedOutputFormat}\n評価: ${item.evaluationCriteria.join("、")}`;
    } else {
        elements["case-details"].textContent = "";
    }
    persist();
}
function safeTimestamp() { return now().replace(/[:.]/g, "-"); }
function download(kind) {
    const records = app.state.records;
    const body = kind === "json" ? JSON.stringify({ schemaVersion: "1.0", exportedAt: now(), records }, null, 2) : records.map(recordToMarkdown).join("\n\n---\n\n");
    const blob = new Blob([body], { type: kind === "json" ? "application/json" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aion-prompt-evaluation-${safeTimestamp()}.${kind === "json" ? "json" : "md"}`;
    link.click();
    URL.revokeObjectURL(url);
}
function fenced(value) {
    const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}\n${value}\n${fence}`;
}
function recordToMarkdown(record) {
    return `# Aion Prompt API 評価記録

- 実行ID: ${record.executionId}
- ケース: ${record.caseId ?? "手入力"}
- 状態: ${record.status}
- 開始: ${record.timestamps.startedAt}
- 完了: ${record.timestamps.completedAt}
- TTFT: ${record.timings.timeToFirstTextMs ?? "未取得"} ms
- 合計: ${record.timings.totalMs} ms
- Availability: ${record.availability}
- Online: ${record.environment.online}

## 実行環境

- Edge: ${record.environment.edgeVersion || "手動確認が必要"}
- OS: ${record.environment.os || "手動確認が必要"}
- ハードウェア: ${record.environment.hardware || "手動確認が必要"}
- Device class: ${record.environment.deviceClass || "手動確認が必要"}
- モデル確認: ${record.environment.modelConfirmation || "手動確認が必要"}

## 設定

- Temperature: ${record.settings.temperature ?? "未対応"}
- Top K: ${record.settings.topK ?? "未対応"}
- Streaming: ${record.settings.streaming}

### System prompt

${fenced(record.settings.systemPrompt)}

## 入力 (${record.input.chars} 文字)

${fenced(record.input.resolvedPrompt)}

## 出力 (${record.output.chars} 文字)

${fenced(record.output.text)}

## エラー

${fenced(record.error ?? "なし")}

## 人手メモ

${fenced(record.humanNotes || "なし")}`;
}
async function loadCases() {
    try {
        const response = await fetch(casesUrl);
        if (!response.ok) throw new Error(`Evaluation cases request failed: ${response.status}`);
        const payload = await response.json();
        app.cases = payload.cases;
        elements["case-select"].replaceChildren(new Option("手入力", ""), ...app.cases.map(item => new Option(`${item.id}: ${item.category} (${item.size})`, item.id)));
        elements["case-select"].value = app.state.selectedCaseId;
        selectCase();
    } catch (error) {
        console.error(error);
        elements["case-select"].replaceChildren(new Option("評価ケースを読み込めなかった", ""));
        setStatus("評価ケースを読み込めなかった。", errorText(error));
    }
}
async function settingsChanged() {
    if (app.isRunning) return;
    if (app.session) await discardSession("設定変更で破棄");
    persist();
}
async function initialize() {
    restore();
    renderTurns();
    renderRecordCount();
    for (const element of [elements["system-prompt"], elements.temperature, elements["top-k"], elements.streaming]) element.addEventListener("change", () => settingsChanged().catch(error => console.error(error)));
    for (const element of [elements["human-notes"], elements["edge-version"], elements["os-version"], elements.hardware, elements["device-class"], elements["model-confirmation"]]) element.addEventListener("change", persist);
    elements["prepare-session"].addEventListener("click", () => ensureSession().catch(() => {}));
    elements["send-prompt"].addEventListener("click", send);
    elements["cancel-prompt"].addEventListener("click", cancel);
    elements["reset-session"].addEventListener("click", () => resetSession().catch(error => console.error(error)));
    elements["clear-history"].addEventListener("click", () => clearHistory().catch(error => console.error(error)));
    elements["case-select"].addEventListener("change", selectCase);
    elements["download-json"].addEventListener("click", () => download("json"));
    elements["download-markdown"].addEventListener("click", () => download("markdown"));
    window.addEventListener("pagehide", () => { if (app.session?.destroy) app.session.destroy().catch(error => console.error(error)); });
    try {
        const inspection = await app.client.inspect();
        updateInspection(inspection);
        configureParameters(await app.client.getParameters());
        if (!inspection.exists) setStatus("LanguageModel API がないブラウザー。Edge Dev/Canary とフラグを確認する。");
        else if (!knownAvailability.has(inspection.availability)) setStatus("未知の LanguageModel availability 状態を検出した。", `Unsupported LanguageModel availability state: ${inspection.availability}`);
        else setStatus("LanguageModel API を検出した。");
    } catch (error) {
        console.error(error);
        updateInspection({ exists: false, availability: "error" });
        setStatus("Prompt API の状態を確認できなかった。", errorText(error));
    }
    await loadCases();
}

initialize();
