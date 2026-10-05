// options.js - reads/writes Anthropic settings to chrome.storage.local.
// Never logs the API key, never sends it anywhere except via background.js.

const DEFAULT_MODEL = "claude-3-5-haiku-20241022";

const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const statusEl = document.getElementById("status");
const toggleKeyBtn = document.getElementById("toggleKey");

function showStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.className = isError ? "err" : "ok";
  if (text) {
    setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "";
    }, 2500);
  }
}

function load() {
  chrome.storage.local.get(["anthropicApiKey", "anthropicModel"], (res) => {
    apiKeyEl.value = res.anthropicApiKey || "";
    modelEl.value = res.anthropicModel || DEFAULT_MODEL;
  });
}

document.getElementById("save").addEventListener("click", () => {
  const apiKey = apiKeyEl.value.trim();
  const model = modelEl.value.trim() || DEFAULT_MODEL;
  chrome.storage.local.set(
    { anthropicApiKey: apiKey, anthropicModel: model },
    () => {
      showStatus("已經儲存。", false);
    }
  );
});

document.getElementById("clear").addEventListener("click", () => {
  apiKeyEl.value = "";
  chrome.storage.local.set({ anthropicApiKey: "" }, () => {
    showStatus("API 金鑰已經清除,爬蟲會改用本機嘅後備摘要。", false);
  });
});

toggleKeyBtn.addEventListener("click", () => {
  const show = apiKeyEl.type === "password";
  apiKeyEl.type = show ? "text" : "password";
  toggleKeyBtn.textContent = show ? "隱藏" : "顯示";
});

load();
