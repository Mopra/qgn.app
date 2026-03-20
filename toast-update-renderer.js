const messageEl = document.getElementById("message");
const actionBtn = document.getElementById("action-btn");

window.updateAPI.onUpdateStatus((data) => {
  if (data.status === "downloading") {
    messageEl.textContent = `Downloading update… ${data.percent ? Math.round(data.percent) + "%" : ""}`;
    actionBtn.style.display = "none";
  } else if (data.status === "ready") {
    messageEl.textContent = "Update ready";
    actionBtn.textContent = "Restart";
    actionBtn.style.display = "";
  }
});
