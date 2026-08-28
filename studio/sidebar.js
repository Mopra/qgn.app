/* QGN Studio sidebar: background, frame and layout controls.

   One copy, shared by stills and clips. Previously this file existed twice,
   once in studio.html and once in video-studio.html, and had already started
   to drift. */

/* ───────────────────────── Swatch helpers ───────────────────────── */
function gradientCss(gr) {
  const stops = gr.stops.map(([p, c]) => `${c} ${Math.round(p * 100)}%`).join(", ");
  return `linear-gradient(${gr.angle}deg, ${stops})`;
}
function wallpaperCss(wp) {
  const layers = wp.blobs.map((b) =>
    `radial-gradient(circle at ${Math.round(b.x * 100)}% ${Math.round(b.y * 100)}%, ${b.c} 0%, transparent ${Math.round(b.r * 55)}%)`
  );
  return `${layers.join(", ")}, ${wp.base}`;
}

function buildSwatches(container, presets, css, getId, setId, onSelect) {
  container.innerHTML = "";
  for (const p of presets) {
    const el = document.createElement("div");
    el.className = "swatch" + (getId() === p.id ? " active" : "");
    el.style.background = css(p);
    el.dataset.id = p.id;
    el.addEventListener("click", () => {
      setId(p.id);
      container.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.id === p.id));
      if (onSelect) onSelect(p.id);
      requestPaint();
    });
    container.appendChild(el);
  }
}

/* ───────────────────────── Gradient palette ───────────────────────── */
let gradSeq = 0;
function gradientUid() { return "g" + Date.now().toString(36) + "-" + (gradSeq++); }
function gradientKey(angle, c0, c1) { return angle + "|" + c0 + "|" + c1; }

// The editor only shows while the custom gradient swatch is selected.
function updateGradientCustomVisibility() {
  const show = state.bgMode === "gradient" && state.gradientId === "custom";
  document.getElementById("gradientCustomPanel").classList.toggle("hidden", !show);
}
function refreshCustomSwatch() {
  const el = document.getElementById("gradientSwatches").querySelector(".swatch.custom");
  if (el) el.style.background = gradientCss(buildCustomGradient());
}
function setActiveGradient(id) {
  state.gradientId = id;
  document.getElementById("gradientSwatches")
    .querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.id === id));
}

// A selectable gradient swatch. Pass removeId to add a hover x that deletes a
// saved gradient from the palette.
function makeGradientSwatch(id, background, removeId) {
  const el = document.createElement("div");
  el.className = "swatch" + (state.gradientId === id ? " active" : "");
  el.style.background = background;
  el.dataset.id = id;
  el.addEventListener("click", () => {
    setActiveGradient(id);
    updateGradientCustomVisibility();
    requestPaint();
  });
  if (removeId) {
    const rm = document.createElement("div");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = "Remove from palette";
    rm.addEventListener("click", (e) => { e.stopPropagation(); removeSavedGradient(removeId); });
    el.appendChild(rm);
  }
  return el;
}

// Grid order: built-in presets, then user-saved gradients, then the custom
// gradient editor trigger (pencil) at the very end.
function renderGradientSwatches() {
  const container = document.getElementById("gradientSwatches");
  container.innerHTML = "";
  for (const p of GRADIENTS) container.appendChild(makeGradientSwatch(p.id, gradientCss(p), null));
  for (const g of savedGradients) container.appendChild(makeGradientSwatch(g.id, gradientCss(gradientFromSaved(g)), g.id));
  const customEl = document.createElement("div");
  customEl.className = "swatch custom" + (state.gradientId === "custom" ? " active" : "");
  customEl.dataset.id = "custom";
  customEl.title = "Custom gradient";
  customEl.style.background = gradientCss(buildCustomGradient());
  customEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  customEl.addEventListener("click", () => {
    setActiveGradient("custom");
    updateGradientCustomVisibility();
    requestPaint();
  });
  container.appendChild(customEl);
}

function persistGradients() {
  window.studio.saveGradients(savedGradients.map((g) => ({ angle: g.angle, c0: g.c0, c1: g.c1 })));
}

// Save the gradient currently in the editor to the palette (deduped by content).
function addSavedGradient() {
  const c0 = normHex(state.gradientCustom.c0);
  const c1 = normHex(state.gradientCustom.c1);
  if (!c0 || !c1) return;
  const angle = ((Math.round(state.gradientCustom.angle) % 360) + 360) % 360;
  const key = gradientKey(angle, c0, c1);
  if (savedGradients.some((g) => gradientKey(g.angle, g.c0, g.c1) === key)) return; // already saved
  savedGradients.unshift({ id: gradientUid(), angle, c0, c1 });
  if (savedGradients.length > MAX_SAVED_GRADIENTS) savedGradients = savedGradients.slice(0, MAX_SAVED_GRADIENTS);
  persistGradients();
  renderGradientSwatches();
}

