/* @flow */

const {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it
} = require('mocha')
const path = require('path')
const should = require('should')

const configHelpers = require('../support/helpers/config')
const cozyHelpers = require('../support/helpers/cozy')
const pouchHelpers = require('../support/helpers/pouch')
const { IntegrationTestHelpers } = require('../support/helpers/integration')

describe('Trash', () => {
  let cozy, helpers, pouch, prep

  before(configHelpers.createConfig)
  before(configHelpers.registerClient)
  beforeEach(pouchHelpers.createDatabase)
  beforeEach(cozyHelpers.deleteAll)

  afterEach(() => helpers.local.clean())
  afterEach(pouchHelpers.cleanDatabase)
  after(configHelpers.cleanConfig)

  beforeEach(async function () {
    cozy = cozyHelpers.cozy
    helpers = new IntegrationTestHelpers(this.config, this.pouch, cozy)
    pouch = helpers._pouch
    prep = helpers.prep

    await helpers.local.setupTrash()
    await helpers.remote.ignorePreviousChanges()
  })

  describe('file', async () => {
    let parent, file

    beforeEach(async () => {
      parent = await cozy.files.createDirectory({name: 'parent'})
      file = await cozy.files.create('File content...', {name: 'file', dirID: parent._id})
      await helpers.remote.pullChanges()
      await helpers.syncAll()
      helpers.spyPouch()
    })

    it('local', async () => {
      await prep.trashFileAsync('local', {path: 'parent/file'})

      should(helpers.putDocs('path', '_deleted', 'trashed')).deepEqual([
        {path: path.normalize('parent/file'), _deleted: true}
      ])
      await should(pouch.db.get(file._id)).be.rejectedWith({status: 404})

      await helpers.syncAll()

      should(await helpers.remote.tree()).deepEqual([
        '.cozy_trash/',
        '.cozy_trash/file',
        'parent/'
      ])
    })

    it('remote', async () => {
      await cozy.files.trashById(file._id)

      await helpers.remote.pullChanges()

      should(helpers.putDocs('path', '_deleted', 'trashed')).deepEqual([
        {path: path.normalize('parent/file'), _deleted: true}
      ])
      await should(pouch.db.get(file._id)).be.rejectedWith({status: 404})

      await helpers.syncAll()

      should(await helpers.local.tree()).deepEqual([
        '/Trash/file',
        'parent/'
      ])
    })
  })

  describe('directory', async () => {
    let parent, dir, subdir

    beforeEach(async () => {
      parent = await cozy.files.createDirectory({name: 'parent'})
      dir = await cozy.files.createDirectory({name: 'dir', dirID: parent._id})
      await cozy.files.createDirectory({name: 'empty-subdir', dirID: dir._id})
      subdir = await cozy.files.createDirectory({name: 'subdir', dirID: dir._id})
      await cozy.files.create('foo', {name: 'file', dirID: subdir._id})

      await helpers.remote.pullChanges()
      await helpers.syncAll()

      helpers.spyPouch()
    })

    it('local', async () => {
      await prep.trashFolderAsync('local', {path: path.normalize('parent/dir')})

      should(helpers.putDocs('path', '_deleted', 'trashed')).deepEqual([
        // XXX: Why isn't file deleted? (it works anyway)
        {path: path.normalize('parent/dir/subdir'), _deleted: true},
        {path: path.normalize('parent/dir/empty-subdir'), _deleted: true},
        {path: path.normalize('parent/dir'), _deleted: true}
      ])

      await helpers.syncAll()

      should(await helpers.remote.tree()).deepEqual([
        '.cozy_trash/',
        '.cozy_trash/dir/',
        '.cozy_trash/dir/empty-subdir/',
        '.cozy_trash/dir/subdir/',
        '.cozy_trash/dir/subdir/file',
        'parent/'
      ])
    })

    it('remote', async() => {
      // FIXME: should pass a remote doc, or trash from Cozy
      await prep.trashFolderAsync('remote', {path: 'parent/dir'})

      should(helpers.putDocs('path', '_deleted', 'trashed')).deepEqual([
        // XXX: Why isn't file deleted? (it works anyway)
        {path: path.normalize('parent/dir/subdir'), _deleted: true},
        {path: path.normalize('parent/dir/empty-subdir'), _deleted: true},
        {path: path.normalize('parent/dir'), _deleted: true}
      ])

      await helpers.syncAll()

      should(await helpers.local.tree()).deepEqual([
        '/Trash/dir/',
        '/Trash/dir/empty-subdir/',
        '/Trash/dir/subdir/',
        '/Trash/dir/subdir/file',
        'parent/'
      ])
    })
  })
})
