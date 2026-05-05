import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPublicDir = path.join(__dirname, "public");
const publicDir = await access(defaultPublicDir).then(() => defaultPublicDir).catch(() => __dirname);
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dataFile = path.join(dataDir, "videos.json");
const port = Number(process.env.PORT || 5177);
const sharePassword = process.env.SHARE_PASSWORD || "";
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024 * 1024);

const categories = new Set(["noa", "maya", "ready"]);
const categoryLabels = {
  noa: "הסרטונים של נועה",
  maya: "הסרטונים של מאיה",
  ready: "סרטונים מוכנים"
};

await mkdir(uploadsDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

async function readVideos() {
  try {
    return JSON.parse(await readFile(dataFile, "utf8"));
  } catch {
    return [];
  }
}

async function writeVideos(videos) {
  await writeFile(dataFile, JSON.stringify(videos, null, 2));
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function isAuthed(req) {
  if (!sharePassword) return true;
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)family_video_auth=([^;]+)/);
  if (!match) return false;

  const expected = Buffer.from(sharePassword);
  const actual = Buffer.from(decodeURIComponent(match[1]));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  sendJson(res, 401, { error: "צריך סיסמה כדי להיכנס." });
  return false;
}

async function handleLogin(req, res) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4096) req.destroy();
  });
  req.on("end", () => {
    try {
      const { password = "" } = JSON.parse(body || "{}");
      if (!sharePassword || password !== sharePassword) {
        return sendJson(res, 401, { error: "סיסמה לא נכונה." });
      }
      res.writeHead(204, {
        "set-cookie": `family_video_auth=${encodeURIComponent(sharePassword)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`
      });
      res.end();
    } catch {
      sendJson(res, 400, { error: "בקשה לא תקינה." });
    }
  });
}

function safeName(name) {
  const base = path.basename(name || "video");
  return base.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "video";
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
}

async function serveStatic(req, res, pathname) {
  const decoded = decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(publicDir, decoded === "/" ? "index.html" : decoded));
  if (!filePath.startsWith(publicDir)) return sendText(res, 403, "Forbidden");

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return sendText(res, 404, "Not found");
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "content-length": fileStat.size
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function serveVideo(req, res, id) {
  const videos = await readVideos();
  const video = videos.find((item) => item.id === id);
  if (!video) return sendText(res, 404, "Video not found");

  const filePath = path.join(uploadsDir, video.storedName);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return sendText(res, 404, "File missing");
  }

  const range = req.headers.range;
  const headers = {
    "accept-ranges": "bytes",
    "content-type": video.type || contentType(video.originalName),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(video.originalName)}`
  };

  if (!range) {
    res.writeHead(200, { ...headers, "content-length": fileStat.size });
    return createReadStream(filePath).pipe(res);
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) return sendText(res, 416, "Invalid range");

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : fileStat.size - 1;
  if (start >= fileStat.size || end >= fileStat.size || start > end) {
    res.writeHead(416, { "content-range": `bytes */${fileStat.size}` });
    return res.end();
  }

  res.writeHead(206, {
    ...headers,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${fileStat.size}`
  });
  createReadStream(filePath, { start, end }).pipe(res);
}

async function handleUpload(req, res, url) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > maxUploadBytes) {
    return sendJson(res, 413, { error: "הקובץ גדול מהמגבלה שהוגדרה." });
  }

  const category = url.searchParams.get("category");
  if (!categories.has(category)) {
    return sendJson(res, 400, { error: "צריך לבחור קטגוריה תקינה." });
  }

  const originalName = safeName(url.searchParams.get("name"));
  const ext = path.extname(originalName) || ".video";
  const id = randomUUID();
  const storedName = `${id}${ext}`;
  const tempPath = path.join(uploadsDir, `${storedName}.uploading`);
  const finalPath = path.join(uploadsDir, storedName);
  const file = createWriteStream(tempPath);
  let bytes = 0;

  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > maxUploadBytes) {
      req.destroy();
      file.destroy(new Error("Upload too large"));
    }
  });

  req.pipe(file);

  file.on("finish", async () => {
    try {
      await rename(tempPath, finalPath);
      const videos = await readVideos();
      const video = {
        id,
        category,
        categoryLabel: categoryLabels[category],
        originalName,
        storedName,
        type: req.headers["content-type"] || "application/octet-stream",
        size: bytes,
        createdAt: new Date().toISOString()
      };
      videos.unshift(video);
      await writeVideos(videos);
      sendJson(res, 201, video);
    } catch (error) {
      sendJson(res, 500, { error: "ההעלאה נכשלה." });
    }
  });

  file.on("error", async () => {
    await unlink(tempPath).catch(() => {});
    sendJson(res, 500, { error: "לא היה אפשר לשמור את הקובץ." });
  });
}

async function handleDelete(req, res, id) {
  const videos = await readVideos();
  const video = videos.find((item) => item.id === id);
  if (!video) return sendJson(res, 404, { error: "הסרטון לא נמצא." });

  await unlink(path.join(uploadsDir, video.storedName)).catch(() => {});
  await writeVideos(videos.filter((item) => item.id !== id));
  sendJson(res, 200, { ok: true });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "POST" && url.pathname === "/api/login") {
      return handleLogin(req, res);
    }

    if (url.pathname.startsWith("/api/") && !requireAuth(req, res)) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/videos") {
      const videos = await readVideos();
      return sendJson(res, 200, videos);
    }

    if (req.method === "POST" && url.pathname === "/api/videos") {
      return handleUpload(req, res, url);
    }

    const videoMatch = url.pathname.match(/^\/api\/videos\/([^/]+)\/file$/);
    if (req.method === "GET" && videoMatch) {
      if (!requireAuth(req, res)) return;
      return serveVideo(req, res, videoMatch[1]);
    }

    const deleteMatch = url.pathname.match(/^\/api\/videos\/([^/]+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      return handleDelete(req, res, deleteMatch[1]);
    }

    return serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: "שגיאה בשרת." });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Family video share is running on http://localhost:${port}`);
});
