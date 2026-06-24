// Convierte audio a un formato que la API de WhatsApp acepta.
//
// Meta solo permite estos MIME de audio: audio/aac, audio/mp4, audio/mpeg,
// audio/amr, audio/ogg (únicamente con codec Opus). El navegador (MediaRecorder
// en Chrome/Firefox) solo sabe grabar en audio/webm, que Meta rechaza — así que
// antes de subir el archivo lo remuxamos/recodificamos a Ogg/Opus aquí.
//
// Requiere el binario `ffmpeg` en el PATH del servidor (ver backend/nixpacks.toml,
// que le pide a Railway que lo instale).

const ffmpeg = require('fluent-ffmpeg');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function runFfmpeg(inPath, outPath, useStreamCopy) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inPath).noVideo().format('ogg');
    if (useStreamCopy) {
      cmd.audioCodec('copy'); // rápido: el audio ya es Opus, solo cambia el contenedor
    } else {
      cmd.audioCodec('libopus').audioBitrate('64k'); // fallback: recodifica desde cero
    }
    cmd.on('error', reject).on('end', resolve).save(outPath);
  });
}

// buffer: Buffer del archivo original. Devuelve un Buffer en formato Ogg/Opus.
async function convertToOggOpus(buffer) {
  const id = crypto.randomUUID();
  const inPath  = path.join(os.tmpdir(), `${id}.in`);
  const outPath = path.join(os.tmpdir(), `${id}.ogg`);

  await fs.promises.writeFile(inPath, buffer);
  try {
    try {
      await runFfmpeg(inPath, outPath, true); // intento rápido: copiar el stream Opus
    } catch {
      await runFfmpeg(inPath, outPath, false); // si falla, recodificar
    }
    return await fs.promises.readFile(outPath);
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

module.exports = { convertToOggOpus };
