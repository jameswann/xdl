// @flow

import fsp from 'mz/fs';
import mkdirp from 'mkdirp-promise';
import os from 'os';
import path from 'path';

import Config from '../Config';

/*
A Cacher is used to wrap a fallible or expensive function and to memoize its results on disk
in case it either fails or we don't need fresh results very often. It stores objects in JSON, and
parses JSON from disk when returning an object.

It's constructed with a "refresher" callback which will be called for the results, a filename to use
for the cache, and an optional TTL and boostrap file. The TTL (in milliseconds) can be used to speed
up slow calls from the cache (for example checking npm published versions can be very slow). The
bootstrap file can be used to "seed" the cache with a particular value stored in a file.

If there is a problem calling the refresher function or in performing the cache's disk I/O, errors
will be stored in variables on the class. The only times Cacher will throw an exception are if it's
not possible to create the cache directory (usually weird home directory permissions), or if getAsync()
is called but no value can be provided. The latter will only occur if the refresher fails, no cache
is available on disk (i.e. this is the first call or it has been recently cleared), and bootstrapping
was not available (either a bootstrap file wasn't provided or reading/writing failed).

See src/__tests__/tools/FsCache-test.js for usage examples.
*/
class Cacher<T> {
  refresher: () => Promise<T>;
  filename: string;
  bootstrapFile: ?string;
  ttlMilliseconds: number;

  readError: ?any;
  writeError: ?any;

  constructor(
    refresher: () => Promise<T>,
    filename: string,
    ttlMilliseconds: ?number,
    bootstrapFile: ?string,
  ) {
    this.refresher = refresher;
    this.filename = path.join(getCacheDir(), filename);
    this.ttlMilliseconds = ttlMilliseconds || 0;
    this.bootstrapFile = bootstrapFile;
  }

  async getAsync(): Promise<T> {
    await mkdirp(getCacheDir());

    let mtime: Date;
    try {
      const stats = await fsp.stat(this.filename);
      mtime = stats.mtime;
    } catch (e) {

      if (this.bootstrapFile) {
        try {
          const bootstrapContents = (await fsp.readFile(this.bootstrapFile)).toString();
          await fsp.writeFile(this.filename, bootstrapContents, 'utf8');
        } catch (e) {
          // intentional no-op
        }
      }
      mtime = new Date(1989, 10, 19);
    }

    let fromCache: ?T;
    let failedRefresh = null;

    // if mtime + ttl >= now, attempt to fetch the value, otherwise read from disk
    if (new Date() - mtime > this.ttlMilliseconds) {
      try {
        fromCache = await this.refresher();
        try {
          await fsp.writeFile(this.filename, JSON.stringify(fromCache), 'utf8');
        } catch (e) {
          this.writeError = e;
          // do nothing, if the refresh succeeded it'll be returned, if the persist failed we don't care
        }
      } catch (e) {
        failedRefresh = e;
      }
    }

    if (!fromCache) {
      try {
        fromCache = JSON.parse(await fsp.readFile(this.filename));
      } catch (e) {
        this.readError = e;
        // if this fails then we've exhausted our options and it should remain null
      }
    }

    if (fromCache) {
      return fromCache;
    } else {
      if (failedRefresh) {
        throw new Error(`Unable to perform cache refresh for ${this.filename}: ${failedRefresh}`);
      } else {
        throw new Error(`Unable to read ${this.filename}. ${this.readError || ''}`);
      }
    }
  }

  async clearAsync(): Promise<void> {
    try {
      await fsp.unlink(this.filename);
    } catch (e) {
      this.writeError = e;
    }
  }
}

function getCacheDir(): string {
  const homeDir = os.homedir();
  if (process.env.XDG_CACHE_HOME) {
    return process.env.XDG_CACHE_HOME;
  } else if (process.platform === 'win32') {
    return path.join(homeDir, 'AppData', 'Local', 'Exponent');
  } else {
    return path.join(homeDir, '.cache', 'exponent');
  }
}

export { Cacher, getCacheDir };
