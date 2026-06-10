#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

function parseArgs(argv) {
  const args = {
    hostPath: path.resolve(__dirname, '..', 'native-host.js'),
    timeoutMs: 10000
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--host') {
      args.hostPath = path.resolve(argv[++i] || args.hostPath);
    } else if (value === '--timeout-ms') {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.timeoutMs = parsed;
      }
    }
  }

  return args;
}

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...detail }, null, 2));
  process.exit(1);
}

function createNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length, 0);
  return Buffer.concat([length, body]);
}

function parseNativeMessages(buffer) {
  const messages = [];
  let remaining = buffer;
  while (remaining.length >= 4) {
    const length = remaining.readUInt32LE(0);
    if (remaining.length < 4 + length) break;
    const json = remaining.slice(4, 4 + length).toString('utf8');
    messages.push(JSON.parse(json));
    remaining = remaining.slice(4 + length);
  }
  return messages;
}

function createWavBuffer() {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const durationMs = 120;
  const sampleCount = Math.floor(sampleRate * durationMs / 1000);
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = sampleCount * channels * bytesPerSample;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wav = createWavBuffer();
  const sessionId = `upload_only_smoke_${Date.now()}`;
  const firstChunk = wav.slice(0, 512);
  const secondChunk = wav.slice(512);
  const chunks = [firstChunk, secondChunk];

  const messages = [
    {
      type: 'transcribe_init',
      id: sessionId,
      totalBytes: wav.length,
      totalChunks: chunks.length,
      chunkBytes: firstChunk.length,
      language: 'en',
      modelId: 'upload-only-smoke-model',
      mode: 'fast'
    },
    ...chunks.map((chunk, index) => ({
      type: 'transcribe_chunk',
      id: sessionId,
      index,
      totalChunks: chunks.length,
      byteLength: chunk.length,
      data: chunk.toString('base64')
    })),
    {
      type: 'transcribe_complete',
      id: sessionId
    }
  ];

  const child = spawn(process.execPath, [args.hostPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stdout = Buffer.alloc(0);
  let stderr = '';
  let closed = false;

  child.stdout.on('data', (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.on('error', (error) => {
    fail('Failed to start native host', { hostPath: args.hostPath, detail: error.message });
  });

  const closePromise = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });

  for (const message of messages) {
    child.stdin.write(createNativeMessage(message));
  }
  child.stdin.end();

  const timeout = setTimeout(() => {
    if (!closed) {
      child.kill('SIGKILL');
    }
  }, args.timeoutMs);

  const closeResult = await closePromise;
  clearTimeout(timeout);

  let responses = [];
  try {
    responses = parseNativeMessages(stdout);
  } catch (error) {
    fail('Native host produced invalid native-message output', {
      hostPath: args.hostPath,
      exit: closeResult,
      stderr: stderr.trim(),
      detail: error.message
    });
  }

  const initAck = responses.find((response) => response.type === 'transcribe_init_ack' && response.id === sessionId);
  const chunkAcks = responses.filter((response) => response.type === 'transcribe_chunk_ack' && response.id === sessionId);
  const transcriptionResponses = responses.filter((response) => response.id === sessionId && (response.type === 'transcription' || response.type === 'transcription_error'));
  const completionError = transcriptionResponses.find((response) => response.type === 'transcription_error');

  if (!initAck?.success) {
    fail('Chunked upload did not initialize successfully', { exit: closeResult, stderr: stderr.trim(), responses });
  }

  if (chunkAcks.length !== chunks.length) {
    fail('Native host did not acknowledge every uploaded chunk', { expected: chunks.length, actual: chunkAcks.length, responses });
  }

  const failedChunk = chunkAcks.find((ack) => ack.success !== true || ack.error);
  if (failedChunk) {
    fail('Chunk ACK failed; chunk handling is not upload-only', { failedChunk, responses, stderr: stderr.trim() });
  }

  const transcribedChunk = chunkAcks.find((ack) => ack.processedSegments !== 0 || (Array.isArray(ack.segments) && ack.segments.length > 0) || ack.text);
  if (transcribedChunk) {
    fail('Chunk ACK included transcription output before completion', { transcribedChunk, responses });
  }

  if (transcriptionResponses.length !== 1 || !completionError) {
    fail('Native host did not defer model lookup until transcribe_complete', { transcriptionResponses, responses, stderr: stderr.trim() });
  }

  if (!String(completionError.error || '').includes('No installed Parakeet ASR model package is available')) {
    fail('Unexpected completion error after upload-only chunks', { completionError, responses, stderr: stderr.trim() });
  }

  console.log(JSON.stringify({
    ok: true,
    hostPath: args.hostPath,
    sessionId,
    uploadedBytes: wav.length,
    completionError: completionError.error,
    chunks: chunkAcks.map((ack) => ({
      byteLength: ack.byteLength,
      receivedBytes: ack.receivedBytes,
      processedSegments: ack.processedSegments
    }))
  }, null, 2));
}

main().catch((error) => {
  fail('Upload-only native host smoke test failed', { detail: error.message });
});
