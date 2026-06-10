#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MODEL_ID = 'parakeet-tdt-0.6b-v3-linux-x64-cpu-sherpa-onnx-int8';
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const WHOOPTIDO_SMOKE_USER_AGENT = 'Whooptido-ASR-Subtitles-Linux-Smoke/1.0 (+https://whooptido.app)';
const DOWNLOAD_HEADERS = {
  'User-Agent': WHOOPTIDO_SMOKE_USER_AGENT,
  Accept: 'application/octet-stream, application/json;q=0.9, */*;q=0.8'
};

function parseArgs(argv) {
  const args = {
    binary: null,
    audio: null,
    modelId: DEFAULT_MODEL_ID,
    manifestUrl: null,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--binary') {
      args.binary = path.resolve(argv[++index] || '');
    } else if (value === '--audio') {
      args.audio = path.resolve(argv[++index] || '');
    } else if (value === '--model-id') {
      args.modelId = argv[++index] || args.modelId;
    } else if (value === '--manifest-url') {
      args.manifestUrl = argv[++index] || null;
    } else if (value === '--timeout-ms') {
      const parsed = Number(argv[++index]);
      if (Number.isFinite(parsed) && parsed > 0) args.timeoutMs = parsed;
    }
  }

  if (!args.manifestUrl) {
    args.manifestUrl = `https://whooptido.app/models/${args.modelId}/package.json`;
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

function absoluteWhooptidoUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `https://whooptido.app${url}`;
  return `https://whooptido.app/models/${url}`;
}