function removeSavedGradient(id) {
  savedGradients = savedGradients.filter((g) => g.id !== id);
  persistGradients();
  if (state.gradientId === id) { state.gradientId = "indigo"; requestPaint(); }
  renderGradientSwatches();
}

/* ───────────────────────── Solid color palette ───────────────────────── */
let savedColors = [];

function renderPalette() {
  const solidPalette = document.getElementById("solidPalette");
  solidPalette.innerHTML = "";
  const current = normHex(state.solidColor);
  for (const hex of savedColors) {
    const el = document.createElement("div");
    el.className = "pal" + (hex === current ? " active" : "");
    el.style.background = hex;
    el.dataset.hex = hex;
    el.title = hex;
    el.addEventListener("click", () => applySolid(hex, false));
    const rm = document.createElement("div");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = "Remove from palette";
    rm.addEventListener("click", (e) => { e.stopPropagation(); removeSavedColor(hex); });
    el.appendChild(rm);
    solidPalette.appendChild(el);
  }
}

// Persist the whole palette (main process validates and caps it too).
function persistColors() { window.studio.saveColors(savedColors); }

// Add a color to the front of the palette (most-recent first), de-duped.
function addSavedColor(value) {
  const hex = normHex(value);
  if (!hex) return;
  savedColors = savedColors.filter((c) => c !== hex);
  savedColors.unshift(hex);
  if (savedColors.length > MAX_SAVED_COLORS) savedColors = savedColors.slice(0, MAX_SAVED_COLORS);
  persistColors();
  renderPalette();
}

function removeSavedColor(hex) {
  savedColors = savedColors.filter((c) => c !== hex);
  persistColors();
  renderPalette();
}

// Apply a solid color to state + inputs. addToPalette saves it for reuse.
function applySolid(value, addToPalette) {
  const hex = normHex(value);
  if (!hex) return;
  state.solidColor = hex;
  document.getElementById("solidColor").value = hex;
  document.getElementById("solidHex").value = hex;
  if (addToPalette) addSavedColor(hex);
  else renderPalette();
  requestPaint();
}

/* ───────────────────────── Background mode ───────────────────────── */
function setBgMode(mode) {
  state.bgMode = mode;
  const panels = {
    gradient: document.getElementById("gradientSwatches"),
    wallpaper: document.getElementById("wallpaperSwatches"),
    solid: document.getElementById("solidPanel"),
    image: document.getElementById("imagePanel"),
  };
  document.querySelectorAll("#bgTabs .seg").forEach((b) => b.classList.toggle("active", b.dataset.bg === mode));
  for (const key in panels) panels[key].classList.toggle("hidden", key !== mode);
  updateGradientCustomVisibility();
  requestPaint();
}

/* ───────────────────────── Sliders ───────────────────────── */
function bindSlider(rangeId, valueId, apply) {
  const range = document.getElementById(rangeId);
  const value = document.getElementById(valueId);
  range.addEventListener("input", () => {
    value.textContent = range.value;
    apply(range.value / 100);
    requestPaint();
  });
}

