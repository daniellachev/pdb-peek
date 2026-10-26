// PDB Peek service worker: selection menu and the optional "every website" content script.
const ALL_SITES = ["http://*/*", "https://*/*"];
const ALL_SITES_SCRIPT = "pdbpeek-all-sites";

function normalizeId(raw) {
  const value = String(raw || "").trim().replace(/^pdb_0000/i, "");
  return /^[1-9][a-z0-9]{3}$/i.test(value) ? value.toUpperCase() : null;
}

function openViewer(raw) {
  const id = normalizeId(raw) || String(raw || "").trim().slice(0, 40);
  chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?mode=full&id=${encodeURIComponent(id)}`) });
}

async function syncAllSites() {
  const granted = await chrome.permissions.contains({ origins: ALL_SITES });
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_SCRIPT] });
  if (granted && !registered.length) {
    const curated = chrome.runtime.getManifest().content_scripts[0].matches;
    await chrome.scripting.registerContentScripts([{
      id: ALL_SITES_SCRIPT,
      matches: ALL_SITES,
      excludeMatches: curated,
      js: ["content.js"],
      css: ["content.css"],
      runAt: "document_idle",
    }]);
  } else if (!granted && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_SCRIPT] });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "pdbpeek-selection",
    title: "Peek at PDB entry \"%s\"",
    contexts: ["selection"],
  });
  syncAllSites();
});

chrome.runtime.onStartup.addListener(syncAllSites);
chrome.permissions.onAdded.addListener(syncAllSites);
chrome.permissions.onRemoved.addListener(syncAllSites);

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "pdbpeek-selection") openViewer(info.selectionText);
});
