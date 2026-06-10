#!/opt/homebrew/bin/node

/**
 * Whooptido Companion - Native Messaging Host for local ASR packages
 * 
 * Uses chrome-native-messaging npm package for reliable stdio handling.
 * This is the recommended approach for Chrome native messaging with Node.js.
 * 
 * Chrome Extension <-> Native Messaging <-> This Script <-> hosted package runner
 */

const nativeMessage = require('chrome-native-messaging');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const {
  calculateFileSha256
} = require('./file-hash.js');
const {
  cleanupDeadProcessRecords,
  cleanupTempFilesForSession,
  registerProcessRecord,
  terminateAllRegisteredProcesses,
  terminateOperationProcesses,
  terminateProcessTree,
  terminateSessionProcesses,
  unregisterProcessRecord
} = require('./process-registry.js');
const {
  getPackageDirectorySize,
  validateModelPackage
} = require('./model-package-validation.js');
const {
  ensurePackageRuntimeSupport,
  getPackageRuntimeSupport
} = require('./package-runtime-support.js');

const WHOOPTIDO_DIR = path.join(os.homedir(), '.whooptido');
const MODELS_DIR = path.join(WHOOPTIDO_DIR, 'models');
const MODEL_PACKAGE_MANIFEST = 'whooptido-model.json';
const HOST_VERSION = '1.0.0';
const WHOOPTIDO_DOWNLOAD_USER_AGENT = `Whooptido-ASR-Subtitles/${HOST_VERSION} (+https://whooptido.app)`;
const MODEL_QUALITY_RANK = Object.freeze({
  'parakeet-tdt-0.6b-v3-macos-arm64-metal': 1000,
  'parakeet-tdt-0.6b-v3-windows-x64-cpu-sherpa-onnx-int8': 1000
});
const ASR_PROCESSING_PROFILE = Object.freeze({
  AUTO: 'auto',
  MAX_THROUGHPUT: 'max-throughput',
  LOW_MEMORY: 'low-memory'
});
const VALID_ASR_PROCESSING_PROFILES = new Set(Object.values(ASR_PROCESSING_PROFILE));

// Log file for debugging
const LOG_FILE = path.join(os.tmpdir(), 'whooptido-companion.log');

function log(message) {
  const timestamp = new Date().toISOString();
  try {
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
  } catch (e) {
    // Can't log, ignore
  }
}

// Also log to stderr which goes to Chrome's debug log
function logError(message) {
  log(message);
  process.stderr.write(`[Whooptido] ${message}\n`);
}

function getExecutableDir() {
  if (process.pkg && process.execPath) {
    return path.dirname(process.execPath);
  }
  return __dirname;
}

function safeExecFile(command, args = [], timeout = 3000) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout,
      windowsHide: true
    });
  } catch (error) {
    return '';
  }
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function splitCommandLines(output) {
  return uniqueStrings(String(output || '').split(/\r?\n/g));
}

function detectNvidiaDevices() {
  const output = safeExecFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], 3000);
  const nvidiaSmiDevices = splitCommandLines(output);
  if (nvidiaSmiDevices.length > 0) return nvidiaSmiDevices;
  if (os.platform() === 'win32') {
    return getWindowsVideoControllerNames().filter(line => /nvidia/i.test(line));
  }
  return [];
}

function getWindowsVideoControllerNames() {
  const command = '(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join [Environment]::NewLine';
  const powershellOutput = safeExecFile('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command
  ], 5000);
  if (powershellOutput.trim()) return splitCommandLines(powershellOutput);

  const wmicOutput = safeExecFile('wmic.exe', ['path', 'win32_VideoController', 'get', 'name'], 5000);
  return splitCommandLines(wmicOutput).filter(line => !/^name$/i.test(line));
}

function detectAmdDevices() {
  const platform = os.platform();
  let deviceLines = [];

  if (platform === 'win32') {
    deviceLines = getWindowsVideoControllerNames();
  } else if (platform === 'linux') {
    deviceLines = splitCommandLines(safeExecFile('lspci', [], 3000));
  }

  return deviceLines.filter(line => /(amd|radeon|advanced micro devices)/i.test(line));
}

function detectAcceleratedHardware() {
  const platform = os.platform();
  const arch = os.arch();
  const hardwareBackends = [];
  const devices = [];

  if (platform === 'darwin') {
    if (arch === 'arm64') {
      hardwareBackends.push('metal');
      devices.push({ vendor: 'apple', backend: 'metal', name: 'Apple Silicon' });
    }
  } else if (platform === 'win32' || platform === 'linux') {
    for (const name of detectNvidiaDevices()) {
      hardwareBackends.push('cuda');
      devices.push({ vendor: 'nvidia', backend: 'cuda', name });
    }

    for (const name of detectAmdDevices()) {
      hardwareBackends.push('vulkan');
      devices.push({ vendor: 'amd', backend: 'vulkan', name });
    }
  }

  const supportedBackends = uniqueStrings(hardwareBackends);
  return {
    platform,
    arch,
    supportedBackends,
    devices,
    supported: supportedBackends.length > 0 || platform === 'win32' || platform === 'linux',
    unsupportedReason: supportedBackends.length > 0 || platform === 'win32' || platform === 'linux'
      ? null
      : 'Word-for-Word captions require Apple Silicon Metal on macOS. Windows and Linux can use NVIDIA CUDA, AMD Vulkan, or CPU-only ASR.'
  };
}

function inferPackageRuntimeBackend(modelPackage) {
  const descriptor = [
    modelPackage?.runtimeKind,
    modelPackage?.packageVariant,
    modelPackage?.id,
    modelPackage?.runner
  ].filter(Boolean).join(' ').toLowerCase();

  if (descriptor.includes('metal')) return 'metal';
  if (descriptor.includes('cuda')) return 'cuda';
  if (descriptor.includes('vulkan')) return 'vulkan';
  if (descriptor.includes('cpu')) return 'cpu';
  return 'package-runner';
}

function getModelPackageRuntimeStatus(modelPackage) {
  const runnerPath = resolvePackageRunner(modelPackage);
  return getPackageRuntimeSupport(modelPackage, runnerPath);
}

function ensureModelPackageRuntime(modelPackage) {
  const runnerPath = resolvePackageRunner(modelPackage);
  const runtimeStatus = getPackageRuntimeSupport(modelPackage, runnerPath);
  if (runtimeStatus?.supported) {
    return {
      ...runtimeStatus,
      installed: false
    };
  }
  const ensured = ensurePackageRuntimeSupport(modelPackage, runnerPath);
  if (!ensured?.supported) {
    throw new Error(ensured?.error || runtimeStatus?.error || `Failed to prepare ASR runtime for ${modelPackage?.id || 'model package'}.`);
  }
  return ensured;
}

function buildPackageRuntimeStatus(packageModels, hardwareInfo = detectAcceleratedHardware(), packageRuntimeStatuses = null) {
  const runtimeStatuses = Array.isArray(packageRuntimeStatuses)
    ? packageRuntimeStatuses
    : (packageModels || []).map(model => getModelPackageRuntimeStatus(model));
  const runnableStatus = runtimeStatuses.find(status => status?.supported);
  if (!runnableStatus) {
    return {
      hardwareBackends: hardwareInfo.supportedBackends,
      hardwareDevices: hardwareInfo.devices,
      hardwareSupported: hardwareInfo.supported,
      runtimeBackend: null,
      runtimeFlavor: null,
      runtimeSupported: false,
      asrSupported: false,
      selectedBackend: null,
      gpuBackend: 'unknown',
      unsupportedReason: 'No installed hosted ASR model package has a supported runner.'
    };
  }

  const runnablePackage = (packageModels || []).find((model, index) => runtimeStatuses[index] === runnableStatus)
    || (packageModels || []).find(model => Boolean(resolvePackageRunner(model)));
  const runtimeBackend = runnableStatus.runtimeBackend || inferPackageRuntimeBackend(runnablePackage);

  return {
    hardwareBackends: hardwareInfo.supportedBackends,
    hardwareDevices: hardwareInfo.devices,
    hardwareSupported: hardwareInfo.supported,
    runtimeBackend,
    runtimeFlavor: runtimeBackend,
    runtimeSupported: true,
    asrSupported: true,
    selectedBackend: 'package-runner',
    gpuBackend: runtimeBackend,
    unsupportedReason: null
  };
}

