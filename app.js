const videosEl = document.querySelector("#videos");
const loginScreen = document.querySelector("#loginScreen");
const loginForm = document.querySelector("#loginForm");
const passwordEl = document.querySelector("#password");
const loginStatusEl = document.querySelector("#loginStatus");
const emptyEl = document.querySelector("#empty");
const counterEl = document.querySelector("#counter");
const form = document.querySelector("#uploadForm");
const categoryEl = document.querySelector("#category");
const fileEl = document.querySelector("#videoFile");
const fileNameEl = document.querySelector("#fileName");
const statusEl = document.querySelector("#status");
const progressEl = document.querySelector("#progress");
const tabs = document.querySelectorAll(".tabs button");

let videos = [];
let activeFilter = "all";

const categoryLabels = {
  noa: "הסרטונים של נועה",
  maya: "הסרטונים של מאיה",
  ready: "סרטונים מוכנים"
};

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("he-IL", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function render() {
  const visible = activeFilter === "all" ? videos : videos.filter((video) => video.category === activeFilter);
  counterEl.textContent = `${videos.length} ${videos.length === 1 ? "סרטון" : "סרטונים"}`;
  emptyEl.classList.toggle("show", visible.length === 0);

  videosEl.innerHTML = visible
    .map((video) => {
      const url = `/api/videos/${video.id}/file`;
      return `
        <article class="video-card">
          <video controls preload="metadata" src="${url}"></video>
          <div class="video-info">
            <p class="video-title">${escapeHtml(video.originalName)}</p>
            <p class="video-meta">${categoryLabels[video.category]} · ${formatBytes(video.size)} · ${formatDate(video.createdAt)}</p>
            <div class="video-actions">
              <a href="${url}" download="${escapeHtml(video.originalName)}">הורדת מקור</a>
              <button type="button" data-delete="${video.id}">מחיקה</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char];
  });
}

async function loadVideos() {
  const response = await fetch("/api/videos");
  if (response.status === 401) {
    loginScreen.hidden = false;
    return;
  }
  videos = await response.json();
  loginScreen.hidden = true;
  render();
}

function uploadVideo(file, category) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `/api/videos?category=${encodeURIComponent(category)}&name=${encodeURIComponent(file.name)}`;
    xhr.open("POST", url);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      progressEl.style.width = `${percent}%`;
      statusEl.textContent = `מעלה ${percent}%`;
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error("Upload failed"));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.send(file);
  });
}

fileEl.addEventListener("change", () => {
  fileNameEl.textContent = fileEl.files[0]?.name || "בחירת סרטון";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileEl.files[0];
  if (!file) return;

  const button = form.querySelector("button");
  button.disabled = true;
  statusEl.textContent = "מתחיל העלאה";
  progressEl.style.width = "0%";

  try {
    const video = await uploadVideo(file, categoryEl.value);
    videos.unshift(video);
    fileEl.value = "";
    fileNameEl.textContent = "בחירת סרטון";
    statusEl.textContent = "הסרטון נשמר באיכות המקורית";
    render();
  } catch {
    statusEl.textContent = "ההעלאה נכשלה";
  } finally {
    button.disabled = false;
  }
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeFilter = tab.dataset.filter;
    tabs.forEach((item) => item.classList.toggle("active", item === tab));
    render();
  });
});

videosEl.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete]");
  if (!button) return;
  const id = button.dataset.delete;

  if (!confirm("למחוק את הסרטון הזה?")) return;
  await fetch(`/api/videos/${id}`, { method: "DELETE" });
  videos = videos.filter((video) => video.id !== id);
  render();
});

loadVideos();

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginStatusEl.textContent = "";

  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: passwordEl.value })
  });

  if (!response.ok) {
    loginStatusEl.textContent = "סיסמה לא נכונה";
    return;
  }

  passwordEl.value = "";
  await loadVideos();
});
