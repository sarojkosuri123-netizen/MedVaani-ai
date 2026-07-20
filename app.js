// ============================================
// MedVaani AI — app.js
// Pipeline: Image Capture -> OCR -> Correction -> Translation -> Warning Detection -> Voice Output
// ============================================

import { saveScan, getRecentScans } from "./firebase-config.js";

// ---- Warning keywords (hand-curated, no dataset needed) ----
const WARNING_KEYWORDS = [
  "not for pregnant",
  "pregnant women",
  "avoid alcohol",
  "do not exceed",
  "consult doctor",
  "consult your doctor",
  "keep out of reach of children",
  "may cause drowsiness",
  "do not take with",
  "overdose",
  "allergic reaction",
  "discontinue use",
  "not recommended for children",
  "before food",
  "after food",
];

// ---- DOM references ----
const imageInput = document.getElementById("imageInput");
const captureBtn = document.getElementById("captureBtn");
const imagePreviewWrap = document.getElementById("imagePreviewWrap");
const imagePreview = document.getElementById("imagePreview");
const rotateBtn = document.getElementById("rotateBtn");

let originalImageDataUrl = null; // keep the unrotated original so rotations don't compound errors
let currentRotation = 0; // degrees: 0, 90, 180, 270

const ocrSection = document.getElementById("ocr-section");
const ocrLoading = document.getElementById("ocrLoading");
const ocrText = document.getElementById("ocrText");
const confirmTextBtn = document.getElementById("confirmTextBtn");

const translateSection = document.getElementById("translate-section");
const languageSelect = document.getElementById("languageSelect");
const translateBtn = document.getElementById("translateBtn");
const translateLoading = document.getElementById("translateLoading");

const resultsSection = document.getElementById("results-section");
const dangerBadge = document.getElementById("dangerBadge");
const translatedTextEl = document.getElementById("translatedText");
const warningsBlock = document.getElementById("warningsBlock");
const warningsList = document.getElementById("warningsList");
const speakBtn = document.getElementById("speakBtn");
const resetBtn = document.getElementById("resetBtn");

const historyLoading = document.getElementById("historyLoading");
const historyList = document.getElementById("historyList");
const refreshHistoryBtn = document.getElementById("refreshHistoryBtn");

let currentTranslatedText = "";
let currentLangCode = "en";

// ---- Step 1: Image capture ----
captureBtn.addEventListener("click", () => imageInput.click());

imageInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    originalImageDataUrl = evt.target.result;
    currentRotation = 0;
    imagePreview.src = originalImageDataUrl;
    imagePreviewWrap.classList.remove("hidden");

    preprocessImage(originalImageDataUrl).then((processedDataUrl) => {
      runOCR(processedDataUrl);
    });
  };
  reader.readAsDataURL(file);
});

// ---- Rotate photo (fixes sideways/rotated label text) ----
rotateBtn.addEventListener("click", () => {
  if (!originalImageDataUrl) return;
  currentRotation = (currentRotation + 90) % 360;

  rotateImage(originalImageDataUrl, currentRotation).then((rotatedDataUrl) => {
    imagePreview.src = rotatedDataUrl;
    preprocessImage(rotatedDataUrl).then((processedDataUrl) => {
      runOCR(processedDataUrl);
    });
  });
});

/**
 * Rotate an image by a given angle (0/90/180/270) using Canvas.
 */
function rotateImage(dataUrl, degrees) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      if (degrees === 90 || degrees === 270) {
        canvas.width = img.height;
        canvas.height = img.width;
      } else {
        canvas.width = img.width;
        canvas.height = img.height;
      }

      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((degrees * Math.PI) / 180);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);

      resolve(canvas.toDataURL("image/jpeg", 0.95));
    };
    img.src = dataUrl;
  });
}

/**
 * Preprocess an image for better OCR accuracy:
 * 1. Upscale (helps with small/dense text)
 * 2. Convert to grayscale
 * 3. Boost contrast (push mid-tones toward pure black/white)
 */
function preprocessImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = 2; // upscale factor — helps small/dense label text
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d");

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      const contrastFactor = 1.6; // >1 increases contrast

      for (let i = 0; i < data.length; i += 4) {
        // Convert to grayscale using standard luminance weighting
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

        // Boost contrast around the midpoint (128)
        let contrasted = (gray - 128) * contrastFactor + 128;
        contrasted = Math.max(0, Math.min(255, contrasted));

        data[i] = contrasted; // R
        data[i + 1] = contrasted; // G
        data[i + 2] = contrasted; // B
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL("image/jpeg", 0.95));
    };
    img.src = dataUrl;
  });
}