async function fetchPackageManifest(manifestUrl) {
  const response = await fetch(manifestUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': WHOOPTIDO_SMOKE_USER_AGENT
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Package manifest request failed: HTTP ${response.status}; ${body.slice(0, 200)}`);
  }
  const manifest = await response.json();
  if (!manifest?.id || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Package manifest is missing id/files');
  }
  return {
    ...manifest,
    files: manifest.files.map((file) => ({
      ...file,
      url: absoluteWhooptidoUrl(file.url || file.path || file.name || '')
    }))
  };
}

async function preflightPackageFiles(files) {
  const results = [];
  for (const file of files) {
    const head = await fetch(file.url, {
      method: 'HEAD',
      headers: DOWNLOAD_HEADERS,
      redirect: 'follow'
    });
    const sample = await fetch(file.url, {
      method: 'GET',
      headers: {
        ...DOWNLOAD_HEADERS,
        Range: 'bytes=0-15'
      },
      redirect: 'follow'
    });
    const sampleBody = sample.ok ? Buffer.from(await sample.arrayBuffer()) : Buffer.alloc(0);
    const result = {
      path: file.path || file.name || null,
      url: file.url,
      headStatus: head.status,
      headFinalUrl: head.url,
      headContentLength: head.headers.get('content-length'),
      headBacking: head.headers.get('x-whooptido-model-backing'),
      sampleStatus: sample.status,
      sampleFinalUrl: sample.url,
      sampleContentLength: sample.headers.get('content-length'),
      sampleContentRange: sample.headers.get('content-range'),
      sampleBytes: sampleBody.length,
      expectedSize: file.size || null
    };
    results.push(result);
    console.log(JSON.stringify({ preflight: result }, null, 2));
    if (!head.ok || !sample.ok || sampleBody.length === 0) {
      fail('Hosted package file preflight failed', { result });
    }
  }
  return results;
}

function runHostMessage(binary, message, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(options.env || {}) };
    const child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env
    });

    let stdout = Buffer.alloc(0);
    let stderr = '';
    let closed = false;
    const timeout = setTimeout(() => {
      if (!closed) child.kill('SIGKILL');
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      let messages = [];
      try {
        messages = parseNativeMessages(stdout);
      } catch (error) {
        reject(new Error(`Invalid native-message output: ${error.message}; stderr=${stderr.trim()}`));
        return;
      }
      resolve({ code, signal, messages, stderr: stderr.trim(), stdoutBytes: stdout.length });
    });

    child.stdin.end(createNativeMessage(message));
  });
}

function findMessage(result, type) {
  return result.messages.find((message) => message?.type === type);
}

function assertStatusReady(status, modelId) {
  if (!status || status.type !== 'status') {
    fail('Native host did not return status', { status });
  }
  if (status.installed !== true || status.reachable !== true) {
    fail('Native host is not reachable', { status });
  }
  if (status.platform !== 'linux-x64') {
    fail('Native host did not report linux-x64', { platform: status.platform, status });
  }
  if (modelId && !status.models?.some((model) => model.id === modelId)) {
    fail('Downloaded model was not listed in status', { modelId, models: status.models });
  }
  if (modelId && status.packageRuntimeSupported !== true) {
    fail('Downloaded package runtime was not reported as supported', { status });
  }
}

function assertRunnerExecutable(status, modelId) {
  const model = status.models?.find((entry) => entry.id === modelId);
  const modelPath = model?.path || status.modelPath;
  if (!modelPath) fail('No installed model path was reported', { status });
  const runnerPath = path.join(modelPath, 'runner');
  const runtimePath = path.join(modelPath, 'runtime', 'bin', 'sherpa-onnx-offline');
  for (const filePath of [runnerPath, runtimePath]) {
    const stats = fs.statSync(filePath);
    if ((stats.mode & 0o111) === 0) {
      fail('Installed runtime file is not executable', { filePath, mode: stats.mode.toString(8) });
    }
  }
  return { modelPath, runnerPath, runtimePath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.binary || !fs.existsSync(args.binary)) {
    fail('Missing --binary path', { binary: args.binary });
  }
  if (!args.audio || !fs.existsSync(args.audio)) {
    fail('Missing --audio WAV path', { audio: args.audio });
  }

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whooptido-linux-cpu-smoke-home-'));
  const env = { HOME: tempHome };
  const manifest = await fetchPackageManifest(args.manifestUrl);
  if (manifest.id !== args.modelId) {
    fail('Package manifest id mismatch', { expected: args.modelId, actual: manifest.id });
  }
  if (manifest.runner !== 'runner') {
    fail('Linux CPU manifest does not use native runner', { runner: manifest.runner });
  }
  const preflight = await preflightPackageFiles(manifest.files);

  const initialStatus = findMessage(
    await runHostMessage(args.binary, { type: 'status' }, { env, timeoutMs: 15000 }),
    'status'
  );
  assertStatusReady(initialStatus);

  const downloadPayload = {
    type: 'download_model',
    modelId: args.modelId,
    size: manifest.diskSizeBytes || manifest.size || 0,
    files: manifest.files,
    packageManifest: {
      id: manifest.id,
      displayName: manifest.displayName,
      family: manifest.family,
      runtimeKind: manifest.runtimeKind,
      runner: manifest.runner,
      packageVariant: manifest.packageVariant,
      supportedLanguages: manifest.supportedLanguages,
      primaryLanguage: manifest.primaryLanguage,
      timestampSupport: manifest.timestampSupport,
      diskSizeBytes: manifest.diskSizeBytes || manifest.size || 0,
      freeRamRequiredGb: manifest.freeRamRequiredGb || manifest.ramRequired || 0,
      license: manifest.license,
      verifiedAt: manifest.verifiedAt,
      gpuBackends: manifest.gpuBackends
    }
  };
  const downloadResult = await runHostMessage(args.binary, downloadPayload, { env, timeoutMs: args.timeoutMs });
  const download = findMessage(downloadResult, 'download_complete');
  if (!download?.success) {
    fail('Hosted package download did not complete', { download, messages: downloadResult.messages, stderr: downloadResult.stderr });
  }
  if (download.packageRuntimeSupported !== true) {
    fail('Download did not report supported package runtime', { download });
  }

  const listed = findMessage(
    await runHostMessage(args.binary, { type: 'listModels' }, { env, timeoutMs: 15000 }),
    'models'
  );
  if (!listed?.models?.some((model) => model.id === args.modelId)) {
    fail('Downloaded model was not listed by listModels', { listed });
  }

  const readyStatus = findMessage(
    await runHostMessage(args.binary, { type: 'status' }, { env, timeoutMs: 30000 }),
    'status'
  );
  assertStatusReady(readyStatus, args.modelId);
  const executablePaths = assertRunnerExecutable(readyStatus, args.modelId);

  const transcriptionId = `linux_cpu_smoke_${Date.now()}`;
  const transcription = findMessage(
    await runHostMessage(args.binary, {
      type: 'transcribe',
      id: transcriptionId,
      audioPath: args.audio,
      language: 'en',
      modelId: args.modelId,
      performanceProfile: 'low-memory'
    }, { env, timeoutMs: args.timeoutMs }),
    'transcription'
  );
  if (!transcription) {
    fail('Transcription response was not produced');
  }
  if (!String(transcription.text || '').trim()) {
    fail('Transcription text was empty', { transcription });
  }
  if (!Array.isArray(transcription.segments) || transcription.segments.length === 0) {
    fail('Transcription segments were empty', { transcription });
  }

  console.log(JSON.stringify({
    ok: true,
    binary: args.binary,
    modelId: args.modelId,
    manifestUrl: args.manifestUrl,
    tempHome,
    preflight,
    download: {
      size: download.size,
      packageRuntimeSupported: download.packageRuntimeSupported,
      packageRuntimeInstalled: download.packageRuntimeInstalled
    },
    status: {
      hostVersion: readyStatus.hostVersion || readyStatus.version,
      platform: readyStatus.platform,
      health: readyStatus.health,
      packageRuntimeSupported: readyStatus.packageRuntimeSupported,
      runtimeBackend: readyStatus.runtimeBackend,
      selectedBackend: readyStatus.selectedBackend,
      modelCount: readyStatus.models.length
    },
    executablePaths,
    transcription: {
      text: transcription.text,
      segmentCount: transcription.segments.length,
      duration: transcription.duration
    }
  }, null, 2));
}

main().catch((error) => {
  fail('Linux CPU hosted package smoke failed', { detail: error.message, stack: error.stack });
});
