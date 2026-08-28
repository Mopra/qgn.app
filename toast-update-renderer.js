const titleEl = document.getElementById("title");
const subtitleEl = document.getElementById("subtitle");
const progressArea = document.getElementById("progress-area");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const actionBtn = document.getElementById("action-btn");

document.getElementById("btn-close").addEventListener("click", () => {
  window.updateAPI.dismiss();
});

document.getElementById("link-later").addEventListener("click", () => {
  window.updateAPI.dismiss();
});

document.getElementById("link-star").addEventListener("click", () => {
  window.updateAPI.star();
});

document.getElementById("link-notes").addEventListener("click", () => {
  window.updateAPI.openNotes();
});

// What the primary button does depends on where the update got to. Swapping
// the behaviour through this flag (rather than adding a second listener) is
// what stops a failed update's "Dismiss" from also firing quitAndInstall.
let actionMode = "install"; // install | dismiss

actionBtn.addEventListener("click", () => {
  if (actionBtn.disabled) return;
  if (actionMode === "dismiss") window.updateAPI.dismiss();
  else window.updateAPI.installUpdate();
});

// Name the version being installed so "What's new" has an obvious subject.
function versionSuffix(data) {
  return data && data.version ? " " + data.version : "";
}

window.updateAPI.onUpdateStatus((data) => {
  if (data.status === "downloading") {
    const pct = data.percent ? Math.round(data.percent) : 0;
    progressFill.style.width = pct + "%";
    progressLabel.textContent = pct + "% downloaded";
    titleEl.textContent = "Downloading update";
    subtitleEl.textContent = "QGN" + versionSuffix(data) + " is downloading";
    actionBtn.textContent = "Downloading...";
    actionBtn.disabled = true;
    actionMode = "install";
    progressArea.style.display = "";
  } else if (data.status === "ready") {
    titleEl.textContent = "Ready to update";
    subtitleEl.textContent = "QGN" + versionSuffix(data) + " is ready to install";
    progressFill.style.width = "100%";
    progressLabel.textContent = "Download complete";
    actionBtn.textContent = "Update & relaunch";
    actionBtn.disabled = false;
    actionMode = "install";
  } else if (data.status === "error") {
    titleEl.textContent = "Update failed";
    subtitleEl.textContent = data.message || "Something went wrong";
    progressArea.style.display = "none";
    actionBtn.textContent = "Dismiss";
    actionBtn.disabled = false;
    actionMode = "dismiss";
  }
});
