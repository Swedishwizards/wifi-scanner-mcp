'use strict';
const { execFile } = require('node:child_process');

/**
 * Run a program without a shell and resolve with { code, stdout, stderr, error }.
 * Never rejects, so callers can decide what a failure means.
 */
function run(file, args, { timeoutMs = 20000, env, verbatim = false } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      encoding: 'utf8',
      env: env || process.env,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error || null,
        timedOut: Boolean(error && error.killed),
      });
    });
  });
}

class ScanError extends Error {
  constructor(message, { hint, code } = {}) {
    super(message);
    this.name = 'ScanError';
    this.hint = hint || null;
    this.code = code || 'scan_failed';
  }
}

module.exports = { run, ScanError };
