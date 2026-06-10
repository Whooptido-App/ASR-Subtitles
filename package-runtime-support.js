const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MLX_AUDIO_MODULE = 'mlx_audio.stt.generate';
const MLX_AUDIO_PIP_PACKAGE = 'mlx-audio';
const MLX_MINIMUM_PYTHON_VERSION = Object.freeze({ major: 3, minor: 10 });
const MLX_AUDIO_REQUIRED_MODULES = [MLX_AUDIO_MODULE, 'torch', 'dacite', 'mlx_audio.stt.models.parakeet'];
const MLX_AUDIO_PIP_PACKAGES = [MLX_AUDIO_PIP_PACKAGE, 'torch', 'dacite'];
const MLX_AUDIO_PIP_PACKAGE_LIST = MLX_AUDIO_PIP_PACKAGES.join(', ');
const DEFAULT_RUNTIME_PROBE_TIMEOUT_MS = 15000;
const MLX_PYTHON_PROBE = [
  'import importlib, sys',
  `minimum = (${MLX_MINIMUM_PYTHON_VERSION.major}, ${MLX_MINIMUM_PYTHON_VERSION.minor})`,
  'if sys.version_info[:2] < minimum:',
  '    sys.stderr.write("Python >= %d.%d is required for Parakeet MLX. Current: %s" % (minimum[0], minimum[1], sys.version.split()[0]))',
  '    sys.exit(1)',
  `required = ${JSON.stringify(MLX_AUDIO_REQUIRED_MODULES)}`,
  'missing = []',
  'for name in required:',
  '    try:',
  '        importlib.import_module(name)',
  '    except Exception as exc:',
  '        missing.append(name + " (" + exc.__class__.__name__ + ": " + str(exc) + ")")',
  'if missing:',
  '    sys.stderr.write("Missing or incompatible Python module(s): " + "; ".join(missing))',
  '    sys.exit(1)'
].join('\n');
const MLX_BASE_PYTHON_PROBE = [
  'import sys, venv',
  `minimum = (${MLX_MINIMUM_PYTHON_VERSION.major}, ${MLX_MINIMUM_PYTHON_VERSION.minor})`,
  'if sys.version_info[:2] < minimum:',
  '    sys.stderr.write("Python >= %d.%d is required for Parakeet MLX. Current: %s" % (minimum[0], minimum[1], sys.version.split()[0]))',
  '    sys.exit(1)'
].join('\n');
const DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

function isPathLike(candidate) {
  return Boolean(candidate && (candidate.includes(path.sep) || candidate.includes('/') || candidate.includes('\\')));
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function clampText(value, maxLength = 1000) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function getMlxPythonCandidates(options = {}) {
  const env = options.env || process.env;
  const homeDir = typeof options.homedir === 'function' ? options.homedir() : (options.homeDir || os.homedir());
  return uniqueStrings([
    env.WHOOPTIDO_MLX_PYTHON,
    homeDir ? path.join(homeDir, '.whooptido', 'runtimes', 'mlx', 'bin', 'python3') : null,
    homeDir ? path.join(homeDir, '.whooptido', 'runtimes', 'mlx', 'bin', 'python') : null,
    '/opt/homebrew/bin/python3.13',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.10',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3.13',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.11',
    '/usr/local/bin/python3.10',
    '/usr/local/bin/python3',
    'python3',
    'python'
  ]);
}

function getMlxRuntimeDir(options = {}) {
  const homeDir = typeof options.homedir === 'function' ? options.homedir() : (options.homeDir || os.homedir());
  return options.runtimeDir || (homeDir ? path.join(homeDir, '.whooptido', 'runtimes', 'mlx') : null);
}

function getMlxRuntimePythonPath(options = {}) {
  const runtimeDir = getMlxRuntimeDir(options);
  if (!runtimeDir) return null;
  if (os.platform() === 'win32') return path.join(runtimeDir, 'Scripts', 'python.exe');
  return path.join(runtimeDir, 'bin', 'python3');
}

function runCommand(command, args, options = {}) {
  const exec = options.execFileSync || execFileSync;
  const timeout = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS;
  return exec(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout,
    windowsHide: true,
    env: options.env || process.env
  });
}

function checkPythonSupportsMlxRuntime(candidate, options = {}) {
  try {
    runCommand(candidate, ['-c', MLX_BASE_PYTHON_PROBE], {
      ...options,
      timeoutMs: Number.isFinite(Number(options.probeTimeoutMs))
        ? Number(options.probeTimeoutMs)
        : DEFAULT_RUNTIME_PROBE_TIMEOUT_MS
    });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: clampText(error.stderr || error.stdout || error.message) };
  }
}

