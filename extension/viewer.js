// PDB Peek viewer: RCSB metadata and a 3Dmol.js preview for one PDB entry.
// Opened inside the hover card (mode=card) or as its own tab (mode=full).
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "full" ? "full" : "card";
document.documentElement.dataset.mode = mode;

const CARD_ATOM_LIMIT = 120000;
const FULL_ATOM_LIMIT = 1500000;
const WATER = ["HOH", "WAT", "DOD"];
const UTM = `utm_source=pdb_peek&utm_medium=extension&utm_campaign=pdb_peek&utm_content=${mode}`;
const CTA_URL = `https://animiotics.com/molecular-animation-software?${UTM}`;
const METHODS = {
  "X-RAY DIFFRACTION": "X-ray",
  "ELECTRON MICROSCOPY": "EM",
  "SOLUTION NMR": "NMR",
  "SOLID-STATE NMR": "Solid-state NMR",
  "NEUTRON DIFFRACTION": "Neutron",
  "ELECTRON CRYSTALLOGRAPHY": "Electron crystallography",
  "FIBER DIFFRACTION": "Fiber diffraction",
};
const QUERY = `query ($id: String!) {
  entry(entry_id: $id) {
    rcsb_id
    struct { title }
    exptl { method }
    rcsb_entry_info { resolution_combined deposited_atom_count deposited_polymer_entity_instance_count molecular_weight }
    rcsb_accession_info { initial_release_date }
    rcsb_primary_citation { title rcsb_journal_abbrev year pdbx_database_id_DOI }
    polymer_entities { rcsb_entity_source_organism { ncbi_scientific_name } rcsb_polymer_entity { pdbx_description } }
    nonpolymer_entities { nonpolymer_comp { chem_comp { id name } } }
  }
}`;

const $ = (id) => document.getElementById(id);

let viewer = null;
let model = null;
let entry = null;
let currentStyle = "cartoon";
let spinning = true;

function normalizeId(raw) {
  const value = String(raw || "").trim().replace(/^pdb_0000/i, "");
  return /^[1-9][a-z0-9]{3}$/i.test(value) ? value.toUpperCase() : null;
}

