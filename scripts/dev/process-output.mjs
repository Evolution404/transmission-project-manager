export function createOutputCapture() {
  let stdout = '';
  let stderr = '';
  return {
    appendStdout(chunk) { stdout += String(chunk); },
    appendStderr(chunk) { stderr += String(chunk); },
    stdout() { return stdout; },
    diagnostic() { return [stdout, stderr].filter(Boolean).join('\n'); },
  };
}
