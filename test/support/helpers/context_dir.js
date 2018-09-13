/* @flow */

const autoBind = require('auto-bind')
const Promise = require('bluebird')
const fs = require('fs-extra')
const path = require('path')

const checksumer = require('../../../core/local/checksumer')
const { TMP_DIR_NAME } = require('../../../core/local/constants')
const { getPath } = require('../../../core/utils/path')

Promise.promisifyAll(fs) // FIXME: Isn't fs-extra already promisified?
Promise.promisifyAll(checksumer)

/*:: import type { PathObject } from '../../../core/utils/path' */

function posixifyPath (localPath /*: string */) /*: string */ {
  return localPath.split(path.sep).join(path.posix.sep)
}

// A directory in the context of which we want to perform many FS operations.
class ContextDir {
  /*::
  root: string
  */

  constructor (root /*: string */) {
    this.root = root
    autoBind(this)
  }

  abspath (target /*: string|PathObject */) /*: string */ {
    return path.join(this.root, getPath(target))
  }

  relpath (abspath /*: string */) /*: string */ {
    return posixifyPath(abspath.slice(this.root.length + path.sep.length))
  }

  async tree () /*: Promise<string[]> */ {
    const dirsToRead = [this.root]
    const relPaths = []

    while (true) {
      const dir = dirsToRead.shift()
      if (dir == null) break

      for (const name of await fs.readdirAsync(dir)) {
        const absPath = path.join(dir, name)
        const stat = await fs.statAsync(absPath)
        let relPath = this.relpath(absPath)

        if (stat.isDirectory()) {
          dirsToRead.push(absPath)
          relPath = relPath + path.posix.sep
        }

        relPaths.push(relPath)
      }
    }

    return relPaths
      .sort((a, b) => a.localeCompare(b))
      .filter(relPath => relPath !== `${TMP_DIR_NAME}/`)
  }

  existsSync (target /*: string|PathObject */) /*: bool */ {
    return fs.existsSync(this.abspath(target))
  }

  exists (target /*: string|PathObject */) /*: Promise<bool> */ {
    return fs.exists(this.abspath(target))
  }

  emptyDir (target /*: string|PathObject */) /*: Promise<void> */ {
    return fs.emptyDir(this.abspath(target))
  }

  async ensureDir (target /*: string|PathObject */) {
    await fs.ensureDir(this.abspath(target))
  }

  async ensureParentDir (target /*: string|PathObject */) {
    await this.ensureDir(path.dirname(getPath(target)))
  }

  async mtime (target /*: string|PathObject */) /*: Promise<Date> */ {
    const stats = await this.stat(target)
    return stats.mtime
  }

  async unlink (target /*: string|PathObject */) {
    await fs.unlinkAsync(this.abspath(target))
  }

  async rmdir (target /*: string|PathObject */) {
    await fs.rmdirSync(this.abspath(target))
  }

  async readFile (target /*: string|PathObject */, opts /*: * */ = 'utf8') /*: Promise<string> */ {
    return fs.readFile(this.abspath(target), opts)
  }

  async outputFile (target /*: string|PathObject */, data /*: string */) {
    return fs.outputFile(this.abspath(target), data)
  }

  async checksum (target /*: string|PathObject */) /*: Promise<string> */ {
    // $FlowFixMe
    return checksumer.computeChecksumAsync(this.abspath(target))
  }

  stat (target /*: string|PathObject */) /*: Promise<fs.Stat> */ {
    return fs.stat(this.abspath(target))
  }

  remove (target /*: string|PathObject */) /*: Promise<void> */ {
    return fs.remove(this.abspath(target))
  }

  async removeParentDir (target /*: string|PathObject */) /*: Promise<void> */ {
    await fs.remove(this.abspath(path.dirname(getPath(target))))
  }
}

module.exports = {
  ContextDir,
  posixifyPath
}