function getWindowsLocalAppDataModelsDir() {
  if (os.platform() !== 'win32') return null;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Whooptido', 'models');
}

function normalizePathKey(filePath) {
  const resolved = path.resolve(filePath);
  return os.platform() === 'win32' ? resolved.toLowerCase() : resolved;
}

function safeModelDirectoryName(modelId) {
  return String(modelId || 'model')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'model';
}

function safePackageRelativePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some(part => part === '..')) {
    throw new Error('Invalid model package file path');
  }
  return normalized;
}

function readModelPackageManifest(packageDir) {
  const manifestPath = path.join(packageDir, MODEL_PACKAGE_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest?.id) return null;
    return {
      ...manifest,
      path: packageDir,
      manifestPath
    };
  } catch (error) {
    log('Error reading model package manifest ' + manifestPath + ': ' + error.message);
    return null;
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const candidate of paths.filter(Boolean)) {
    const key = normalizePathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function getModelSearchDirs() {
  return uniquePaths([
    MODELS_DIR,
    getWindowsLocalAppDataModelsDir(),
    path.join(getExecutableDir(), 'models')
  ]);
}

function getModelDirPriority(dir) {
  const key = normalizePathKey(dir);
  if (key === normalizePathKey(MODELS_DIR)) return 400;
  const windowsModelsDir = getWindowsLocalAppDataModelsDir();
  if (windowsModelsDir && key === normalizePathKey(windowsModelsDir)) return 300;
  if (key === normalizePathKey(path.join(getExecutableDir(), 'models'))) return 100;
  return 0;
}

function getModelSource(dir) {
  const key = normalizePathKey(dir);
  if (key === normalizePathKey(MODELS_DIR)) return 'canonical';
  const windowsModelsDir = getWindowsLocalAppDataModelsDir();
  if (windowsModelsDir && key === normalizePathKey(windowsModelsDir)) return 'windows-localappdata';
  if (key === normalizePathKey(path.join(getExecutableDir(), 'models'))) return 'install-dir';
  return 'other';
}

function buildPackageModelDescriptor(packageDir) {
  const manifest = readModelPackageManifest(packageDir);
  if (!manifest) return null;
  const actualSize = getPackageDirectorySize(packageDir);
  const validation = validateModelPackage(packageDir, manifest, { actualSizeBytes: actualSize });
  const size = manifest.diskSizeBytes || actualSize;
  return {
    id: String(manifest.id),
    name: manifest.displayName || manifest.id,
    displayName: manifest.displayName || manifest.id,
    fileName: path.basename(packageDir),
    path: packageDir,
    manifestPath: manifest.manifestPath,
    size,
    diskSizeBytes: size,
    qualityRank: manifest.qualityRank || getModelRank(manifest.id),
    source: getModelSource(path.dirname(packageDir)),
    modelsDir: path.dirname(packageDir),
    dirPriority: getModelDirPriority(path.dirname(packageDir)),
    runtimeKind: manifest.runtimeKind || 'unknown',
    runner: manifest.runner || null,
    packageVariant: manifest.packageVariant || '',
    supportedLanguages: Array.isArray(manifest.supportedLanguages) ? manifest.supportedLanguages : [],
    primaryLanguage: manifest.primaryLanguage || null,
    timestampSupport: manifest.timestampSupport || '',
    license: manifest.license || '',
    verifiedAt: manifest.verifiedAt || null,
    packageReleaseId: manifest.packageReleaseId || manifest.releaseId || null,
    installedFiles: Array.isArray(manifest.installedFiles) ? manifest.installedFiles.map(file => ({
      path: file.path || file.name || '',
      size: Number(file.size || 0) || 0,
      sha256: file.sha256 || null
    })).filter(file => file.path) : [],
    installedAt: manifest.installedAt || null,
    packageComplete: validation.complete,
    packageError: validation.error || null,
    missingFiles: validation.missingFiles,
    invalidFiles: validation.invalidFiles,
    actualSizeBytes: actualSize,
    expectedSizeBytes: validation.expectedSizeBytes,
    package: true
  };
}

function sortModels(models) {
  return models.sort((a, b) =>
    (b.qualityRank || 0) - (a.qualityRank || 0)
    || (b.dirPriority || 0) - (a.dirPriority || 0)
    || (b.size || 0) - (a.size || 0)
  );
}

function stripInternalModelFields(model) {
  const { dirPriority, ...publicModel } = model;
  return publicModel;
}

function findInstalledModelById(modelId) {
  if (!modelId) return null;
  const normalizedModelId = String(modelId).trim();
  return listUsableInstalledModels().find((model) => model.id === normalizedModelId) || null;
}

function listUsableInstalledModels(models = listInstalledModels()) {
  return models.filter(model => !(model.package === true && model.packageComplete === false));
}

function listIncompletePackageModels(models = listInstalledModels()) {
  return models.filter(model => model.package === true && model.packageComplete === false);
}

function getModelRank(modelId) {
  return MODEL_QUALITY_RANK[modelId] || 0;
}

function getPlatformId() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'macos-arm' : 'macos-intel';
  }
  if (platform === 'win32') {
    return 'windows-x64';
  }
  if (platform === 'linux') {
    return 'linux-x64';
  }
  return `${platform}-${arch}`;
}

function listInstalledModels() {
  try {
    const discovered = [];

    for (const dir of getModelSearchDirs()) {
      if (!fs.existsSync(dir)) continue;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isDirectory())) {
        try {
          const packageModel = buildPackageModelDescriptor(path.join(dir, entry.name));
          if (packageModel) discovered.push(packageModel);
        } catch (error) {
          log('Error reading model package ' + path.join(dir, entry.name) + ': ' + error.message);
        }
      }
    }

    const deduped = new Map();
    for (const model of sortModels(discovered)) {
      if (!deduped.has(model.id)) {
        deduped.set(model.id, stripInternalModelFields(model));
      }
    }

    return Array.from(deduped.values());
  } catch (error) {
    log('Error listing installed models: ' + error.message);
    return [];
  }
}

function normalizeAsrProcessingProfile(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_ASR_PROCESSING_PROFILES.has(normalized)
    ? normalized
    : ASR_PROCESSING_PROFILE.AUTO;
}

function normalizeBackend(value) {
  return String(value || '').trim().toLowerCase() || 'unknown';
}

function getAsrThreadCount({ performanceProfile = ASR_PROCESSING_PROFILE.AUTO, runtimeBackend = 'unknown' } = {}) {
  const cpuCount = os.cpus()?.length || 4;
  const coreLimit = Math.max(1, cpuCount - 1);
  const normalizedProfile = normalizeAsrProcessingProfile(performanceProfile);
  const backend = normalizeBackend(runtimeBackend);
  const configuredMaxThreads = Number.parseInt(process.env.WHOOPTIDO_MAX_THREADS || '', 10);

  if (Number.isFinite(configuredMaxThreads) && configuredMaxThreads > 0) {
    return Math.max(1, Math.min(configuredMaxThreads, coreLimit));
  }

  if (normalizedProfile === ASR_PROCESSING_PROFILE.LOW_MEMORY) {
    return Math.max(1, Math.min(2, coreLimit));
  }

  if (backend === 'metal') {
    return Math.max(1, Math.min(8, coreLimit));
  }

  if (backend === 'cuda' || backend === 'vulkan') {
    return Math.max(1, Math.min(6, coreLimit));
  }

  return Math.max(1, Math.min(4, coreLimit));
}

