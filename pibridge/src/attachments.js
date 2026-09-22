// File attachments for the AI chat surfaces.
//
// WHY THIS EXISTS: techs live with screenshots and log extracts. Before this, the only
// way to get one in front of the model was to paste the text and hope the formatting
// survived - and a screenshot could not be sent at all. Everything here turns a browser
// upload into something a model can actually read:
//
//   image/*  -> ImageContent block (session.prompt(text, { images })) - only if the
//               ACTIVE model advertises image input, otherwise it is rejected with a
//               reason the operator can act on ("switch model or paste the text").
//   text-ish -> inlined into the prompt inside sentinel markers so the chat window can
//               collapse it back into a chip instead of re-rendering a 200 KB log.
//   binary   -> rejected by name with the reason. NEVER silently dropped: "I attached
//               it and the AI ignored it" is the worst possible failure here.
//
// Nothing is written to disk. Attachments live in the turn and in the session transcript
// (pi's own .jsonl), which is where the audit trail already is.

export const ATTACH_LIMITS = {
  // Per message. Deliberately small: this is a chat box, not a file share.
  maxFiles: 5,
  // Per file, decoded bytes.
  maxFileBytes: 8 * 1024 * 1024,
  // All files in one message, decoded bytes.
  maxTotalBytes: 20 * 1024 * 1024,
  // A text file is inlined into the prompt, so it is charged as input tokens on every
  // subsequent turn of the conversation. 200 KB is roughly 50k tokens - already
  // expensive; anything larger gets truncated with a visible notice.
  maxTextBytes: 200 * 1024,
  maxTotalTextBytes: 500 * 1024,
};

// Sentinel markers. The model reads them as plain text (they are self-describing), and
// the chat window uses them to strip inlined file bodies back out of the transcript so
// a reload shows a chip, not the whole file. Keep them boring and greppable.
export const ATTACH_OPEN_RE = /\[\[pi-attachment:([^\]|]*)\|(\d+)\]\]/;
export const attachOpen = (name, bytes) => `[[pi-attachment:${name}|${bytes}]]`;
export const ATTACH_CLOSE = "[[/pi-attachment]]";

// Image formats every major provider accepts. Anything else (bmp, tiff, svg, heic) is
// rejected rather than sent and 400'd by the provider mid-turn.
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Extensions we treat as text even when the browser reports a useless mime
// (application/octet-stream is what Chrome sends for .log, .ps1, .conf, ...).
const TEXT_EXTS = new Set([
  "txt", "log", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "ini", "conf", "cfg",
  "reg", "ps1", "psm1", "bat", "cmd", "sh", "bash", "py", "js", "ts", "sql", "html",
  "htm", "css", "env", "evtx_txt", "nfo", "diff", "patch", "toml", "properties", "srt",
]);