// ---- Step 2: OCR via Tesseract.js ----
function runOCR(imageDataUrl) {
  ocrSection.classList.remove("hidden");
  ocrLoading.classList.remove("hidden");
  ocrText.value = "";
  confirmTextBtn.classList.add("hidden");

  Tesseract.recognize(imageDataUrl, "eng", {
    logger: (m) => console.log(m), // progress logs, useful for demo/debugging
  })
    .then(({ data: { text } }) => {
      const cleaned = cleanOcrText(text);
      ocrText.value = cleaned || "";
      ocrLoading.classList.add("hidden");
      confirmTextBtn.classList.remove("hidden");

      if (!cleaned) {
        ocrText.placeholder =
          "Couldn't read this clearly. Please type the label text manually.";
      }
    })
    .catch((err) => {
      console.error("OCR error:", err);
      ocrLoading.classList.add("hidden");
      ocrText.placeholder =
        "Something went wrong reading the image. Please type the label text manually.";
      confirmTextBtn.classList.remove("hidden");
    });
}

// Post-process OCR output entirely in plain JS (no dependency on Tesseract's
// internal whitelist API, which requires the more fragile worker setup).
// 1. Strip any character that isn't a normal letter/number/basic punctuation.
// 2. Drop lines that become empty or are just leftover junk after stripping.
function cleanOcrText(rawText) {
  const allowedCharsPattern = /[^A-Za-z0-9 .,()\-%/:'"\n]/g;

  return rawText
    .replace(allowedCharsPattern, "") // remove disallowed characters entirely
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      // Drop leftover junk lines with no real letters/numbers at all
      if (!/[a-zA-Z0-9]/.test(line)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

// ---- Step 2 -> 3: confirm text, move to translation ----
confirmTextBtn.addEventListener("click", () => {
  if (!ocrText.value.trim()) {
    alert("Please enter or confirm the label text before continuing.");
    return;
  }
  translateSection.classList.remove("hidden");
  translateSection.scrollIntoView({ behavior: "smooth" });
});

// ---- Step 3: Translation ----
// Uses LibreTranslate public API (free, no key required for light use).
// NOTE: for hackathon demo reliability, wrap in try/catch with a graceful fallback.
translateBtn.addEventListener("click", async () => {
  const text = ocrText.value.trim();
  const targetLang = languageSelect.value;
  currentLangCode = targetLang;

  if (!text) {
    alert("No text to translate.");
    return;
  }

  translateLoading.classList.remove("hidden");
  translateBtn.disabled = true;

  try {
    const translated = await translateText(text, targetLang);
    currentTranslatedText = translated;
    showResults(text, translated, targetLang);
  } catch (err) {
    console.error("Translation error:", err);
    // Graceful fallback: show original text so the demo never fully breaks
    currentTranslatedText = text;
    showResults(text, text, targetLang);
    alert(
      "Translation service didn't respond — showing original text. Try again if you have internet."
    );
  } finally {
    translateLoading.classList.add("hidden");
    translateBtn.disabled = false;
  }
});

async function translateText(text, targetLang) {
  if (targetLang === "en") return text; // no translation needed

  // MyMemory's free tier has a ~500 character limit PER REQUEST.
  // Real medicine labels are often longer than that, so we split the text
  // into smaller chunks (by line, then by length if needed), translate each
  // chunk separately, and join the results back together.
  const chunks = splitTextIntoChunks(text, 450);

  const translatedChunks = [];
  for (const chunk of chunks) {
    const translated = await translateChunk(chunk, targetLang);
    translatedChunks.push(translated);
  }

  return translatedChunks.join(" ");
}

function splitTextIntoChunks(text, maxLength) {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if ((current + " " + line).trim().length > maxLength) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current = (current + " " + line).trim();
    }
  }
  if (current) chunks.push(current.trim());

  // Safety net: if a single line itself is longer than maxLength, hard-split it
  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxLength) return [chunk];
    const pieces = [];
    for (let i = 0; i < chunk.length; i += maxLength) {
      pieces.push(chunk.slice(i, i + maxLength));
    }
    return pieces;
  });
}

