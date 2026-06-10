const fs = require('fs');
const os = require('os');
const path = require('path');

const LARGE_FILE_PLACEHOLDER_THRESHOLD_BYTES = 1024 * 1024;
const PACKAGE_SIZE_VALIDATION_THRESHOLD_BYTES = 10 * 1024 * 1024;
const PACKAGE_SIZE_MIN_RATIO = 0.9;

const PARAKEET_MLX_REQUIRED_PACKAGE_FILES = Object.freeze([
  'model.safetensors',
  'config.json',
  'tokenizer.model',
  'tokenizer.vocab',
  'vocab.txt'
]);
const PARAKEET_SHERPA_ONNX_REQUIRED_PACKAGE_FILES = Object.freeze([
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt'
]);
const PARAKEET_SHERPA_ONNX_REQUIRED_PACKAGE_FILE_GROUPS = Object.freeze(
  PARAKEET_SHERPA_ONNX_REQUIRED_PACKAGE_FILES.map(fileName => Object.freeze([
    fileName,
    `model/${fileName}`
  ]))
);

function safePackageRelativePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some(part => part === '..')) {
    throw new Error('Invalid model package file path');
  }
  return normalized;
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function collectManifestFilePaths(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    if (typeof entry === 'string') return entry;
    return entry?.path || entry?.name || null;
  }).filter(Boolean);
}

function getRuntimeDescriptor(manifest) {
  return [
    manifest?.runtimeKind,
    manifest?.id,
    manifest?.packageVariant,
    manifest?.runner
  ].filter(Boolean).join(' ').toLowerCase();
}

function isSherpaOnnxPackage(manifest) {
  const descriptor = getRuntimeDescriptor(manifest);
  return descriptor.includes('sherpa') || descriptor.includes('onnx');
}

function isMlxParakeetPackage(manifest) {
  const descriptor = getRuntimeDescriptor(manifest);
  return descriptor.includes('parakeet')
    && (descriptor.includes('mlx') || descriptor.includes('metal') || descriptor.includes('safetensors'));
}

function collectRunnerCandidates(manifest, platform = os.platform(), arch = os.arch()) {
  const runner = manifest?.runner || null;
  const platformKey = `${platform}-${arch}`;
  const candidates = [];

  if (typeof runner === 'string') {
    candidates.push(runner);
  } else if (runner && typeof runner === 'object') {
    candidates.push(runner[platformKey], runner[platform], runner.default);
  }

  if (isSherpaOnnxPackage(manifest) && platform === 'win32') {
    candidates.push('runner.exe');
    return uniqueStrings(candidates.filter(candidate => String(candidate).toLowerCase().endsWith('.exe')));
  }

  candidates.push('runner.js', platform === 'win32' ? 'runner.exe' : 'runner');
  return uniqueStrings(candidates);
}

function getRuntimeRequiredFiles(manifest, options = {}) {
  if (isSherpaOnnxPackage(manifest)) {
    return options.platform === 'win32' ? ['runner.exe'] : [];
  }

  if (isMlxParakeetPackage(manifest)) {
    return PARAKEET_MLX_REQUIRED_PACKAGE_FILES;
  }

  return [];
}

function getRuntimeRequiredFileGroups(manifest) {
  if (isSherpaOnnxPackage(manifest)) {
    return PARAKEET_SHERPA_ONNX_REQUIRED_PACKAGE_FILE_GROUPS;
  }

  return [];
}

function getExpectedSizeBytes(manifest) {
  const manifestSize = Number(manifest?.diskSizeBytes);
  if (Number.isFinite(manifestSize) && manifestSize > 0) return manifestSize;

  const fileSizes = [
    ...(Array.isArray(manifest?.files) ? manifest.files : []),
    ...(Array.isArray(manifest?.installedFiles) ? manifest.installedFiles : [])
  ].map(file => Number(file?.size)).filter(size => Number.isFinite(size) && size > 0);

  if (fileSizes.length === 0) return null;
  return fileSizes.reduce((total, size) => total + size, 0);
}

function getPackageDirectorySize(packageDir) {
  let total = 0;
  if (!fs.existsSync(packageDir)) return 0;

  for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
    const entryPath = path.join(packageDir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += getPackageDirectorySize(entryPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        total += fs.statSync(entryPath).size;
      }
    } catch (_error) {
      // Broken links are reported by the required-file checks.
    }
  }

  return total;
}

function hasSparsePlaceholderStorage(stats) {
  return stats.size > LARGE_FILE_PLACEHOLDER_THRESHOLD_BYTES
    && Number.isFinite(stats.blocks)
    && stats.blocks === 0;
}

function hasSafetensorsHeader(filePath) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(8);
    const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
    if (bytesRead < header.length) return false;
    return header.some(byte => byte !== 0);
  } finally {
    fs.closeSync(handle);
  }
}

