import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

export const fixWindowsFolderWatches = (platform = process.platform) => {
  if (platform !== 'win32') return;
  const watch = fs.watch;
  fs.watch = function (...args) {
    const watcher = watch.apply(this, args);
    const options = args[1];
    const encoding = options === 'buffer' || Buffer.isEncoding(options) ? options : options?.encoding;
    if (encoding && encoding !== 'utf8') return watcher;
    watcher.on('change', (_event, name) => {
      if (name && path.win32.isAbsolute(String(name))) watcher.close();
    });
    return watcher;
  };
  syncBuiltinESMExports();
};