function findBasePythonForMlxRuntime(options = {}) {
  const fsModule = options.fs || fs;
  const candidates = getMlxPythonCandidates(options);
  const runtimeDir = getMlxRuntimeDir(options);
  const attempts = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (runtimeDir && path.resolve(candidate).startsWith(path.resolve(runtimeDir))) {
      continue;
    }
    if (isPathLike(candidate) && !fsModule.existsSync(candidate)) {
      attempts.push({ candidate, ok: false, skipped: true, error: 'missing executable' });
      continue;
    }

    try {
      const support = checkPythonSupportsMlxRuntime(candidate, options);
      if (!support.ok) {
        throw new Error(support.error);
      }
      attempts.push({ candidate, ok: true });
      return { ok: true, pythonPath: candidate, attempts };
    } catch (error) {
      attempts.push({
        candidate,
        ok: false,
        skipped: false,
        error: clampText(error.stderr || error.stdout || error.message)
      });
    }
  }

  return {
    ok: false,
    pythonPath: null,
    attempts,
    error: `No Python runtime >= ${MLX_MINIMUM_PYTHON_VERSION.major}.${MLX_MINIMUM_PYTHON_VERSION.minor} with venv support was found for installing ${MLX_AUDIO_PIP_PACKAGE_LIST}. Checked: ${candidates.join(', ')}`
  };
}

function shouldProbeMlxAudio(modelPackage, runnerPath) {
  const descriptor = [
    modelPackage?.runtimeKind,
    modelPackage?.id,
    modelPackage?.packageVariant,
    modelPackage?.runner,
    runnerPath
  ].filter(Boolean).join(' ').toLowerCase();
  return descriptor.includes('parakeet-mlx-runner');
}

function getPackageRuntimeDescriptor(modelPackage, runnerPath) {
  return [
    modelPackage?.runtimeKind,
    modelPackage?.id,
    modelPackage?.packageVariant,
    modelPackage?.runner,
    runnerPath
  ].filter(Boolean).join(' ').toLowerCase();
}

function shouldProbeSherpaOnnx(modelPackage, runnerPath) {
  const descriptor = getPackageRuntimeDescriptor(modelPackage, runnerPath);
  return descriptor.includes('sherpa') || descriptor.includes('onnx');
}

function inferPackageRuntimeBackend(modelPackage, runnerPath) {
  const descriptor = getPackageRuntimeDescriptor(modelPackage, runnerPath);
  if (descriptor.includes('cuda') || descriptor.includes('nvidia')) return 'cuda';
  if (descriptor.includes('vulkan') || descriptor.includes('rocm') || descriptor.includes('amd')) return 'vulkan';
  if (descriptor.includes('metal') || descriptor.includes('mlx')) return 'metal';
  if (descriptor.includes('cpu')) return 'cpu';
  return 'package-runner';
}

function getPackageModelDir(modelPackage, runnerPath, options = {}) {
  return options.modelDir || modelPackage?.path || (runnerPath ? path.dirname(runnerPath) : null);
}

function ensurePackageExecutable(filePath, options = {}) {
  const platform = options.platform || os.platform();
  if (platform === 'win32' || !filePath) return;
  try {
    const fsModule = options.fs || fs;
    fsModule.chmodSync(filePath, 0o755);
  } catch (_error) {
    // The probe below will return the actionable execution failure.
  }
}

function probeSherpaOnnxRunner(modelPackage, runnerPath, options = {}) {
  const modelDir = getPackageModelDir(modelPackage, runnerPath, options);
  if (!modelDir) {
    return {
      ok: false,
      modelDir: null,
      args: null,
      stdout: '',
      error: 'Cannot probe sherpa-onnx package runner without a model directory.'
    };
  }

  const args = ['--whooptido-probe', '--model-dir', modelDir];
  try {
    ensurePackageExecutable(runnerPath, options);
    const stdout = runCommand(runnerPath, args, {
      ...options,
      timeoutMs: Number.isFinite(Number(options.probeTimeoutMs))
        ? Number(options.probeTimeoutMs)
        : DEFAULT_RUNTIME_PROBE_TIMEOUT_MS
    });
    return {
      ok: true,
      modelDir,
      args,
      stdout: clampText(stdout),
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      modelDir,
      args,
      stdout: clampText(error.stdout),
      error: `Parakeet sherpa-onnx runner probe failed: ${clampText(error.stderr || error.stdout || error.message)}`
    };
  }
}

