#!/usr/bin/env node
/**
 * send-mail.mjs — Envoie un email de notification via SMTP.
 *
 * Utilisation :
 *   node send-mail.mjs --subject "Objet" --body "Corps du message"
 *   node send-mail.mjs --subject "..." --body "..." --attachment "/chemin/rapport.md"
 *
 * Les informations SMTP sont lues depuis un fichier .env (ou l'environnement).
 * Variables attendues (mêmes que le plugin de notification) :
 *   NOTIFY_SMTP_HOST, NOTIFY_SMTP_PORT, NOTIFY_SMTP_USER, NOTIFY_SMTP_PASS,
 *   NOTIFY_SMTP_FROM, NOTIFY_RECIPIENTS
 *
 * Code de sortie : 0 si succès, 1 si échec.
 */
import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { connect } from "node:tls"

const HERE = dirname(fileURLToPath(import.meta.url))

// --- Parse des arguments ---
const args = process.argv.slice(2)
function argValue(name) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined
}
const subject = argValue("--subject")
const body = argValue("--body")
const attachment = argValue("--attachment")

if (!subject || !body) {
  console.error("Usage: node send-mail.mjs --subject <objet> --body <corps> [--attachment <chemin>]")
  process.exit(1)
}

// --- Chargement du .env ---
function loadEnvFile(path) {
  if (!existsSync(path)) return
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

// Cherche le .env dans le répertoire du script, puis dans les répertoires parents.
let envPath = resolve(HERE, ".env")
if (!existsSync(envPath)) envPath = resolve(HERE, "..", ".env")
if (!existsSync(envPath)) envPath = resolve(HERE, "..", "plugin", ".env")
loadEnvFile(envPath)

function env(name, fallback) {
  const v = process.env[name]
  return v && v.length > 0 ? v : fallback
}

const SMTP = {
  host: env("NOTIFY_SMTP_HOST", "mail.man-dam.net"),
  port: Number(env("NOTIFY_SMTP_PORT", "465")),
  user: env("NOTIFY_SMTP_USER", "contact@man-dam.net"),
  pass: env("NOTIFY_SMTP_PASS", ""),
  from: env("NOTIFY_SMTP_FROM", "contact@man-dam.net"),
}
const RECIPIENTS = env("NOTIFY_RECIPIENTS", "it.specialist.gasca@gmail.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

if (!SMTP.pass) {
  console.error("Erreur : NOTIFY_SMTP_PASS est vide. Vérifiez le fichier .env.")
  process.exit(1)
}
if (RECIPIENTS.length === 0) {
  console.error("Erreur : aucun destinataire (NOTIFY_RECIPIENTS).")
  process.exit(1)
}

function crlf(s) {
  return s.replace(/\r?\n/g, "\r\n")
}

// --- Construction du message MIME ---
const hasAttachment = !!attachment && existsSync(attachment)
const boundaryMix = `----_opencode_mix_${Date.now().toString(36)}`
const boundaryAlt = `----_opencode_alt_${Date.now().toString(36)}`
const date = new Date().toUTCString()
const msgId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${SMTP.host}>`
const encSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`

const altParts =
  `--${boundaryAlt}\r\n` +
  `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n` +
  crlf(body) + "\r\n" +
  `--${boundaryAlt}--\r\n`

let message
if (hasAttachment) {
  const fileName = basename(attachment)
  const content = readFileSync(attachment, "utf8")
  message =
    `From: opencode <${SMTP.from}>\r\n` +
    `To: ${RECIPIENTS.join(", ")}\r\n` +
    `Subject: ${encSubject}\r\n` +
    `Date: ${date}\r\n` +
    `Message-ID: ${msgId}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundaryMix}"\r\n` +
    `\r\n` +
    `--${boundaryMix}\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"\r\n\r\n` +
    altParts + "\r\n" +
    `--${boundaryMix}\r\n` +
    `Content-Type: text/markdown; charset=utf-8; name="${fileName}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="${fileName}"\r\n\r\n` +
    Buffer.from(content, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n") + "\r\n" +
    `--${boundaryMix}--\r\n`
} else {
  message =
    `From: opencode <${SMTP.from}>\r\n` +
    `To: ${RECIPIENTS.join(", ")}\r\n` +
    `Subject: ${encSubject}\r\n` +
    `Date: ${date}\r\n` +
    `Message-ID: ${msgId}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"\r\n` +
    `\r\n` +
    altParts
}

// --- Envoi SMTP ---
function send() {
  return new Promise((resolve) => {
    const socket = connect(
      SMTP.port,
      SMTP.host,
      { rejectUnauthorized: false },
      () => socket.write("EHLO opencode\r\n")
    )
    let buffer = ""
    let step = 0
    let rcptDone = 0
    let succeeded = false

    const sendLine = (s) => socket.write(crlf(s) + "\r\n")
    const b64 = (s) => Buffer.from(s, "utf8").toString("base64")
    const recipients = RECIPIENTS.map((r) => `RCPT TO:<${r}>`)

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let idx
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const code = parseInt(line.slice(0, 3), 10)

        if (step === 0 && line.startsWith("220")) {
          sendLine("EHLO opencode")
          step = 1
        } else if (step === 1 && line.startsWith("250 ")) {
          sendLine("AUTH LOGIN")
          step = 2
        } else if (step === 2 && line.startsWith("334")) {
          sendLine(b64(SMTP.user))
          step = 3
        } else if (step === 3 && line.startsWith("334")) {
          sendLine(b64(SMTP.pass))
          step = 4
        } else if (step === 4 && line.startsWith("235")) {
          sendLine(`MAIL FROM:<${SMTP.from}>`)
          step = 5
        } else if (step === 5 && line.startsWith("250 ")) {
          sendLine(recipients[0])
          step = 6
        } else if (step === 6 && line.startsWith("250 ")) {
          rcptDone += 1
          if (rcptDone < recipients.length) {
            sendLine(recipients[rcptDone])
          } else {
            sendLine("DATA")
            step = 7
          }
        } else if (step === 7 && line.startsWith("354")) {
          sendLine(message + "\r\n.")
          step = 8
        } else if (step === 8 && line.startsWith("250 ")) {
          succeeded = true
          sendLine("QUIT")
          step = 9
        }

        if (code >= 400 && code < 600) {
          socket.destroy()
          resolve(false)
        }
      }
    })
    socket.on("error", () => resolve(false))
    socket.on("close", () => resolve(succeeded))
    socket.setTimeout(20000, () => {
      socket.destroy()
      resolve(succeeded)
    })
  })
}

send().then((ok) => {
  if (ok) {
    console.log("Email envoyé avec succès.")
    process.exit(0)
  } else {
    console.error("Échec de l'envoi de l'email.")
    process.exit(1)
  }
})