/* ───────────────────────── Wiring ───────────────────────── */
function initSidebar() {
  renderGradientSwatches();

  // Load the saved gradient palette from disk on open.
  window.studio.getGradients().then((list) => {
    if (!Array.isArray(list)) return;
    savedGradients = list.map((g) => {
      const c0 = normHex(g && g.c0);
      const c1 = normHex(g && g.c1);
      if (!c0 || !c1) return null;
      let angle = Number(g && g.angle);
      if (!Number.isFinite(angle)) angle = 135;
      angle = ((Math.round(angle) % 360) + 360) % 360;
      return { id: gradientUid(), angle, c0, c1 };
    }).filter(Boolean).slice(0, MAX_SAVED_GRADIENTS);
    renderGradientSwatches();
  }).catch(() => {});

  document.getElementById("saveGradientBtn").addEventListener("click", addSavedGradient);

  // Custom gradient editor inputs (start/end color + angle).
  function bindGradientColor(colorId, hexId, key) {
    const colorEl = document.getElementById(colorId);
    const hexEl = document.getElementById(hexId);
    colorEl.addEventListener("input", () => {
      state.gradientCustom[key] = colorEl.value;
      hexEl.value = colorEl.value.toUpperCase();
      refreshCustomSwatch();
      requestPaint();
    });
    hexEl.addEventListener("input", () => {
      const hex = normHex(hexEl.value);
      if (hex) {
        state.gradientCustom[key] = hex;
        colorEl.value = hex;
        refreshCustomSwatch();
        requestPaint();
      }
    });
  }
  bindGradientColor("gradC0", "gradC0Hex", "c0");
  bindGradientColor("gradC1", "gradC1Hex", "c1");

  const gradAngle = document.getElementById("gradAngle");
  const gradAngleValue = document.getElementById("gradAngleValue");
  gradAngle.addEventListener("input", () => {
    state.gradientCustom.angle = +gradAngle.value;
    gradAngleValue.textContent = gradAngle.value + "°";
    refreshCustomSwatch();
    requestPaint();
  });

  buildSwatches(
    document.getElementById("wallpaperSwatches"), WALLPAPERS, wallpaperCss,
    () => state.wallpaperId, (id) => { state.wallpaperId = id; }
  );

  document.querySelectorAll("#bgTabs .seg").forEach((b) => {
    b.addEventListener("click", () => setBgMode(b.dataset.bg));
  });

  // Solid color: live updates while dragging / typing, palette write on commit.
  const solidColor = document.getElementById("solidColor");
  const solidHex = document.getElementById("solidHex");
  solidColor.addEventListener("input", () => {
    state.solidColor = solidColor.value;
    solidHex.value = solidColor.value.toUpperCase();
    renderPalette();
    requestPaint();
  });
  solidHex.addEventListener("input", () => {
    const hex = normHex(solidHex.value);
    if (hex) {
      state.solidColor = hex;
      solidColor.value = hex;
      renderPalette();
      requestPaint();
    }
  });
  solidColor.addEventListener("change", () => addSavedColor(solidColor.value));
  solidHex.addEventListener("change", () => addSavedColor(solidHex.value));

  window.studio.getColors().then((colors) => {
    if (Array.isArray(colors)) {
      savedColors = colors.map(normHex).filter(Boolean).slice(0, MAX_SAVED_COLORS);
      renderPalette();
    }
  }).catch(() => {});

  // Background image upload.
  const fileInput = document.getElementById("fileInput");
  const uploadBtn = document.getElementById("uploadBtn");
  const uploadLabel = document.getElementById("uploadLabel");
  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const im = new Image();
      im.onload = () => {
        state.customImage = im;
        uploadBtn.classList.add("has-image");
        uploadLabel.textContent = file.name.length > 24 ? file.name.slice(0, 22) + "…" : file.name;
        requestPaint();
      };
      im.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  // Frame.
  const browserOptions = document.getElementById("browserOptions");
  document.querySelectorAll("#frameTabs .seg").forEach((b) => {
    b.addEventListener("click", () => {
      state.frame = b.dataset.frame;
      document.querySelectorAll("#frameTabs .seg").forEach((s) => s.classList.toggle("active", s === b));
      browserOptions.classList.toggle("hidden", state.frame !== "browser");
      requestPaint();
    });
  });
  document.querySelectorAll("#frameThemeTabs .seg").forEach((b) => {
    b.addEventListener("click", () => {
      state.frameTheme = b.dataset.theme;
      document.querySelectorAll("#frameThemeTabs .seg").forEach((s) => s.classList.toggle("active", s === b));
      requestPaint();
    });
  });
  const urlInput = document.getElementById("urlInput");
  urlInput.addEventListener("input", () => { state.url = urlInput.value; requestPaint(); });

  // Aspect.
  document.querySelectorAll("#aspectTabs .seg").forEach((b) => {
    b.addEventListener("click", () => {
      state.aspect = b.dataset.aspect;
      document.querySelectorAll("#aspectTabs .seg").forEach((s) => s.classList.toggle("active", s === b));
      requestPaint();
    });
  });

  bindSlider("padRange", "padValue", (f) => { state.padPct = f * 0.25; });
  bindSlider("radiusRange", "radiusValue", (f) => { state.radiusPct = f * 0.05; });
  bindSlider("shadowRange", "shadowValue", (f) => { state.shadowPct = f * 0.12; });
}

// Reflect the current state back into the sidebar widgets. Used when a mode
// switch changes the scene defaults underneath the UI.
function syncSidebarToState() {
  document.querySelectorAll("#frameTabs .seg").forEach((s) => s.classList.toggle("active", s.dataset.frame === state.frame));
  document.getElementById("browserOptions").classList.toggle("hidden", state.frame !== "browser");
  document.querySelectorAll("#aspectTabs .seg").forEach((s) => s.classList.toggle("active", s.dataset.aspect === state.aspect));
  const pad = document.getElementById("padRange");
  const radius = document.getElementById("radiusRange");
  const shadow = document.getElementById("shadowRange");
  pad.value = Math.round((state.padPct / 0.25) * 100);
  radius.value = Math.round((state.radiusPct / 0.05) * 100);
  shadow.value = Math.round((state.shadowPct / 0.12) * 100);
  document.getElementById("padValue").textContent = pad.value;
  document.getElementById("radiusValue").textContent = radius.value;
  document.getElementById("shadowValue").textContent = shadow.value;
}
