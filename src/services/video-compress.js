// Comprime video para que quepa en el límite de 16 MB de la API de WhatsApp.
//
// La app de WhatsApp del consumidor comprime el video automáticamente antes de
// enviarlo; la API de Meta no lo hace y rechaza archivos > 16 MB. Este servicio
// aplica la misma compresión en el backend (H.264 + AAC, resolución máx 720p,
// bitrate adaptado para apuntar a ~14 MB) antes de subir a Meta.

const ffmpeg = require('fluent-ffmpeg');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const TARGET_MB   = 14;           // margen bajo el límite de 16 MB de Meta
const TARGET_KBPS = 800;          // bitrate de video (kbps) — suficiente para 720p social

async function compressVideo(buffer) {
  const id      = crypto.randomUUID();
  const inPath  = path.join(os.tmpdir(), `${id}.in.mp4`);
  const outPath = path.join(os.tmpdir(), `${id}.out.mp4`);

  await fs.promises.writeFile(inPath, buffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .videoCodec('libx264')
        .videoBitrate(TARGET_KBPS)
        .audioCodec('aac')
        .audioBitrate('96k')
        // Máx 720p, mantiene relación de aspecto
        .videoFilters('scale=trunc(min(iw\\,1280)/2)*2:trunc(ow/a/2)*2')
        .outputOptions([
          '-preset fast',
          '-movflags +faststart', // reproduce antes de descargar completamente
          '-pix_fmt yuv420p',     // compatibilidad máxima
        ])
        .format('mp4')
        .on('error', reject)
        .on('end', resolve)
        .save(outPath);
    });

    const compressed = await fs.promises.readFile(outPath);
    const origMB     = (buffer.length      / 1024 / 1024).toFixed(1);
    const compMB     = (compressed.length  / 1024 / 1024).toFixed(1);
    console.log(`[video-compress] ${origMB} MB → ${compMB} MB`);
    return compressed;

  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

module.exports = { compressVideo };