function inspectRequiredFile(packageDir, relativePath) {
  let safeRelativePath;
  try {
    safeRelativePath = safePackageRelativePath(relativePath);
  } catch (error) {
    return { path: String(relativePath || ''), ok: false, reason: error.message };
  }

  const filePath = path.join(packageDir, safeRelativePath);
  if (!fs.existsSync(filePath)) {
    return { path: safeRelativePath, ok: false, reason: 'missing' };
  }

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    return { path: safeRelativePath, ok: false, reason: `stat failed: ${error.message}` };
  }

  if (!stats.isFile()) {
    return { path: safeRelativePath, ok: false, reason: 'not a file' };
  }

  if (stats.size <= 0) {
    return { path: safeRelativePath, ok: false, reason: 'empty file' };
  }

  if (hasSparsePlaceholderStorage(stats)) {
    return { path: safeRelativePath, ok: false, reason: 'sparse placeholder file' };
  }

  if (safeRelativePath.toLowerCase().endsWith('.safetensors') && !hasSafetensorsHeader(filePath)) {
    return { path: safeRelativePath, ok: false, reason: 'invalid safetensors header' };
  }

  return { path: safeRelativePath, ok: true, size: stats.size };
}

function inspectRequiredFileGroup(packageDir, relativePaths) {
  const inspections = relativePaths.map(relativePath => inspectRequiredFile(packageDir, relativePath));
  const passing = inspections.find(result => result.ok);
  if (passing) return { ...passing, alternatives: relativePaths };

  const first = inspections[0] || { path: String(relativePaths?.[0] || ''), reason: 'missing' };
  return {
    path: first.path,
    ok: false,
    reason: inspections.map(result => `${result.path}: ${result.reason}`).join('; ') || first.reason,
    alternatives: relativePaths
  };
}

function validateModelPackage(packageDir, manifest, options = {}) {
  const expectedSizeBytes = getExpectedSizeBytes(manifest);
  const actualSizeBytes = Number.isFinite(Number(options.actualSizeBytes))
    ? Number(options.actualSizeBytes)
    : getPackageDirectorySize(packageDir);
  const runnerCandidates = collectRunnerCandidates(manifest, options.platform, options.arch);
  const existingRunner = runnerCandidates.find((candidate) => {
    try {
      return fs.existsSync(path.join(packageDir, safePackageRelativePath(candidate)));
    } catch (_error) {
      return false;
    }
  });

  const requiredFiles = uniqueStrings([
    ...collectManifestFilePaths(manifest?.files),
    ...collectManifestFilePaths(manifest?.installedFiles),
    ...getRuntimeRequiredFiles(manifest, options)
  ]);
  const requiredFileGroups = getRuntimeRequiredFileGroups(manifest);
  const reportedRequiredFiles = uniqueStrings([
    ...requiredFiles,
    ...requiredFileGroups.flat()
  ]);

  const inspected = [
    ...requiredFiles.map(relativePath => inspectRequiredFile(packageDir, relativePath)),
    ...requiredFileGroups.map(relativePaths => inspectRequiredFileGroup(packageDir, relativePaths))
  ];
  const failedFiles = inspected.filter(file => !file.ok);
  const missingFiles = failedFiles.map(file => file.path);
  const invalidFiles = failedFiles.map(file => ({ path: file.path, reason: file.reason }));
  const sizeTooSmall = requiredFiles.length === 0
    && expectedSizeBytes > PACKAGE_SIZE_VALIDATION_THRESHOLD_BYTES
    && actualSizeBytes < expectedSizeBytes * PACKAGE_SIZE_MIN_RATIO;
  const complete = Boolean(existingRunner) && failedFiles.length === 0 && !sizeTooSmall;

  let error = null;
  if (!existingRunner) {
    error = `Installed ASR model package is incomplete: missing runner (${runnerCandidates.join(', ')}).`;
  } else if (failedFiles.length > 0) {
    error = `Installed ASR model package is incomplete or corrupt: ${invalidFiles.map(file => `${file.path} (${file.reason})`).join(', ')}.`;
  } else if (sizeTooSmall) {
    error = `Installed ASR model package is incomplete: expected about ${expectedSizeBytes} bytes but found ${actualSizeBytes} bytes.`;
  }

  return {
    complete,
    error,
    missingFiles,
    invalidFiles,
    requiredFiles: reportedRequiredFiles,
    runnerCandidates,
    runnerPath: existingRunner || null,
    expectedSizeBytes,
    actualSizeBytes
  };
}

module.exports = {
  PARAKEET_MLX_REQUIRED_PACKAGE_FILES,
  PARAKEET_SHERPA_ONNX_REQUIRED_PACKAGE_FILES,
  PARAKEET_SHERPA_ONNX_REQUIRED_PACKAGE_FILE_GROUPS,
  getPackageDirectorySize,
  getRuntimeRequiredFileGroups,
  getRuntimeRequiredFiles,
  isMlxParakeetPackage,
  isSherpaOnnxPackage,
  validateModelPackage
};
