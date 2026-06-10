const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REGISTRY_DIR = process.env.WHOOPTIDO_ASR_PROCESS_REGISTRY_DIR
  || path.join(os.tmpdir(), 'whooptido-asr-processes');

function ensureRegistryDir() {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
}

function sanitizeFilePart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 180) || 'operation';
}

function recordPathForOperation(operationKey) {
  return path.join(REGISTRY_DIR, `${sanitizeFilePart(operationKey)}.json`);
}

function sessionIdFromOperationKey(operationKey) {
  const parts = String(operationKey || '').split(':');
  if (parts[0] === 'chunk' && parts[1]) return parts[1];
  if (parts[0] === 'direct' && parts[1]) return parts[1];
  return null;
}

function normalizeStringArray(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function registerProcessRecord(operationKey, proc, metadata = {}) {
  if (!operationKey || !proc?.pid) return null;
  ensureRegistryDir();

  const record = {
    operationKey,
    sessionId: metadata.sessionId || sessionIdFromOperationKey(operationKey),
    pid: proc.pid,
    parentPid: process.pid,
    startedAt: Date.now(),
    command: metadata.command || proc.spawnfile || null,
    args: Array.isArray(metadata.args) ? metadata.args : (Array.isArray(proc.spawnargs) ? proc.spawnargs : []),
    audioFilePath: metadata.audioFilePath || null,
    outputPath: metadata.outputPath || null,
    cleanupPaths: normalizeStringArray(metadata.cleanupPaths)
  };

  fs.writeFileSync(recordPathForOperation(operationKey), JSON.stringify(record, null, 2));
  return record;
}

function unregisterProcessRecord(operationKey) {
  if (!operationKey) return false;
  const filePath = recordPathForOperation(operationKey);
  if (!fs.existsSync(filePath)) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function readProcessRecord(filePath) {
  try {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!record || !record.operationKey || !Number.isInteger(record.pid)) return null;
    return record;
  } catch (_error) {
    return null;
  }
}

function listProcessRecords(filter = {}) {
  if (!fs.existsSync(REGISTRY_DIR)) return [];
  const records = [];
  for (const fileName of fs.readdirSync(REGISTRY_DIR)) {
    if (!fileName.endsWith('.json')) continue;
    const record = readProcessRecord(path.join(REGISTRY_DIR, fileName));
    if (!record) continue;
    if (filter.sessionId && record.sessionId !== filter.sessionId) continue;
    if (filter.operationKey && record.operationKey !== filter.operationKey) continue;
    records.push(record);
  }
  return records;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function parsePidLines(output) {
  return String(output || '')
    .split(/\r?\n/g)
    .map(line => Number(line.trim()))
    .filter(pid => Number.isInteger(pid) && pid > 0);
}

function getDirectChildPids(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return [];

  try {
    if (process.platform === 'win32') {
      const output = execFileSync('wmic.exe', [
        'process',
        'where',
        `(ParentProcessId=${pid})`,
        'get',
        'ProcessId',
        '/value'
      ], { encoding: 'utf8', stdio: 'pipe', timeout: 3000 });
      return String(output || '')
        .split(/\r?\n/g)
        .map(line => line.match(/ProcessId=(\d+)/)?.[1])
        .map(value => Number(value))
        .filter(childPid => Number.isInteger(childPid) && childPid > 0);
    }

    return parsePidLines(execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 3000
    }));
  } catch (_error) {
    return [];
  }
}

function collectProcessTreePids(rootPid, seen = new Set()) {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || seen.has(rootPid)) return [];
  seen.add(rootPid);
  const children = [];
  for (const childPid of getDirectChildPids(rootPid)) {
    children.push(...collectProcessTreePids(childPid, seen));
  }
  children.push(rootPid);
  return children;
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (_error) {
    return false;
  }
}

function signalUnixProcessGroup(pid, signal) {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (_error) {
    return false;
  }
}

function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;

  const forceAfterMs = Number.isFinite(Number(options.forceAfterMs))
    ? Number(options.forceAfterMs)
    : 3000;

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000
      });
      return true;
    } catch (_error) {
      return false;
    }
  }

  const pids = collectProcessTreePids(pid);
  let signalled = signalUnixProcessGroup(pid, 'SIGTERM');
  for (const targetPid of pids) {
    signalled = signalPid(targetPid, 'SIGTERM') || signalled;
  }

  if (forceAfterMs >= 0) {
    const timer = setTimeout(() => {
      signalUnixProcessGroup(pid, 'SIGKILL');
      for (const targetPid of pids) {
        if (isProcessAlive(targetPid)) {
          signalPid(targetPid, 'SIGKILL');
        }
      }
    }, forceAfterMs);
    if (typeof timer.unref === 'function' && options.unrefForceTimer === true) {
      timer.unref();
    }
  }

  return signalled;
}

