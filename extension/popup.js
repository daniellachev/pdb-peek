// PDB Peek popup: open an entry by ID, search RCSB by name, plus the two page settings.
const ALL_SITES = ["http://*/*", "https://*/*"];
const $ = (id) => document.getElementById(id);

function normalizeId(raw) {
  const value = String(raw || "").trim().replace(/^pdb_0000/i, "");
  return /^[1-9][a-z0-9]{3}$/i.test(value) ? value.toUpperCase() : null;
}

function openViewer(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?mode=full&id=${encodeURIComponent(id)}`) });
  window.close();
}

async function search(text) {
  const body = {
    query: { type: "terminal", service: "full_text", parameters: { value: text } },
    return_type: "entry",
    request_options: { paginate: { start: 0, rows: 6 } },
  };
  const response = await fetch("https://search.rcsb.org/rcsbsearch/v2/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return [];
  if (!response.ok) throw new Error(`RCSB search answered ${response.status}.`);
  const ids = ((await response.json()).result_set || []).map((hit) => hit.identifier);
  if (!ids.length) return [];
  const titles = await fetch("https://data.rcsb.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "query ($ids: [String!]!) { entries(entry_ids: $ids) { rcsb_id struct { title } } }", variables: { ids } }),
  }).then((r) => r.json()).catch(() => ({}));
  const byId = new Map(((titles.data || {}).entries || []).map((e) => [e.rcsb_id, e.struct && e.struct.title]));
  return ids.map((id) => ({ id, title: byId.get(id) || "" }));
}

function tidy(text) {
  if (!text || text !== text.toUpperCase()) return text || "";
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

$("search").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("query").value.trim();
  const id = normalizeId(text);
  if (id) return openViewer(id);
  $("results").replaceChildren();
  $("status").textContent = "Searching RCSB…";
  try {
    const hits = await search(text);
    $("status").textContent = hits.length ? "" : "No entries found.";
    for (const hit of hits) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const code = document.createElement("b");
      code.textContent = hit.id;
      button.append(code, tidy(hit.title));
      button.addEventListener("click", () => openViewer(hit.id));
      item.append(button);
      $("results").append(item);
    }
  } catch (error) {
    $("status").textContent = error.message;
  }
});

chrome.storage.sync.get({ enabled: true }, (settings) => {
  $("enabled").checked = settings.enabled !== false;
});

$("enabled").addEventListener("change", (event) => {
  chrome.storage.sync.set({ enabled: event.target.checked });
});

chrome.permissions.contains({ origins: ALL_SITES }, (granted) => {
  $("all-sites").checked = granted;
});

$("all-sites").addEventListener("change", async (event) => {
  if (event.target.checked) {
    event.target.checked = await chrome.permissions.request({ origins: ALL_SITES });
  } else {
    await chrome.permissions.remove({ origins: ALL_SITES });
  }
});

$("made-by").href = "https://animiotics.com/?utm_source=pdb_peek&utm_medium=extension&utm_campaign=pdb_peek&utm_content=popup";
$("query").focus();