function resolveMlxAudioRuntime(options = {}) {
  const fsModule = options.fs || fs;
  const exec = options.execFileSync || execFileSync;
  const timeout = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_RUNTIME_PROBE_TIMEOUT_MS;
  const candidates = getMlxPythonCandidates(options);
  const attempts = [];

  for (const candidate of candidates) {
    if (isPathLike(candidate) && !fsModule.existsSync(candidate)) {
      attempts.push({ candidate, ok: false, skipped: true, error: 'missing executable' });
      continue;
    }

    try {
      exec(candidate, ['-c', MLX_PYTHON_PROBE], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout,
        windowsHide: true,
        env: options.env || process.env
      });
      attempts.push({ candidate, ok: true });
      return { ok: true, pythonPath: candidate, candidates, attempts };
    } catch (error) {
      attempts.push({
        candidate,
        ok: false,
        skipped: false,
        error: clampText(error.stderr || error.stdout || error.message)
      });
    }
  }

  return {
    ok: false,
    pythonPath: null,
    candidates,
    attempts,
    error: `Parakeet MLX runtime is missing Python >= ${MLX_MINIMUM_PYTHON_VERSION.major}.${MLX_MINIMUM_PYTHON_VERSION.minor} or package(s) ${MLX_AUDIO_PIP_PACKAGE_LIST} (${MLX_AUDIO_REQUIRED_MODULES.join(', ')}). Checked: ${candidates.join(', ')}`
  };
}

function ensureMlxAudioRuntime(options = {}) {
  const fsModule = options.fs || fs;
  const existing = resolveMlxAudioRuntime(options);
  if (existing.ok) {
    return {
      ok: true,
      installed: false,
      pythonPath: existing.pythonPath,
      attempts: existing.attempts,
      error: null
    };
  }

  const runtimeDir = getMlxRuntimeDir(options);
  const runtimePython = getMlxRuntimePythonPath(options);
  if (!runtimeDir || !runtimePython) {
    return {
      ok: false,
      installed: false,
      pythonPath: null,
      attempts: existing.attempts,
      error: 'Could not resolve the Whooptido MLX runtime directory.'
    };
  }

  try {
    fsModule.mkdirSync(path.dirname(runtimeDir), { recursive: true });

    let createRuntime = !fsModule.existsSync(runtimePython);
    if (!createRuntime) {
      const runtimeSupport = checkPythonSupportsMlxRuntime(runtimePython, options);
      if (!runtimeSupport.ok) {
        try {
          fsModule.rmSync?.(runtimeDir, { recursive: true, force: true });
        } catch (_error) {
          // Recreating below will surface a useful install error if cleanup failed.
        }
        createRuntime = true;
      }
    }

    if (createRuntime) {
      const basePython = findBasePythonForMlxRuntime(options);
      if (!basePython.ok) {
        return {
          ok: false,
          installed: false,
          pythonPath: null,
          attempts: basePython.attempts,
          error: basePython.error
        };
      }
      fsModule.mkdirSync(runtimeDir, { recursive: true });
      runCommand(basePython.pythonPath, ['-m', 'venv', runtimeDir], options);
    }

    runCommand(runtimePython, ['-m', 'pip', 'install', '--upgrade', 'pip'], options);
    runCommand(runtimePython, ['-m', 'pip', 'install', ...MLX_AUDIO_PIP_PACKAGES], options);

    const verified = resolveMlxAudioRuntime({
      ...options,
      env: {
        ...(options.env || process.env),
        WHOOPTIDO_MLX_PYTHON: runtimePython
      }
    });

    if (!verified.ok) {
      return {
        ok: false,
        installed: false,
        pythonPath: runtimePython,
        attempts: verified.attempts,
        error: verified.error
      };
    }

    return {
      ok: true,
      installed: true,
      pythonPath: verified.pythonPath,
      attempts: verified.attempts,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      installed: false,
      pythonPath: runtimePython,
      attempts: existing.attempts,
      error: `Failed to install ${MLX_AUDIO_PIP_PACKAGE_LIST}: ${clampText(error.stderr || error.stdout || error.message)}`
    };
  }
}

