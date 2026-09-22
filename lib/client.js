/**
 * Client half: a sidebar tab that shows what this session's records say.
 *
 * The host half writes two kinds of record into the session log -- one per
 * finished step, one per finished turn -- and they are only reachable by
 * scrolling back through the conversation. This half puts them in a tab.
 *
 * Shape: a closure-factory bundle. `window.__ModuleLoader__.load` with a
 * `factory(require)` is the only form the client module system accepts; React
 * and every host service arrive through the injected `require`, so this file
 * is copied to `lib/` verbatim with no build step and declares no dependency
 * on React.
 *
 * The entries are registered under `sidebarRightTabs` (the service that owns
 * the right panel), and the panel dispatches the component through two seats
 * that must be registered together: `sidebar.right.pane.tab` for the body and
 * `sidebar.right.pane.tab.title` for its title. The seat props are always an
 * empty object -- everything usable arrives in the third argument the host
 * passes to `renderSlot`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-stepwise-distill',
  factory: (require) => {
    const react = require('react')
    const { createElement, useState } = react

    const PLUGIN_ID = 'dsh-stepwise-distill'
    /** Identifies this tab among every other right-panel tab. */
    const TAB_ID = 'stepwise-distill'
    /** Distinguishes the tab's kind; the host matches entries by this. */
    const TAB_KIND = 'stepwise-distill'

    /**
     * The tab body.
     *
     * A placeholder until the records are wired up: it states what the tab is
     * for so that a successful mount is visible rather than an empty panel.
     */
    function DistillTab(props) {
      const [expanded, setExpanded] = useState(false)
      return createElement('div', {
        className: 'dsh-stepwise-distill',
        style: { padding: '12px', font: '12px/1.6 system-ui, sans-serif' },
      }, [
        createElement('div', {
          key: 'title',
          style: { fontWeight: 600, marginBottom: '6px' },
        }, '保留的信息'),
        createElement('div', {
          key: 'note',
          style: { opacity: 0.7 },
        }, '这里会显示本次会话的步间记录与轮间记录。'),
        createElement('button', {
          key: 'toggle',
          type: 'button',
          onClick: () => setExpanded((value) => !value),
          style: { marginTop: '8px' },
        }, expanded ? '收起' : '展开'),
        expanded && createElement('pre', {
          key: 'detail',
          style: { whiteSpace: 'pre-wrap', marginTop: '8px' },
        }, `tabId: ${String(props?.tabId ?? 'unknown')}`),
      ])
    }

    /** The label shown on the tab strip, and in the panel's guide list. */
    function DistillTabTitle() {
      return createElement('span', null, '保留的信息')
    }

    function apply(ctx) {
      ctx.inject(['sidebarRightTabs'], (injected) => {
        const tabs = injected.sidebarRightTabs
        if (tabs === undefined || typeof tabs.register !== 'function') return

        // Every disposer is collected before anything is registered, so that a
        // failure part-way through unwinds exactly what was already done.
        const disposers = []
        const own = (result) => {
          if (typeof result === 'function') disposers.push(result)
        }
        const release = () => {
          for (const dispose of disposers) dispose()
          disposers.length = 0
        }

        try {
          own(tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => '保留的信息',
            guide: [{
              order: 60,
              title: () => '保留的信息',
              description: () => '查看本会话的步间记录与轮间记录。',
            }],
          }))

          own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
          }, (props) => createElement(DistillTab, { ...props, host: 'sidebar' }))))

          own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: TAB_ID,
          }, () => createElement(DistillTabTitle))))
        } catch (error) {
          release()
          ctx.logger?.warn?.(`[${PLUGIN_ID}] sidebar tab not registered: ${String(error)}`)
          return
        }
        return release
      })
    }

    return { apply, name: PLUGIN_ID, inject: ['slots'] }
  },
})
