/* @flow */

import type { Cozy } from 'cozy-client-js'

import RemoteDirBuilder from './remote/dir'
import RemoteFileBuilder from './remote/file'
import StreamBuilder from './stream'

// Test data builders facade.
//
//     builders.remote.dir()...
//     builders.stream()...
//
export class BuilderFactory {
  cozy: Cozy

  constructor (cozy: Cozy) {
    this.cozy = cozy
  }

  get remote (): * {
    if (this.cozy == null) {
      throw new Error('Cannot create remote files/dirs without a Cozy client.')
      // TODO: Allow building RemoteDoc instances without a Cozy client
    }

    return {
      dir: () => new RemoteDirBuilder(this.cozy),
      file: () => new RemoteFileBuilder(this.cozy)
    }
  }

  stream (): StreamBuilder {
    return new StreamBuilder()
  }
}
