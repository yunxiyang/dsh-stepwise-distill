import { describe, expect, it } from 'vitest'

// The web half is a closure-factory bundle, not an ES module: importing it runs
// `window.__ModuleLoader__.load` at the top level and hands the loader a
// factory. Loading it here means installing a stand-in loader first, then
// asking the factory for the plugin with a stand-in `react`.
const PLUGIN_ID = 'dsh-stepwise-distill'
const TAB_ID = 'stepwise-distill'
const SETTINGS_NAMESPACE = 'stepwise-distill'

function reactStub() {
  return {
    createElement: () => null,
    useCallback: () => () => {},
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: () => [undefined, () => {}],
  }
}

let spec

async function loadSpec() {
  if (spec === undefined) {
    globalThis.window = {
      __ModuleLoader__: {
        load(loaded) {
          spec = loaded
        },
      },
    }
    await import('../src/client.js')
    delete globalThis.window
  }
  return spec
}

async function makePlugin() {
  const loaded = await loadSpec()
  return loaded.factory(name => (name === 'react' ? reactStub() : undefined))
}

function makeHost(options = {}) {
  const seen = { effects: [], injects: [], seats: [], entries: [], tabs: [], warns: [] }

  const services = {
    configForms: options.configForms,
    settingsScope: options.settingsScope,
    sidebarRightTabs:
      options.sidebarRightTabs === null
        ? undefined
        : (options.sidebarRightTabs ?? {
            register(entry) {
              seen.tabs.push(entry)
              return () => {}
            },
          }),
    slots:
      options.slots === null
        ? undefined
        : (options.slots ?? {
            inject(name, factory) {
              seen.seats.push(name)
              return factory()
            },
            register(entry) {
              seen.entries.push(entry)
              return () => {}
            },
          }),
  }

  const ctx = {
    // The host decides when an effect runs. Collecting the callback without
    // calling it keeps `installStyles`, which reads `document`, out of the way.
    effect(callback) {
      seen.effects.push(callback)
    },
    get(name) {
      return services[name]
    },
    inject(names, callback) {
      seen.injects.push(names.join('+'))
      // The real `ctx.inject` hands back a derived context, so a service the
      // plugin declared at the top stays reachable inside the callback: the
      // sidebar branch registers its seats through `injected.slots`. A service
      // the host does not have stays `undefined`, which is what the branches
      // test for -- `null` here would throw on the property read instead.
      callback({ ...services })
    },
    logger: {
      warn(message) {
        seen.warns.push(message)
      },
    },
  }

  return { ctx, seen }
}

describe('web half', () => {
  it('loads through the client module loader under the plugin id', async () => {
    const loaded = await loadSpec()
    expect(loaded.id).toBe(PLUGIN_ID)
    expect(typeof loaded.factory).toBe('function')
  })

  it('hands the host the same plugin shape as the node half', async () => {
    const plugin = await makePlugin()
    expect(plugin.name).toBe(PLUGIN_ID)
    expect(typeof plugin.apply).toBe('function')
  })

  it('does not name settingsScope among the services it requires', async () => {
    // A plugin that requires a service its host lacks never mounts at all, and
    // the 0.1.7 line has no `settingsScope`. Naming it here would cost the
    // sidebar tab along with the card, so `apply` resolves it conditionally.
    const plugin = await makePlugin()
    expect(plugin.inject).toEqual(['slots', 'sessions'])
  })

  it('hands the card stylesheet to the host instead of running it', async () => {
    const plugin = await makePlugin()
    const host = makeHost()
    plugin.apply(host.ctx)
    // `installStyles` reads `document`. Under Node the call would throw, so
    // returning at all means the callback went to the host unrun.
    expect(host.seen.effects).toHaveLength(1)
  })

  it('registers nothing when the host serves none of the seats', async () => {
    const plugin = await makePlugin()
    const host = makeHost({ sidebarRightTabs: null, slots: null })
    plugin.apply(host.ctx)
    expect(host.seen.injects).toEqual(['sidebarRightTabs', 'slots+settingsScope'])
    expect(host.seen.entries).toEqual([])
    expect(host.seen.warns).toEqual([])
  })

  it('seats both sidebar slots when the sidebar service is present', async () => {
    const plugin = await makePlugin()
    const host = makeHost()
    plugin.apply(host.ctx)
    expect(host.seen.tabs).toHaveLength(1)
    expect(host.seen.tabs[0]).toMatchObject({ id: TAB_ID, kind: TAB_ID })
    expect(typeof host.seen.tabs[0].title()).toBe('string')
    expect(host.seen.tabs[0].title().length).toBeGreaterThan(0)
    expect(host.seen.seats).toEqual(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
    expect(host.seen.entries.map(entry => entry.name)).toEqual([
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
    ])
    expect(host.seen.entries.every(entry => entry.key === TAB_ID)).toBe(true)
    expect(host.seen.warns).toEqual([])
  })

  it('takes the configForms line when the host offers it', async () => {
    const plugin = await makePlugin()
    const host = makeHost({ configForms: { get: () => undefined }, sidebarRightTabs: null })
    plugin.apply(host.ctx)
    expect(host.seen.injects).toEqual(['sidebarRightTabs', 'slots'])
    expect(host.seen.entries).toEqual([
      { name: 'plugins.row.config', key: `${PLUGIN_ID}#${SETTINGS_NAMESPACE}` },
    ])
  })

  it('falls back to the legacy settings item when settingsScope is still there', async () => {
    const plugin = await makePlugin()
    const host = makeHost({ settingsScope: { bind: () => ({}) }, sidebarRightTabs: null })
    plugin.apply(host.ctx)
    expect(host.seen.injects).toEqual(['sidebarRightTabs', 'slots+settingsScope'])
    expect(host.seen.entries).toEqual([{ name: 'settings.plugin.item', key: SETTINGS_NAMESPACE }])
  })
})
