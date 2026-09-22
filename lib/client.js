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
    const { createElement, useEffect, useState } = react

    const PLUGIN_ID = 'dsh-stepwise-distill'
    /** Identifies this tab among every other right-panel tab. */
    const TAB_ID = 'stepwise-distill'
    /** Distinguishes the tab's kind; the host matches entries by this. */
    const TAB_KIND = 'stepwise-distill'

    // Declared on both sides rather than shared: the host half keeps its own
    // copy in `src/index.js`, and there is no module both halves import.
    const RECORDS_ROUTE = '/api/stepwise-distill/records'

    /**
     * The tab body.
     *
     * The records live in the session log, which only the host half can read:
     * the panel's own paging verb is addressed by `seq`, so it cannot be asked
     * for "everything this session retained". The tab therefore asks the host
     * for the list, and the host answers from the log it already holds.
     */
    function DistillTab(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [records, setRecords] = useState(null)
      const [error, setError] = useState(null)
      // One open body at a time. The bodies are long enough that several open
      // at once would push every later record off the panel, which defeats the
      // reason for opening one. Keyed by seq, not by list position: a later
      // read that reorders the list must not move an open body to a different
      // record.
      const [openSeq, setOpenSeq] = useState(null)

      useEffect(() => {
        // A tab is remounted before the injected fiber re-fires, so this runs
        // more than once per panel and the previous request must be abandoned
        // rather than allowed to land on a newer render's state.
        let cancelled = false
        if (sessionId === '') {
          setRecords([])
          return () => { cancelled = true }
        }
        const read = async () => {
          try {
            const response = await fetch(RECORDS_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            if (payload?.ok !== true) throw new Error('records read failed')
            if (!cancelled) setRecords(Array.isArray(payload.value) ? payload.value : [])
          } catch (failure) {
            if (!cancelled) setError(String(failure?.message ?? failure))
          }
        }
        read()
        return () => { cancelled = true }
      }, [sessionId])

      const loading = records === null && error === null
      const list = records ?? []
      const turns = list.filter((item) => item?.kind === 'turn')
      const steps = list.filter((item) => item?.kind !== 'turn')

      return createElement('div', {
        className: 'dsh-stepwise-distill',
        style: { padding: '12px', font: '12px/1.6 system-ui, sans-serif' },
      }, [
        createElement('div', {
          key: 'title',
          style: { fontWeight: 600, marginBottom: '6px' },
        }, '保留的信息'),
        error !== null && createElement('div', {
          key: 'error',
          style: { color: '#c0392b' },
        }, `读取失败：${error}`),
        loading && createElement('div', {
          key: 'loading',
          style: { opacity: 0.7 },
        }, '读取中…'),
        !loading && error === null && list.length === 0 && createElement('div', {
          key: 'empty',
          style: { opacity: 0.7 },
        }, '本次会话还没有记录。'),
        section('轮间记录', turns, 'turn', openSeq, setOpenSeq),
        section('步间记录', steps, 'step', openSeq, setOpenSeq),
      ])
    }

    /**
     * One group of records, newest first.
     *
     * Grouped rather than listed together because the two kinds answer
     * different questions: a step record replaces the step it covers, a turn
     * record is added on top of everything the turn already had.
     *
     * Bodies start closed -- a session accumulates records faster than anyone
     * reads them, and the labels alone are enough to pick one out. Opening one
     * closes the rest, so the open state is held by the parent rather than by
     * each entry.
     */
    function section(label, items, kind, openSeq, setOpenSeq) {
      if (items.length === 0) return null
      const sorted = [...items].sort((a, b) => (a?.turn ?? a?.seq ?? 0) - (b?.turn ?? b?.seq ?? 0))
      return createElement('div', {
        key: `section-${kind}`,
        style: { marginTop: '12px' },
      }, [
        createElement('div', {
          key: 'label',
          style: { fontWeight: 600, opacity: 0.8, marginBottom: '4px' },
        }, `${label}（${items.length}）`),
        ...sorted.map((item, index) => {
          const seq = item?.seq
          const open = openSeq !== null && seq === openSeq
          return createElement('div', {
          key: `entry-${kind}-${seq ?? index}`,
          style: { borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: '6px', marginTop: '6px' },
        }, [
          createElement('button', {
            key: 'at',
            type: 'button',
            onClick: () => setOpenSeq(open ? null : seq),
            style: {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              background: 'none',
              border: 0,
              padding: 0,
              font: 'inherit',
              color: 'inherit',
              opacity: open ? 0.95 : 0.6,
              cursor: 'pointer',
            },
          }, `${open ? '▾' : '▸'} ${where(item)}`),
          open && createElement('pre', {
            key: 'text',
            style: { whiteSpace: 'pre-wrap', margin: '4px 0 0', font: 'inherit' },
          }, String(item?.text ?? '')),
        ])
        }),
      ])
    }

    /** Where a record belongs, as far as the log says. */
    function where(item) {
      if (item?.kind === 'turn') return `turn ${item.turn ?? '?'}`
      return item?.turn === null || item?.turn === undefined
        ? `seq ${item.seq}`
        : `turn ${item.turn}, step ${item.step}`
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
            // Probe, not a decision: the seat is declared `scope: "session"` in
            // the host's own registry, but that declaration sits on the parent
            // chain under `rightbar.session`, which this plugin does not join.
            // Whether the callback is handed a value is therefore unknown until
            // it renders one -- so the tab shows what it got either way.
            inject: (sessionId) => ({ sessionId }),
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