function parseWavHeader(buffer) {
  if (!buffer || buffer.length < 44) return null;
  try {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const byteRate = view.getUint32(28, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    const channels = view.getUint16(22, true);
    return {
      headerSize: 44,
      header: buffer.slice(0, 44),
      byteRate,
      sampleRate,
      bitsPerSample,
      channels
    };
  } catch (e) {
    return null;
  }
}

function getUploadedAudioDurationMs(session, fallbackMs) {
  const uploadedBytes = Number(session?.receivedBytes || 0);
  const headerBytes = session?.wavHeader?.length || 44;
  const audioBytes = Math.max(0, uploadedBytes - headerBytes);
  if (session?.byteRate && audioBytes > 0) {
    return Math.round((audioBytes / session.byteRate) * 1000);
  }
  return fallbackMs;
}

function ensurePackageExecutable(filePath) {
  if (os.platform() === 'win32' || !filePath) return;
  try {
    fs.chmodSync(filePath, 0o755);
  } catch (error) {
    log(`Unable to mark package executable ${filePath}: ${error.message}`);
  }
}

function resolvePackageRunner(modelPackage) {
  if (modelPackage?.packageComplete === false) {
    return null;
  }

  const manifest = readModelPackageManifest(modelPackage.path);
  const runner = manifest?.runner || null;
  const platformKey = `${os.platform()}-${os.arch()}`;
  const runnerCandidate = typeof runner === 'string'
    ? runner
    : runner?.[platformKey] || runner?.[os.platform()] || runner?.default || null;

  const candidates = [
    runnerCandidate,
    'runner.js',
    os.platform() === 'win32' ? 'runner.exe' : 'runner'
  ].filter(Boolean);

  for (const candidate of candidates) {
    const relative = safePackageRelativePath(candidate);
    const runnerPath = path.join(modelPackage.path, relative);
    if (fs.existsSync(runnerPath)) {
      ensurePackageExecutable(runnerPath);
      return runnerPath;
    }
  }

  return null;
}

function transcribeFileWithRunnerPackage({
  audioFilePath,
  language,
  modelPackage,
  mode = 'accurate',
  performanceProfile = ASR_PROCESSING_PROFILE.AUTO,
  cleanupPaths = [],
  operationKey = null,
  isCancelled = () => false
}) {
  return new Promise((resolve, reject) => {
    if (isCancelled()) {
      reject(new Error('Transcription cancelled before start'));
      return;
    }

    const runnerPath = resolvePackageRunner(modelPackage);
    if (!runnerPath) {
      reject(new Error(`Installed model package ${modelPackage.id} does not include a runnable ASR adapter yet.`));
      return;
    }

    const outputPath = path.join(os.tmpdir(), `whooptido-transcription-${Date.now()}.json`);
    const args = [
      '--model-dir', modelPackage.path,
      '--audio', audioFilePath,
      '--language', language || 'auto',
      '--output', outputPath,
      '--mode', mode,
      '--performance-profile', normalizeAsrProcessingProfile(performanceProfile)
    ];

    const command = runnerPath.endsWith('.js') ? process.execPath : runnerPath;
    const commandArgs = runnerPath.endsWith('.js') ? [runnerPath, ...args] : args;
    log(`ASR package runner: ${command} ${commandArgs.join(' ')}`);
    const startTime = Date.now();
    const child = spawn(command, commandArgs, {
      cwd: modelPackage.path,
      env: { ...process.env, WHOOPTIDO_MODEL_DIR: modelPackage.path },
      detached: os.platform() !== 'win32',
      windowsHide: true
    });
    registerAsrProcess(operationKey, child, {
      audioFilePath,
      outputPath,
      cleanupPaths,
      command,
      args: commandArgs
    });
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearAsrProcess(operationKey);
      cleanupPaths.forEach((filePath) => {
        if (filePath && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
        }
      });

      if (code !== 0) {
        if (isCancelled()) {
          reject(new Error('Transcription cancelled'));
          return;
        }
        reject(new Error(`ASR package runner failed with code ${code}: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        try { fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
        resolve({
          segments: Array.isArray(result.segments) ? result.segments : [],
          text: result.text || '',
          duration: result.duration || (Date.now() - startTime)
        });
      } catch (error) {
        reject(new Error(`Failed to read ASR package output: ${error.message}`));
      }
    });

    child.on('error', (err) => {
      clearAsrProcess(operationKey);
      reject(new Error(`Failed to start ASR package runner: ${err.message}`));
    });
  });
}

function transcribeFileWithModel(options) {
  const installedModel = options.modelId
    ? findInstalledModelById(options.modelId)
    : listUsableInstalledModels()[0] || null;

  if (!installedModel?.package) {
    throw new Error('No installed Parakeet ASR model package is available. Install a hosted Parakeet model package first.');
  }

  return transcribeFileWithRunnerPackage({
    ...options,
    modelPackage: installedModel
  });
}

log('=== Whooptido Companion started (chrome-native-messaging) ===');
log(`Node version: ${process.version}`);
log(`Platform: ${process.platform} ${process.arch}`);
cleanupDeadProcessRecords();

const chunkSessions = new Map();
const directSessions = new Map();
const activeAsrProcesses = new Map();

function removeChunkSession(sessionId) {
  const session = chunkSessions.get(sessionId);
  let removed = false;
  if (session) {
    session.cancelRequested = true;
    session.status = 'cancelled';
    session.updatedAt = Date.now();
    if (session.activeOperationKey) {
      cancelAsrOperation(session.activeOperationKey);
    }
    if (session.tempFile && fs.existsSync(session.tempFile)) {
      try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
    }
    chunkSessions.delete(sessionId);
    removed = true;
  }
  const external = terminateSessionProcesses(sessionId);
  cleanupTempFilesForSession(sessionId);
  return removed || external.terminated.length > 0 || external.cleanedFiles.length > 0;
}

function removeDirectSession(sessionId) {
  const session = directSessions.get(sessionId);
  let removed = false;
  if (session) {
    session.cancelRequested = true;
    session.status = 'cancelled';
    session.updatedAt = Date.now();
    cancelAsrOperation(session.operationKey);
    directSessions.delete(sessionId);
    removed = true;
  }
  const external = terminateSessionProcesses(sessionId);
  return removed || external.terminated.length > 0 || external.cleanedFiles.length > 0;
}

function preemptOtherSessions(currentSessionId) {
  const cancelled = [];

  for (const sessionId of Array.from(chunkSessions.keys())) {
    if (sessionId === currentSessionId) continue;
    if (removeChunkSession(sessionId)) {
      cancelled.push(sessionId);
    }
  }

  for (const sessionId of Array.from(directSessions.keys())) {
    if (sessionId === currentSessionId) continue;
    if (removeDirectSession(sessionId)) {
      cancelled.push(sessionId);
    }
  }

  if (cancelled.length > 0) {
    log(`Preempted ${cancelled.length} stale ASR session(s): ${cancelled.join(', ')}`);
  }

  const external = terminateAllRegisteredProcesses({
    exceptSessionId: currentSessionId,
    includeProcessScan: true,
    scanDespiteExceptSession: true
  });
  if (external.terminated.length > 0) {
    log(`Preempted ${external.terminated.length} stale ASR process(es) from registry`);
  }
}

function registerAsrProcess(operationKey, proc, metadata = {}) {
  if (!operationKey || !proc) return;
  activeAsrProcesses.set(operationKey, proc);
  registerProcessRecord(operationKey, proc, metadata);
}

function clearAsrProcess(operationKey) {
  if (!operationKey) return;
  activeAsrProcesses.delete(operationKey);
  unregisterProcessRecord(operationKey);
}

function cancelAsrOperation(operationKey) {
  if (!operationKey) return false;
  const proc = activeAsrProcesses.get(operationKey);
  let cancelled = false;
  const externalResult = terminateOperationProcesses(operationKey);
  cancelled = externalResult.terminated.length > 0;
  try {
    if (proc?.pid) {
      cancelled = terminateProcessTree(proc.pid) || cancelled;
    }
    return cancelled;
  } catch (error) {
    logError(`Failed to cancel ASR operation ${operationKey}: ${error.message}`);
    return cancelled;
  }
}

function pauseAsrOperation(operationKey) {
  if (!operationKey) return false;
  const proc = activeAsrProcesses.get(operationKey);
  if (!proc) return false;
  try {
    proc.kill('SIGSTOP');
    return true;
  } catch (error) {
    logError(`Failed to pause ASR operation ${operationKey}: ${error.message}`);
    return false;
  }
}

function resumeAsrOperation(operationKey) {
  if (!operationKey) return false;
  const proc = activeAsrProcesses.get(operationKey);
  if (!proc) return false;
  try {
    proc.kill('SIGCONT');
    return true;
  } catch (error) {
    logError(`Failed to resume ASR operation ${operationKey}: ${error.message}`);
    return false;
  }
}

// Use the chrome-native-messaging Transform stream pattern
const inputStream = new nativeMessage.Input();
const transformStream = new nativeMessage.Transform(function(msg, push, done) {
  log(`Received: ${JSON.stringify(msg).substring(0, 500)}`);
  
  try {
    handleMessage(msg, push, done);
  } catch (err) {
    logError(`Error handling message: ${err.message}\n${err.stack}`);
    push({ error: err.message, type: 'error' });
    done();
  }
});
const outputStream = new nativeMessage.Output();

// Monitor stream state
process.stdin.on('close', () => log('stdin closed'));
process.stdin.on('end', () => log('stdin ended'));
process.stdout.on('close', () => log('stdout closed'));
process.stdout.on('error', (err) => log(`stdout error: ${err.message}`));

process.stdin
  .pipe(inputStream)
  .pipe(transformStream)
  .pipe(outputStream)
  .pipe(process.stdout);

function cleanupAllOperations() {
  for (const sessionId of Array.from(chunkSessions.keys())) {
    const session = chunkSessions.get(sessionId);
    if (session?.activeOperationKey) {
      cancelAsrOperation(session.activeOperationKey);
    }
    if (session?.tempFile && fs.existsSync(session.tempFile)) {
      try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
    }
    chunkSessions.delete(sessionId);
  }

  for (const sessionId of Array.from(directSessions.keys())) {
    const session = directSessions.get(sessionId);
    cancelAsrOperation(session?.operationKey);
    directSessions.delete(sessionId);
  }

  for (const operationKey of Array.from(activeAsrProcesses.keys())) {
    cancelAsrOperation(operationKey);
    clearAsrProcess(operationKey);
  }

  terminateAllRegisteredProcesses({ includeProcessScan: false });
}

// Handle SIGTERM/SIGINT gracefully
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down');
  cleanupAllOperations();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down');
  cleanupAllOperations();
  process.exit(0);
});

// Catch uncaught exceptions
process.on('uncaughtException', (err) => {
  logError(`Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

/**
 * Handle incoming messages
 */
function handleMessage(msg, push, done) {
  const msgType = msg.type || 'unknown';
  
  switch (msgType) {
    case 'ping':
      push({ type: 'pong', version: HOST_VERSION });
      done();
      break;
      
    case 'status':
      handleStatus(push);
      done();
      break;
      
    case 'listModels':
      handleListModels(push);
      done();
      break;

    case 'delete_model':
      handleDeleteModel(msg, push);
      done();
      break;
      
    case 'download_model':
      handleDownloadModel(msg, push, done);
      // Note: done() called asynchronously after download
      break;
      
    case 'transcribe':
      handleTranscribe(msg, push, done);
      // Note: done() called asynchronously after transcription
      break;

    case 'transcribe_init':
      handleTranscribeInit(msg, push, done);
      break;

    case 'transcribe_chunk':
      handleTranscribeChunk(msg, push, done);
      break;

    case 'transcribe_complete':
      handleTranscribeComplete(msg, push, done);
      break;

    case 'transcribe_cancel':
      handleTranscribeCancel(msg, push, done);
      break;

    case 'transcribe_pause':
      handleTranscribePause(msg, push, done);
      break;

    case 'transcribe_resume':
      handleTranscribeResume(msg, push, done);
      break;

    case 'transcribe_status':
      handleTranscribeStatus(msg, push, done);
      break;

    case 'transcribe_cleanup':
      handleTranscribeCleanup(msg, push, done);
      break;

    case 'uninstall':
      handleUninstall(msg, push, done);
      break;
      
    default:
      push({ type: 'error', error: `Unknown message type: ${msgType}` });
      done();
  }
}

/**
 * Get the native messaging host manifest path for the current platform
 * @returns {string}
 */
/**
 * Get ALL native messaging host manifest paths for the current platform.
 * Returns both user-level and system-level paths so uninstall cleans everything.
 * @returns {string[]}
 */
function getAllNativeMessagingManifestPaths() {
  const home = os.homedir();
  const platform = os.platform();
  const paths = [];

  switch (platform) {
    case 'darwin':
      paths.push(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome',
        'NativeMessagingHosts', 'com.whooptido.companion.json'));
      // System-wide path (may require elevated permissions)
      paths.push('/Library/Google/Chrome/NativeMessagingHosts/com.whooptido.companion.json');
      break;
    case 'linux':
      paths.push(path.join(home, '.config', 'google-chrome',
        'NativeMessagingHosts', 'com.whooptido.companion.json'));
      // System-wide path
      paths.push('/etc/opt/chrome/native-messaging-hosts/com.whooptido.companion.json');
      break;
    case 'win32':
      paths.push(path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
        'Google', 'Chrome', 'User Data', 'NativeMessagingHosts', 'com.whooptido.companion.json'));
      break;
  }

  return paths;
}

/**
 * Handle self-uninstall request from the extension.
 * Removes: native messaging manifests, ASR model packages, temp files, then companion directory.
 * Sends ack response BEFORE deleting self, then exits.
 */
/**
 * Handle self-uninstall request from the extension.
 * Since all Whooptido files live under ~/.whooptido/ (binary, models, logs),
 * uninstall is straightforward: remove NM manifests, clean temp files,
 * send ack, then rm -rf the entire Whooptido directory.
 */
function handleUninstall(msg, push, done) {
  const errors = [];
  const deleted = [];

  // 1. Remove ALL native messaging manifests (user-level AND system-level)
  const manifestPaths = getAllNativeMessagingManifestPaths();
  for (const manifestPath of manifestPaths) {
    try {
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
        deleted.push('manifest: ' + manifestPath);
        log('Uninstall: removed manifest at ' + manifestPath);
      }
    } catch (e) {
      // System-level path may require root — log but don't treat as fatal
      if (manifestPath.startsWith('/Library') || manifestPath.startsWith('/etc')) {
        log('Uninstall: skipped system manifest (permission denied): ' + manifestPath);
      } else {
        errors.push('manifest: ' + e.message);
        log('Uninstall: failed to remove manifest: ' + e.message);
      }
    }
  }

  // 2. Clean up temp files
  try {
    const tmpDir = os.tmpdir();
    const tmpFiles = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('whooptido-'));
    for (const f of tmpFiles) {
      try {
        const fullPath = path.join(tmpDir, f);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      } catch (e) {
        // Best-effort cleanup — ignore individual file errors
      }
    }
    if (tmpFiles.length > 0) {
      deleted.push('temp: ' + tmpFiles.length + ' files');
    }
    log('Uninstall: cleaned ' + tmpFiles.length + ' temp files');
  } catch (e) {
    // ignore
  }

  // 3. On Windows, remove registry entry for native messaging
  if (os.platform() === 'win32') {
    try {
      const { execSync } = require('child_process');
      execSync('reg delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.whooptido.companion" /f', { stdio: 'pipe' });
      deleted.push('registry: com.whooptido.companion');
      log('Uninstall: removed registry entry');
    } catch (e) {
      log('Uninstall: registry removal skipped (may not exist): ' + e.message);
    }
  }

  // 4. Send success ack BEFORE self-deletion
  push({
    type: 'uninstall_ack',
    success: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    deleted: deleted
  });
  done();

  // 5. Delete entire ~/.whooptido/ directory (binary, models, everything)
  const platform = os.platform();

  if (platform === 'win32') {
    // Windows: can't delete running exe — spawn detached cleanup script
    try {
      const batContent = '@echo off\r\ntimeout /t 2 /nobreak >nul\r\nrmdir /s /q "' + WHOOPTIDO_DIR + '"\r\n';
      const batPath = path.join(os.tmpdir(), 'whooptido-cleanup.bat');
      fs.writeFileSync(batPath, batContent);
      const { spawn } = require('child_process');
      spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
      log('Uninstall: spawned Windows cleanup script');
    } catch (e) {
      log('Uninstall: Windows cleanup script failed: ' + e.message);
    }
  } else {
    // macOS/Linux: safe to delete self while running (inode-based filesystem)
    try {
      if (fs.existsSync(WHOOPTIDO_DIR)) {
        fs.rmSync(WHOOPTIDO_DIR, { recursive: true, force: true });
        log('Uninstall: removed ' + WHOOPTIDO_DIR);
      }
    } catch (e) {
      log('Uninstall: failed to remove companion dir: ' + e.message);
    }
  }

  // 7. Exit after a short delay to ensure ack is flushed
  log('Uninstall: complete — exiting');
  setTimeout(() => process.exit(0), 200);
}

function handleStatus(push) {
  const discoveredModels = listInstalledModels();
  const incompletePackageModels = listIncompletePackageModels(discoveredModels);
  const models = listUsableInstalledModels(discoveredModels);
  const activeModel = models[0] || null;
  const packageModels = models.filter(model => model.package === true);
  const packageRuntimeStatuses = packageModels.map(model => getModelPackageRuntimeStatus(model));
  const packageRuntimeSupported = packageRuntimeStatuses.some(status => status?.supported === true);
  const firstPackageRuntimeFailure = packageRuntimeStatuses.find(status => status?.supported === false) || null;
  const hardwareInfo = detectAcceleratedHardware();
  const runtimeStatus = buildPackageRuntimeStatus(packageModels, hardwareInfo, packageRuntimeStatuses);
  const gpuBackend = runtimeStatus.gpuBackend || 'unknown';
  const canInstallModels = true;
  const hasInstalledModelWithoutRuntime = packageModels.length > 0 && !packageRuntimeSupported && !runtimeStatus.asrSupported;
  const hasIncompletePackage = incompletePackageModels.length > 0;
  const health = (!hasIncompletePackage && !hasInstalledModelWithoutRuntime)
    ? 'ok'
    : 'degraded';
  const installState = health === 'ok' ? 'installed' : 'installed-degraded';
  const packageError = hasInstalledModelWithoutRuntime
    ? (firstPackageRuntimeFailure?.error || 'Installed hosted ASR model package does not include a runnable adapter for this companion build.')
    : null;
  const incompletePackageErrors = incompletePackageModels.map(model =>
    model.packageError || `Installed hosted ASR model package ${model.id} is incomplete.`
  );
  const errors = [
    ...incompletePackageErrors,
    !packageRuntimeSupported && models.length > 0 ? runtimeStatus.unsupportedReason : null,
    packageError
  ].filter(Boolean);

  push({
    type: 'status',
    installed: true,
    reachable: true,
    protocolVersion: 2,
    hostVersion: HOST_VERSION,
    version: HOST_VERSION,
    platform: getPlatformId(),
    systemInfo: {
      os: os.platform(),
      architecture: os.arch(),
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem()
    },
    installState,
    health,
    canInstallModels,
    packageRuntimeSupported,
    modelInstalled: models.length > 0,
    modelPath: activeModel?.path || null,
    modelsDir: MODELS_DIR,
    modelSearchDirs: getModelSearchDirs(),
    models,
    incompletePackages: incompletePackageModels.map(model => ({
      id: model.id,
      name: model.name,
      displayName: model.displayName,
      path: model.path,
      manifestPath: model.manifestPath,
      packageError: model.packageError,
      missingFiles: model.missingFiles,
      invalidFiles: model.invalidFiles,
      actualSizeBytes: model.actualSizeBytes,
      expectedSizeBytes: model.expectedSizeBytes
    })),
    packageRuntimeChecks: packageRuntimeStatuses.map(status => ({
      supported: status.supported === true,
      runtimeKind: status.runtimeKind || null,
      runtimeBackend: status.runtimeBackend || null,
      runnerPath: status.runnerPath || null,
      modelDir: status.modelDir || null,
      probeArgs: status.probeArgs || null,
      pythonPath: status.pythonPath || null,
      error: status.error || null
    })),
    activeModelId: activeModel?.id || null,
    gpuBackend,
    hardwareBackends: runtimeStatus.hardwareBackends,
    hardwareDevices: runtimeStatus.hardwareDevices,
    hardwareSupported: runtimeStatus.hardwareSupported,
    runtimeBackend: runtimeStatus.runtimeBackend,
    runtimeFlavor: runtimeStatus.runtimeFlavor,
    runtimeSupported: runtimeStatus.runtimeSupported || packageRuntimeSupported,
    asrSupported: runtimeStatus.asrSupported || packageRuntimeSupported || models.length === 0,
    selectedBackend: runtimeStatus.selectedBackend || (packageRuntimeSupported ? 'package-runner' : null),
    defaultProcessingProfile: ASR_PROCESSING_PROFILE.MAX_THROUGHPUT,
    defaultThreadCount: getAsrThreadCount({
      performanceProfile: ASR_PROCESSING_PROFILE.MAX_THROUGHPUT,
      runtimeBackend: runtimeStatus.runtimeBackend || gpuBackend
    }),
    lowMemoryThreadCount: getAsrThreadCount({
      performanceProfile: ASR_PROCESSING_PROFILE.LOW_MEMORY,
      runtimeBackend: runtimeStatus.runtimeBackend || gpuBackend
    }),
    unsupportedReason: packageError || (!packageRuntimeSupported && models.length > 0 ? runtimeStatus.unsupportedReason : null),
    acceleratedBackendsRequired: false,
    errors
  });

  if (packageRuntimeSupported) {
    log('Status check: host reachable, hosted package runner available, models=' + models.length + ', backend=' + gpuBackend);
  } else {
    log('Status check: host reachable, ASR degraded - ' + errors.join(' | '));
  }
}

/**
 * List installed ASR model packages
 */
function handleListModels(push) {
  try {
    const discoveredModels = listInstalledModels();
    const models = listUsableInstalledModels(discoveredModels);
    const incompletePackages = listIncompletePackageModels(discoveredModels);
    push({ type: 'models', models, incompletePackages, modelSearchDirs: getModelSearchDirs() });
    log(`Listed ${models.length} models`);
  } catch (e) {
    push({ type: 'models', models: [], modelSearchDirs: getModelSearchDirs(), error: e.message });
    log('Error listing models: ' + e.message);
  }
}

function handleDeleteModel(msg, push) {
  const modelId = String(msg.modelId || '').trim();

  if (!modelId) {
    push({ type: 'delete_model_ack', success: false, error: 'Missing modelId' });
    return;
  }

  try {
    const deleted = [];
    for (const dir of getModelSearchDirs()) {
      if (!fs.existsSync(dir)) continue;

      const presentEntries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of presentEntries.filter((item) => item.isDirectory())) {
        const packageDir = path.join(dir, entry.name);
        const manifest = readModelPackageManifest(packageDir);
        if (manifest?.id !== modelId) continue;
        fs.rmSync(packageDir, { recursive: true, force: true });
        deleted.push(packageDir);
        log('Deleted model package: ' + packageDir);
      }
    }

    push({
      type: 'delete_model_ack',
      success: true,
      deleted
    });
  } catch (error) {
    log('Delete model error: ' + error.message);
    push({
      type: 'delete_model_ack',
      success: false,
      error: error.message
    });
  }
}

function shouldSkipChecksum(value) {
  return !value || /^skip_check/i.test(String(value));
}

async function downloadFile(url, destinationPath, expectedSize, expectedSha256 = null) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    throw new Error(`Invalid model download URL: ${error.message}`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Unsupported model download protocol: ${parsedUrl.protocol}`);
  }

  const tempPath = `${destinationPath}.part`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3600000);
  let movedToDestination = false;

  try {
    const response = await fetch(parsedUrl, {
      headers: {
        'User-Agent': WHOOPTIDO_DOWNLOAD_USER_AGENT,
        Accept: 'application/octet-stream, application/json;q=0.9, */*;q=0.8'
      },
      redirect: 'follow',
      signal: controller.signal
    });

    if (!response.ok) {
      const excerpt = await response.text()
        .then(body => String(body || '').replace(/\s+/g, ' ').trim().slice(0, 200))
        .catch(() => '');
      throw new Error(`Model download failed: HTTP ${response.status}${excerpt ? `; ${excerpt}` : ''}`);
    }

    if (!response.body) {
      throw new Error('Model download failed: empty response body');
    }

    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath));

    const stats = fs.statSync(tempPath);
    if (expectedSize && Math.abs(stats.size - expectedSize) > 1000) {
      throw new Error(`Model download size mismatch: expected ${expectedSize}, got ${stats.size}`);
    }

    if (!shouldSkipChecksum(expectedSha256)) {
      const actualSha256 = await calculateFileSha256(tempPath);
      if (actualSha256.toLowerCase() !== String(expectedSha256).toLowerCase()) {
        throw new Error('Model download checksum mismatch');
      }
    }

    if (fs.existsSync(destinationPath)) {
      fs.unlinkSync(destinationPath);
    }
    fs.renameSync(tempPath, destinationPath);
    movedToDestination = true;
    return stats.size;
  } catch (error) {
    if (!movedToDestination) {
      try { fs.unlinkSync(tempPath); } catch (cleanupError) { /* ignore */ }
    }
    if (error?.name === 'AbortError') {
      throw new Error('Model download timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function handleDownloadModel(msg, push, done) {
  const { modelId, size, files, packageManifest } = msg;
  const expectedSize = Number.isFinite(Number(size)) ? Number(size) : null;

  if (Array.isArray(files) && files.length > 0) {
    handleDownloadModelPackage({ modelId, files, packageManifest, expectedSize }, push, done);
    return;
  }

  push({
    type: 'download_error',
    success: false,
    modelId,
    error: 'Hosted ASR downloads must include a package manifest and file list.'
  });
  done();
}

function handleDownloadModelPackage({ modelId, files, packageManifest = null, expectedSize = null }, push, done) {
  const packageDir = path.join(MODELS_DIR, safeModelDirectoryName(modelId));
  const manifestPath = path.join(packageDir, MODEL_PACKAGE_MANIFEST);
  log(`Package download requested: ${modelId}, files=${files.length}`);

  const existingModel = findInstalledModelById(modelId);
  if (existingModel?.package && (!expectedSize || Math.abs((existingModel.size || 0) - expectedSize) < 1000)) {
    try {
      const runtime = ensureModelPackageRuntime(existingModel);
      push({
        type: 'download_complete',
        success: true,
        modelId,
        path: existingModel.path,
        size: existingModel.size,
        packageRuntimeSupported: true,
        packageRuntimeInstalled: runtime.installed === true,
        pythonPath: runtime.pythonPath || null,
        message: runtime.installed
          ? 'Model package already installed; ASR runtime repaired'
          : 'Model package already installed'
      });
    } catch (error) {
      push({
        type: 'download_error',
        success: false,
        modelId,
        path: existingModel.path,
        error: error.message
      });
      log(`Package runtime repair error: ${error.message}`);
    }
    done();
    return;
  }

  (async () => {
    let keepPackageOnError = false;
    try {
      fs.mkdirSync(packageDir, { recursive: true });
      let downloadedSize = 0;
      const installedFiles = [];

      for (const file of files) {
        const relativePath = safePackageRelativePath(file.path || file.name);
        const destinationPath = path.join(packageDir, relativePath);
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        const fileSize = Number.isFinite(Number(file.size)) ? Number(file.size) : null;
        const finalSize = await downloadFile(file.url, destinationPath, fileSize, file.sha256);
        downloadedSize += finalSize || 0;
        installedFiles.push({
          path: relativePath,
          size: finalSize || fileSize || 0,
          sha256: file.sha256 || null
        });
      }

      const manifest = {
        ...(packageManifest || {}),
        id: modelId,
        installedAt: new Date().toISOString(),
        installedFiles,
        diskSizeBytes: downloadedSize || expectedSize || packageManifest?.diskSizeBytes || 0,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      keepPackageOnError = true;

      const installedModel = buildPackageModelDescriptor(packageDir);
      const runtime = ensureModelPackageRuntime(installedModel || {
        id: modelId,
        path: packageDir,
        package: true,
        packageComplete: true,
        runtimeKind: manifest.runtimeKind,
        runner: manifest.runner
      });

      push({
        type: 'download_complete',
        success: true,
        modelId,
        path: packageDir,
        size: manifest.diskSizeBytes,
        packageRuntimeSupported: true,
        packageRuntimeInstalled: runtime.installed === true,
        pythonPath: runtime.pythonPath || null
      });
      log(`Package download complete: ${packageDir}`);
    } catch (e) {
      if (!keepPackageOnError) {
        try {
          fs.rmSync(packageDir, { recursive: true, force: true });
        } catch (cleanupErr) { /* ignore */ }
      }

      push({
        type: 'download_error',
        success: false,
        modelId,
        error: e.message
      });
      log(`Package download error: ${e.message}`);
    } finally {
      done();
    }
  })();
}

function handleTranscribe(msg, push, done) {
  const { audioPath, audio, language, modelId, id, cleanupPath, performanceProfile } = msg;
  const sessionId = id || `direct_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const operationKey = `direct:${sessionId}`;
  preemptOtherSessions(sessionId);
  
  let audioFilePath = audioPath;
  let tempFile = null;
  
  // If base64 audio data provided, write to temp file
  if (audio && !audioPath) {
    tempFile = path.join(os.tmpdir(), `whooptido-audio-${Date.now()}.wav`);
    try {
      const audioBuffer = Buffer.from(audio, 'base64');
      fs.writeFileSync(tempFile, audioBuffer);
      audioFilePath = tempFile;
      log(`Wrote ${audioBuffer.length} bytes to temp file: ${tempFile}`);
    } catch (e) {
      push({ id: sessionId, type: 'transcription_error', error: `Failed to write audio: ${e.message}` });
      done();
      return;
    }
  }
  
  if (!audioFilePath || !fs.existsSync(audioFilePath)) {
    push({ id: sessionId, type: 'transcription_error', error: `Audio file not found: ${audioFilePath}` });
    done();
    return;
  }
  
  const lang = language || 'auto';
  log(`Transcribing: ${audioFilePath} with model=${modelId || 'auto'} language=${lang}`);
  directSessions.set(sessionId, {
    id: sessionId,
    operationKey,
    status: 'running',
    cancelRequested: false,
    pauseRequested: false,
    startedAt: Date.now(),
    updatedAt: Date.now()
  });

  (async () => {
    try {
      const result = await transcribeFileWithModel({
        audioFilePath,
        language: lang,
        modelId,
        performanceProfile,
        cleanupPaths: [tempFile, cleanupPath],
        operationKey,
        isCancelled: () => !!directSessions.get(sessionId)?.cancelRequested
      });

      const session = directSessions.get(sessionId);
      if (session?.cancelRequested) {
        throw new Error('Transcription cancelled');
      }

      const segmentCount = result.segments.length;
      const response = {
        id: sessionId,
        type: 'transcription',
        duration: result.duration,
        segments: result.segments,
        text: result.text
      };
      log(`Pushing transcription response: id=${sessionId} segments=${segmentCount} textLen=${response.text?.length || 0}`);
      push(response);
      log(`Push completed for id=${sessionId}`);
    } catch (e) {
      log(`Error reading transcription: ${e.message}`);
      push({
        id: sessionId,
        type: 'transcription_error',
        error: e.message
      });
    } finally {
      directSessions.delete(sessionId);
      clearAsrProcess(operationKey);
    }

    log(`Calling done() for id=${sessionId}`);
    done();
  })();
}

function handleTranscribeInit(msg, push, done) {
  const { id, totalBytes, totalChunks, chunkBytes, language, modelId, mode, performanceProfile, requestedPerformanceProfile, runtimeBackend } = msg;
  if (!id) {
    push({ id, type: 'transcribe_init_ack', error: 'Missing id' });
    done();
    return;
  }
  preemptOtherSessions(id);
  removeChunkSession(id);
  removeDirectSession(id);

  const tempFile = path.join(os.tmpdir(), `whooptido-audio-chunked-${id}.wav`);

  try {
    fs.writeFileSync(tempFile, Buffer.alloc(0));
    chunkSessions.set(id, {
      id,
      tempFile,
      totalBytes,
      totalChunks,
      chunkBytes,
      receivedBytes: 0,
      bytesConsumed: 0,
      byteRate: null,
      wavHeader: null,
      headerParsed: false,
      language,
      modelId,
      mode: mode === 'fast' ? 'fast' : 'accurate',
      performanceProfile: normalizeAsrProcessingProfile(performanceProfile || requestedPerformanceProfile),
      requestedPerformanceProfile: normalizeAsrProcessingProfile(requestedPerformanceProfile || performanceProfile),
      runtimeBackend: normalizeBackend(runtimeBackend),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      cancelRequested: false,
      pauseRequested: false,
      activeOperationKey: null
    });
    log(`Chunked init: id=${id} totalBytes=${totalBytes} totalChunks=${totalChunks} chunkBytes=${chunkBytes} mode=${mode === 'fast' ? 'fast' : 'accurate'} profile=${normalizeAsrProcessingProfile(performanceProfile || requestedPerformanceProfile)} backend=${normalizeBackend(runtimeBackend)}`);
    push({ id, type: 'transcribe_init_ack', success: true });
  } catch (e) {
    logError(`Chunked init error: ${e.message}`);
    push({ id, type: 'transcribe_init_ack', error: e.message });
  }

  done();
}

function handleTranscribeChunk(msg, push, done) {
  const { id, data, byteLength, index, totalChunks } = msg;
  const session = chunkSessions.get(id);
  if (!session) {
    push({ id, type: 'transcribe_chunk_ack', error: 'Session not found' });
    done();
    return;
  }

  (async () => {
    try {
      if (session.cancelRequested) {
        push({ id, type: 'transcribe_chunk_ack', error: 'Session cancelled' });
        done();
        return;
      }
      if (session.pauseRequested) {
        push({ id, type: 'transcribe_chunk_ack', error: 'Session paused' });
        done();
        return;
      }

      session.updatedAt = Date.now();
      const buffer = Buffer.from(data, 'base64');
      const expectedByteLength = Number(byteLength);
      if (Number.isFinite(expectedByteLength) && expectedByteLength >= 0 && buffer.length !== expectedByteLength) {
        throw new Error(`Chunk byte length mismatch: expected ${expectedByteLength}, received ${buffer.length}`);
      }

      fs.appendFileSync(session.tempFile, buffer);
      session.receivedBytes += buffer.length;

      if (!session.headerParsed) {
        const headerInfo = parseWavHeader(buffer);
        if (!headerInfo) {
          throw new Error('Failed to parse WAV header from first chunk');
        }
        session.wavHeader = headerInfo.header;
        session.byteRate = headerInfo.byteRate;
        session.headerParsed = true;
      }

      session.bytesConsumed = Math.max(0, session.receivedBytes - (session.wavHeader?.length || 0));

      const chunkIndex = Number(index);
      const chunkCount = Number(totalChunks || session.totalChunks);
      if (
        chunkIndex === 0 ||
        (Number.isFinite(chunkIndex) && Number.isFinite(chunkCount) && (chunkIndex + 1) === chunkCount) ||
        (Number.isFinite(chunkIndex) && (chunkIndex + 1) % 10 === 0)
      ) {
        log(`Chunked upload progress: id=${id} chunk=${Number.isFinite(chunkIndex) ? chunkIndex + 1 : '?'}${Number.isFinite(chunkCount) ? `/${chunkCount}` : ''} received=${session.receivedBytes}`);
      }

      push({
        id,
        type: 'transcribe_chunk_ack',
        success: true,
        receivedBytes: session.receivedBytes,
        byteLength: buffer.length,
        processedSegments: 0,
        segments: [],
        text: ''
      });
    } catch (e) {
      session.activeOperationKey = null;
      logError(`Chunked upload error: ${e.message}`);
      push({ id, type: 'transcribe_chunk_ack', error: e.message });
    }

    done();
  })();
}

function handleTranscribeComplete(msg, push, done) {
  const { id } = msg;
  const session = chunkSessions.get(id);
  if (!session) {
    push({ id, type: 'transcription_error', error: 'Session not found' });
    done();
    return;
  }

  const durationMs = Date.now() - session.startedAt;
  log(`Chunked complete: id=${id} received=${session.receivedBytes}/${session.totalBytes} in ${durationMs}ms`);

  if (session.cancelRequested) {
    if (session.tempFile && fs.existsSync(session.tempFile)) {
      try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
    }
    chunkSessions.delete(id);
    push({ id, type: 'transcription_error', error: 'Session cancelled' });
    done();
    return;
  }

  if (session.pauseRequested) {
    push({ id, type: 'transcription_error', error: 'Session paused' });
    done();
    return;
  }

  if (!session.headerParsed) {
    if (session.tempFile && fs.existsSync(session.tempFile)) {
      try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
    }
    chunkSessions.delete(id);
    push({ id, type: 'transcription_error', error: 'No uploaded WAV data available' });
    done();
    return;
  }

  const expectedTotalBytes = Number(session.totalBytes);
  if (Number.isFinite(expectedTotalBytes) && expectedTotalBytes > 0 && session.receivedBytes !== expectedTotalBytes) {
    if (session.tempFile && fs.existsSync(session.tempFile)) {
      try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
    }
    chunkSessions.delete(id);
    push({
      id,
      type: 'transcription_error',
      error: `Chunked upload incomplete: received ${session.receivedBytes} of ${expectedTotalBytes} bytes`
    });
    done();
    return;
  }

  const operationKey = `chunk:${id}:complete`;
  session.status = 'transcribing';
  session.updatedAt = Date.now();
  session.activeOperationKey = operationKey;

  (async () => {
    try {
      const result = await transcribeFileWithModel({
        audioFilePath: session.tempFile,
        language: session.language,
        modelId: session.modelId,
        mode: session.mode,
        performanceProfile: session.performanceProfile,
        cleanupPaths: [session.tempFile],
        operationKey,
        isCancelled: () => !!chunkSessions.get(id)?.cancelRequested
      });

      const currentSession = chunkSessions.get(id);
      if (currentSession?.cancelRequested) {
        throw new Error('Transcription cancelled');
      }

      const segments = Array.isArray(result.segments)
        ? result.segments.sort((a, b) => (a.start || 0) - (b.start || 0))
        : [];
      const text = result.text || '';
      const duration = Number.isFinite(Number(result.duration)) && Number(result.duration) > 0
        ? result.duration
        : getUploadedAudioDurationMs(session, durationMs);

      push({
        id,
        type: 'transcription',
        duration,
        segments,
        text
      });
    } catch (e) {
      logError(`Chunked transcription error: ${e.message}`);
      push({
        id,
        type: 'transcription_error',
        error: e.message
      });
    } finally {
      const currentSession = chunkSessions.get(id);
      if (currentSession) {
        currentSession.activeOperationKey = null;
        if (currentSession.tempFile && fs.existsSync(currentSession.tempFile)) {
          try { fs.unlinkSync(currentSession.tempFile); } catch (e) { /* ignore */ }
        }
        chunkSessions.delete(id);
      }
      clearAsrProcess(operationKey);
      done();
    }
  })();
}

function handleTranscribeCancel(msg, push, done) {
  const { id } = msg;
  const cancelled = [];

  const cancelChunkSession = (sessionId) => {
    const session = chunkSessions.get(sessionId);
    if (!session) return false;
    session.cancelRequested = true;
    session.status = 'cancelled';
    session.updatedAt = Date.now();
    if (session.activeOperationKey) {
      cancelAsrOperation(session.activeOperationKey);
    }
    cancelled.push(sessionId);
    return true;
  };

  const cancelDirectSession = (sessionId) => {
    const session = directSessions.get(sessionId);
    if (!session) return false;
    session.cancelRequested = true;
    session.status = 'cancelled';
    session.updatedAt = Date.now();
    cancelAsrOperation(session.operationKey);
    cancelled.push(sessionId);
    return true;
  };

  if (id) {
    cancelChunkSession(id);
    cancelDirectSession(id);
    const external = terminateSessionProcesses(id);
    if (external.terminated.length > 0 || external.cleanedFiles.length > 0) {
      cancelled.push(id);
    }
  } else {
    for (const sessionId of chunkSessions.keys()) {
      cancelChunkSession(sessionId);
    }
    for (const sessionId of directSessions.keys()) {
      cancelDirectSession(sessionId);
    }
    const external = terminateAllRegisteredProcesses();
    if (external.terminated.length > 0) {
      cancelled.push(`external:${external.terminated.length}`);
    }
  }

  push({
    id: id || null,
    type: 'transcribe_cancel_ack',
    success: true,
    cancelled
  });
  done();
}

function handleTranscribePause(msg, push, done) {
  const { id } = msg;
  const paused = [];

  const pauseChunkSession = (sessionId) => {
    const session = chunkSessions.get(sessionId);
    if (!session) return false;
    session.pauseRequested = true;
    session.status = 'paused';
    session.updatedAt = Date.now();
    if (session.activeOperationKey) {
      pauseAsrOperation(session.activeOperationKey);
    }
    paused.push(sessionId);
    return true;
  };

  const pauseDirectSession = (sessionId) => {
    const session = directSessions.get(sessionId);
    if (!session) return false;
    session.pauseRequested = true;
    session.status = 'paused';
    session.updatedAt = Date.now();
    pauseAsrOperation(session.operationKey);
    paused.push(sessionId);
    return true;
  };

  if (id) {
    pauseChunkSession(id);
    pauseDirectSession(id);
  } else {
    for (const sessionId of chunkSessions.keys()) {
      pauseChunkSession(sessionId);
    }
    for (const sessionId of directSessions.keys()) {
      pauseDirectSession(sessionId);
    }
  }

  push({
    id: id || null,
    type: 'transcribe_pause_ack',
    success: true,
    paused
  });
  done();
}

function handleTranscribeResume(msg, push, done) {
  const { id } = msg;
  const resumed = [];

  const resumeChunkSession = (sessionId) => {
    const session = chunkSessions.get(sessionId);
    if (!session) return false;
    session.pauseRequested = false;
    session.status = 'running';
    session.updatedAt = Date.now();
    if (session.activeOperationKey) {
      resumeAsrOperation(session.activeOperationKey);
    }
    resumed.push(sessionId);
    return true;
  };

  const resumeDirectSession = (sessionId) => {
    const session = directSessions.get(sessionId);
    if (!session) return false;
    session.pauseRequested = false;
    session.status = 'running';
    session.updatedAt = Date.now();
    resumeAsrOperation(session.operationKey);
    resumed.push(sessionId);
    return true;
  };

  if (id) {
    resumeChunkSession(id);
    resumeDirectSession(id);
  } else {
    for (const sessionId of chunkSessions.keys()) {
      resumeChunkSession(sessionId);
    }
    for (const sessionId of directSessions.keys()) {
      resumeDirectSession(sessionId);
    }
  }

  push({
    id: id || null,
    type: 'transcribe_resume_ack',
    success: true,
    resumed
  });
  done();
}

function handleTranscribeStatus(msg, push, done) {
  const { id } = msg;
  if (id) {
    const chunk = chunkSessions.get(id);
    if (chunk) {
      push({
        id,
        type: 'transcribe_status_ack',
        success: true,
        status: chunk.status,
        mode: 'chunk',
        startedAt: chunk.startedAt,
        updatedAt: chunk.updatedAt
      });
      done();
      return;
    }

    const direct = directSessions.get(id);
    if (direct) {
      push({
        id,
        type: 'transcribe_status_ack',
        success: true,
        status: direct.status,
        mode: 'direct',
        startedAt: direct.startedAt,
        updatedAt: direct.updatedAt
      });
      done();
      return;
    }

    push({
      id,
      type: 'transcribe_status_ack',
      success: true,
      status: 'not-found'
    });
    done();
    return;
  }

  push({
    id: null,
    type: 'transcribe_status_ack',
    success: true,
    direct: Array.from(directSessions.values()).map((session) => ({
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt
    })),
    chunk: Array.from(chunkSessions.values()).map((session) => ({
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt
    })),
    activeProcesses: activeAsrProcesses.size
  });
  done();
}

function handleTranscribeCleanup(msg, push, done) {
  const { id } = msg;
  const cleaned = [];

  const cleanupChunkSession = (sessionId) => {
    const session = chunkSessions.get(sessionId);
    if (!session) return false;
    session.cancelRequested = true;
    if (session.activeOperationKey) {
      cancelAsrOperation(session.activeOperationKey);
    }
    if (session.tempFile && fs.existsSync(session.tempFile)) {
      try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
    }
    chunkSessions.delete(sessionId);
    cleaned.push(sessionId);
    return true;
  };

  const cleanupDirectSession = (sessionId) => {
    const session = directSessions.get(sessionId);
    if (!session) return false;
    session.cancelRequested = true;
    cancelAsrOperation(session.operationKey);
    directSessions.delete(sessionId);
    cleaned.push(sessionId);
    return true;
  };

  if (id) {
    cleanupChunkSession(id);
    cleanupDirectSession(id);
    const external = terminateSessionProcesses(id);
    cleanupTempFilesForSession(id);
    if (external.terminated.length > 0 || external.cleanedFiles.length > 0) {
      cleaned.push(id);
    }
  } else {
    for (const sessionId of Array.from(chunkSessions.keys())) {
      cleanupChunkSession(sessionId);
    }
    for (const sessionId of Array.from(directSessions.keys())) {
      cleanupDirectSession(sessionId);
    }
    const external = terminateAllRegisteredProcesses();
    if (external.terminated.length > 0) {
      cleaned.push(`external:${external.terminated.length}`);
    }
  }

  push({
    id: id || null,
    type: 'transcribe_cleanup_ack',
    success: true,
    cleaned
  });
  done();
}
