#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

function parseArgs(argv) {
  const args = {
    binary: null,
    expectPlatform: null,
    timeoutMs: 10000
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--expect-platform') {
      args.expectPlatform = argv[++i] || null;
    } else if (value === '--timeout-ms') {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.timeoutMs = parsed;
      }
    } else if (!args.binary) {
      args.binary = value;
    }
  }

  return args;
}

function fail(message, detail = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...detail }, null, 2));
  process.exit(1);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.binary) {
    fail('Usage: node scripts/smoke-native-host.js <binary> [--expect-platform <id>] [--timeout-ms <ms>]');
  }

  const binary = path.resolve(args.binary);
  const child = spawn(binary, [], {
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

  const closePromise = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });

  child.on('error', (error) => {
    fail('Failed to start native host', { binary, detail: error.message });
  });

  const request = Buffer.from(JSON.stringify({ type: 'status' }), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(request.length, 0);
  child.stdin.write(length);
  child.stdin.write(request);
  child.stdin.end();

  const timeout = setTimeout(() => {
    if (!closed) {
      child.kill('SIGKILL');
    }
  }, args.timeoutMs);

  const closeResult = await closePromise;
  clearTimeout(timeout);

  let messages = [];
  try {
    messages = parseNativeMessages(stdout);
  } catch (error) {
    fail('Native host produced invalid native-message output', {
      binary,
      exit: closeResult,
      stderr: stderr.trim(),
      detail: error.message
    });
  }

  const status = messages.find((message) => message && message.type === 'status');
  if (!status) {
    fail('Native host did not return a status message', {
      binary,
      exit: closeResult,
      stderr: stderr.trim(),
      stdoutBytes: stdout.length,
      messageCount: messages.length
    });
  }

  if (args.expectPlatform && status.platform !== args.expectPlatform) {
    fail('Native host returned an unexpected platform', {
      binary,
      expected: args.expectPlatform,
      actual: status.platform,
      status
    });
  }

  if (status.installed !== true || status.reachable !== true) {
    fail('Native host status is not reachable', {
      binary,
      status
    });
  }

  console.log(JSON.stringify({
    ok: true,
    binary,
    version: status.version || status.hostVersion || null,
    platform: status.platform || null,
    health: status.health || null,
    modelCount: Array.isArray(status.models) ? status.models.length : null,
    packageRuntimeSupported: status.packageRuntimeSupported === true,
    runtimeBackend: status.runtimeBackend || null,
    selectedBackend: status.selectedBackend || null
  }, null, 2));
}

main().catch((error) => {
  fail('Native host smoke test failed', { detail: error.message });
});