/** Path components and control characters out; length capped. Display name only. */
export function safeName(raw) {
  const base = String(raw || "file")
    .replace(/[\\/]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (base || "file").slice(0, 120);
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Is this buffer plausibly UTF-8 text? A NUL byte, or a high proportion of
 * non-printable bytes, means "binary" - sniffing beats trusting the mime type,
 * because browsers get the mime type wrong for exactly the files techs attach.
 */
function looksTextual(buf) {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return true;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    // tab, LF, CR, and printable ASCII are fine; so is anything >= 0x80 (UTF-8 tail)
    if (b < 0x09 || (b > 0x0d && b < 0x20)) suspicious++;
  }
  return suspicious / n < 0.05;
}

function decodeBase64(data) {
  // Accept both a raw base64 string and a data: URL, because both are one line of
  // FileReader away and getting it wrong is an invisible failure.
  const s = String(data || "");
  const comma = s.startsWith("data:") ? s.indexOf(",") : -1;
  return Buffer.from(comma >= 0 ? s.slice(comma + 1) : s, "base64");
}

/**
 * Turn browser attachments into model input.
 *
 * @param {Array<{name?:string, mime?:string, data?:string}>} list
 * @param {{ modelAcceptsImages?: boolean, modelName?: string, limits?: object }} opts
 * @returns {{
 *   images: Array<{type:"image", data:string, mimeType:string}>,
 *   text: string,                       // inlined text blocks, "" if none
 *   accepted: Array<{name:string, kind:"image"|"text", bytes:number, truncated?:boolean}>,
 *   rejected: Array<{name:string, reason:string}>,
 * }}
 */
export function normalizeAttachments(list, opts = {}) {
  const L = { ...ATTACH_LIMITS, ...(opts.limits || {}) };
  const out = { images: [], text: "", accepted: [], rejected: [] };
  if (!Array.isArray(list) || list.length === 0) return out;

  const items = list.slice(0, L.maxFiles);
  for (const extra of list.slice(L.maxFiles)) {
    out.rejected.push({
      name: safeName(extra?.name),
      reason: `only ${L.maxFiles} files per message - send the rest in a follow-up`,
    });
  }

  let totalBytes = 0;
  let totalText = 0;
  const textParts = [];

  for (const raw of items) {
    const name = safeName(raw?.name);
    const mime = String(raw?.mime || "").toLowerCase().split(";")[0].trim();
    let buf;
    try {
      buf = decodeBase64(raw?.data);
    } catch {
      out.rejected.push({ name, reason: "could not be decoded" });
      continue;
    }
    if (!buf.length) {
      out.rejected.push({ name, reason: "empty file" });
      continue;
    }
    if (buf.length > L.maxFileBytes) {
      out.rejected.push({
        name,
        reason: `${humanBytes(buf.length)} is over the ${humanBytes(L.maxFileBytes)} per-file limit`,
      });
      continue;
    }
    if (totalBytes + buf.length > L.maxTotalBytes) {
      out.rejected.push({
        name,
        reason: `would exceed the ${humanBytes(L.maxTotalBytes)} total for one message`,
      });
      continue;
    }

    const ext = extOf(name);
    const isImage = mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);

    if (isImage) {
      const mimeType = IMAGE_MIMES.has(mime)
        ? mime
        : ext === "png" ? "image/png"
        : ext === "gif" ? "image/gif"
        : ext === "webp" ? "image/webp"
        : ["jpg", "jpeg"].includes(ext) ? "image/jpeg"
        : "";
      if (!mimeType) {
        out.rejected.push({
          name,
          reason: `${mime || ext || "this image format"} is not supported - save it as PNG or JPEG`,
        });
        continue;
      }
      if (!opts.modelAcceptsImages) {
        out.rejected.push({
          name,
          reason: `${opts.modelName || "the selected model"} cannot read images - switch model, or paste the text`,
        });
        continue;
      }
      out.images.push({ type: "image", data: buf.toString("base64"), mimeType });
      out.accepted.push({ name, kind: "image", bytes: buf.length });
      totalBytes += buf.length;
      continue;
    }

    // PDFs are the single most common "why not?" - answer it precisely instead of
    // letting it fall through to the generic binary rejection.
    if (mime === "application/pdf" || ext === "pdf") {
      out.rejected.push({
        name,
        reason: "PDFs are not supported yet - export the relevant page as PNG, or paste the text",
      });
      continue;
    }

    const textual = TEXT_EXTS.has(ext) || mime.startsWith("text/")
      ? looksTextual(buf)
      : looksTextual(buf) && (!mime || mime === "application/octet-stream" || mime.includes("json") || mime.includes("xml") || mime.includes("script"));

    if (!textual) {
      out.rejected.push({
        name,
        reason: `${mime || ext || "this file type"} is not readable by the AI - attach an image or a text/log file`,
      });
      continue;
    }

    let body = buf.toString("utf8");
    // EMBEDDED MEDIA IN A TEXT FILE. A saved HTML page (an error screen, an exported
    // report) carries its images and fonts inline as `data:...;base64,...`. As TEXT those
    // are worth nothing to the model - it cannot see an image by reading its base64 - and
    // they are actively harmful twice over:
    //   1. they fill the per-file budget, so the real content (the error message the
    //      technician wanted read) gets truncated away. That happened on TICKET/61431:
    //      a 174 KB error page whose useful text lost out to its own inline artwork.
    //   2. they land in the transcript and in the chat window as a wall of base64.
    // Replaced with a short, honest placeholder so the model knows something was there.
    let inlineMedia = 0;
    body = body.replace(/data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=\s]{200,}/gi,
      (m, mime) => {
        inlineMedia += 1;
        return `[inline ${mime} removed: ${humanBytes(Math.round((m.length * 3) / 4))} of base64 - ` +
               `attach the image itself if you need the AI to see it]`;
      });
    let truncated = false;
    if (buf.length > L.maxTextBytes) {
      body = buf.subarray(0, L.maxTextBytes).toString("utf8");
      truncated = true;
    }
    if (totalText + Buffer.byteLength(body) > L.maxTotalTextBytes) {
      const room = Math.max(0, L.maxTotalTextBytes - totalText);
      if (room < 1024) {
        out.rejected.push({ name, reason: "no room left in this message for more text files" });
        continue;
      }
      body = body.slice(0, room);
      truncated = true;
    }
    // Strip a stray sentinel so an attached file can never forge an attachment boundary.
    body = body.split("[[/pi-attachment]]").join("[[/pi-attachment ]]");

    textParts.push(
      `${attachOpen(name, buf.length)}\n${body}` +
        (truncated ? `\n...[truncated - original file is ${humanBytes(buf.length)}]` : "") +
        `\n${ATTACH_CLOSE}`,
    );
    totalText += Buffer.byteLength(body);
    totalBytes += buf.length;
    out.accepted.push({ name, kind: "text", bytes: buf.length, truncated, inlineMedia });
  }

  if (textParts.length) {
    out.text =
      `The technician attached ${textParts.length} file(s). Their full contents follow ` +
      `between [[pi-attachment:...]] markers.\n\n${textParts.join("\n\n")}`;
  }
  return out;
}