function cleanupRecordFiles(record) {
  const paths = normalizeStringArray([
    record?.audioFilePath,
    record?.outputPath,
    ...(record?.cleanupPaths || [])
  ]);
  const removed = [];
  for (const filePath of paths) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removed.push(filePath);
      }
    } catch (_error) {
      // Best-effort cleanup only.
    }
  }
  return removed;
}

function findProcessIdsByNeedles(needles) {
  const wanted = normalizeStringArray(needles);
  if (wanted.length === 0) return [];

  try {
    if (process.platform === 'win32') {
      const output = execFileSync('wmic.exe', ['process', 'get', 'ProcessId,CommandLine', '/format:csv'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000
      });
      return String(output || '')
        .split(/\r?\n/g)
        .map(line => {
          const match = line.match(/,(\d+)$/);
          if (!match) return null;
          return { command: line, pid: Number(match[1]) };
        })
        .filter(entry => entry && entry.pid !== process.pid && wanted.some(needle => entry.command.includes(needle)))
        .map(entry => entry.pid);
    }

    const output = execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
    return String(output || '')
      .split(/\r?\n/g)
      .map(line => {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: match[2] || '' };
      })
      .filter(entry => entry && entry.pid !== process.pid && wanted.some(needle => entry.command.includes(needle)))
      .map(entry => entry.pid);
  } catch (_error) {
    return [];
  }
}

function processNeedlesForSession(sessionId) {
  if (!sessionId) return [];
  return [
    `whooptido-audio-chunk-${sessionId}`,
    `whooptido-audio-chunked-${sessionId}`,
    `whooptido-audio-chunk-${sessionId}-`,
    sessionId
  ];
}

function cleanupTempFilesForSession(sessionId) {
  if (!sessionId) return [];
  const removed = [];
  const tmpDir = os.tmpdir();
  const prefixes = [
    `whooptido-audio-chunk-${sessionId}`,
    `whooptido-audio-chunked-${sessionId}`
  ];

  try {
    for (const fileName of fs.readdirSync(tmpDir)) {
      if (!prefixes.some(prefix => fileName.startsWith(prefix))) continue;
      const filePath = path.join(tmpDir, fileName);
      try {
        fs.unlinkSync(filePath);
        removed.push(filePath);
      } catch (_error) {
        // Best-effort cleanup only.
      }
    }
  } catch (_error) {
    // Best-effort cleanup only.
  }

  return removed;
}

function terminateRecords(records, options = {}) {
  const kill = options.killProcessTree || terminateProcessTree;
  const terminated = [];
  const cleanedFiles = [];

  for (const record of records) {
    if (record.pid && kill(record.pid, options)) {
      terminated.push(record.pid);
    }
    cleanedFiles.push(...cleanupRecordFiles(record));
    unregisterProcessRecord(record.operationKey);
  }

  return { terminated, cleanedFiles };
}

function terminateOperationProcesses(operationKey, options = {}) {
  const records = listProcessRecords({ operationKey });
  return terminateRecords(records, options);
}

function terminateSessionProcesses(sessionId, options = {}) {
  const records = listProcessRecords({ sessionId });
  const result = terminateRecords(records, options);
  const findPids = options.findProcessIdsByNeedles || findProcessIdsByNeedles;
  const kill = options.killProcessTree || terminateProcessTree;
  const processPids = findPids(processNeedlesForSession(sessionId));

  for (const pid of processPids) {
    if (kill(pid, options)) {
      result.terminated.push(pid);
    }
  }

  result.cleanedFiles.push(...cleanupTempFilesForSession(sessionId));
  return result;
}

function terminateAllRegisteredProcesses(options = {}) {
  const exceptSessionId = options.exceptSessionId || null;
  const records = listProcessRecords().filter(record => record.sessionId !== exceptSessionId);
  const result = terminateRecords(records, options);

  if ((!exceptSessionId || options.scanDespiteExceptSession === true) && options.includeProcessScan !== false) {
    const findPids = options.findProcessIdsByNeedles || findProcessIdsByNeedles;
    const kill = options.killProcessTree || terminateProcessTree;
    const processPids = findPids(['whooptido-audio-chunk-', 'whooptido-audio-chunked-']);
    for (const pid of processPids) {
      if (kill(pid, options)) {
        result.terminated.push(pid);
      }
    }
  }

  return result;
}

function cleanupDeadProcessRecords() {
  let removed = 0;
  for (const record of listProcessRecords()) {
    if (!isProcessAlive(record.pid)) {
      cleanupRecordFiles(record);
      unregisterProcessRecord(record.operationKey);
      removed++;
    }
  }
  return removed;
}

module.exports = {
  REGISTRY_DIR,
  cleanupDeadProcessRecords,
  cleanupTempFilesForSession,
  collectProcessTreePids,
  findProcessIdsByNeedles,
  isProcessAlive,
  listProcessRecords,
  processNeedlesForSession,
  registerProcessRecord,
  sessionIdFromOperationKey,
  terminateAllRegisteredProcesses,
  terminateOperationProcesses,
  terminateProcessTree,
  terminateSessionProcesses,
  unregisterProcessRecord
};