async function translateChunk(text, targetLang) {
  const langPair = `en|${targetLang}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
    text
  )}&langpair=${langPair}`;

  const response = await fetch(url);

  if (!response.ok) throw new Error("Translation API failed");

  const data = await response.json();

  if (!data.responseData || !data.responseData.translatedText) {
    throw new Error("Translation API returned no result");
  }

  const result = data.responseData.translatedText;

  // MyMemory sometimes returns an HTTP 200 "success" response that actually
  // contains an error message as the "translation" (e.g. length limit exceeded,
  // invalid language pair, etc). Detect these disguised errors and treat them
  // as real failures so the app's fallback logic kicks in properly.
  const looksLikeApiError =
    /QUERY LENGTH LIMIT EXCEEDED|INVALID LANGUAGE PAIR|IS AN INVALID|AMOUNT OF WORDS LIMIT EXCEEDED/i.test(
      result
    );

  if (looksLikeApiError) {
    throw new Error(`MyMemory API error: ${result}`);
  }

  return result;
}

// ---- Step 4: Warning detection + Danger Score ----
function detectWarnings(originalText) {
  const lowerText = originalText.toLowerCase();
  return WARNING_KEYWORDS.filter((kw) => lowerText.includes(kw));
}

function getDangerLevel(warningsFound) {
  if (warningsFound.length === 0) return "low";
  if (warningsFound.length <= 2) return "medium";
  return "high";
}

function showResults(originalText, translated, langCode) {
  resultsSection.classList.remove("hidden");
  translatedTextEl.textContent = translated;

  const warnings = detectWarnings(originalText);
  const level = getDangerLevel(warnings);

  dangerBadge.classList.remove("hidden", "low", "medium", "high");
  dangerBadge.classList.add(level);
  dangerBadge.textContent =
    level === "low"
      ? "✅ Low Risk — No Critical Warnings Found"
      : level === "medium"
      ? "⚠️ Medium Risk — Some Warnings Found"
      : "🔴 High Risk — Multiple Critical Warnings";

  warningsList.innerHTML = "";
  if (warnings.length === 0) {
    warningsBlock.classList.add("no-warnings");
  } else {
    warningsBlock.classList.remove("no-warnings");
    warnings.forEach((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      warningsList.appendChild(li);
    });
  }

  resultsSection.scrollIntoView({ behavior: "smooth" });

  // Save this scan to Firestore (non-blocking — history is a bonus, not critical path)
  saveScan({
    originalText,
    translatedText: translated,
    langCode,
    dangerLevel: level,
    warnings,
  }).then(() => loadHistory());
}

// ---- Step 5: Voice output (Web Speech API) ----
speakBtn.addEventListener("click", () => {
  if (!currentTranslatedText) return;

  const utterance = new SpeechSynthesisUtterance(currentTranslatedText);

  // Map our language codes to browser speech-synthesis locale tags
  const langMap = { te: "te-IN", hi: "hi-IN", en: "en-IN" };
  utterance.lang = langMap[currentLangCode] || "en-IN";

  speechSynthesis.cancel(); // stop any ongoing speech first
  speechSynthesis.speak(utterance);
});

// ---- Scan History (Firestore) ----
function formatTimestamp(ts) {
  if (!ts || !ts.toDate) return "just now";
  const date = ts.toDate();
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function loadHistory() {
  historyLoading.classList.remove("hidden");
  historyList.innerHTML = "";

  const scans = await getRecentScans(10);

  historyLoading.classList.add("hidden");

  if (scans.length === 0) {
    historyList.innerHTML = `<li class="history-empty">No scans yet — your first scan will show up here.</li>`;
    return;
  }

  scans.forEach((scan) => {
    const li = document.createElement("li");
    li.className = `history-item ${scan.dangerLevel || "low"}`;
    li.innerHTML = `
      <div class="history-item-top">
        <span class="history-lang">${(scan.langCode || "en").toUpperCase()}</span>
        <span class="history-time">${formatTimestamp(scan.createdAt)}</span>
      </div>
      <p class="history-text">${(scan.translatedText || "").slice(0, 90)}${
      (scan.translatedText || "").length > 90 ? "…" : ""
    }</p>
    `;
    historyList.appendChild(li);
  });
}

refreshHistoryBtn.addEventListener("click", loadHistory);

// Load history as soon as the page opens
loadHistory();

// ---- Reset flow ----
resetBtn.addEventListener("click", () => {
  imageInput.value = "";
  imagePreviewWrap.classList.add("hidden");
  ocrSection.classList.add("hidden");
  translateSection.classList.add("hidden");
  resultsSection.classList.add("hidden");
  ocrText.value = "";
  currentTranslatedText = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
});