function getPackageRuntimeSupport(modelPackage, runnerPath, options = {}) {
  if (!runnerPath) {
    return {
      supported: false,
      runnerPath: null,
      runtimeKind: modelPackage?.runtimeKind || null,
      pythonPath: null,
      error: `Installed hosted ASR model package ${modelPackage?.id || 'unknown'} does not include a runnable ASR adapter.`
    };
  }

  if (shouldProbeSherpaOnnx(modelPackage, runnerPath)) {
    const probe = probeSherpaOnnxRunner(modelPackage, runnerPath, options);
    return {
      supported: probe.ok,
      runnerPath,
      runtimeKind: modelPackage?.runtimeKind || 'parakeet-sherpa-onnx-runner',
      runtimeBackend: inferPackageRuntimeBackend(modelPackage, runnerPath),
      modelDir: probe.modelDir,
      probeArgs: probe.args,
      probeOutput: probe.stdout,
      pythonPath: null,
      error: probe.ok ? null : probe.error
    };
  }

  if (!shouldProbeMlxAudio(modelPackage, runnerPath)) {
    return {
      supported: true,
      runnerPath,
      runtimeKind: modelPackage?.runtimeKind || 'package-runner',
      runtimeBackend: inferPackageRuntimeBackend(modelPackage, runnerPath),
      pythonPath: null,
      error: null
    };
  }

  const runtime = resolveMlxAudioRuntime(options);
  return {
    supported: runtime.ok,
    runnerPath,
    runtimeKind: modelPackage?.runtimeKind || 'parakeet-mlx-runner',
    runtimeBackend: inferPackageRuntimeBackend(modelPackage, runnerPath),
    pythonPath: runtime.pythonPath,
    error: runtime.ok ? null : runtime.error,
    attempts: runtime.attempts,
    candidates: runtime.candidates
  };
}

function ensurePackageRuntimeSupport(modelPackage, runnerPath, options = {}) {
  if (!runnerPath) {
    return {
      supported: false,
      installed: false,
      runnerPath: null,
      runtimeKind: modelPackage?.runtimeKind || null,
      pythonPath: null,
      error: `Installed hosted ASR model package ${modelPackage?.id || 'unknown'} does not include a runnable ASR adapter.`
    };
  }

  if (shouldProbeSherpaOnnx(modelPackage, runnerPath)) {
    const probe = probeSherpaOnnxRunner(modelPackage, runnerPath, options);
    return {
      supported: probe.ok,
      installed: false,
      runnerPath,
      runtimeKind: modelPackage?.runtimeKind || 'parakeet-sherpa-onnx-runner',
      runtimeBackend: inferPackageRuntimeBackend(modelPackage, runnerPath),
      modelDir: probe.modelDir,
      probeArgs: probe.args,
      probeOutput: probe.stdout,
      pythonPath: null,
      error: probe.ok ? null : probe.error
    };
  }

  if (!shouldProbeMlxAudio(modelPackage, runnerPath)) {
    return {
      supported: true,
      installed: false,
      runnerPath,
      runtimeKind: modelPackage?.runtimeKind || 'package-runner',
      runtimeBackend: inferPackageRuntimeBackend(modelPackage, runnerPath),
      pythonPath: null,
      error: null
    };
  }

  const runtime = ensureMlxAudioRuntime(options);
  return {
    supported: runtime.ok,
    installed: runtime.installed === true,
    runnerPath,
    runtimeKind: modelPackage?.runtimeKind || 'parakeet-mlx-runner',
    runtimeBackend: inferPackageRuntimeBackend(modelPackage, runnerPath),
    pythonPath: runtime.pythonPath,
    error: runtime.ok ? null : runtime.error,
    attempts: runtime.attempts
  };
}

module.exports = {
  MLX_AUDIO_MODULE,
  MLX_AUDIO_PIP_PACKAGE,
  MLX_AUDIO_PIP_PACKAGES,
  MLX_AUDIO_REQUIRED_MODULES,
  MLX_MINIMUM_PYTHON_VERSION,
  ensureMlxAudioRuntime,
  ensurePackageRuntimeSupport,
  findBasePythonForMlxRuntime,
  getMlxPythonCandidates,
  getPackageModelDir,
  getMlxRuntimeDir,
  getMlxRuntimePythonPath,
  getPackageRuntimeSupport,
  inferPackageRuntimeBackend,
  probeSherpaOnnxRunner,
  resolveMlxAudioRuntime,
  shouldProbeMlxAudio,
  shouldProbeSherpaOnnx
};
