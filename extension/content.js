// PDB Peek content script: marks PDB IDs on the page and shows a 3D preview card on hover.
(() => {
  if (window.__pdbPeekLoaded) return;
  window.__pdbPeekLoaded = true;

  const ID_CLASS = "pdbpeek-id";
  const LINK_ATTR = "data-pdbpeek";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "BUTTON", "SVG", "CANVAS", "IFRAME", "HEAD", "TITLE", "MATH",
  ]);
  const MAX_TEXT_NODES = 40000;
  const SHOW_DELAY = 350;
  const HIDE_DELAY = 300;
  const CARD_WIDTH = 360;
  const CARD_HEIGHT = 430;

  // "PDB 1HHO", "PDB ID: 6VXX", "PDB codes 1ABC, 2DEF and 3GHI", "wwPDB entry 7K3G"
  const CONTEXT = /\b(?:ww|RCSB\s+)?PDB\b(?:[\s-]*(?:IDs?|codes?|entr(?:y|ies)|accessions?(?:\s+(?:codes?|numbers?))?|structures?|files?))?\s*(?:[:#=]|nos?\.)?[\s(\[]*/gi;
  const LIST_ID = /^(?:pdb_0000)?([1-9][a-z0-9]{3})(?![a-z0-9_])/i;
  const LIST_SEP = /^[\s)\]]*(?:,|;|\/|&|\band\b|\bor\b)[\s(\[]*/i;
  const DOI = /10\.2210\/pdb([1-9][a-z0-9]{3})\/pdb/gi;
  const QUICK_CHECK = /pdb|10\.2210/i;
  const LINK_PATTERNS = [
    /rcsb\.org\/(?:structure|3d-view|sequence|annotations|experimental|genome|ligands|versions)\/([1-9][a-z0-9]{3})(?![a-z0-9])/i,
    /rcsb\.org\/pdb\/explore(?:\.do)?\?(?:.*&)?structureId=([1-9][a-z0-9]{3})(?![a-z0-9])/i,
    /files\.rcsb\.org\/(?:download|view|header)\/([1-9][a-z0-9]{3})\./i,
    /ebi\.ac\.uk\/pdbe\/entry\/pdb\/([1-9][a-z0-9]{3})(?![a-z0-9])/i,
    /pdbj\.org\/mine\/(?:summary|structural_details|experimental_details)\/([1-9][a-z0-9]{3})(?![a-z0-9])/i,
    /ncbi\.nlm\.nih\.gov\/Structure\/pdb\/([1-9][a-z0-9]{3})(?![a-z0-9])/i,
    /molstar\.org\/viewer\/?\?(?:.*&)?pdb=([1-9][a-z0-9]{3})(?![a-z0-9])/i,
    /doi\.org\/10\.2210\/pdb([1-9][a-z0-9]{3})\/pdb/i,
  ];

  let enabled = true;
  let observer = null;
  let pending = new Set();
  let flushTimer = 0;
  let scannedNodes = 0;

  // ---------- finding IDs ----------

  function skipNode(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.classList.contains(ID_CLASS) || el.hasAttribute(LINK_ATTR)) return true;
      if (el.isContentEditable) return true;
    }
    return false;
  }

  // Parses "1ABC, 2DEF and 3GHI" from the start of text; returns [{start, end, id}] relative to offset.
  function parseIdList(text, offset) {
    const found = [];
    let pos = 0;
    for (;;) {
      const m = LIST_ID.exec(text.slice(pos));
      if (!m) break;
      const id = m[1].toUpperCase();
      // A text match needs a letter, so years such as "PDB 2023" are not taken for IDs.
      if (!/[A-Z]/.test(id)) break;
      found.push({ start: offset + pos, end: offset + pos + m[0].length, id });
      pos += m[0].length;
      const sep = LIST_SEP.exec(text.slice(pos));
      if (!sep) break;
      pos += sep[0].length;
    }
    return found;
  }

  function findMatches(text, carryContext) {
    const matches = [];
    if (carryContext) {
      const lead = /^[\s:#(\[]*/.exec(text)[0].length;
      matches.push(...parseIdList(text.slice(lead), lead));
    }
    let endsWithContext = false;
    CONTEXT.lastIndex = 0;
    let m;
    while ((m = CONTEXT.exec(text))) {
      const end = m.index + m[0].length;
      const list = parseIdList(text.slice(end), end);
      matches.push(...list);
      if (!list.length && !text.slice(end).trim()) endsWithContext = true;
      if (m[0].length === 0) CONTEXT.lastIndex++;
    }
    DOI.lastIndex = 0;
    while ((m = DOI.exec(text))) {
      const idStart = m.index + m[0].indexOf(m[1]);
      matches.push({ start: idStart, end: idStart + 4, id: m[1].toUpperCase() });
    }
    matches.sort((a, b) => a.start - b.start);
    const clean = [];
    for (const match of matches) {
      if (!clean.length || match.start >= clean[clean.length - 1].end) clean.push(match);
    }
    return { matches: clean, endsWithContext };
  }

  function wrapMatches(node, matches) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const { start, end, id } of matches) {
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
      const span = document.createElement("span");
      span.className = ID_CLASS;
      span.dataset.pdbpeekId = id;
      span.tabIndex = 0;
      span.textContent = text.slice(start, end);
      frag.appendChild(span);
      last = end;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  function idFromHref(href) {
    for (const pattern of LINK_PATTERNS) {
      const m = pattern.exec(href);
      if (m) return m[1].toUpperCase();
    }
    return null;
  }

  function markLinks(root) {
    const links = root.querySelectorAll ? root.querySelectorAll(`a[href]:not([${LINK_ATTR}])`) : [];
    const all = root.matches && root.matches("a[href]") ? [root, ...links] : links;
    for (const a of all) {
      if (a.hasAttribute(LINK_ATTR)) continue;
      const id = idFromHref(a.href);
      if (id) a.setAttribute(LINK_ATTR, id);
    }
  }

  function scan(root) {
    if (!enabled || !root || scannedNodes > MAX_TEXT_NODES) return;
    if (root.nodeType === Node.ELEMENT_NODE) markLinks(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const work = [];
    let carry = false;
    let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
    while (node && scannedNodes <= MAX_TEXT_NODES) {
      scannedNodes++;
      const text = node.nodeValue;
      if (text && text.trim()) {
        if ((carry || QUICK_CHECK.test(text)) && !skipNode(node)) {
          const { matches, endsWithContext } = findMatches(text, carry);
          if (matches.length) work.push([node, matches]);
          carry = endsWithContext;
        } else {
          carry = false;
        }
      }
      node = root.nodeType === Node.TEXT_NODE ? null : walker.nextNode();
    }
    for (const [textNode, matches] of work) {
      if (textNode.parentNode) wrapMatches(textNode, matches);
    }
  }

  function unwrapAll() {
    for (const span of document.querySelectorAll(`.${ID_CLASS}`)) {
      span.replaceWith(document.createTextNode(span.textContent));
    }
    for (const a of document.querySelectorAll(`a[${LINK_ATTR}]`)) a.removeAttribute(LINK_ATTR);
    document.body && document.body.normalize();
  }

  function startObserving() {
    if (observer || !document.body) return;
    observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE || added.nodeType === Node.TEXT_NODE) pending.add(added);
        }
      }
      if (pending.size && !flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = 0;
          const roots = [...pending];
          pending = new Set();
          observer.disconnect();
          for (const root of roots) if (root.isConnected) scan(root);
          observer.observe(document.body, { childList: true, subtree: true });
        }, 400);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserving() {
    if (observer) observer.disconnect();
    observer = null;
    pending = new Set();
    clearTimeout(flushTimer);
    flushTimer = 0;
  }

  // ---------- preview card ----------

  let card = null;
  let cardId = null;
  let anchor = null;
  let pinned = false;
  let showTimer = 0;
  let hideTimer = 0;

  function targetOf(el) {
    return el && el.closest ? el.closest(`.${ID_CLASS}, a[${LINK_ATTR}]`) : null;
  }

  function idOf(el) {
    return el.dataset.pdbpeekId || el.getAttribute(LINK_ATTR);
  }

  function ensureCard() {
    if (card) return card;
    card = document.createElement("iframe");
    card.setAttribute("title", "PDB Peek structure preview");
    card.setAttribute("allow", "clipboard-write");
    const style = {
      all: "initial",
      position: "fixed",
      "z-index": "2147483647",
      width: `${CARD_WIDTH}px`,
      height: `${CARD_HEIGHT}px`,
      border: "0",
      "border-radius": "12px",
      "box-shadow": "0 12px 40px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.08)",
      "color-scheme": "normal",
      background: "transparent",
      display: "none",
    };
    for (const [key, value] of Object.entries(style)) card.style.setProperty(key, value, "important");
    card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    card.addEventListener("mouseleave", scheduleHide);
    document.documentElement.appendChild(card);
    return card;
  }

  function place() {
    if (!card || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) {
      if (!pinned) hide();
      return;
    }
    const margin = 8;
    let top = rect.bottom + 6;
    if (top + CARD_HEIGHT > innerHeight - margin && rect.top - CARD_HEIGHT - 6 > margin) top = rect.top - CARD_HEIGHT - 6;
    top = Math.max(margin, Math.min(top, innerHeight - CARD_HEIGHT - margin));
    let left = rect.left;
    left = Math.max(margin, Math.min(left, innerWidth - CARD_WIDTH - margin));
    card.style.setProperty("top", `${top}px`, "important");
    card.style.setProperty("left", `${left}px`, "important");
  }

  function show(el) {
    const id = idOf(el);
    if (!id) return;
    ensureCard();
    anchor = el;
    if (cardId !== id) {
      cardId = id;
      card.src = chrome.runtime.getURL(`viewer.html?mode=card&id=${encodeURIComponent(id)}`);
    }
    card.style.setProperty("display", "block", "important");
    place();
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    pinned = false;
    if (card) card.style.setProperty("display", "none", "important");
    anchor = null;
  }

  function scheduleHide() {
    clearTimeout(showTimer);
    if (pinned) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY);
  }

  document.addEventListener("mouseover", (event) => {
    const target = targetOf(event.target);
    if (!target || !enabled) return;
    clearTimeout(hideTimer);
    if (anchor === target && card && card.style.display !== "none") return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(target), SHOW_DELAY);
  }, true);

  document.addEventListener("mouseout", (event) => {
    const target = targetOf(event.target);
    if (!target) return;
    if (event.relatedTarget && (target.contains(event.relatedTarget) || event.relatedTarget === card)) return;
    scheduleHide();
  }, true);

  document.addEventListener("click", (event) => {
    const target = targetOf(event.target);
    if (target && target.classList.contains(ID_CLASS) && !target.closest("a")) {
      clearTimeout(showTimer);
      show(target);
      pinned = true;
      return;
    }
    if (!target && card && card.style.display !== "none") hide();
  }, true);

  document.addEventListener("focusin", (event) => {
    const target = targetOf(event.target);
    if (target && target.classList.contains(ID_CLASS)) show(target);
  });

  document.addEventListener("focusout", (event) => {
    if (targetOf(event.target)) scheduleHide();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && card && card.style.display !== "none") hide();
  });

  addEventListener("scroll", place, { passive: true, capture: true });
  addEventListener("resize", place, { passive: true });

  addEventListener("message", (event) => {
    if (!card || event.source !== card.contentWindow) return;
    const data = event.data || {};
    if (data.pdbPeek === "close") hide();
  });

  // ---------- settings ----------

  function setEnabled(value) {
    enabled = value;
    if (enabled) {
      scannedNodes = 0;
      scan(document.body);
      startObserving();
    } else {
      hide();
      stopObserving();
      unwrapAll();
    }
  }

  chrome.storage.sync.get({ enabled: true }, (settings) => setEnabled(settings.enabled !== false));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.enabled) setEnabled(changes.enabled.newValue !== false);
  });
})();
