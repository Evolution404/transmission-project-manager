import { readFile } from 'node:fs/promises';
import { validateConfig, validateAcceptance, inspectInputs, verifyBackup } from './lib.mjs';

const [mode, ...args] = process.argv.slice(2);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
try {
  let result;
  if (mode === 'config' && args.length === 1) {
    result = { kind: 'offline-config-only', errors: validateConfig(await json(args[0])), deployed: false };
    process.exitCode = result.errors.length ? 1 : 0;
  } else if (mode === 'acceptance' && args.length === 1) {
    result = validateAcceptance(await json(args[0]));
    process.exitCode = result.errors.length ? 1 : result.complete ? 0 : 2;
  } else if (mode === 'inputs' && args.length) {
    result = await inspectInputs(args); process.exitCode = result.files.some(f => !f.supported) ? 2 : 0;
  } else if (mode === 'backup' && args.length === 2) {
    result = await verifyBackup(await json(args[0]), args[1]); process.exitCode = result.errors.length ? 1 : 0;
  } else throw new Error('usage');
  console.log(JSON.stringify(result, null, 2));
} catch {
  // Parser errors can contain credential values or business rows: never print raw exceptions.
  console.error('P7 check failed: unreadable/invalid input or arguments. Usage: config <JSON> | acceptance <JSON> | inputs <files...> | backup <manifest.json> <object-root>');
  process.exitCode = 1;
}