/**
 * Compose the final prompt string for a turn: what the tech typed, plus any inlined
 * text files. Kept separate so callers can log/audit the typed text on its own.
 */
export function composePrompt(typed, attachText) {
  const t = String(typed || "").trim();
  if (!attachText) return t;
  return t ? `${t}\n\n${attachText}` : attachText;
}

/** One-line audit summary, e.g. `screenshot.png (image, 412.0 KB), errors.log (text, 8.2 KB)`. */
export function describeAccepted(accepted) {
  return accepted
    .map((a) => `${a.name} (${a.kind}, ${humanBytes(a.bytes)}${a.truncated ? ", truncated" : ""}` +
      `${a.inlineMedia ? `, ${a.inlineMedia} inline image(s) stripped` : ""})`)
    .join(", ");
}

/**
 * The whole browser-side intake for one chat surface, so the device chat and the ticket
 * (decision) chat cannot drift apart - they are the same window with a different tool
 * belt, and an attachment that works in one but is silently ignored in the other is the
 * exact confusion this module exists to prevent.
 *
 * Returns `takeAttachments(msg)` -> { images: [{data, mime}], text, accepted, rejected }.
 * `images` is in the {data, mime} shape both surfaces\' runPrompt() already speaks.
 *
 * @param {object} deps
 * @param {(frame:object)=>void} deps.send   send a frame to the browser
 * @param {()=>object|undefined} deps.model  the ACTIVE model (a function: it can change mid-chat)
 * @param {(...a:any[])=>void} [deps.log]
 * @param {string} [deps.key]                agent id / ticket ref, for the log line
 * @param {string} [deps.sessionId]
 */
export function makeAttachmentIntake({ send, model, log = () => {}, key = "", sessionId = "" }) {
  const EMPTY = { images: [], text: "", accepted: [], rejected: [] };
  return function takeAttachments(msg) {
    const list = Array.isArray(msg?.attachments) ? msg.attachments : null;
    if (!list || !list.length) return EMPTY;
    const active = model();
    const res = normalizeAttachments(list, {
      modelAcceptsImages: Array.isArray(active?.input) ? active.input.includes("image") : false,
      modelName: active?.name || "",
    });
    if (res.accepted.length) log("attach", key, sessionId, describeAccepted(res.accepted));
    if (res.rejected.length) {
      log("attach_rejected", key, sessionId,
          res.rejected.map((r) => `${r.name}: ${r.reason}`).join("; "));
      // Never silent: the operator must see, in the transcript, that the model did not
      // get the file - otherwise they argue with an answer based on evidence it never had.
      try {
        send({
          type: "attachments_rejected",
          rejected: res.rejected,
          message: "Not sent to the AI - " +
            res.rejected.map((r) => `${r.name} (${r.reason})`).join("; "),
        });
      } catch { /* socket gone */ }
    }
    return { ...res, images: res.images.map((i) => ({ data: i.data, mime: i.mimeType })) };
  };
}