function tidy(text) {
  if (!text) return "";
  if (text !== text.toUpperCase()) return text;
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function methodLabel(method) {
  return METHODS[method] || tidy(method || "");
}

function setStatus(text) {
  $("peek-status").textContent = text;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function organismsOf(data) {
  return unique((data.polymer_entities || []).flatMap((entity) =>
    (entity.rcsb_entity_source_organism || []).map((org) => org.ncbi_scientific_name)));
}

function shortList(values, max) {
  return values.length > max ? `${values.slice(0, max).join(", ")} +${values.length - max}` : values.join(", ");
}

async function fetchEntry(id) {
  const response = await fetch("https://data.rcsb.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { id } }),
  });
  if (!response.ok) throw new Error(`RCSB answered ${response.status}.`);
  const json = await response.json();
  return json.data ? json.data.entry : null;
}

function renderEntry(id, data) {
  const info = data.rcsb_entry_info || {};
  const methods = unique((data.exptl || []).map((e) => methodLabel(e.method)));
  const resolution = info.resolution_combined && info.resolution_combined[0];
  const released = data.rcsb_accession_info && data.rcsb_accession_info.initial_release_date;
  const organisms = organismsOf(data);
  const title = tidy(data.struct && data.struct.title) || id;

  $("peek-title").textContent = title;
  $("peek-method").textContent = methods.join(", ");
  $("peek-meta").textContent = [
    resolution ? `${resolution.toFixed(2)} Å` : "",
    released ? released.slice(0, 4) : "",
    shortList(organisms, 2),
  ].filter(Boolean).join(" · ");
  if (mode === "full") document.title = `${id}: ${title} | PDB Peek`;

  if (mode !== "full") return;
  const molecules = unique((data.polymer_entities || []).map((e) => tidy(e.rcsb_polymer_entity && e.rcsb_polymer_entity.pdbx_description)));
  const ligands = unique((data.nonpolymer_entities || [])
    .map((e) => e.nonpolymer_comp && e.nonpolymer_comp.chem_comp)
    .filter((comp) => comp && !WATER.includes(comp.id))
    .map((comp) => `${comp.id} (${tidy(comp.name)})`));
  const facts = [
    ["Method", methods.join(", ")],
    ["Resolution", resolution ? `${resolution.toFixed(2)} Å` : ""],
    ["Released", released ? released.slice(0, 10) : ""],
    ["Weight", info.molecular_weight ? `${info.molecular_weight.toFixed(1)} kDa` : ""],
    ["Chains", info.deposited_polymer_entity_instance_count ? String(info.deposited_polymer_entity_instance_count) : ""],
    ["Atoms", info.deposited_atom_count ? info.deposited_atom_count.toLocaleString("en") : ""],
    ["Organism", organisms.join(", ")],
    ["Molecules", molecules.join("; ")],
    ["Ligands", ligands.join("; ")],
  ].filter(([, value]) => value);
  const list = $("peek-facts");
  list.replaceChildren();
  for (const [label, value] of facts) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
  const citation = data.rcsb_primary_citation;
  const cite = $("peek-citation");
  cite.replaceChildren();
  if (citation && citation.title) {
    cite.append(`${citation.title} ${[citation.rcsb_journal_abbrev, citation.year].filter(Boolean).join(" ")}. `);
    if (citation.pdbx_database_id_DOI) {
      const link = document.createElement("a");
      link.href = `https://doi.org/${citation.pdbx_database_id_DOI}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `doi:${citation.pdbx_database_id_DOI}`;
      cite.append(link);
    }
  }
  $("peek-details").hidden = false;
}

function stageColor() {
  return getComputedStyle(document.documentElement).getPropertyValue("--stage").trim() || "#ffffff";
}

function applyStyle() {
  if (!viewer || !model) return;
  const chains = new Set(model.selectedAtoms({}).map((atom) => atom.chain)).size;
  const hasPolymer = !entry || (entry.rcsb_entry_info || {}).deposited_polymer_entity_instance_count > 0;
  const noWater = { not: { resn: WATER } };
  const ligands = { hetflag: true, not: { resn: WATER } };
  const style = hasPolymer ? currentStyle : currentStyle === "cartoon" ? "stick" : currentStyle;
  viewer.setStyle({}, {});
  if (style === "cartoon") {
    viewer.setStyle({}, { cartoon: chains > 1 ? { colorscheme: "chain", arrows: true } : { color: "spectrum", arrows: true } });
    viewer.addStyle(ligands, { stick: { colorscheme: "Jmol", radius: 0.22 } });
  } else if (style === "stick") {
    viewer.setStyle(noWater, { stick: { colorscheme: "Jmol", radius: 0.16 } });
  } else {
    viewer.setStyle(noWater, { sphere: chains > 1 ? { colorscheme: "chain" } : { colorscheme: "Jmol" } });
  }
  viewer.render();
  for (const button of document.querySelectorAll("[data-style]")) {
    button.setAttribute("aria-pressed", String(button.dataset.style === currentStyle));
  }
}

function setSpin(on) {
  spinning = on;
  if (viewer) viewer.spin(on ? "y" : false, 0.6);
  $("peek-spin").setAttribute("aria-pressed", String(on));
}

async function loadStructure(id, atoms) {
  if (mode === "card" && atoms > CARD_ATOM_LIMIT) {
    setStatus(`Large structure (${atoms.toLocaleString("en")} atoms). Open the full view to load it in 3D.`);
    return;
  }
  if (atoms > FULL_ATOM_LIMIT) {
    setStatus(`Too large to preview here (${atoms.toLocaleString("en")} atoms). Open it in Mol* instead.`);
    return;
  }
  setStatus("Loading 3D…");
  const response = await fetch(`https://models.rcsb.org/${id}.bcif.gz`);
  if (!response.ok) throw new Error(`No 3D coordinates for ${id} (RCSB answered ${response.status}).`);
  const data = new Uint8Array(await response.arrayBuffer());
  viewer = $3Dmol.createViewer($("peek-3d"), { backgroundColor: stageColor(), antialias: true });
  model = viewer.addModel(data, "bcif", { noComputeSecondaryStructure: true });
  applyStyle();
  viewer.zoomTo();
  viewer.zoom(1.1);
  viewer.render();
  setSpin(spinning);
  setStatus("");
}

function openFullView(id) {
  const url = chrome.runtime.getURL(`viewer.html?mode=full&id=${encodeURIComponent(id)}`);
  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
  else window.open(url, "_blank", "noopener");
}

function wireControls(id) {
  $("peek-close").addEventListener("click", () => window.parent.postMessage({ pdbPeek: "close" }, "*"));
  $("peek-full").addEventListener("click", () => openFullView(id));
  $("peek-spin").addEventListener("click", () => setSpin(!spinning));
  $("peek-3d").addEventListener("pointerdown", () => setSpin(false));
  for (const button of document.querySelectorAll("[data-style]")) {
    button.addEventListener("click", () => {
      currentStyle = button.dataset.style;
      applyStyle();
    });
  }
  $("peek-png").addEventListener("click", () => {
    if (!viewer) return;
    const link = document.createElement("a");
    link.href = viewer.pngURI();
    link.download = `${id}-pdb-peek.png`;
    link.click();
  });
  addEventListener("resize", () => viewer && viewer.resize());
}

async function main() {
  const id = normalizeId(params.get("id"));
  $("peek-cta").href = CTA_URL;
  if (!id) {
    $("peek-title").textContent = "Not a PDB ID";
    setStatus("PDB IDs have four characters and start with a digit, like 1HHO or 6VXX.");
    document.querySelector(".peek-links").hidden = true;
    $("peek-close").addEventListener("click", () => window.parent.postMessage({ pdbPeek: "close" }, "*"));
    return;
  }
  $("peek-id").textContent = id;
  $("peek-id").href = `https://www.rcsb.org/structure/${id}`;
  $("link-rcsb").href = `https://www.rcsb.org/structure/${id}`;
  $("link-pdbe").href = `https://www.ebi.ac.uk/pdbe/entry/pdb/${id.toLowerCase()}`;
  $("link-molstar").href = `https://molstar.org/viewer/?pdb=${id}`;
  wireControls(id);
  if (mode === "full") document.title = `${id} | PDB Peek`;

  try {
    entry = await fetchEntry(id);
  } catch (error) {
    setStatus(`Could not reach RCSB: ${error.message}`);
    return;
  }
  if (!entry) {
    $("peek-title").textContent = `No PDB entry ${id}`;
    setStatus("RCSB has no current entry with this ID. It may be obsolete or not a PDB ID.");
    return;
  }
  renderEntry(id, entry);
  try {
    await loadStructure(id, (entry.rcsb_entry_info || {}).deposited_atom_count || 0);
  } catch (error) {
    setStatus(error.message);
  }
}

main();
