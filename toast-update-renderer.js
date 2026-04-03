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

actionBtn.addEventListener("click", () => {
  if (!actionBtn.disabled) {
    window.updateAPI.installUpdate();
  }
});

window.updateAPI.onUpdateStatus((data) => {
  if (data.status === "downloading") {
    const pct = data.percent ? Math.round(data.percent) : 0;
    progressFill.style.width = pct + "%";
    progressLabel.textContent = pct + "% downloaded";
    titleEl.textContent = "Downloading update";
    subtitleEl.textContent = "A new version of qgn is downloading";
    actionBtn.textContent = "Downloading...";
    actionBtn.disabled = true;
    progressArea.style.display = "";
  } else if (data.status === "ready") {
    titleEl.textContent = "Ready to update";
    subtitleEl.textContent = "The new version has been downloaded";
    progressFill.style.width = "100%";
    progressLabel.textContent = "Download complete";
    actionBtn.textContent = "Update & relaunch";
    actionBtn.disabled = false;
  } else if (data.status === "error") {
    titleEl.textContent = "Update failed";
    subtitleEl.textContent = data.message || "Something went wrong";
    progressArea.style.display = "none";
    actionBtn.textContent = "Dismiss";
    actionBtn.disabled = false;
    actionBtn.onclick = () => window.updateAPI.dismiss();
  }
});
